import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpecBatch } from '../../src/spec/prepare.js'
import type { SpecGenerator } from '../../src/spec/types.js'
import { startSpecWorkbench, type LocalWorkbench } from '../../src/server.js'
import { renderSpecWorkbench, representativeSpecModules, type SpecBatchLike, type SpecModuleLike } from '../../src/ui/spec-workbench.js'

const module = (id: string, path: string, status = 'sample-ready'): SpecModuleLike => ({
  id, relativePath: path, outputPath: path.replace(/\.[^.]+$/, '.md'), status, renderedMarkdown: `# ${path}\n\n- [ev_0123456789abcdef01234567]`,
  structuralFacts: { exports: [id], imports: [], lineCount: 3 }, evidence: [{ id: 'ev_0123456789abcdef01234567', relativePath: path, startLine: 1, endLine: 3 }],
})

const browserBatch = (): SpecBatchLike => ({
  id: 'batch', revision: 1, digest: 'a'.repeat(64), sourceRoot: '/source', outputRoot: '/output', samples: ['a', 'b', 'c'], instructions: '',
  modules: [module('a', 'src/entry.ts'), module('b', 'src/widget.jsx'), module('c', 'src/helper.js'), module('d', 'src/unchecked.ts', 'needs-review')],
  excluded: [{ relativePath: 'node_modules', reason: 'ignored-folder' }], summary: { excluded: 1 },
})

function executeClient(lang: 'en' | 'zh-TW' | undefined, browserLanguage: string): string {
  const html = renderSpecWorkbench(browserBatch(), { csrfToken: 'csrf', lang })
  const scripts = html.split('<script>').slice(1).map(part => part.split('</script>')[0])
  const bootSource = scripts[0]!.replace('window.__DSH_DITTO_SPEC_BOOT__=', '').replace(/;$/, '')
  const window = { __DSH_DITTO_SPEC_BOOT__: JSON.parse(bootSource) }
  const node = () => ({ disabled: false, hidden: false, open: false, value: '', textContent: '', innerHTML: '', dataset: {}, className: '', addEventListener: () => undefined, focus: () => undefined })
  const nodes = new Map<string, ReturnType<typeof node>>()
  const document = {
    documentElement: { lang: '', setAttribute: () => undefined }, title: 'Ditto · Code → Spec', head: { appendChild: () => undefined },
    querySelector: (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector)! },
    querySelectorAll: () => [], createElement: () => node(),
  }
  new Function('window', 'document', 'navigator', 'fetch', 'matchMedia', scripts[1]!)(window, document, { language: browserLanguage }, async () => ({ ok: true, json: async () => ({}) }), () => ({ matches: false }))
  return document.documentElement.lang
}

