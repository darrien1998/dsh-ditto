#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dittoVersion } from './compat.js'
import { createPlan, defaultRecipe } from './core/index.js'
import { demoGenerator, runHeadlessDemo, writeDemoRepository } from './demo.js'
import { renderDoctorReport, runDoctor } from './doctor.js'
import { startLocalWorkbench, startSpecWorkbench } from './server.js'
import { isUiLocale, supportedUiLocales, type UiLocale } from './ui/strings.js'

const USAGE = `dsh-ditto ${dittoVersion()} — Review a few. Ditto the rest.

Usage:
  dsh-ditto demo [--headless] [--dir <folder>] [--lang <locale>]
                                                 Code → Spec demo on a synthetic 16-module repository (no model, no API key)
  dsh-ditto demo-files [--dir <folder>] [--lang <locale>]
                                                 File-organisation demo on synthetic documents
  dsh-ditto doctor [--profile <name>] [--workspace-root <dir>] [--state-root <dir>]
                                                 Check Node, DSH, pnpm, the profile, tool/skill registration, and folders
  dsh-ditto serve <source> <output> <state> [--lang <locale>]
                                                 Open the local code → spec review page for a real folder
  dsh-ditto --version | --help

The browser demos print a local http://127.0.0.1 URL. Nothing is written until you press the apply button.
Demo folders default to a temporary directory; pass --dir to keep them somewhere else.`

async function main(argv: string[]): Promise<void> {
  const { command, flags, positional } = parse(argv)
  const lang = uiLocale(flags)
  if (flags.has('version') || command === 'version') { console.log(dittoVersion()); return }
  if (!command || flags.has('help') || command === 'help') { console.log(USAGE); process.exitCode = command ? 0 : 2; return }
  if (command === 'demo') return flags.has('headless') ? await headlessDemo(demoRoot(flags.get('dir'), 'spec-demo')) : await browserSpecDemo(demoRoot(flags.get('dir'), 'spec-demo'), lang)
  if (command === 'demo-files') return await browserFilesDemo(demoRoot(flags.get('dir'), 'files-demo'), lang)
  if (command === 'doctor') {
    const report = await runDoctor({ profile: flags.get('profile'), workspaceRoot: flags.get('workspace-root'), stateRoot: flags.get('state-root') })
    console.log(renderDoctorReport(report))
    process.exitCode = report.ok ? 0 : 1
    return
  }
  if (command === 'serve') {
    if (positional.length !== 3) { console.error('serve needs three folders: <source> <output> <state>'); process.exitCode = 2; return }
    return await serveSpec(resolve(positional[0]!), resolve(positional[1]!), resolve(positional[2]!), lang)
  }
  console.error(`Unknown command: ${command}\n\n${USAGE}`)
  process.exitCode = 2
}

function demoRoot(dir: string | undefined, kind: string): string {
  return dir ? resolve(dir) : join(tmpdir(), 'dsh-ditto', kind, randomUUID())
}

async function headlessDemo(runRoot: string): Promise<void> {
  const result = await runHeadlessDemo(runRoot, line => console.log(line))
  if (!result.sourceHashesUnchanged || result.written !== result.batch.items.length) process.exitCode = 1
}

async function browserSpecDemo(runRoot: string, lang: UiLocale | undefined): Promise<void> {
  const sourceRoot = join(runRoot, 'source'); const outputRoot = join(runRoot, 'specifications'); const stateRoot = join(runRoot, 'state')
  await writeDemoRepository(sourceRoot)
  const workbench = await startSpecWorkbench({ sourceRoot, outputRoot, stateRoot, generator: demoGenerator, demo: true, lang })
  console.log('Ditto demo — synthetic repository, deterministic generator, no model calls, no API key')
  console.log(`Source  ${sourceRoot}\nOutput  ${outputRoot}`)
  console.log(`\nOpen in your browser: ${workbench.url}`)
  console.log('Review the three samples, approve them, generate the full preview, then write. Nothing is written before you press the button.')
  console.log('Press Ctrl+C to stop.')
  await waitForInterrupt()
  await workbench.close()
}

