import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chooseSamples, createSpecBatch } from '../../src/spec/prepare.js'

describe('representative source samples', () => {
  it('covers three roles where the previous export/import/smallest heuristic picked only routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-spread-'))
    try {
      const files = {
        'src/routes/a.ts': "import x from './c';\nimport y from './b';\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n",
        'src/routes/b.ts': "import a from './a';\nimport c from './c';\nimport d from '../models/entity';\nexport const route = 1;\n",
        'src/routes/c.ts': 'export const tiny = 1;',
        'src/services/worker.ts': 'export class Worker {\n  run() {}\n}\nexport const worker = new Worker();\n',
        'src/models/entity.ts': 'export interface Entity {\n  id: string;\n  name: string;\n}\n',
      }
      for (const [path, text] of Object.entries(files)) { const file = join(root, 'source', path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text) }
      const batch = await createSpecBatch({ sourceRoot: join(root, 'source'), outputRoot: join(root, 'output') })
      const old = [
        [...batch.items].sort((a, b) => b.facts.exports.length * 10 + b.facts.imports.length * 4 + Math.min(b.facts.lineCount, 100) / 100 - (a.facts.exports.length * 10 + a.facts.imports.length * 4 + Math.min(a.facts.lineCount, 100) / 100))[0]!,
      ]
      old.push([...batch.items].sort((a, b) => b.facts.imports.length - a.facts.imports.length).find(item => !old.includes(item))!)
      old.push([...batch.items].sort((a, b) => a.facts.lineCount - b.facts.lineCount).find(item => !old.includes(item))!)
      expect(old.every(item => item.relativePath.startsWith('src/routes/'))).toBe(true)
      const selected = batch.samples.map(id => batch.items.find(item => item.id === id)!)
      expect(selected[0]!.relativePath).toBe('src/routes/a.ts')
      expect(new Set(selected.map(item => item.relativePath.split('/')[1])).size).toBe(3)
      expect(chooseSamples([...batch.items].reverse())).toEqual(batch.samples)

      const base = batch.items[0]!
      const variants = [
        { ...base, id: 'rich', relativePath: 'rich.ts', facts: { exports: ['a', 'b', 'c'], imports: ['x', 'y'], lineCount: 100 } },
        { ...base, id: 'duplicate', relativePath: 'copy.ts', facts: { exports: ['renamedA', 'renamedB', 'renamedC'], imports: ['p', 'q'], lineCount: 100 } },
        { ...base, id: 'small', relativePath: 'tiny.ts', facts: { exports: [], imports: [], lineCount: 2 } },
        { ...base, id: 'other', relativePath: 'other.py', language: 'python', facts: { exports: ['one'], imports: [], lineCount: 15 } },
      ]
      const diverse = chooseSamples(variants)
      expect(diverse).toContain('small'); expect(diverse).toContain('other')
      expect(diverse.filter(id => id === 'rich' || id === 'duplicate')).toHaveLength(1)
      expect(chooseSamples(variants.slice(0, 3))).toHaveLength(3)
      expect(() => chooseSamples(variants.slice(0, 2))).toThrow('At least three')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
