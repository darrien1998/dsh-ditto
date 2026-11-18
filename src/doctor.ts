import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { COMPATIBILITY, dittoVersion, dshSupportLevel, isSupportedNodeVersion } from './compat.js'
import { TOOL_NAMES } from './dsh/catalog.js'
import { resolveConfig } from './dsh/config.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface DoctorCheck { status: CheckStatus; label: string; detail?: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }

export interface DoctorOptions {
  /** DSH profile to inspect. Default: `web`. */
  profile?: string
  /** Mirrors the plugin's `workspaceRoot` config. Default: the current directory. */
  workspaceRoot?: string
  /** Mirrors the plugin's `stateRoot` config. Default: `.dsh-ditto` under the workspace. */
  stateRoot?: string
  /** Mirrors the plugin's `allowedSourceRoots` config. Default: the workspace. */
  allowedSourceRoots?: string[]
  /** Mirrors the plugin's `allowedDestinationRoots` config. Default: the workspace. */
  allowedDestinationRoots?: string[]
  /** Mirrors the plugin's `approvalUnavailable` config. Default: `deny`. */
  approvalUnavailable?: 'deny' | 'agent'
  /** Environment to read DSH_HOME from. */
  env?: NodeJS.ProcessEnv
  /** Skip the in-process plugin mount (used by tests that already cover it). */
  skipMount?: boolean
  /** Do not launch CLI subprocesses (used by the native diagnostic tool). */
  skipCommands?: boolean
}

