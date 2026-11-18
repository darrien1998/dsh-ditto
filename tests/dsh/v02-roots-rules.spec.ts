import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { DshDitto } from '../../src/dsh/index.js'
import { resolveConfig } from '../../src/dsh/config.js'
import { atomicWriteStateText, readStateText, stateCategoryPath } from '../../src/core/state-paths.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(NativeExecutor, {})
  return ctx
}

let callNumber = 0
async function call(ctx: Context, name: string, arguments_: unknown) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `v02-${++callNumber}` as never, name, arguments: JSON.stringify(arguments_) }], signal: new AbortController().signal })
  return batch.results[0]!.result
}

function value(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, unknown>
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root
}

const PRODUCT_NAME = '\u5546\u54c1\u7c21\u4ecb' // product leaflet

/** Insurance DM files shaped `CODE_name.pdf`, optionally plus one unmatched file. */
async function insuranceFixture(source: string, count = 30, includeReadme = true): Promise<void> {
  await mkdir(source, { recursive: true })
  for (let index = 1; index <= count; index++) {
    const code = count > 99 ? `PX${String(index).padStart(4, '0')}` : `AB${String(index).padStart(2, '0')}`
    await writeFile(join(source, `${code}_${PRODUCT_NAME}.pdf`), `%PDF-1.4 ${code}`, 'utf8')
  }
  if (includeReadme) await writeFile(join(source, 'README.txt'), 'not a product document', 'utf8')
}

/** The Windows 8.3 short name `dir /x` reports for one child, or undefined when the volume has none. */
function shortNameOf(parent: string, name: string): string | undefined {
  try {
    for (const line of execFileSync('cmd', ['/c', 'dir', '/x', parent], { encoding: 'utf8' }).split('\n')) {
      const parts = line.trim().split(/\s+/)
      const index = parts.indexOf(name)
      if (index > 0) return parts[index - 1]
    }
  } catch { /* 8.3 names are optional; leave the caller to skip */ }
  return undefined
}

