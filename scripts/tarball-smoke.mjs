// Clean-install smoke: pack this package, install the tarball into an empty
// project next to the supported DSH peer packages, mount the plugin from the
// installed copy, and run the installed CLI. No DSH launcher required.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const dshVersion = process.env.DITTO_DSH_VERSION ?? '0.2.2-rc.4'
const cordisVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/cordis']
const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`)
  return result.stdout
}

const packDir = mkdtempSync(join(tmpdir(), 'dsh-ditto-pack-'))
const packed = JSON.parse(capture(npm, ['pack', '--json', '--pack-destination', packDir], { cwd: root }))
const tarball = join(packDir, packed[0].filename)
const files = packed[0].files.map(file => file.path)
for (const required of ['dist/dsh/index.js', 'dist/cli.js', 'skills/ditto/SKILL.md', 'cordis.patch.yml', 'README.md', 'LICENSE']) if (!files.includes(required)) throw new Error(`tarball is missing ${required}`)
for (const forbidden of files.filter(file => /^(docs|tests|src|scripts|\.github)\//.test(file) || /AGENTS\.md|\.local/.test(file))) throw new Error(`tarball must not contain ${forbidden}`)
console.log(`Packed ${packed[0].filename} (${files.length} files; no source, docs, or tests).`)

const project = mkdtempSync(join(tmpdir(), 'dsh-ditto-tarball-'))
try {
  // A DSH profile installs one consistent closure of @deepseek-ai/dsh-* packages. Mirror that here so
  // npm's peer resolution cannot mix rc versions (the published packages declare ^ ranges across rc tags).
  const pinned = ['dsh-agent', 'dsh-brand', 'dsh-code-runtime', 'dsh-invariants', 'dsh-llm', 'dsh-scope', 'dsh-session', 'dsh-session-projection', 'dsh-skill', 'dsh-system-prompt', 'dsh-timeout', 'dsh-tools', 'dsh-typert-protocol', 'dsh-user-approval', 'dsh-util-crypto', 'dsh-util-values']
  const overrides = Object.fromEntries(pinned.map(name => [`@deepseek-ai/${name}`, dshVersion]))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'ditto-tarball-smoke', private: true, type: 'module', overrides }, null, 2))
  run(npm, ['install', '--no-audit', '--no-fund', tarball, `@deepseek-ai/cordis@${cordisVersion}`, `@deepseek-ai/dsh-tools@${dshVersion}`, `@deepseek-ai/dsh-skill@${dshVersion}`, `@deepseek-ai/dsh-system-prompt@${dshVersion}`, `@deepseek-ai/dsh-tool-executor-native@${dshVersion}`], { cwd: project })
  const installed = JSON.parse(readFileSync(join(project, 'node_modules', 'dsh-ditto', 'package.json'), 'utf8'))
  if (!installed.dsh?.bundle?.patch) throw new Error('installed package.json lacks dsh.bundle.patch')
  if (!existsSync(join(project, 'node_modules', 'dsh-ditto', installed.dsh.bundle.patch))) throw new Error('bundle patch file missing from the installed package')
  const mountScript = [
    "import { Context } from '@deepseek-ai/cordis'",
    "import SkillRegistry from '@deepseek-ai/dsh-skill'",
    "import SystemPrompt from '@deepseek-ai/dsh-system-prompt'",
    "import ToolRuntime from '@deepseek-ai/dsh-tools'",
    "import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'",
    "import DshDitto, { TOOL_NAMES } from 'dsh-ditto/dsh'",
    'const ctx = new Context()',
    'await ctx.plugin(SkillRegistry, {})',
    'await ctx.plugin(SystemPrompt, {})',
    "await ctx.plugin(ToolRuntime, {})",
    "await ctx.plugin(NativeExecutor, {})",
    'const fiber = await ctx.plugin(DshDitto, { workspaceRoot: process.cwd() })',
    'const tools = ctx.tools.schemas().map(t => t.name).filter(n => TOOL_NAMES.includes(n))',
    "const skill = (await ctx.skills.list()).find(s => s.name === 'ditto')",
    "if (tools.length !== TOOL_NAMES.length) throw new Error('expected ' + TOOL_NAMES.length + ' tools, got ' + tools.length)",
    "if (!skill) throw new Error('skill not registered')",
    "const diagnosis = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'packed-doctor', name: 'ditto_doctor', arguments: '{}' }], signal: new AbortController().signal })",
    "if (diagnosis.results[0].result.isError || !diagnosis.results[0].result.value.ok) throw new Error('installed diagnostic failed')",
    'await fiber.dispose()',
    "if (ctx.tools.schemas().some(t => TOOL_NAMES.includes(t.name))) throw new Error('tools survived unload')",
    'await ctx.fiber.dispose()',
    "console.log('Mounted from the installed tarball: ' + tools.length + ' tools + skill \"' + skill.name + '\" (' + skill.source + '); clean unload.')",
  ].join('\n')
  writeFileSync(join(project, 'mount.mjs'), mountScript)
  run(process.execPath, ['mount.mjs'], { cwd: project, shell: false })
  const cli = join(project, 'node_modules', 'dsh-ditto', 'dist', 'cli.js')
  const demo = capture(process.execPath, [cli, 'demo', '--headless'], { cwd: project, shell: false })
  if (!/16\/16 written · 0 failed · 0 source files modified/.test(demo)) throw new Error(`installed CLI demo did not complete:\n${demo}`)
  console.log('Installed CLI ran the headless demo: 16/16 written, 0 source files modified.')
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--workspace-root', project], { cwd: project, encoding: 'utf8', shell: false, env: { ...process.env, DSH_HOME: join(project, 'dsh-home') } })
  if (doctor.status !== 0 || !/(\d+) of \1 tools registered/.test(doctor.stdout)) throw new Error(`installed doctor did not mount the plugin:\n${doctor.stdout}\n${doctor.stderr}`)
  console.log('Installed doctor mounted the plugin from the tarball copy.')
  console.log('Tarball smoke passed.')
} finally {
  rmSync(project, { recursive: true, force: true })
  rmSync(packDir, { recursive: true, force: true })
}
