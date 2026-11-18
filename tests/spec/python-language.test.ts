import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adapterFor, approveSpecSamples, applySpecBatch, createSpecBatch, generateSpecBatch, loadSpecBatch, saveSpecBatch, pythonFacts, type SpecGenerator } from '../../src/core/index.js'

describe('Python source adapter', () => {
  it('extracts public module declarations and imports without counting comments, strings, methods, or private names', () => {
    const text = [
      'import os, pathlib as paths', 'from .models import (', '  User,', ')', 'from .. import shared',
      '# import invented', '"""', 'def fabricated(): pass', 'import fake', '"""',
      'TEXT = "def fake(): pass"', "ESCAPED = 'a\\\'b'", 'class Client:', '    def nested(self): pass',
      'async def fetch(): pass', 'def _internal(): pass', '_secret = 1', 'COUNT: int = 4',
    ].join('\r\n')
    expect(pythonFacts(text)).toEqual({ exports: ['COUNT', 'Client', 'ESCAPED', 'TEXT', 'fetch'], imports: ['..', '.models', 'os', 'pathlib'], lineCount: 18 })
    expect(adapterFor('module.PY')?.id).toBe('python')
    expect(adapterFor('types.pyi')?.exclude?.('types.pyi')).toBe('declaration-file')
  })

  it('completes evidence, sample approval, full preview, apply, and resume on a mixed-language repository without executing sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-python-'))
    try {
      const sourceRoot = join(root, 'source'); const stateRoot = join(root, 'state'); const outputRoot = join(root, 'specs')
      await mkdir(sourceRoot)
      const sources: Record<string, string> = {
        'client.py': 'import pathlib\nclass Client:\n    pass\nraise RuntimeError("must never execute")\n',
        'async_api.py': 'async def fetch():\n    return 1\n',
        'types.ts': 'export interface User { id: string }\n',
        'Service.java': 'public class Service {}\n',
      }
      for (const [name, content] of Object.entries(sources)) await writeFile(join(sourceRoot, name), content)
      await writeFile(join(sourceRoot, 'typing.pyi'), 'def stub() -> None: ...')
      await mkdir(join(sourceRoot, '.venv'))
      await writeFile(join(sourceRoot, '.venv', 'third_party.py'), 'raise Exception("skip")')
      const generator: SpecGenerator = {
        id: 'python-test', async generate(request) {
          return { draft: { version: 1, moduleId: request.module.id, purpose: { text: `Describes ${request.module.relativePath}.`, citations: [request.module.evidence[0]!.id] } } }
        },
      }
      let batch = await createSpecBatch({ sourceRoot, outputRoot, stateRoot })
      expect(batch.items.map(item => item.language).sort()).toEqual(['java', 'python', 'python', 'typescript'])
      expect(batch.discovery.excludedByReason['declaration-file']).toBe(1)
      expect(batch.discovery.excludedByReason['ignored-folder']).toBe(1)
      batch = await generateSpecBatch(batch, generator, { only: 'samples', stateRoot })
      batch = approveSpecSamples(batch)
      batch = await generateSpecBatch(batch, generator, { only: 'remaining', stateRoot })
      await saveSpecBatch(batch, stateRoot)
      const result = await applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, stateRoot)
      expect(result.summary.applied).toBe(4)
      const resumed = await applySpecBatch(await loadSpecBatch(batch.id, stateRoot), { id: batch.id, revision: batch.revision, digest: batch.digest }, stateRoot)
      expect(resumed.summary.applied).toBe(4)
      for (const [name, content] of Object.entries(sources)) expect(await readFile(join(sourceRoot, name), 'utf8')).toBe(content)
      expect(await readFile(join(outputRoot, 'client.md'), 'utf8')).toContain('client.py')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