function zipEntryNames(archive: Buffer): string[] {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const end = archive.lastIndexOf(signature)
  if (end < 0) throw new Error('ZIP end-of-central-directory record is missing')
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const names: string[] = []
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central-directory entry')
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

describe('authorised external roots', () => {
  it('reads an external source and writes an external destination when both roles are allowlisted', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const externalSource = await temp('dsh-ditto-ext-src-')
    const externalDestination = await temp('dsh-ditto-ext-dst-')
    await mkdir(join(externalSource, 'inbox'))
    await writeFile(join(externalSource, 'inbox', 'note.txt'), 'external', 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, {
      workspaceRoot: workspace,
      stateRoot: join(workspace, '.dsh-ditto'),
      approval: 'agent',
      allowedSourceRoots: [externalSource],
      allowedDestinationRoots: [externalDestination],
      resultItems: 20,
    })

    const preview = value(await call(ctx, 'ditto_preview', {
      source_root: join(externalSource, 'inbox'),
      destination_root: join(externalDestination, 'PRO', 'PRO_FILES'),
      pattern: '{stem}',
      classification: 'none',
    }))
    const plan = preview.plan as { id: string; revision: number; digest: string }
    expect(preview.page).toMatchObject({ total: 1 })

    const applied = value(await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest }))
    expect((applied.result as { approval: string }).approval).toBe('agent')
    expect(await readFile(join(externalDestination, 'PRO', 'PRO_FILES', 'note.txt'), 'utf8')).toBe('external')
    expect(await readFile(join(externalSource, 'inbox', 'note.txt'), 'utf8')).toBe('external')
    await ctx.fiber.dispose()
  })

  it('refuses sibling roots, wrong roles, and a relative path that tries to leave the workspace', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const externalSource = await temp('dsh-ditto-ext-src-')
    const externalDestination = await temp('dsh-ditto-ext-dst-')
    const outsider = await temp('dsh-ditto-outsider-')
    await mkdir(join(externalSource, 'inbox'))
    await writeFile(join(externalSource, 'inbox', 'note.txt'), 'x', 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, {
      workspaceRoot: workspace,
      stateRoot: join(workspace, '.dsh-ditto'),
      approval: 'agent',
      allowedSourceRoots: [externalSource],
      allowedDestinationRoots: [externalDestination],
    })

    expect((await call(ctx, 'ditto_preview', { source_root: join(outsider, 'inbox'), destination_root: join(externalDestination, 'out') })).isError).toBe(true)
    expect((await call(ctx, 'ditto_preview', { source_root: externalDestination, destination_root: join(externalDestination, 'out') })).isError).toBe(true)
    expect((await call(ctx, 'ditto_preview', { source_root: join('..', 'inbox'), destination_root: 'out' })).isError).toBe(true)
    expect((await call(ctx, 'ditto_preview', { source_root: join(externalSource, 'inbox'), destination_root: join(externalSource, 'inbox', 'nested') })).isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('keeps Code-to-Spec inside the workspace even when file allowlists point outside', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const external = await temp('dsh-ditto-ext-')
    await mkdir(join(external, 'repo'))
    for (let index = 1; index <= 6; index++) await writeFile(join(external, 'repo', `m${index}.ts`), `export const m${index} = ${index}\n`, 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, {
      workspaceRoot: workspace,
      stateRoot: join(workspace, '.dsh-ditto'),
      allowedSourceRoots: [external],
      allowedDestinationRoots: [external],
    })

    expect((await call(ctx, 'ditto_spec_create', { source_root: join(external, 'repo'), output_root: join(external, 'specs') })).isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rejects a persisted plan whose roots are no longer authorised', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const externalSource = await temp('dsh-ditto-ext-src-')
    const externalDestination = await temp('dsh-ditto-ext-dst-')
    await mkdir(join(externalSource, 'inbox'))
    await writeFile(join(externalSource, 'inbox', 'note.txt'), 'x', 'utf8')

    const ctx = await host()
    const fiber = await ctx.plugin(DshDitto, {
      workspaceRoot: workspace,
      stateRoot: join(workspace, '.dsh-ditto'),
      approval: 'agent',
      allowedSourceRoots: [externalSource],
      allowedDestinationRoots: [externalDestination],
    })
    const preview = value(await call(ctx, 'ditto_preview', { source_root: join(externalSource, 'inbox'), destination_root: join(externalDestination, 'out') }))
    const plan = preview.plan as { id: string }
    await fiber.dispose()

    const narrowed = await host()
    await narrowed.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent' })
    expect((await call(narrowed, 'ditto_status', { plan_id: plan.id })).isError).toBe(true)
    expect((await call(narrowed, 'ditto_apply', { plan_id: plan.id, revision: 1, digest: 'x' })).isError).toBe(true)
    await narrowed.fiber.dispose()
  })

  it('rejects a linked destination ancestor that appears after review', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const outside = await temp('dsh-ditto-outside-')
    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent' })
    await mkdir(join(workspace, 'source'))
    await writeFile(join(workspace, 'source', 'note.txt'), 'x', 'utf8')
    const link = join(workspace, 'link')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await call(ctx, 'ditto_preview', { source_root: join(workspace, 'source'), destination_root: join(link, 'out') })
    expect(result.isError).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe('ditto_revise_rule', () => {
  it('captures a code and builds nested destinations with zero per-item edits', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'ftp-backup')
    await insuranceFixture(source)

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent', resultItems: 50 })

    const preview = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(workspace, 'PRO'), classification: 'none', max_items: 100 }))
    const first = preview.plan as { id: string; revision: number; digest: string }
    expect(preview.page).toMatchObject({ total: 31 })

    const revised = value(await call(ctx, 'ditto_revise_rule', {
      plan_id: first.id, revision: first.revision,
      match_regex: '^(?<code>[^_]+)_.*\\.pdf$',
      match_scope: 'basename',
      pattern: 'PRO_FILES/{match.code}/{match.code}{ext}',
    }))
    const plan = revised.plan as { revision: number; digest: string; diagnostics: { ready: number; exceptions: number; exceptionsByReason: Record<string, number> } }
    expect(plan.revision).toBe(2)
    expect(plan.digest).not.toBe(first.digest)
    expect(plan.diagnostics.ready).toBe(30)
    expect(plan.diagnostics.exceptions).toBe(1)
    expect(plan.diagnostics.exceptionsByReason.unmatched).toBe(1)

    const destinations = (revised.items as Array<{ relativePath: string; destination: string; proposalDisposition: string }>)
    const pdf = destinations.find(item => item.relativePath === `AB01_${PRODUCT_NAME}.pdf`)!
    expect(pdf.destination.replace(/\\/g, '/')).toBe('PRO_FILES/AB01/AB01.pdf')
    expect(pdf.proposalDisposition).toBe('ready')
    expect(destinations.find(item => item.relativePath === 'README.txt')).toMatchObject({ proposalDisposition: 'exception', exceptionCode: 'unmatched' })

    const applied = value(await call(ctx, 'ditto_apply', { plan_id: first.id, revision: plan.revision, digest: plan.digest }))
    expect((applied.result as { summary: { applied: number; exception: number } }).summary).toMatchObject({ applied: 30, exception: 1 })
    expect(await readFile(join(workspace, 'PRO', 'PRO_FILES', 'AB07', 'AB07.pdf'), 'utf8')).toBe('%PDF-1.4 AB07')
    await expect(readFile(join(workspace, 'PRO', 'PRO_FILES', 'README.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.fiber.dispose()
  }, 30_000)

  it('rejects unsafe captures, stale revisions, and post-apply rule edits', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'inbox')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'nested', 'AB01_a.pdf'), 'x', 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent' })
    const preview = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(workspace, 'out') }))
    const plan = preview.plan as { id: string; revision: number; digest: string }

    const injected = value(await call(ctx, 'ditto_revise_rule', {
      plan_id: plan.id, revision: plan.revision,
      match_regex: '^(?<code>.+)\\.pdf$',
      match_scope: 'relative-path',
      pattern: '{match.code}/x.pdf',
    }))
    expect((injected.items as Array<{ proposalDisposition: string; exceptionCode?: string }>)[0]).toMatchObject({ proposalDisposition: 'exception', exceptionCode: 'unsafe-capture' })

    const current = (injected.plan as { revision: number }).revision
    // A template that names another extension keeps the source extension, exactly like the frozen v1 append rule.
    const appended = value(await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: current, pattern: '{stem}.md' }))
    expect((appended.items as Array<{ destination: string }>)[0]!.destination.replace(/\\/g, '/').endsWith('/AB01_a.md.pdf')).toBe(true)

    // ReDoS-shaped and unsupported patterns are refused by the linear-time grammar.
    for (const regex of ['^(a+)+$', '^(a|aa)+$', '^a\\1$', '^(?=a)a$']) {
      expect((await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: current, match_regex: regex })).isError).toBe(true)
    }
    // A stale revision is refused.
    expect((await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: current + 99, pattern: '{stem}' })).isError).toBe(true)

    const readyRevision = (appended.plan as { revision: number }).revision
    const ready = value(await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: readyRevision, match_regex: null, pattern: '{stem}', classification: 'none' }))
    expect((ready.plan as { diagnostics: { exceptions: number; ready: number } }).diagnostics).toMatchObject({ exceptions: 0, ready: 1 })

    const final = (value(await call(ctx, 'ditto_status', { plan_id: plan.id })).plan) as { revision: number; digest: string }
    value(await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: final.revision, digest: final.digest }))
    expect((await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: final.revision, pattern: '{stem}' })).isError).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe('reviewed sidecars and the archive', () => {
  const sidecars = [
    { kind: 'manifest', destination: 'REVIEW.csv', format: 'csv' },
    { kind: 'checksums', destination: 'SHA256SUMS.txt' },
    {
      kind: 'sql-insert',
      destination: 'INIT_PRO_FILES.sql',
      sql: {
        dialect: 'sqlserver',
        schema: 'dbo',
        table: 'PRO_FILES',
        columns: ['BANK_PRO_CODE', 'FILE_TYPE', 'FILE_PATH'],
        values: { BANK_PRO_CODE: '{match.code}', FILE_TYPE: 'G', FILE_PATH: 'PRO_FILES/{match.code}/{match.code}{ext}' },
      },
    },
  ]

  it('accepts sidecars and an archive directly in the first preview', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'inbox')
    await mkdir(source)
    await writeFile(join(source, 'one.txt'), 'one', 'utf8')
    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent' })
    const preview = value(await call(ctx, 'ditto_preview', {
      source_root: source, destination_root: join(workspace, 'out'),
      sidecars: [{ kind: 'checksums', destination: 'SHA256SUMS.txt' }],
      archive: { kind: 'zip', destination: 'bundle.zip' },
    }))
    const plan = preview.plan as { id: string; revision: number; digest: string; artifacts: unknown[]; archive: { status: string } }
    expect(plan.artifacts).toHaveLength(1)
    expect(plan.archive.status).toBe('ready')
    const applied = value(await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest }))
    expect((applied.result as { deliverables: { archive?: string } }).deliverables.archive).toBe('bundle.zip')
    expect((applied.plan as { archive: { status: string } }).archive.status).toBe('applied')
    expect(zipEntryNames(await readFile(join(workspace, 'out', 'bundle.zip')))).toEqual(['SHA256SUMS.txt', 'text/one.txt'])
    await ctx.fiber.dispose()
  }, 30_000)

  it('renders, reviews, and writes deterministic sidecars plus an archive of exactly the reviewed outputs', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'ftp-backup')
    await insuranceFixture(source)
    // A formula-looking name must not become an active spreadsheet cell.
    await writeFile(join(source, '=cmd_report.pdf'), 'x', 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent', resultItems: 50 })
    const output = join(workspace, 'PRO')

    const preview = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: output, classification: 'none', max_items: 100 }))
    const plan = preview.plan as { id: string; revision: number }

    const revised = value(await call(ctx, 'ditto_revise_rule', {
      plan_id: plan.id, revision: plan.revision,
      match_regex: '^(?<code>[^_]+)_.*\\.pdf$', match_scope: 'basename', match_flags: 'u',
      pattern: 'PRO_FILES/{match.code}/{match.code}{ext}',
      sidecars,
      archive: { kind: 'zip', destination: 'bundle.zip' },
    }))
    const identity = revised.plan as { revision: number; digest: string; diagnostics: { ready: number; exceptions: number; artifactCount: number } }
    expect(identity.diagnostics).toMatchObject({ ready: 31, exceptions: 1, artifactCount: 3 })

    const artifacts = (revised.plan as unknown as { artifacts: Array<{ id: string; kind: string; destination: string }> }).artifacts
    const sql = artifacts.find(artifact => artifact.kind === 'sql-insert')!
    const manifestArtifact = artifacts.find(artifact => artifact.kind === 'manifest')!

    expect((await call(ctx, 'ditto_artifact_review', { plan_id: plan.id, revision: identity.revision, digest: 'stale', artifact_id: sql.id })).isError).toBe(true)
    const reviewed = value(await call(ctx, 'ditto_artifact_review', { plan_id: plan.id, revision: identity.revision, digest: identity.digest, artifact_id: sql.id, limit: 8000 }))
    const sqlText = reviewed.content as string
    expect(sqlText).toContain("INSERT INTO [dbo].[PRO_FILES] ([BANK_PRO_CODE], [FILE_TYPE], [FILE_PATH]) VALUES (N'AB01', N'G', N'PRO_FILES/AB01/AB01.pdf');")
    // Exactly one statement per reviewed file, and no comment, batch separator, or raw expression.
    expect(sqlText.trim().split('\n')).toHaveLength(31)
    expect(sqlText).not.toMatch(/--|\/\*|;.*;/)

    const csv = value(await call(ctx, 'ditto_artifact_review', { plan_id: plan.id, revision: identity.revision, digest: identity.digest, artifact_id: manifestArtifact.id, limit: 8000 })).content as string
    expect(csv.split('\n')[0]).toBe('source,destination,sha256,classification,disposition,status,exception_code,exception_details')
    const formulaRow = csv.split('\n').find(line => line.includes('=cmd_report'))!
    expect(formulaRow.startsWith('"\'=cmd_report.pdf"')).toBe(true)
    const exceptionRow = csv.split('\n').find(line => line.includes('README.txt'))!
    expect(exceptionRow).toContain('"exception","exception","unmatched"')

    const exported = value(await call(ctx, 'ditto_manifest', { plan_id: plan.id, revision: identity.revision, digest: identity.digest, format: 'json' }))
    expect(exported.rows).toBe(32)
    expect(String(exported.path)).toContain('.dsh-ditto')

    value(await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: identity.revision, digest: identity.digest }))
    const final = value(await call(ctx, 'ditto_status', { plan_id: plan.id }))
    expect((final.plan as { summary: { applied: number; exception: number } }).summary).toMatchObject({ applied: 31, exception: 1 })

    expect(await readFile(join(output, 'PRO_FILES', 'AB12', 'AB12.pdf'), 'utf8')).toBe('%PDF-1.4 AB12')
    expect(await readFile(join(output, 'INIT_PRO_FILES.sql'), 'utf8')).toBe(sqlText)
    const archive = await readFile(join(output, 'bundle.zip'))
    expect(archive.readUInt32LE(0)).toBe(0x04034b50)
    const entries = zipEntryNames(archive)
    expect(entries).toHaveLength(34)
    expect(entries).toContain('PRO_FILES/AB01/AB01.pdf')
    expect(entries).toContain('INIT_PRO_FILES.sql')
    expect(entries).not.toContain('bundle.zip')
    await ctx.fiber.dispose()
  }, 30_000)

  it('organises a 174-file insurance batch with zero per-item edits and complete deliverables', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'ftp-backup')
    const output = join(workspace, 'delivery')
    await insuranceFixture(source, 174, false)
    const before = new Map<string, Buffer>()
    for (let index = 1; index <= 174; index++) {
      const code = `PX${String(index).padStart(4, '0')}`
      before.set(code, await readFile(join(source, `${code}_${PRODUCT_NAME}.pdf`)))
    }

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent', maxItems: 200, resultItems: 25 })
    const preview = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: output, classification: 'none', max_items: 200 }))
    expect(preview.page).toMatchObject({ total: 174, returned: 25, nextOffset: 25 })
    const initial = preview.plan as { id: string; revision: number }
    const revised = value(await call(ctx, 'ditto_revise_rule', {
      plan_id: initial.id, revision: initial.revision,
      match_regex: '^(?<code>[^_]+)_.*\\.pdf$', match_scope: 'basename', match_flags: 'u',
      pattern: 'PRO_FILES/{match.code}/{match.code}{ext}',
      sidecars,
      archive: { kind: 'zip', destination: 'insurance-delivery.zip' },
    }))
    const plan = revised.plan as { revision: number; digest: string; diagnostics: { ready: number; exceptions: number } }
    expect(plan.diagnostics).toMatchObject({ ready: 174, exceptions: 0 })

    const exported = value(await call(ctx, 'ditto_manifest', { plan_id: initial.id, revision: plan.revision, digest: plan.digest, format: 'json' }))
    const manifest = JSON.parse(await readFile(String(exported.path), 'utf8')) as { items: unknown[] }
    expect(manifest.items).toHaveLength(174)

    value(await call(ctx, 'ditto_apply', { plan_id: initial.id, revision: plan.revision, digest: plan.digest }))
    const sql = await readFile(join(output, 'INIT_PRO_FILES.sql'), 'utf8')
    expect(sql.trim().split('\n')).toHaveLength(174)
    expect(sql).toContain("N'PX0174'")
    for (let index = 1; index <= 174; index++) {
      const code = `PX${String(index).padStart(4, '0')}`
      expect(await readFile(join(output, 'PRO_FILES', code, `${code}.pdf`))).toEqual(before.get(code))
      expect(await readFile(join(source, `${code}_${PRODUCT_NAME}.pdf`))).toEqual(before.get(code))
    }
    const entries = zipEntryNames(await readFile(join(output, 'insurance-delivery.zip')))
    const expected = [
      'INIT_PRO_FILES.sql', 'REVIEW.csv', 'SHA256SUMS.txt',
      ...Array.from({ length: 174 }, (_, index) => {
        const code = `PX${String(index + 1).padStart(4, '0')}`
        return `PRO_FILES/${code}/${code}.pdf`
      }),
    ].sort()
    expect(entries).toEqual(expected)
    await ctx.fiber.dispose()
  }, 120_000)

  it('keeps unreviewed files out of the archive and refuses sidecar collisions', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const source = join(workspace, 'inbox')
    await mkdir(source)
    await writeFile(join(source, 'AB01_a.pdf'), 'x', 'utf8')
    const output = join(workspace, 'out')

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: workspace, stateRoot: join(workspace, '.dsh-ditto'), approval: 'agent' })
    const preview = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: output }))
    const plan = preview.plan as { id: string; revision: number }

    // A sidecar may not overwrite a reviewed file destination.
    expect((await call(ctx, 'ditto_revise_rule', {
      plan_id: plan.id, revision: plan.revision, pattern: '{stem}',
      sidecars: [{ kind: 'checksums', destination: 'documents/AB01_a.pdf' }],
    })).isError).toBe(true)
    // Two sidecars may not share one path.
    expect((await call(ctx, 'ditto_revise_rule', {
      plan_id: plan.id, revision: plan.revision, pattern: '{stem}',
      sidecars: [{ kind: 'checksums', destination: 'A.txt' }, { kind: 'checksums', destination: 'a.txt' }],
    })).isError).toBe(true)
    // Raw SQL, an unsupported dialect, and a mismatched column list are refused.
    for (const bad of [
      { kind: 'sql-insert', destination: 'X.sql', sql: { dialect: 'mysql', schema: 'dbo', table: 'T', columns: ['A'], values: { A: 'x' } } },
      { kind: 'sql-insert', destination: 'X.sql', sql: { dialect: 'sqlserver', schema: 'dbo', table: 'T;DROP', columns: ['A'], values: { A: 'x' } } },
      { kind: 'sql-insert', destination: 'X.sql', sql: { dialect: 'sqlserver', schema: 'dbo', table: 'T', columns: ['A'], values: { B: 'x' } } },
    ]) expect((await call(ctx, 'ditto_revise_rule', { plan_id: plan.id, revision: plan.revision, pattern: '{stem}', sidecars: [bad] })).isError).toBe(true)

    // Reviewed nested destinations keep their forward slashes on every platform.
    const revised = value(await call(ctx, 'ditto_revise_rule', {
      plan_id: plan.id, revision: plan.revision, pattern: '{stem}',
      sidecars: [{ kind: 'checksums', destination: 'review/SHA256SUMS.txt' }],
      archive: { kind: 'zip', destination: 'delivery/bundle.zip' },
    }))
    const identity = revised.plan as { revision: number; digest: string }
    const artifactId = (revised.plan as unknown as { artifacts: Array<{ id: string }> }).artifacts[0]!.id
    expect((revised.plan as unknown as { artifacts: Array<{ destination: string }> }).artifacts[0]!.destination.replace(/\\/g, '/')).toBe('review/SHA256SUMS.txt')
    const review = value(await call(ctx, 'ditto_artifact_review', { plan_id: plan.id, revision: identity.revision, digest: identity.digest, artifact_id: artifactId }))
    expect((review.page as { total: number }).total).toBeGreaterThan(0)

    // An unrelated file that appears in the output folder before apply must not enter the archive.
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'unreviewed-secret.txt'), 'not reviewed', 'utf8')
    value(await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: identity.revision, digest: identity.digest }))
    const archive = await readFile(join(output, 'delivery', 'bundle.zip'))
    expect(archive.includes(Buffer.from('unreviewed-secret.txt'))).toBe(false)
    expect(zipEntryNames(archive)).toEqual(['documents/AB01_a.pdf', 'review/SHA256SUMS.txt'].sort())
    await ctx.fiber.dispose()
  })
})