describe('specification review page', () => {
  it('renders actual sample ids, evidence line links, scan exclusions, and a locked batch action', () => {
    const html = renderSpecWorkbench(browserBatch(), { csrfToken: 'csrf</script>', demo: true })
    expect(html).toContain('Synthetic demo')
    expect(html).toContain('id="sample-a"')
    expect(html).toContain('lines 1–3')
    expect(html).toContain('ignored-folder')
    expect(html).toContain('id="generate-button" type="button" disabled')
    expect(html).toContain('/api/spec/approve')
    expect(html).not.toContain('csrf</script>')
    const scripts = html.split('<script>').slice(1).map(part => part.split('</script>')[0])
    expect(() => new Function(scripts[1]!)).not.toThrow()
  })

  it('keeps apply disabled when approved samples leave the rest of the batch pending', () => {
    const batch = browserBatch()
    batch.modules = batch.modules.map((item, index) => ({ ...item, status: index < 3 ? 'approved' : 'pending' }))
    const html = renderSpecWorkbench(batch, { csrfToken: 'csrf', samplesApproved: true, canApply: false })
    expect(html).toContain('"canApply":false')
    expect(html).toContain("$('#apply-button').disabled=dirty||!canApply")
  })

  it('escapes reviewed Markdown and evidence path text before embedding browser state', () => {
    const batch = browserBatch(); batch.modules[0]!.renderedMarkdown = '# safe\n\n</textarea><script>window.injected=1</script>'
    batch.modules[0]!.evidence![0]!.relativePath = 'x</code><img src=x onerror=alert(1)>.ts'
    const html = renderSpecWorkbench(batch, { csrfToken: 'token</script>' })
    expect(html).not.toContain('</textarea><script>window.injected=1</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;window.injected=1')
  })

  it('keeps a deterministic structural fallback for fixtures without recorded sample ids', () => {
    expect(representativeSpecModules(browserBatch().modules).map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('embeds explicit locale precedence and the shared locale table in the client script', () => {
    const html = renderSpecWorkbench(browserBatch(), { csrfToken: 'csrf', lang: 'zh-TW' })
    expect(html).toContain('"lang":"zh-TW"')
    expect(html).toContain('typeof navigator')
    expect(html).toContain("navigator.language==='zh-TW'?'zh-TW':'en'")
    expect(html).toContain('document.documentElement.lang=locale')
    expect(executeClient('zh-TW', 'en-US')).toBe('zh-TW')
    expect(executeClient(undefined, 'zh-TW')).toBe('zh-TW')
    expect(executeClient(undefined, 'de-DE')).toBe('en')
  })
})

const servers: LocalWorkbench[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

const fakeGenerator: SpecGenerator = {
  id: 'deterministic-test-generator',
  async generate(request) {
    const evidence = request.module.evidence[0]!
    return { metadata: { synthetic: 'true' }, draft: { version: 1, moduleId: request.module.id, title: { text: `${request.module.relativePath} specification`, citations: [evidence.id] }, purpose: { text: 'The behaviour of this module must be confirmed against the source evidence.', citations: [evidence.id] } } }
  },
}

describe('specification server flow', () => {
  it('blocks generation before approval, changes digest on reviewed samples, then returns per-item apply results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-spec-ui-')); const source = join(root, 'source'); const output = join(root, 'specs'); const state = join(root, 'state')
    const names = Array.from({ length: 12 }, (_, index) => `module-${String(index + 1).padStart(2, '0')}.ts`)
    await mkdir(source, { recursive: true })
    await Promise.all(names.map((name, index) => writeFile(join(source, name), `export function fn${index}(value: string) { return value }\n`, 'utf8')))
    const before = await Promise.all(names.map(name => readFile(join(source, name), 'utf8')))
    const server = await startSpecWorkbench({ sourceRoot: source, outputRoot: output, stateRoot: state, generator: fakeGenerator, demo: true }); servers.push(server)
    const headers = { 'content-type': 'application/json', 'x-dsh-csrf': server.csrfToken, origin: server.url }
    const initial = await (await fetch(`${server.url}/api/spec/batch`)).json() as { batch: SpecBatchLike }
    expect(initial.batch.modules).toHaveLength(12); expect(initial.batch.samples).toHaveLength(3)
    const blocked = await fetch(`${server.url}/api/spec/generate`, { method: 'POST', headers, body: JSON.stringify({ revision: initial.batch.revision, digest: initial.batch.digest }) })
    expect(blocked.status).toBe(409)
    const sampleEdits = initial.batch.samples!.map(id => { const item = initial.batch.modules.find(candidate => candidate.id === id)!; return { moduleId: id, markdown: item.renderedMarkdown! } })
    const revised = await (await fetch(`${server.url}/api/spec/revise`, { method: 'POST', headers, body: JSON.stringify({ revision: initial.batch.revision, sampleEdits, instructions: 'Test instructions' }) })).json() as { batch: SpecBatchLike }
    expect(revised.batch.digest).not.toBe(initial.batch.digest)
    expect(revised.batch.modules.filter(item => revised.batch.samples!.includes(item.id)).every(item => item.status === 'sample-ready')).toBe(true)
    const blockedAfterRevision = await fetch(`${server.url}/api/spec/generate`, { method: 'POST', headers, body: JSON.stringify({ revision: revised.batch.revision, digest: revised.batch.digest }) })
    expect(blockedAfterRevision.status).toBe(409)
    const approved = await (await fetch(`${server.url}/api/spec/approve`, { method: 'POST', headers, body: JSON.stringify({ revision: revised.batch.revision, digest: revised.batch.digest }) })).json() as { batch: SpecBatchLike }
    const premature = await fetch(`${server.url}/api/spec/apply`, { method: 'POST', headers, body: JSON.stringify({ id: approved.batch.id, revision: approved.batch.revision, digest: approved.batch.digest }) })
    expect(premature.status).toBe(409)
    await expect(premature.json()).resolves.toMatchObject({ error: expect.stringContaining('preview is not complete') })
    const firstSample = approved.batch.modules.find(item => item.id === approved.batch.samples![0])!
    const recalibratedEdits = approved.batch.samples!.map(id => {
      const item = approved.batch.modules.find(candidate => candidate.id === id)!
      return { moduleId: id, markdown: id === firstSample.id ? `${item.renderedMarkdown!.trimEnd()}\n- Recalibrated content [${item.evidence![0]!.id}]\n` : item.renderedMarkdown! }
    })
    const recalibrated = await (await fetch(`${server.url}/api/spec/revise`, { method: 'POST', headers, body: JSON.stringify({ revision: approved.batch.revision, sampleEdits: recalibratedEdits, instructions: 'Updated test instructions' }) })).json() as { batch: SpecBatchLike, samplesApproved: boolean }
    expect(recalibrated.samplesApproved).toBe(false)
    expect(recalibrated.batch.modules.filter(item => !recalibrated.batch.samples!.includes(item.id)).every(item => item.status === 'pending' && !item.renderedMarkdown)).toBe(true)
    const blockedAfterRecalibration = await fetch(`${server.url}/api/spec/generate`, { method: 'POST', headers, body: JSON.stringify({ revision: recalibrated.batch.revision, digest: recalibrated.batch.digest }) })
    expect(blockedAfterRecalibration.status).toBe(409)
    const reapproved = await (await fetch(`${server.url}/api/spec/approve`, { method: 'POST', headers, body: JSON.stringify({ revision: recalibrated.batch.revision, digest: recalibrated.batch.digest }) })).json() as { batch: SpecBatchLike, samplesApproved: boolean }
    expect(reapproved.samplesApproved).toBe(true)
    const generated = await (await fetch(`${server.url}/api/spec/generate`, { method: 'POST', headers, body: JSON.stringify({ revision: reapproved.batch.revision, digest: reapproved.batch.digest }) })).json() as { batch: SpecBatchLike }
    expect(generated.batch.modules.every(item => Boolean(item.renderedMarkdown))).toBe(true)
    const applied = await (await fetch(`${server.url}/api/spec/apply`, { method: 'POST', headers, body: JSON.stringify({ id: generated.batch.id, revision: generated.batch.revision, digest: generated.batch.digest }) })).json() as { items: Array<{ status: string }> }
    expect(applied.items).toHaveLength(12); expect(applied.items.every(item => item.status === 'applied')).toBe(true)
    const blockedAfterApply = await fetch(`${server.url}/api/spec/revise`, { method: 'POST', headers, body: JSON.stringify({ revision: generated.batch.revision, sampleEdits: recalibratedEdits, instructions: 'No edits after writing' }) })
    expect(blockedAfterApply.status).toBe(409)
    expect(await Promise.all(names.map(name => readFile(join(source, name), 'utf8')))).toEqual(before)
  })
})
