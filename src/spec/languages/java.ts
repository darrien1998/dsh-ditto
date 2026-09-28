import type { StructuralFacts } from '../types.js'
import type { LanguageAdapter } from './types.js'

const EXTENSIONS = new Set(['.java'])

function stripNonCode(text: string): string {
  let result = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '/' && next === '/') {
      result += '  '
      index += 2

      while (
        index < text.length &&
        text[index] !== '\n' &&
        text[index] !== '\r'
      ) {
        result += ' '
        index++
      }

      continue
    }

    if (char === '/' && next === '*') {
      result += '  '
      index += 2

      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          result += '  '
          index += 2
          break
        }

        const current = text[index]
        result += current === '\n' || current === '\r' ? current : ' '
        index++
      }

      continue
    }

    if (text.slice(index, index + 3) === '"""') {
      result += '   '
      index += 3

      while (index < text.length) {
        if (text.slice(index, index + 3) === '"""') {
          result += '   '
          index += 3
          break
        }

        const current = text[index]
        result += current === '\n' || current === '\r' ? current : ' '
        index++
      }

      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      result += ' '
      index++

      while (index < text.length) {
        const current = text[index]

        if (current === '\\' && index + 1 < text.length) {
          result += '  '
          index += 2
          continue
        }

        result += current === '\n' || current === '\r' ? current : ' '
        index++

        if (current === quote) break
      }

      continue
    }

    result += char
    index++
  }

  return result
}

export function javaFacts(text: string): StructuralFacts {
  const source = stripNonCode(text)

  const exports = new Set<string>()
  const imports = new Set<string>()

  for (
    const match of source.matchAll(
      /^[ \t]*import[ \t]+(?:static[ \t]+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$*][\w$*]*)*)[ \t]*;/gm,
    )
  ) {
    imports.add(match[1]!)
  }

  const depthAt = new Uint32Array(source.length + 1)
  let depth = 0

  for (let index = 0; index < source.length; index++) {
    depthAt[index] = depth

    if (source[index] === '{') {
      depth++
    } else if (source[index] === '}') {
      depth = Math.max(0, depth - 1)
    }
  }

  const declaration =
    /\bpublic\s+(?:(?:abstract|final|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)\b/g

  for (const match of source.matchAll(declaration)) {
    if (match.index !== undefined && depthAt[match.index] === 0) {
      exports.add(match[1]!)
    }
  }

  return {
    exports: [...exports].sort(),
    imports: [...imports].sort(),
    lineCount: text.replace(/\r\n/g, '\n').split('\n').length,
  }
}

export const java: LanguageAdapter = {
  id: 'java',
  displayName: 'Java',
  extensions: EXTENSIONS,

  exclude: fileName =>
    /^(?:package-info|module-info)\.java$/i.test(fileName)
      ? 'declaration-file'
      : undefined,

  structuralFacts: javaFacts,
}