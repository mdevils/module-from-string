import vm, { createContext } from 'vm'
import { TransformOptions, transform, transformSync } from 'esbuild'
import { nanoid } from 'nanoid/async'
import { Options, requireFromString } from './require'
import {
  isVMModuleAvailable,
  ensureFileURL,
  ensurePath,
  getCallerDirname,
  getModuleFilename,
  createGlobalObject,
  createContextObject,
  resolveModuleSpecifier
} from './utils'

const USE_STRICT = '"use strict";'

const IMPORT_META_URL_SHIM =
  'var import_meta_url = require("url").pathToFileURL(__filename).toString();'

const IMPORT_META_RESOLVE_SHIM = `function import_meta_resolve() {
  throw new Error(
    \`'import.meta.resolve' is not supported
Use asynchronous function 'importFromString' and enable '--experimental-vm-modules' CLI option.
Or use 'transformOptions' to include a polyfill. See https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483 as an example.\`
  );
}`

const getCommonJS = (transformOptions: TransformOptions | undefined): TransformOptions => {
  return {
    ...transformOptions,
    banner:
      `${USE_STRICT}\n` +
      `${IMPORT_META_URL_SHIM}\n` +
      `${IMPORT_META_RESOLVE_SHIM}\n` +
      `${transformOptions?.banner ?? ''}`,
    define: {
      'import.meta.url': 'import_meta_url',
      'import.meta.resolve': 'import_meta_resolve',
      ...transformOptions?.define
    },
    format: 'cjs'
  }
}

const ERR_REQUIRE_ESM = 'ERR_REQUIRE_ESM'
const IMPORTS = '__INTERNAL_IMPORTS_FROM_STRING'

export interface ImportOptions extends Options {
  transformOptions?: TransformOptions | undefined
}

export const importFromString = async (
  code: string,
  { transformOptions, ...options }: ImportOptions | undefined = {}
): Promise<any> => {
  if (!isVMModuleAvailable()) {
    const { code: transformedCode } = await transform(code, getCommonJS(transformOptions))
    try {
      return requireFromString(transformedCode, options)
    } catch (error) {
      if (error != null && (error as NodeJS.ErrnoException).code === ERR_REQUIRE_ESM) {
        throw new Error(
          `'import' statement of ES modules is not supported
Enable '--experimental-vm-modules' CLI option or replace it with dynamic 'import()' expression.`
        )
      }
      throw error
    }
  }

  let transformedCode: string | undefined

  if (transformOptions !== undefined) {
    ;({ code: transformedCode } = await transform(code, {
      format: 'esm',
      ...transformOptions
    }))
  }

  const {
    filename = `${await nanoid()}.js`,
    dirname = getCallerDirname(),
    globals = {},
    useCurrentGlobal = false
  } = options

  const moduleFilename = getModuleFilename(dirname, filename)
  const moduleFileURLString = ensureFileURL(moduleFilename)

  const globalObject = createGlobalObject(globals, useCurrentGlobal)
  const contextObject = createContextObject(
    {
      __dirname: ensurePath(dirname),
      __filename: ensurePath(moduleFilename)
    },
    globalObject
  )
  contextObject[IMPORTS] = {}
  const context = createContext(contextObject)

  const vmModule = new vm.SourceTextModule(transformedCode ?? code, {
    identifier: moduleFileURLString,
    context,
    initializeImportMeta(meta: ImportMeta) {
      meta.url = moduleFileURLString
    },
    // @ts-expect-error: wrong type definition
    async importModuleDynamically(specifier: string) {
      return await import(resolveModuleSpecifier(specifier, dirname))
    }
  })

  const linker = async (specifier: string): Promise<vm.Module> => {
    const resolvedSpecifier = resolveModuleSpecifier(specifier, dirname)
    const targetModule = await import(resolvedSpecifier)
    context[IMPORTS][specifier] = targetModule

    const stringifiedSpecifier = JSON.stringify(specifier)
    const exportedNames = Object.keys(targetModule)
    const targetModuleContent = `${
      exportedNames.includes('default')
        ? `export default ${IMPORTS}[${stringifiedSpecifier}].default;\n`
        : ''
    }export const { ${exportedNames
      .filter(exportedName => exportedName !== 'default')
      .join(', ')} } = ${IMPORTS}[${stringifiedSpecifier}];`

    return new vm.SourceTextModule(targetModuleContent, {
      identifier: resolvedSpecifier,
      context
    })
  }

  await vmModule.link(linker)
  await vmModule.evaluate()
  return vmModule.namespace
}

export const createImportFromString =
  (options?: ImportOptions | undefined): typeof importFromString =>
  async (code, additionalOptions) =>
    await importFromString(code, {
      ...options,
      ...additionalOptions
    })

export const importFromStringSync = (
  code: string,
  { transformOptions, ...options }: ImportOptions | undefined = {}
): any => {
  const { code: transformedCode } = transformSync(code, getCommonJS(transformOptions))
  try {
    return requireFromString(transformedCode, options)
  } catch (error) {
    if (error != null && (error as NodeJS.ErrnoException).code === ERR_REQUIRE_ESM) {
      throw new Error(
        `'import' statement of ES modules is not supported
Use asynchronous function 'importFromString' instead or replace it with dynamic 'import()' expression.`
      )
    }
    throw error
  }
}

export const createImportFromStringSync =
  (options?: ImportOptions | undefined): typeof importFromStringSync =>
  (code, additionalOptions) =>
    importFromStringSync(code, {
      ...options,
      ...additionalOptions
    })
