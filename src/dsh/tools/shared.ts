import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { withStateLock } from '../../core/state-paths.js'

export const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Canonicalize every public tool result into the DSH lossless JSON boundary. */
export function json(value: unknown): ReturnType<typeof JSON.parse> { return JSON.parse(JSON.stringify(value)) }

export function checkNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('The Ditto operation was cancelled before it started')
}

/** Serialize in-process first, then take an atomic stateRoot lock for other DSH processes. */
const mutations = new Map<string, Promise<void>>()

export async function withMutation<T>(stateRoot: string, key: string, work: () => Promise<T>): Promise<T> {
  const prior = mutations.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolvePending => { release = resolvePending })
  const tail = prior.then(() => pending)
  mutations.set(key, tail)
  await prior
  try { return await withStateLock(stateRoot, key, work) } finally { release(); if (mutations.get(key) === tail) mutations.delete(key) }
}

export type ApprovalSource = 'host' | 'agent'

/** The subset of the DSH approval service Ditto relies on. */
export interface ApprovalLike {
  request(request: { agent: NonNullable<ToolRunContext['agent']>; toolName: string; callId?: ToolRunContext['callId']; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/**
 * The human gate in front of every write. With `approval: 'host'` and a DSH
 * approval service present, the host asks the user for a one-shot grant tied
 * to this exact tool call. `rejected` and `cancelled` always abort.
 *
 * `unavailable` means the host could not ask at all — most often because the
 * session's approval policy is `never`, which DSH intentionally maps to
 * `unavailable` so that callers fail closed. Ditto keeps that default. A profile
 * owner who understands the trade-off can set `approvalUnavailable: 'agent'` to
 * fall back to the agent's own conversational approval; that is not proof of a
 * human approval, only a statement that the agent asked.
 */
export async function requireHumanApproval(options: {
  ctx: Context
  mode: ApprovalSource
  exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>
  toolName: string
  reason: string
  unavailable?: 'deny' | 'agent'
}): Promise<ApprovalSource> {
  checkNotAborted(options.exec.signal)
  if (options.mode === 'agent') return 'agent'
  const approval = options.ctx.get('approval') as ApprovalLike | undefined
  if (!approval || typeof approval.request !== 'function' || !options.exec.agent) {
    if (options.unavailable === 'agent') return 'agent'
    throw new Error(`The DSH host could not ask for approval of ${options.toolName} (unavailable), so nothing was written. The approval service or agent identity is unavailable. Set "approvalUnavailable: agent" only if the profile owner intentionally accepts conversational approval fallback.`)
  }
  const outcome = await approval.request({ agent: options.exec.agent, toolName: options.toolName, callId: options.exec.callId, reason: options.reason, signal: options.exec.signal })
  checkNotAborted(options.exec.signal)
  if (outcome === 'allowed-once') return 'host'
  if (outcome === 'unavailable') {
    if (options.unavailable === 'agent') return 'agent'
    throw new Error(`The DSH host could not ask for approval of ${options.toolName} (unavailable), so nothing was written. This usually means the session approval policy is "never". Show the preview to the user and let them approve it, or set "approvalUnavailable: agent" in the Ditto profile configuration to rely on the agent's own approval instead.`)
  }
  throw new Error(`The DSH host did not approve ${options.toolName} (${outcome}). Nothing was written. Show the preview to the user and try again only after they approve it.`)
}
