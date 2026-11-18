import type { StructuralFacts } from '../types.js'
import type { LanguageAdapter } from './types.js'

/** Mask comments and string bodies while preserving line numbers and indentation. */
function structuralText(text: string): string {
  let result = ''; let offset = 0
  while (offset < text.length) {
    const start = offset
    if (text[offset] === '#') {
      while (offset < text.length && text[offset] !== '\n') offset++
    } else if (text[offset] === '"' || text[offset] === "'") {
      const quote = text[offset]!
      const delimiter = text.startsWith(quote.repeat(3), offset) ? quote.repeat(3) : quote
      offset += delimiter.length
      while (offset < text.length) {
        if (text[offset] === '\\') { offset = Math.min(offset + 2, text.length); continue }
        if (text.startsWith(delimiter, offset)) { offset += delimiter.length; break }
        offset++
      }
    } else { result += text[offset++]; continue }
    result += text.slice(start, offset).replace(/[^\n]/g, ' ')
  }
  return result
}

/** Approximate lexical hints, never a claim about Python runtime behaviour or __all__. */
export function pythonFacts(text: string): StructuralFacts {
  const normalized = text.replace(/\r\n?/g, '\n')
  const code = structuralText(normalized)
  const exports = new Set<string>(); const imports = new Set<string>()
  for (const match of code.matchAll(/^(?:(?:async[ \t]+)?def|class)[ \t]+([A-Za-z_]\w*)/gm)) if (!match[1]!.startsWith('_')) exports.add(match[1]!)
  for (const match of code.matchAll(/^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)/gm)) if (!match[1]!.startsWith('_')) exports.add(match[1]!)
  for (const match of code.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm)) imports.add(match[1]!)
  for (const match of code.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm)) {
    for (const part of match[1]!.split(',')) {
      const name = /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/.exec(part)?.[1]
      if (name) imports.add(name)
    }
  }
  return { exports: [...exports].sort(), imports: [...imports].sort(), lineCount: normalized.split('\n').length }
}

export const python: LanguageAdapter = {
  id: 'python',
  displayName: 'Python',
  extensions: new Set(['.py', '.pyi']),
  exclude: fileName => /\.pyi$/i.test(fileName) ? 'declaration-file' : undefined,
  structuralFacts: pythonFacts,
}
