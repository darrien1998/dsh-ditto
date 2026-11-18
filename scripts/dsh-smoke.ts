/**
 * Component-host smoke: runs the native-tool and plugin-contract tests against
 * the real published Cordis + ToolRuntime + SkillRegistry in an isolated
 * DSH_HOME, and asserts the resolved DSH package versions are the ones this
 * run claims to test. Override the expected version with DITTO_DSH_VERSION
 * (the canary CI job does).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const EXPECTED = process.env.DITTO_DSH_VERSION ?? '0.2.2-rc.4'

async function main(): Promise<void> {
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-system-prompt']) assertVersion(name)
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ditto-component-home-'))
  try {
    console.log(`Ditto component-host smoke against DSH ${EXPECTED} (isolated DSH_HOME: ${dshHome})`)
    await run(process.execPath, [vitestBin(), 'run', 'tests/dsh'], { ...process.env, DSH_HOME: dshHome })
    console.log('Passed: real Cordis + published ToolRuntime/SkillRegistry registered the skill from SKILL.md and every catalogued tool, completed the agent-driven evidence/draft flow, honoured guard and pre-execute denials, and removed everything on unload.')
    console.log('Scope: component host only — no @deepseek-ai/dsh CLI profile boot and no model calls. See npm run smoke:profile for the real profile install.')
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
}

function vitestBin(): string {
  const manifestPath = require.resolve('vitest/package.json')
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest
  if (!bin) throw new Error('vitest bin not found')
  return join(dirname(manifestPath), bin)
}

function assertVersion(packageName: string): void {
  const packageJson = require(`${packageName}/package.json`) as { version?: unknown }
  if (packageJson.version !== EXPECTED) throw new Error(`${packageName} must resolve to ${EXPECTED}, got ${String(packageJson.version)}`)
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
    child.once('error', rejectRun)
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`Smoke command exited ${String(code)}`)))
  })
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