/**
 * Plain-language diagnostics for an installed Ditto. Read-only except for one
 * temporary probe file that proves the state folder is writable.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env
  const checks: DoctorCheck[] = []
  const add = (status: CheckStatus, label: string, detail?: string) => { checks.push({ status, label, ...(detail ? { detail } : {}) }) }

  add('ok', `Ditto ${dittoVersion()}`)

  if (isSupportedNodeVersion(process.versions.node)) add('ok', `Node.js ${process.versions.node}`)
  else add('fail', `Node.js ${process.versions.node} is too old`, `Ditto needs Node.js ${COMPATIBILITY.node.minimumVersion} or later.`)

  if (!options.skipCommands) {
    const dsh = commandVersion('dsh')
    if (dsh) add(dshSupportLevel(dsh) === 'supported' ? 'ok' : 'warn', `dsh ${dsh} detected`, dshSupportLevel(dsh) === 'supported' ? undefined : `Ditto ${dittoVersion()} is tested against DSH ${COMPATIBILITY.dsh.supported.join(', ')}; ${dsh} is ${dshSupportLevel(dsh)}.`)
    else add('warn', 'dsh command not found on PATH', `Install DeepSeek Harness first: npm install -g @deepseek-ai/dsh@${COMPATIBILITY.dsh.supported[0]}`)

    const pnpm = commandVersion('pnpm')
    if (pnpm) add('ok', `pnpm ${pnpm} detected (used by "dsh plugin")`)
    else add('warn', 'pnpm not found on PATH', '"dsh plugin --profile <name> add dsh-ditto" forwards to pnpm; install pnpm to manage profile plugins.')
  }

  const home = env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
  // `dsh plugin --profile <name> exec dsh-ditto doctor` runs inside the profile directory, so detect the profile from there.
  const profile = options.profile ?? profileFromCwd(home) ?? 'web'
  if (!profile.trim() || profile === '.' || profile === '..' || profile.toLowerCase() === 'node_modules' || /[\\/<>:"|?*\u0000-\u001f]/.test(profile)) {
    add('fail', 'Invalid DSH profile name', 'Use one folder name without path separators, traversal, control characters, or reserved filename characters.')
    return { ok: false, checks }
  }
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) add('warn', `DSH profile "${profile}" is not initialised at ${profileDir}`, `Run: dsh plugin --profile ${profile} add dsh-ditto`)
  else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      const dependency = manifest.dependencies?.['dsh-ditto']
      const bundled = manifest.dsh?.profile?.bundles?.includes('dsh-ditto') ?? false
      if (dependency && bundled) add('ok', `dsh-ditto is installed in profile "${profile}" and listed in its bundles`)
      else if (dependency) add('fail', `dsh-ditto is a dependency of profile "${profile}" but not in dsh.profile.bundles`, 'Re-run "dsh plugin --profile ' + profile + ' install" so dsh reconciles the bundle list.')
      else add('warn', `dsh-ditto is not installed in profile "${profile}"`, `Run: dsh plugin --profile ${profile} add dsh-ditto`)
      const installed = join(profileDir, 'node_modules', 'dsh-ditto', 'package.json')
      if (existsSync(installed)) {
        const version = (JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }).version ?? 'unknown'
        add(version === dittoVersion() ? 'ok' : 'warn', `profile "${profile}" has dsh-ditto ${version}`, version === dittoVersion() ? undefined : `This doctor is dsh-ditto ${dittoVersion()}. Update the profile with: dsh plugin --profile ${profile} update dsh-ditto`)
      }
    } catch (error) { add('fail', `Cannot read ${manifestPath}`, message(error)) }
  }

  const peers = peerVersions()
  for (const [name, version] of Object.entries(peers)) {
    if (!version) { add('warn', `${name} is not resolvable from here`, 'Ask the DSH agent to run ditto_doctor inside the active profile to inspect runtime registrations.'); continue }
    const level = name === '@deepseek-ai/cordis' ? (/^4\.1\.\d+$/.test(version) ? 'supported' : 'untested') : dshSupportLevel(version)
    add(level === 'supported' ? 'ok' : 'warn', `${name} ${version}`, level === 'supported' ? undefined : `${level} DSH version; tested versions: ${COMPATIBILITY.dsh.supported.join(', ')}`)
  }

  if (!options.skipMount) {
    if (Object.values(peers).some(version => !version)) {
      add('warn', 'Component mount unavailable in this standalone CLI', 'DSH 0.2 resolves host packages inside the plugin runtime. Ask the DSH agent to run ditto_doctor to verify the active registrations; booting the profile does not link these packages for standalone CLIs.')
    } else {
      const mount = await mountProbe()
      if (mount.error) add('fail', 'Ditto plugin could not be mounted on the DSH component host', mount.error)
      else {
        add(mount.tools === TOOL_NAMES.length ? 'ok' : 'fail', `${mount.tools} of ${TOOL_NAMES.length} tools registered`)
        add(mount.skill ? 'ok' : 'fail', mount.skill ? 'skill "ditto" registered' : 'skill "ditto" missing')
      }
    }
  }

  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
  if (existsSync(workspaceRoot) && statSync(workspaceRoot).isDirectory()) add('ok', `workspaceRoot ${workspaceRoot}`, options.workspaceRoot ? undefined : 'Inside DSH, workspaceRoot defaults to the folder you start dsh from; pass --workspace-root to check another folder.')
  else add('fail', `workspaceRoot ${workspaceRoot} is not a directory`)

  const stateRoot = resolve(workspaceRoot, options.stateRoot ?? '.dsh-ditto')
  try {
    resolveConfig({ workspaceRoot, stateRoot, allowedSourceRoots: options.allowedSourceRoots, allowedDestinationRoots: options.allowedDestinationRoots, approvalUnavailable: options.approvalUnavailable })
    const writable = await probeWritable(stateRoot)
    if (writable.ok) add('ok', `stateRoot ${stateRoot} is writable${existsSync(stateRoot) ? '' : ' (will be created on first use)'}`)
    else add('fail', `stateRoot ${stateRoot} is not writable`, writable.error)
  } catch (error) { add('fail', 'Invalid Ditto folder configuration', message(error)) }

  // File organisation may read/write outside the workspace only through these
  // profile-owned allowlists. Code-to-Spec always stays inside workspaceRoot.
  for (const [role, roots] of [['source', options.allowedSourceRoots], ['destination', options.allowedDestinationRoots]] as const) {
    const list = roots && roots.length > 0 ? roots.map(root => resolve(workspaceRoot, root)) : [workspaceRoot]
    const external = list.filter(root => !isInside(workspaceRoot, root))
    add(external.length > 0 ? 'warn' : 'ok', `allowed${role === 'source' ? 'Source' : 'Destination'}Roots ${list.join(', ')}`,
      external.length > 0 ? `External ${role} folders are authorised for batch file organisation only. Confirm each one is intended: ${external.join(', ')}` : undefined)
  }

  const unavailable = options.approvalUnavailable ?? 'deny'
  add(unavailable === 'agent' ? 'warn' : 'ok', `approvalUnavailable ${unavailable}`,
    unavailable === 'agent'
      ? 'A host approval outcome of "unavailable" (for example approval policy "never") will fall back to the agent\'s own conversational approval. This is not proof of human approval; switch to "deny" to keep writes fail-closed.'
      : 'When the host cannot ask (approval policy "never", no answerer), batch writes are denied. Set approvalUnavailable: agent to rely on the agent\'s conversational approval instead.')

  return { ok: checks.every(check => check.status !== 'fail'), checks }
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export function renderDoctorReport(report: DoctorReport): string {
  const marks: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' }
  const lines = report.checks.map(check => `${marks[check.status]} ${check.label}${check.detail ? `\n    ${check.detail}` : ''}`)
  lines.push('', report.ok ? 'Ditto looks healthy.' : 'Ditto is not ready. Fix the ✗ items above.')
  return lines.join('\n')
}

function commandVersion(command: string): string | undefined {
  try {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 15_000 })
    if (result.status !== 0) return undefined
    const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(`${result.stdout}\n${result.stderr}`)
    return match?.[0]
  } catch { return undefined }
}

function peerVersions(): Record<string, string | undefined> {
  const require = createRequire(import.meta.url)
  const read = (name: string): string | undefined => { try { return (require(`${name}/package.json`) as { version?: string }).version } catch { return undefined } }
  return { '@deepseek-ai/cordis': read('@deepseek-ai/cordis'), '@deepseek-ai/dsh-tools': read('@deepseek-ai/dsh-tools'), '@deepseek-ai/dsh-skill': read('@deepseek-ai/dsh-skill') }
}

async function mountProbe(): Promise<{ tools: number; skill: boolean; error?: string }> {
  let root: string | undefined
  try {
    root = await mkdtemp(join(tmpdir(), 'dsh-ditto-doctor-'))
    const [{ Context }, skills, prompt, tools, plugin] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'),
      import('./dsh/index.js'),
    ])
    const ctx = new Context()
    await ctx.plugin(skills.default, {})
    await ctx.plugin(prompt.default, {})
    await ctx.plugin(tools.default, {})
    await ctx.plugin(plugin.DshDitto, { workspaceRoot: root, stateRoot: join(root, '.dsh-ditto') })
    const registered = ctx.tools.schemas().map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)).length
    const skill = (await ctx.skills.list()).some(entry => entry.name === 'ditto')
    await ctx.fiber.dispose()
    return { tools: registered, skill }
  } catch (error) {
    return { tools: 0, skill: false, error: message(error) }
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function probeWritable(stateRoot: string): Promise<{ ok: boolean; error?: string }> {
  let target = stateRoot
  while (!existsSync(target)) { const parent = dirname(target); if (parent === target) return { ok: false, error: 'No existing parent folder' }; target = parent }
  try {
    await access(target, constants.W_OK)
    const probe = join(target, `.dsh-ditto-doctor-${randomUUID()}.tmp`)
    await writeFile(probe, 'probe', { flag: 'wx' })
    await unlink(probe)
    return { ok: true }
  } catch (error) { return { ok: false, error: message(error) } }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function profileFromCwd(home: string): string | undefined {
  const profiles = resolve(home, 'profiles')
  const cwd = process.cwd()
  const relativePath = relative(profiles, cwd)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
  const [name] = relativePath.split(/[\\/]/)
  return name && name !== 'node_modules' ? name : undefined
}
