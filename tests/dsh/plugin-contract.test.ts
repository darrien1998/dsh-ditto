import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SKILL_FILE, TOOL_CATALOG, TOOL_NAMES, dittoSkill, parseSkillFile, requireHumanApproval, resolveConfig } from '../../src/dsh/index.js'
import { isSkillName } from '@deepseek-ai/dsh-skill'

describe('SKILL.md is the single source of truth for the Ditto skill', () => {
  it('parses the shipped file into a valid DSH skill registration', () => {
    const skill = dittoSkill()
    expect(skill.name).toBe('ditto')
    expect(isSkillName(skill.name)).toBe(true)
    expect(skill.source).toBe('bundled')
    expect(skill.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(skill.description.length).toBeGreaterThan(40)
    expect(skill.whenToUse).toContain('every module')
    expect(skill.path).toBe(SKILL_FILE)
    expect(skill.resourceBase).toMatchObject({ kind: 'directory' })
  })

  it('keeps the frontmatter compatible with the DSH filesystem skill provider', () => {
    const parsed = parseSkillFile(readFileSync(SKILL_FILE, 'utf8'))
    expect(Object.keys(parsed.frontmatter).sort()).toEqual(['description', 'name', 'user-invocable', 'whenToUse'])
    expect(parsed.frontmatter['user-invocable']).toBe(true)
    expect(parsed.content.startsWith('# Ditto')).toBe(true)
  })

  it('routes on the shape of the work and names every entry tool the agent needs', () => {
    const { content } = dittoSkill()
    for (const phrase of ['entire folder', 'several similar modules', 'repeated transformation', 'batch documentation', 'batch file organisation', 'single file', 'ordinary question', 'explicitly says not to use Ditto']) expect(content).toContain(phrase)
    for (const name of TOOL_NAMES) expect(content).toContain(name)
    expect(content).toContain('Never call `ditto_spec_apply` or `ditto_apply` on your own initiative')
  })

  it('rejects malformed frontmatter instead of registering a broken skill', () => {
    expect(() => parseSkillFile('no frontmatter')).toThrow('frontmatter')
    expect(() => parseSkillFile('---\nname: x\nuser-invocable: maybe\n---\nbody')).toThrow('boolean')
    expect(() => dittoSkill(SKILL_FILE + '.missing')).toThrow()
  })
})

describe('tool catalog', () => {
  it('covers every registered tool exactly once with the facts docs/TOOLS.md needs', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    expect(TOOL_NAMES).toHaveLength(23)
    for (const fact of TOOL_CATALOG) {
      expect(fact.name).toMatch(/^ditto(_spec)?_[a-z_]+$/)
      for (const field of ['stage', 'purpose', 'writes', 'approval', 'failures'] as const) expect(fact[field].length).toBeGreaterThan(3)
    }
    expect(TOOL_CATALOG.filter(fact => fact.name.endsWith('_apply')).every(fact => fact.approval.includes('Explicit user approval'))).toBe(true)
  })
})

describe('plugin configuration', () => {
  it('defaults to host approval and keeps state inside the workspace', () => {
    const config = resolveConfig({ workspaceRoot: '/ws' })
    expect(config.approval).toBe('host')
    expect(config.stateRoot.replace(/\\/g, '/').endsWith('/.dsh-ditto')).toBe(true)
    expect(() => resolveConfig({ workspaceRoot: '/ws', stateRoot: '/elsewhere' })).toThrow('inside workspaceRoot')
    expect(() => resolveConfig({ approval: 'never' as never })).toThrow("'host' or 'agent'")
    expect(() => resolveConfig({ evidenceItems: 400 })).toThrow('evidenceItems')
  })
})

describe('human approval gate', () => {
  const exec = { agent: { id: 'agent' } as never, callId: 'call-1' as never, signal: new AbortController().signal }
  const stubHost = (request: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>): Context => ({ get: (name: string) => name === 'approval' ? { request } : undefined } as unknown as Context)

  it('refuses cancellation before approval and a late grant after cancellation', async () => {
    const controller = new AbortController()
    const cancelledExec = { ...exec, signal: controller.signal }
    const lateHost = stubHost(async () => { controller.abort(); return 'allowed-once' })
    await expect(requireHumanApproval({ ctx: lateHost, mode: 'host', exec: cancelledExec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('cancelled')
    const unusedHost = stubHost(async () => { throw new Error('must not ask') })
    for (const mode of ['host', 'agent'] as const) await expect(requireHumanApproval({ ctx: unusedHost, mode, unavailable: 'agent', exec: cancelledExec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('cancelled')
  })

  it('asks the host once and proceeds only on a one-shot grant', async () => {
    const asked: unknown[] = []
    const ctx = stubHost(async () => { asked.push(1); return 'allowed-once' })
    await expect(requireHumanApproval({ ctx, mode: 'host', exec, toolName: 'ditto_apply', reason: 'test' })).resolves.toBe('host')
    expect(asked).toHaveLength(1)
  })

  it.each(['rejected', 'cancelled'] as const)('fails closed when the host answers %s', async outcome => {
    const ctx = stubHost(async () => outcome)
    await expect(requireHumanApproval({ ctx, mode: 'host', exec, toolName: 'ditto_spec_apply', reason: 'test' })).rejects.toThrow(`did not approve ditto_spec_apply (${outcome})`)
  })

  it('fails closed on unavailable by default and only falls back when the profile owner opts in', async () => {
    const ctx = stubHost(async () => 'unavailable')
    await expect(requireHumanApproval({ ctx, mode: 'host', exec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('could not ask for approval')
    await expect(requireHumanApproval({ ctx, mode: 'host', unavailable: 'deny', exec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('could not ask for approval')
    await expect(requireHumanApproval({ ctx, mode: 'host', unavailable: 'agent', exec, toolName: 'ditto_apply', reason: 'test' })).resolves.toBe('agent')
    // A rejection is never converted into an agent fallback.
    const rejecting = stubHost(async () => 'rejected')
    await expect(requireHumanApproval({ ctx: rejecting, mode: 'host', unavailable: 'agent', exec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('did not approve')
  })

  it('fails closed when the host service or agent identity is absent unless the profile opts in', async () => {
    const bare = new Context()
    await expect(requireHumanApproval({ ctx: bare, mode: 'host', exec, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('could not ask for approval')
    await expect(requireHumanApproval({ ctx: bare, mode: 'host', unavailable: 'agent', exec, toolName: 'ditto_apply', reason: 'test' })).resolves.toBe('agent')
    const hostWithoutAgent = stubHost(async () => { throw new Error('must not be called') })
    await expect(requireHumanApproval({ ctx: hostWithoutAgent, mode: 'host', exec: { ...exec, agent: undefined }, toolName: 'ditto_apply', reason: 'test' })).rejects.toThrow('could not ask for approval')
    await expect(requireHumanApproval({ ctx: hostWithoutAgent, mode: 'host', unavailable: 'agent', exec: { ...exec, agent: undefined }, toolName: 'ditto_apply', reason: 'test' })).resolves.toBe('agent')
    await expect(requireHumanApproval({ ctx: hostWithoutAgent, mode: 'agent', exec, toolName: 'ditto_apply', reason: 'test' })).resolves.toBe('agent')
    await bare.fiber.dispose()
  })
})
