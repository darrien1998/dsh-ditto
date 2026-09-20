import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { applyPlan, createPlan, defaultRecipe, listRecipes, loadPlan, loadRecipe, recipeFromPlan, revisePlan, savePlan, saveRecipe, applySpecBatch, approveSpecSamples, countConfirmations, createSpecBatch, generateSpecBatch, hasCurrentSampleApproval, isSpecBatchReadyToApply, reviseSpecBatch, saveSpecBatch } from './core/index.js'
import type { Plan, PlanEdit } from './core/types.js'
import { withStateLock } from './core/state-paths.js'
import { renderWorkbench } from './ui/workbench.js'
import { renderSpecWorkbench, type SpecBatchLike } from './ui/spec-workbench.js'
import type { UiLocale } from './ui/strings.js'
import type { SpecBatch, SpecGenerator } from './spec/types.js'

export interface LocalWorkbenchOptions {
  sourceRoot: string
  destinationRoot: string
  stateRoot: string
  plan?: Plan
  recipe?: ReturnType<typeof defaultRecipe>
  lang?: UiLocale
}

export interface LocalWorkbench {
  url: string
  csrfToken: string
  close(): Promise<void>
}

/** Options for the code-to-spec review page. The file-organisation page stays available through startLocalWorkbench. */
export interface SpecWorkbenchServerOptions {
  sourceRoot: string
  outputRoot: string
  stateRoot: string
  generator: SpecGenerator
  batch?: SpecBatch
  instructions?: string
  /** Only use a deterministic generator for a labelled local demo or automated test. */
  demo?: boolean
  lang?: UiLocale
}

const MAX_BODY_BYTES = 16 * 1024

