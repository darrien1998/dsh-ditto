import { describe, expect, it, vi } from 'vitest'
import { renderWorkbench } from '../../src/ui/workbench.js'
import { renderSpecWorkbench } from '../../src/ui/spec-workbench.js'
import type { Plan } from '../../src/core/types.js'
import type { SpecBatchLike } from '../../src/ui/spec-workbench.js'

function browser(kind: 'files' | 'spec') {
  const listeners: Record<string, (event: any) => void> = {}
  const document: any = { activeElement: null, title: '', documentElement: { setAttribute: vi.fn() }, addEventListener: (name: string, handler: any) => { listeners[name] = handler } }
  const node = (editable = false) => {
    const attributes = new Map<string, string>()
    const result: any = { disabled: false, hidden: false, value: '', dataset: {}, textContent: '', innerHTML: '', listeners: {}, editable,
      setAttribute: (key: string, value: string) => attributes.set(key, value), getAttribute: (key: string) => attributes.get(key), removeAttribute: (key: string) => attributes.delete(key),
      closest: () => editable ? result : null, contains: (other: unknown) => other === result,
      focus: vi.fn(() => { document.activeElement = result }), scrollIntoView: vi.fn(), click: vi.fn(),
      addEventListener: (name: string, handler: any) => { result.listeners[name] = handler },
    }
    return result
  }
  const nodes = new Map<string, any>(), samples = [node(), node(), node()]
  document.querySelector = (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector) }
  document.querySelectorAll = (selector: string) => selector === '#sample-list article' ? samples : []
  const plan = { version: 'm0', id: 'plan', revision: 1, digest: 'digest', sourceRoot: '/source', destinationRoot: '/output', items: [{ id: 'one', relativePath: 'one.txt', classification: 'text', destination: 'one.txt', status: 'ready' }] } as Plan
  const batch = { id: 'batch', revision: 1, digest: 'digest', sourceRoot: '/source', outputRoot: '/output', modules: [], samples: [] } as SpecBatchLike
  const html = kind === 'files' ? renderWorkbench(plan, { csrfToken: 'csrf' }) : renderSpecWorkbench(batch, { csrfToken: 'csrf' })
  const scripts = html.split('<script>').slice(1).map(part => part.split('</script>')[0]!)
  const window: any = {}
  new Function('window', scripts[0]!)(window)
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/plan' ? { plan } : { recipes: [], items: [], batch, samplesApproved: true, canApply: false } }))
  new Function('window', 'document', 'navigator', 'fetch', 'matchMedia', 'setTimeout', 'clearTimeout', scripts[1]!)(window, document, { language: 'en' }, fetch, () => ({ matches: false }), () => 0, () => {})
  const key = (key: string, overrides: Record<string, unknown> = {}) => {
    const event = { key, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: document.activeElement, preventDefault: vi.fn(), ...overrides }
    listeners.keydown!(event); return event
  }
  return { document, samples, node, key, fetch, html, approval: nodes.get(kind === 'spec' ? '#approve-button' : '#apply-button') }
}

describe.each(['files', 'spec'] as const)('%s review keyboard flow', kind => {
  it('navigates all samples in both directions and wraps with visible focus', () => {
    const { samples, document, key, html } = browser(kind)
    expect(key('ArrowDown').preventDefault).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(samples[0])
    key('ArrowDown'); expect(document.activeElement).toBe(samples[1])
    key('ArrowUp'); expect(document.activeElement).toBe(samples[0])
    key('ArrowUp'); expect(document.activeElement).toBe(samples[2])
    expect(samples[2].getAttribute('tabindex')).toBe('-1')
    expect(samples[2].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
    expect(html).toContain('id="keyboard-help"'); expect(html).toContain('aria-keyshortcuts="Alt+Shift+A"')
    expect(html).toContain('#sample-list article:focus')
  })

  it('leaves typing, composition, repeated keys and other modifier combinations alone', () => {
    const { key, samples, node, document } = browser(kind)
    const field = node(true); document.activeElement = field
    expect(key('ArrowDown').preventDefault).not.toHaveBeenCalled()
    expect(key('A', { shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    document.activeElement = null
    for (const override of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { defaultPrevented: true }, { altKey: false }, { shiftKey: true }]) expect(key('ArrowDown', override).preventDefault).not.toHaveBeenCalled()
    expect(samples.every(sample => sample.focus.mock.calls.length === 0)).toBe(true)
  })

  it('focuses an enabled approval without submitting and respects disabled/busy gates', async () => {
    const { key, approval, fetch, document } = browser(kind)
    const initialCalls = fetch.mock.calls.length
    approval.disabled = true
    expect(key('A', { shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    approval.disabled = false; approval.setAttribute('aria-busy', 'true')
    expect(key('a', { shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    approval.removeAttribute('aria-busy')
    expect(key('A', { shiftKey: true }).preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(approval); expect(approval.click).not.toHaveBeenCalled()
    expect(fetch.mock.calls.length).toBe(initialCalls)
    expect(key('Enter', { altKey: false }).preventDefault).not.toHaveBeenCalled()
    // Native Enter/Space activation uses this same existing click handler.
    await approval.listeners.click()
    const mutation = fetch.mock.calls.find(([url]) => url === (kind === 'spec' ? '/api/spec/approve' : '/api/apply')) as unknown as [string, RequestInit]
    expect(mutation).toBeDefined()
    expect(mutation[1].headers).toMatchObject({ 'X-DSH-CSRF': 'csrf' })
    expect(JSON.parse(mutation[1].body as string)).toMatchObject({ revision: 1, digest: 'digest' })
  })
})