async function serveSpec(sourceRoot: string, outputRoot: string, stateRoot: string, lang: UiLocale | undefined): Promise<void> {
  const workbench = await startSpecWorkbench({ sourceRoot, outputRoot, stateRoot, generator: demoGenerator, demo: true, lang })
  console.log('Local review page (deterministic generator — inside DSH the agent drafts the specifications instead).')
  console.log(`Open in your browser: ${workbench.url}`)
  console.log('Press Ctrl+C to stop.')
  await waitForInterrupt()
  await workbench.close()
}

async function browserFilesDemo(runRoot: string, lang: UiLocale | undefined): Promise<void> {
  const sourceRoot = join(runRoot, 'source'); const destinationRoot = join(runRoot, 'organised-copies'); const stateRoot = join(runRoot, 'state')
  const fixtures: Array<[string, string]> = [
    ['inbox/client-list.csv', 'client,contact\nNorth Star,J. Lin\n'], ['inbox/quote-draft.md', '# Quote draft\n\nSynthetic demo content.\n'],
    ['inbox/delivery-checklist.txt', 'Synthetic demo: confirm before delivery.\n'], ['meeting-notes.txt', '2026-09-14 discussion summary\n'],
    ['project-brief.md', '# Project brief\n\nLocal synthetic demo.\n'], ['budget.csv', 'item,amount\ndesign,12000\n'],
    ['work-log.json', '{"demo":true,"note":"synthetic fixture"}\n'], ['interview-summary.md', '# Interview summary\n\nUser needs.\n'],
    ['todo.txt', 'Confirm the schedule\nSend the files\n'], ['catalog.csv', 'code,name\nA-01,Demo item\n'],
    ['research-memo.md', '# Research memo\n\nLocal testing only.\n'], ['contacts.csv', 'name,phone\nA. Wang,00000000\n'],
    ['release-notes.txt', `Version ${dittoVersion()} synthetic demo\n`], ['readme.md', '# Read me\n\nThese files were created by the demo command.\n'],
  ]
  await Promise.all(fixtures.map(async ([relativePath, contents]) => { const path = join(sourceRoot, ...relativePath.split('/')); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents, 'utf8') }))
  const plan = await createPlan({ sourceRoot, destinationRoot, recipe: defaultRecipe('Demo: group by type'), excludedRoots: [stateRoot] })
  const workbench = await startLocalWorkbench({ sourceRoot, destinationRoot, stateRoot, plan, lang })
  console.log('Ditto file-organisation demo — synthetic documents, no model calls')
  console.log(`Source  ${sourceRoot}\nOutput  ${destinationRoot}`)
  console.log(`\nOpen in your browser: ${workbench.url}`)
  console.log('Copies are created only when you press the button; originals are never modified. Press Ctrl+C to stop.')
  await waitForInterrupt()
  await workbench.close()
}

function waitForInterrupt(): Promise<void> { return new Promise<void>(resolveStop => process.once('SIGINT', () => resolveStop())) }

function uiLocale(flags: Map<string, string>): UiLocale | undefined {
  if (!flags.has('lang')) return undefined
  const value = flags.get('lang')
  if (!isUiLocale(value)) throw new Error(`Unsupported locale: ${value ?? ''}. Supported locales: ${supportedUiLocales.join(', ')}`)
  return value
}

function parse(argv: string[]): { command: string | undefined; flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>(); const positional: string[] = []; let command: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument.startsWith('--')) {
      const [name, inline] = argument.slice(2).split('=', 2) as [string, string | undefined]
      if (inline !== undefined) flags.set(name, inline)
      else if (['dir', 'profile', 'workspace-root', 'state-root', 'lang'].includes(name) && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) flags.set(name, argv[++index]!)
      else flags.set(name, 'true')
    } else if (command === undefined) command = argument
    else positional.push(argument)
  }
  return { command, flags, positional }
}

void main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