/** Starts a single-purpose, loopback-only server. It has no file or shell endpoints. */
export async function startLocalWorkbench(options: LocalWorkbenchOptions): Promise<LocalWorkbench> {
  let plan = options.plan ?? await createPlan({ sourceRoot: options.sourceRoot, destinationRoot: options.destinationRoot, recipe: options.recipe ?? defaultRecipe(), excludedRoots: [options.stateRoot] })
  await savePlan(plan, options.stateRoot)
  const csrfToken = randomBytes(32).toString('base64url')
  let mutationTail = Promise.resolve()
  const server = createServer(async (request, response) => {
    try {
      if (!hasExpectedHost(request, server)) return respondJson(response, 421, { error: 'Only requests from this local review page are accepted.' })
      const context = { stateRoot: options.stateRoot, csrfToken, lang: options.lang, getPlan: () => plan, setPlan: (next: Plan) => { plan = next }, sourceRoot: options.sourceRoot, destinationRoot: options.destinationRoot }
      if (request.method === 'POST') await withMutationLock(() => route(request, response, context), tail => { mutationTail = tail }, mutationTail)
      else await route(request, response, context)
    }
    catch (error: unknown) { respondJson(response, statusFor(error), { error: messageFor(error) }) }
  })
  await new Promise<void>((resolveStart, rejectStart) => { server.once('error', rejectStart); server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', rejectStart); resolveStart() }) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, csrfToken, close: () => closeServer(server) }
}

/**
 * Starts the code-to-spec review page on a new loopback server. It initially
 * produces only the three calibration samples; the remaining modules stay
 * locked until the samples are approved.
 */
export async function startSpecWorkbench(options: SpecWorkbenchServerOptions): Promise<LocalWorkbench> {
  let batch = options.batch ?? await createSpecBatch({ sourceRoot: options.sourceRoot, outputRoot: options.outputRoot, stateRoot: options.stateRoot, instructions: options.instructions })
  if (!options.batch) batch = await generateSpecBatch(batch, options.generator, { only: 'samples', stateRoot: options.stateRoot })
  await saveSpecBatch(batch, options.stateRoot)
  const csrfToken = randomBytes(32).toString('base64url')
  let mutationTail = Promise.resolve()
  const server = createServer(async (request, response) => {
    try {
      if (!hasExpectedHost(request, server)) return respondJson(response, 421, { error: 'Only requests from this local review page are accepted.' })
      const context = { csrfToken, lang: options.lang, getBatch: () => batch, setBatch: (next: SpecBatch) => { batch = next }, generator: options.generator, stateRoot: options.stateRoot, demo: options.demo ?? false }
      if (request.method === 'POST') await withMutationLock(() => specRoute(request, response, context), tail => { mutationTail = tail }, mutationTail)
      else await specRoute(request, response, context)
    } catch (error: unknown) { respondJson(response, statusFor(error), { error: messageFor(error) }) }
  })
  await new Promise<void>((resolveStart, rejectStart) => { server.once('error', rejectStart); server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', rejectStart); resolveStart() }) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, csrfToken, close: () => closeServer(server) }
}

interface RouteContext {
  stateRoot: string
  csrfToken: string
  sourceRoot: string
  destinationRoot: string
  lang?: UiLocale
  getPlan(): Plan
  setPlan(plan: Plan): void
}

async function route(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const method = request.method ?? 'GET'; const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (method === 'GET' && pathname === '/') return respondHtml(response, renderWorkbench(context.getPlan(), { csrfToken: context.csrfToken, lang: context.lang }))
  if (method === 'GET' && pathname === '/api/plan') return respondJson(response, 200, { plan: context.getPlan() })
  if (method === 'GET' && pathname === '/api/recipe') return respondJson(response, 200, { recipes: await listRecipes(context.stateRoot) })
  if (method !== 'POST' || !['/api/revise', '/api/apply', '/api/recipe', '/api/recipe/load'].includes(pathname)) return respondJson(response, 404, { error: 'Unknown local endpoint.' })
  if (!sameOrigin(request) || request.headers['x-dsh-csrf'] !== context.csrfToken) return respondJson(response, 403, { error: 'The request failed the local security check.' })
  const body = await readJson(request)
  if (pathname === '/api/revise') {
    const revision = integer(body.revision, 'revision'); const edits = planEdits(body.edits)
    const id = context.getPlan().id
    const next = await withStateLock(context.stateRoot, id, async () => {
      const durable = await loadPlan(id, context.stateRoot)
      if (revision !== durable.revision) throw new ClientError(409, 'The preview changed; refresh it before editing.')
      if (edits.some(edit => durable.items.find(item => item.id === edit.id)?.status !== 'ready')) throw new ClientError(409, 'Items that already have a result can no longer be edited.')
      const revised = revisePlan(durable, edits)
      await savePlan(revised, context.stateRoot)
      return revised
    })
    context.setPlan(next)
    return respondJson(response, 200, { plan: next })
  }
  if (pathname === '/api/apply') {
    const revision = integer(body.revision, 'revision'); const digest = text(body.digest, 'digest', 64)
    const current = context.getPlan()
    if (revision !== current.revision || digest !== current.digest) throw new ClientError(409, 'The preview changed; refresh it before applying.')
    const result = await applyPlan(current, { id: current.id, revision, digest }, context.stateRoot)
    context.setPlan(await loadPlan(current.id, context.stateRoot))
    return respondJson(response, 200, result)
  }
  if (pathname === '/api/recipe') {
    const recipe = recipeFromPlan(context.getPlan(), text(body.name, 'name', 80)); await saveRecipe(recipe, context.stateRoot)
    return respondJson(response, 201, { recipe: { id: recipe.id, name: recipe.name, version: recipe.version, createdAt: recipe.createdAt } })
  }
  const id = text(body.id, 'id', 64); const current = context.getPlan()
  if (!current.items.every(item => item.status === 'ready')) throw new ClientError(409, 'This preview already has results and cannot be replaced.')
  const recipe = await loadRecipe(id, context.stateRoot)
  const next = await createPlan({ sourceRoot: context.sourceRoot, destinationRoot: context.destinationRoot, recipe, excludedRoots: [context.stateRoot] })
  await savePlan(next, context.stateRoot); context.setPlan(next)
  return respondJson(response, 200, { plan: next })
}

interface SpecRouteContext {
  csrfToken: string
  stateRoot: string
  generator: SpecGenerator
  demo: boolean
  lang?: UiLocale
  getBatch(): SpecBatch
  setBatch(batch: SpecBatch): void
}

async function specRoute(request: IncomingMessage, response: ServerResponse, context: SpecRouteContext): Promise<void> {
  const method = request.method ?? 'GET'; const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (method === 'GET' && pathname === '/') return respondHtml(response, renderSpecWorkbench(specView(context.getBatch()), { csrfToken: context.csrfToken, lang: context.lang, samplesApproved: hasCurrentSampleApproval(context.getBatch()), canApply: isSpecBatchReadyToApply(context.getBatch()), demo: context.demo }))
  if (method === 'GET' && pathname === '/api/spec/batch') return respondJson(response, 200, { batch: specView(context.getBatch()), samplesApproved: hasCurrentSampleApproval(context.getBatch()), canApply: isSpecBatchReadyToApply(context.getBatch()) })
  if (method !== 'POST' || !['/api/spec/revise', '/api/spec/approve', '/api/spec/generate', '/api/spec/apply'].includes(pathname)) return respondJson(response, 404, { error: 'Unknown local endpoint.' })
  if (!sameOrigin(request) || request.headers['x-dsh-csrf'] !== context.csrfToken) return respondJson(response, 403, { error: 'The request failed the local security check.' })
  const body = await readJson(request); const current = context.getBatch()
  if (pathname === '/api/spec/revise') {
    const revision = integer(body.revision, 'revision'); if (revision !== current.revision) throw new ClientError(409, 'The batch changed; refresh it before editing.')
    const sampleEdits = specSampleEdits(body.sampleEdits); const instructions = body.instructions === undefined ? undefined : text(body.instructions, 'instructions', 8_000)
    try {
      const next = reviseSpecBatch(current, { sampleEdits, instructions }); await saveSpecBatch(next, context.stateRoot); context.setBatch(next)
      return respondJson(response, 200, { batch: specView(next), samplesApproved: hasCurrentSampleApproval(next), canApply: isSpecBatchReadyToApply(next) })
    } catch (error: unknown) { throw new ClientError(409, messageFor(error)) }
  }
  const revision = integer(body.revision, 'revision'); const digest = text(body.digest, 'digest', 64)
  if (current.revision !== revision || current.digest !== digest) throw new ClientError(409, 'The batch changed; refresh it before continuing.')
  if (pathname === '/api/spec/approve') {
    try {
      const next = approveSpecSamples(current); await saveSpecBatch(next, context.stateRoot); context.setBatch(next)
      return respondJson(response, 200, { batch: specView(next), samplesApproved: hasCurrentSampleApproval(next), canApply: isSpecBatchReadyToApply(next) })
    } catch (error: unknown) { throw new ClientError(409, messageFor(error)) }
  }
  if (pathname === '/api/spec/generate') {
    try {
      const next = await generateSpecBatch(current, context.generator, { only: 'remaining', stateRoot: context.stateRoot }); await saveSpecBatch(next, context.stateRoot); context.setBatch(next)
      return respondJson(response, 200, { batch: specView(next), samplesApproved: hasCurrentSampleApproval(next), canApply: isSpecBatchReadyToApply(next) })
    } catch (error: unknown) { throw new ClientError(409, messageFor(error)) }
  }
  const id = text(body.id, 'id', 64)
  if (!isSpecBatchReadyToApply(current)) throw new ClientError(409, 'The full batch preview is not complete; specifications cannot be written yet')
  const result = await applySpecBatch(current, { id, revision, digest }, context.stateRoot)
  const next = { ...current, items: result.items, summary: result.summary }; context.setBatch(next)
  return respondJson(response, 200, { ...result, batch: specView(next), samplesApproved: hasCurrentSampleApproval(next), canApply: isSpecBatchReadyToApply(next) })
}

function specSampleEdits(value: unknown): Array<{ moduleId: string; markdown: string }> {
  if (!Array.isArray(value) || value.length !== 3 || value.some(edit => !edit || typeof edit !== 'object' || typeof (edit as { moduleId?: unknown }).moduleId !== 'string' || typeof (edit as { markdown?: unknown }).markdown !== 'string')) throw new ClientError(400, 'Exactly three sample edits are expected.')
  return value as Array<{ moduleId: string; markdown: string }>
}

/** Keep source text and private generator metadata out of browser state while retaining evidence links. */
export function specView(batch: SpecBatch): SpecBatchLike {
  return {
    id: batch.id, revision: batch.revision, digest: batch.digest, sourceRoot: batch.sourceRoot, outputRoot: batch.outputRoot,
    instructions: batch.recipe.instructions, samples: batch.samples, modules: batch.items.map(item => ({ id: item.id, relativePath: item.relativePath, language: item.language, outputPath: item.outputPath, status: item.status, reason: item.reason, renderedMarkdown: item.approvedMarkdown ?? item.renderedMarkdown, confirmations: countConfirmations(item.approvedMarkdown ?? item.renderedMarkdown), evidence: item.evidence.map(evidence => ({ id: evidence.id, relativePath: evidence.relativePath, startLine: evidence.startLine, endLine: evidence.endLine })), structuralFacts: item.facts })),
    excluded: batch.discovery.excluded.map(item => ({ relativePath: item.relativePath, reason: item.reason })), summary: { ...batch.summary, inScope: batch.discovery.inScope, excluded: batch.discovery.excludedTotal },
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  return typeof origin === 'string' && typeof host === 'string' && origin === `http://${host}` && /^127\.0\.0\.1:\d+$/.test(host)
}

function hasExpectedHost(request: IncomingMessage, server: Server): boolean {
  const address = server.address()
  return typeof address === 'object' && address !== null && request.headers.host === `127.0.0.1:${address.port}`
}

async function withMutationLock<T>(work: () => Promise<T>, setTail: (tail: Promise<void>) => void, previous: Promise<void>): Promise<T> {
  let release!: () => void
  const held = new Promise<void>(resolveRelease => { release = resolveRelease })
  const tail = previous.then(() => held)
  setTail(tail)
  await previous
  try { return await work() } finally { release() }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > MAX_BODY_BYTES) throw new ClientError(413, 'The request body is too large.'); chunks.push(data) }
  try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed as Record<string, unknown> } catch { throw new ClientError(400, 'The request body is not a JSON object.') }
}
function planEdits(value: unknown): PlanEdit[] { if (!Array.isArray(value) || value.length > 1_000 || value.some(edit => !edit || typeof edit !== 'object' || typeof (edit as PlanEdit).id !== 'string' || typeof (edit as PlanEdit).destination !== 'string')) throw new ClientError(400, 'Invalid edits.'); return value as PlanEdit[] }
function integer(value: unknown, name: string): number { if (!Number.isInteger(value)) throw new ClientError(400, `${name} must be an integer.`); return value as number }
function text(value: unknown, name: string, maximum: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new ClientError(400, `${name} is invalid.`); return value }
function respondJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
function respondHtml(response: ServerResponse, value: string): void { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); response.end(value) }
function messageFor(error: unknown): string { return error instanceof ClientError ? error.message : error instanceof Error ? error.message.slice(0, 300) : 'The local operation did not complete.' }
function statusFor(error: unknown): number { return error instanceof ClientError ? error.status : 500 }
class ClientError extends Error { constructor(readonly status: number, message: string) { super(message) } }
function closeServer(server: Server): Promise<void> { return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())) }
