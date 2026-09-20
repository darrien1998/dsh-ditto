import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEMO_MODULES, runHeadlessDemo } from '../../src/demo.js'
import { renderDoctorReport, runDoctor } from '../../src/doctor.js'
import { TOOL_NAMES } from '../../src/dsh/catalog.js'
import { dittoVersion } from '../../src/compat.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('headless demo', () => {
  it('discovers 16 modules, flags exactly one module for confirmation, writes 16 specs, and leaves the sources untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-demo-')); roots.push(root)
    const lines: string[] = []
    const result = await runHeadlessDemo(root, line => lines.push(line))
    expect(result.batch.discovery.inScope).toBe(DEMO_MODULES.length)
    expect(result.batch.discovery.excludedTotal).toBe(3)
    expect(result.written).toBe(16)
    expect(result.needsConfirmation).toEqual(['src/routes/webhooks.ts'])
    expect(result.sourceHashesUnchanged).toBe(true)
    expect(lines.join('\n')).toContain('16/16 written · 0 failed · 0 source files modified')
    const written = await readdir(join(root, 'specifications', 'src', 'routes'))
    expect(written.sort()).toEqual(['orders.md', 'users.md', 'webhooks.md'])
    const webhooks = await readFile(join(root, 'specifications', 'src', 'routes', 'webhooks.md'), 'utf8')
    expect(webhooks).toContain('## Needs confirmation')
    expect(webhooks).toMatch(/\[ev_[a-f0-9]{24}\]/)
    for (const [relativePath, source] of DEMO_MODULES) expect(createHash('sha256').update(await readFile(join(root, 'source', ...relativePath.split('/')))).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'))
  })

  it('is exposed through the CLI with a machine-checkable exit code', () => {
    const result = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'demo', '--headless'], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1. Discover')
    expect(result.stdout).toContain('6. Apply')
    const version = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', '--version'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
    expect(version.stdout.trim()).toBe(dittoVersion())
    // Two real Node/tsx process spawns; a loaded or virus-scanning machine needs room.
  }, 60_000)

  it('validates explicit UI locales and lists the supported values', () => {
    for (const args of [['help', '--lang'], ['help', '--lang', 'fr-FR']]) {
      const result = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Supported locales: en, zh-TW')
    }
    for (const lang of ['en', 'zh-TW']) {
      const result = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'help', '--lang', lang], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
      expect(result.status).toBe(0)
    }
  })
})

describe('doctor', () => {
  it('reports plain-language checks and mounts the plugin in-process', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-ditto-doctor-ws-')); roots.push(workspace)
    const home = await mkdtemp(join(tmpdir(), 'dsh-ditto-doctor-home-')); roots.push(home)
    const report = await runDoctor({ profile: 'web', workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
    const labels = report.checks.map(check => check.label)
    expect(labels[0]).toBe(`Ditto ${dittoVersion()}`)
    expect(labels).toContainEqual(expect.stringContaining('Node.js'))
    expect(labels).toContainEqual(`${TOOL_NAMES.length} of ${TOOL_NAMES.length} tools registered`)
    expect(labels).toContainEqual('skill "ditto" registered')
    expect(report.checks.find(check => check.label.includes('profile "web" is not initialised'))).toMatchObject({ status: 'warn' })
    expect(report.checks.find(check => check.label.startsWith('stateRoot'))).toMatchObject({ status: 'ok' })
    expect(report.checks.find(check => check.label.startsWith('allowedSourceRoots'))).toMatchObject({ status: 'ok' })
    expect(report.checks.find(check => check.label.startsWith('approvalUnavailable'))).toMatchObject({ status: 'ok' })
    expect(report.ok).toBe(true)
    const text = renderDoctorReport(report)
    expect(text).toContain(`✓ ${TOOL_NAMES.length} of ${TOOL_NAMES.length} tools registered`)
    expect(text).toContain('Ditto looks healthy.')
  }, 15_000)

  it('warns when an external root or the agent approval fallback widens the boundary', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-ditto-doctor-ws-')); roots.push(workspace)
    const home = await mkdtemp(join(tmpdir(), 'dsh-ditto-doctor-home-')); roots.push(home)
    const report = await runDoctor({ workspaceRoot: workspace, skipMount: true, allowedDestinationRoots: [join(tmpdir(), 'elsewhere')], approvalUnavailable: 'agent', env: { ...process.env, DSH_HOME: home } })
    expect(report.checks.find(check => check.label.startsWith('allowedDestinationRoots'))).toMatchObject({ status: 'warn' })
    expect(report.checks.find(check => check.label.startsWith('approvalUnavailable'))).toMatchObject({ status: 'warn' })
    expect(report.ok).toBe(true)
  })

  it('fails when the workspace does not exist', async () => {
    const report = await runDoctor({ workspaceRoot: join(tmpdir(), 'dsh-ditto-missing-' + Date.now()), skipMount: true, env: { ...process.env, DSH_HOME: join(tmpdir(), 'dsh-ditto-no-home') } })
    expect(report.ok).toBe(false)
    expect(renderDoctorReport(report)).toContain('✗ workspaceRoot')
  })
})