describe('durable state link safety', () => {
  it('never writes metadata through a linked state category', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const outside = await temp('dsh-ditto-outside-')
    const state = join(workspace, '.dsh-ditto')
    await mkdir(state)
    await atomicWriteStateText(state, 'plans', 'seed.json', '{}')
    await rm(join(state, 'plans'), { recursive: true, force: true })
    await symlink(outside, join(state, 'plans'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(stateCategoryPath(state, 'plans', true)).rejects.toThrow()
    await expect(atomicWriteStateText(state, 'plans', 'evil.json', '{}')).rejects.toThrow()
    await expect(readStateText(state, 'plans', 'evil.json')).rejects.toThrow()
  })

  it('accepts a stateRoot addressed through a Windows 8.3 short name', async () => {
    if (process.platform !== 'win32') return
    const parent = tmpdir()
    const longName = 'ditto-shortname-regression-root'
    const longRoot = join(parent, longName)
    await mkdir(longRoot, { recursive: true })
    const short = shortNameOf(parent, longName)
    // Volumes with 8.3 name generation disabled have nothing to test here.
    if (!short || short === longName) return
    const state = join(parent, short, '.dsh-ditto')
    // realpath expands the short component, so every state comparison must be
    // canonical on both sides or a legitimate temp path looks like an escape.
    const category = await stateCategoryPath(state, 'plans', true)
    await atomicWriteStateText(state, 'plans', 'short.json', '{"ok":true}\n')
    expect(await readStateText(state, 'plans', 'short.json')).toBe('{"ok":true}\n')
    expect(category.toLowerCase()).toContain(longName.toLowerCase())
  })

  it('rejects a stateRoot that is itself a link', async () => {
    const workspace = await temp('dsh-ditto-ws-')
    const outside = await temp('dsh-ditto-outside-')
    const linked = join(workspace, '.dsh-ditto')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveConfig({ workspaceRoot: workspace, stateRoot: linked })).toThrow()
  })
})
