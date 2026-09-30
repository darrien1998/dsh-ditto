// Real-launcher smoke, in an isolated DSH_HOME (your ~/.dsh is never touched):
//   0. initialise `ditto-smoke` from the shipped `web` template in that temporary DSH_HOME
//   1. `dsh plugin --profile ditto-smoke add <packed tarball>` — the documented install command;
//      the profile manifest must then list dsh-ditto as a dependency and a bundle
//   2. `dsh --profile ditto-smoke --dump-config` composes the dsh-ditto/dsh entry
//   3. `dsh --profile ditto-smoke` boots: a plugin that fails to import or throws in its
//      constructor makes the launcher exit non-zero; a healthy tree keeps running, so we
//      wait out the grace period, assert no load failure was logged, then stop it
//   4. `dsh plugin --profile ditto-smoke exec dsh-ditto doctor` passes inside the profile
// Needs `dsh` and `pnpm` on PATH.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const desktopRoot = shell && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop') : ''
const desktopExe = desktopRoot ? join(desktopRoot, 'DSH Desktop.exe') : ''
const desktopCli = desktopRoot ? join(desktopRoot, 'resources', 'app', 'lib', 'desktop-cli.js') : ''
// DSH Desktop's generated dsh.cmd intentionally pins DSH_HOME to the user's
// real profile. Bypass that wrapper so this smoke remains genuinely isolated.
const dshLauncher = desktopExe && existsSync(desktopExe) && existsSync(desktopCli)
  ? { command: desktopExe, prefix: ['--expose-internals', desktopCli], shell: false }
  : { command: 'dsh', prefix: [], shell }
const BOOT_GRACE_MS = Number(process.env.DITTO_BOOT_GRACE_MS ?? 25_000)

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell, ...options })
  return { ...result, ok: result.status === 0 }
}
function captureDsh(args, options = {}) {
  const desktopEnv = dshLauncher.command === desktopExe ? { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_DEFAULT_PROFILE: 'web' } : {}
  return capture(dshLauncher.command, [...dshLauncher.prefix, ...args], { shell: dshLauncher.shell, ...options, env: { ...process.env, ...desktopEnv, ...(options.env ?? {}) } })
}
function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`)
  return result
}

/** Boot the profile; resolve once it is still running after the grace period, or when it exits cleanly. */
function bootProfile(profile, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dshLauncher.command, [...dshLauncher.prefix, '--profile', profile], { env, shell: dshLauncher.shell, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => { stop(child); resolvePromise({ booted: true, stayedUp: true, output }) }, BOOT_GRACE_MS)
    // A profile without an interactive app can legitimately exit 0 straight away;
    // what matters is that the plugin tree loaded without an error.
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolvePromise({ booted: true, stayedUp: false, output }); else reject(new Error(`dsh --profile ${profile} exited ${code}:\n${output.replace(/token=[^\s]+/g, 'token=[redacted]').slice(-12_000)}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
function stop(child) {
  if (shell && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const dsh = captureDsh(['--version'])
if (!dsh.ok) { console.error('dsh is not on PATH; install it first: npm install -g @deepseek-ai/dsh@0.1.5-rc.1'); process.exit(process.env.CI ? 1 : 0) }
const pnpm = capture('pnpm', ['--version'])
if (!pnpm.ok) { console.error('pnpm is not on PATH; dsh plugin needs it (npm install -g pnpm)'); process.exit(process.env.CI ? 1 : 0) }
console.log(`dsh ${dsh.stdout.trim()} · pnpm ${pnpm.stdout.trim()}`)

const packed = JSON.parse(must(capture(npm, ['pack', '--json', '--pack-destination', tmpdir()]), 'npm pack').stdout)
const tarball = join(tmpdir(), packed[0].filename)
const home = mkdtempSync(join(tmpdir(), 'dsh-ditto-profile-home-'))
const profile = 'ditto-smoke'
const env = { ...process.env, DSH_HOME: home, ...(dshLauncher.command === desktopExe ? { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_DEFAULT_PROFILE: 'web' } : {}) }
try {
  console.log(`Isolated DSH_HOME: ${home}`)
  // Starting the profile from the shipped web template keeps the boot step
  // meaningful (it has an app to load). A launcher too old for the flag still
  // works: `dsh plugin add` below initialises the profile, exactly as before.
  const initialised = captureDsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env })
  if (!initialised.ok) console.log('0. profile template        --from-default-profile unavailable; letting "dsh plugin add" initialise the profile')
  must(captureDsh(['plugin', '--profile', profile, 'add', tarball], { env }), 'dsh plugin add')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if (!manifest.dependencies?.['dsh-ditto']) throw new Error('profile manifest does not list dsh-ditto as a dependency')
  if (!manifest.dsh?.profile?.bundles?.includes('dsh-ditto')) throw new Error(`profile bundles do not include dsh-ditto: ${JSON.stringify(manifest.dsh?.profile?.bundles)}`)
  console.log(`1. dsh plugin add          profile "${profile}" bundles = ${JSON.stringify(manifest.dsh.profile.bundles)}`)
  const dump = must(captureDsh(['--profile', profile, '--dump-config'], { env }), 'dsh --dump-config')
  if (!/dsh-ditto\/dsh/.test(dump.stdout)) throw new Error(`composed config does not contain the Ditto entry:\n${dump.stdout.slice(0, 2000)}`)
  console.log('2. dsh --dump-config       composed plugin tree contains the dsh-ditto/dsh entry')

  const boot = await bootProfile(profile, env)
  if (!boot.booted || /plugin tree failed to load|dsh-ditto.*failed|cannot find.*dsh-ditto/i.test(boot.output)) throw new Error(`profile did not boot cleanly:\n${boot.output.slice(0, 3000)}`)
  console.log(`3. dsh --profile           ${boot.stayedUp ? `booted with dsh-ditto in the tree and stayed up for ${BOOT_GRACE_MS / 1000}s` : 'booted with dsh-ditto in the tree and exited cleanly'} (no plugin load error)`)

  const doctor = captureDsh(['plugin', '--profile', profile, 'exec', 'dsh-ditto', 'doctor'], { env })
  const summary = doctor.stdout.split('\n').filter(line => /^[✓!✗]/.test(line)).join('\n    ')
  console.log(`4. doctor inside profile\n    ${summary}`)
  // The doctor labels the count dynamically ("N of N tools registered") and reports a
  // failure when any catalogued tool is missing, so the shape is what matters here.
  if (!doctor.ok || !/(\d+) of \1 tools registered/.test(doctor.stdout) || !new RegExp(`installed in profile "${profile}"`).test(doctor.stdout)) throw new Error(`doctor inside the profile did not pass:\n${doctor.stdout}\n${doctor.stderr}`)
  console.log('Profile smoke passed.')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
