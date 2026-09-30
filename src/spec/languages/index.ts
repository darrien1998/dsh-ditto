import { extname } from 'node:path'
import { java } from './java.js'
import { typescript } from './typescript.js'
import type { LanguageAdapter } from './types.js'

export type { LanguageAdapter } from './types.js'
export { java, javaFacts } from './java.js'
export { typescript, typescriptFacts } from './typescript.js'

/** Adapters shipped with Ditto. Community adapters can be passed through `CreateSpecBatchOptions.adapters`. */
export const DEFAULT_ADAPTERS: readonly LanguageAdapter[] = [
  typescript,
  java,
]

export function validateAdapters(adapters: readonly LanguageAdapter[]): void {
  if (!Array.isArray(adapters) || adapters.length === 0 || adapters.length > 20) throw new Error('At least one language adapter is required')
  const ids = new Set<string>(); const extensions = new Set<string>()
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(adapter.id) || typeof adapter.displayName !== 'string' || typeof adapter.structuralFacts !== 'function' || !(adapter.extensions instanceof Set) || adapter.extensions.size === 0) throw new Error('Invalid language adapter')
    if (ids.has(adapter.id)) throw new Error(`Duplicate language adapter id: ${adapter.id}`)
    ids.add(adapter.id)
    for (const extension of adapter.extensions) {
      if (typeof extension !== 'string' || !/^\.[a-z0-9]+$/.test(extension)) throw new Error(`Invalid adapter extension: ${String(extension)}`)
      if (extensions.has(extension)) throw new Error(`Two language adapters claim ${extension}`)
      extensions.add(extension)
    }
  }
}

/** The adapter that claims a file's extension, if any. */
export function adapterFor(fileName: string, adapters: readonly LanguageAdapter[] = DEFAULT_ADAPTERS): LanguageAdapter | undefined {
  const extension = extname(fileName).toLowerCase()
  return adapters.find(adapter => adapter.extensions.has(extension))
}
