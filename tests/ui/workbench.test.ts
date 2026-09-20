import { describe, expect, it } from 'vitest';
import { renderWorkbench, representativeItems } from '../../src/ui/workbench.js';
import type { Plan, PlanItem } from '../../src/core/types.js';
import { supportedUiLocales, uiStrings } from '../../src/ui/strings.js';

const item = (id: string, relativePath: string, classification: string): PlanItem => ({
  id, source: `C:/source/${relativePath}`, relativePath, destination: `${classification}/${relativePath}`,
  sourceHash: id, classification, status: 'ready',
});

const plan = (items: PlanItem[]): Plan => ({
  version: 'm0', id: 'plan', revision: 1, digest: 'digest', createdAt: '2026-09-14T00:00:00.000Z',
  sourceRoot: 'C:/source', destinationRoot: 'C:/output',
  recipe: { version: 1, id: 'recipe', name: 'Default rule', createdAt: '2026-09-14T00:00:00.000Z', pattern: '{stem}', classification: { kind: 'folder-prefix' } },
  items, summary: { total: items.length, ready: items.length, applied: 0, rejected: 0, failed: 0 },
});

async function submitRecipe(postSucceeds: boolean, lang?: 'en' | 'zh-TW', browserLanguage = 'en-US') {
  const saveButton = createNode();
  const recipeForm = createNode();
  recipeForm.querySelector = () => saveButton;
  const nodes = new Map<string, ReturnType<typeof createNode>>();
  for (const id of ['sample-list', 'batch-list', 'batch-count', 'ready-count', 'problem-count', 'source-count', 'source-root', 'destination-root', 'apply-button', 'revise-button', 'pending-note', 'network-error', 'toast', 'results', 'recipe-list', 'recipe-name']) nodes.set(`#${id}`, createNode());
  nodes.set('#recipe-form', recipeForm);
  nodes.get('#recipe-name')!.value = 'My recipe';
  const document = {
    documentElement: { lang: '', setAttribute: () => undefined }, title: 'Ditto · Organise files',
    querySelector: (selector: string) => selector === '[data-digest]' ? createNode() : nodes.get(selector),
    querySelectorAll: () => [],
    getElementById: () => createNode(),
  };
  const html = renderWorkbench(plan([item('x', 'one.pdf', 'documents')]), { csrfToken: 'csrf', lang });
  const script = html.split('<script>').slice(1).map((part) => part.split('</script>')[0])[1]!;
  const window = { __DSH_DITTO_BOOT__: { plan: plan([item('x', 'one.pdf', 'documents')]), options: { csrfToken: 'csrf', apiBase: '', lang, strings: uiStrings } } };
  const fetch = async (_url: string, init?: { method?: string }) => ({
    ok: init?.method === 'POST' ? postSucceeds : true,
    json: async () => init?.method === 'POST' ? (postSucceeds ? {} : { error: 'Save failed' }) : { recipes: [] },
  });
  new Function('window', 'document', 'navigator', 'fetch', 'matchMedia', 'setTimeout', 'clearTimeout', script)(window, document, { language: browserLanguage }, fetch, () => ({ matches: true }), () => 0, () => undefined);
  await recipeForm.listeners.submit({ preventDefault: () => undefined, currentTarget: recipeForm });
  return { saveButton, locale: document.documentElement.lang };
}

function createNode() {
  const attributes = new Map<string, string>();
  return {
    disabled: false, hidden: false, value: '', textContent: '', innerHTML: '', dataset: {} as Record<string, string>, listeners: {} as Record<string, (event: any) => Promise<void> | void>,
    setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name),
    addEventListener(name: string, listener: (event: any) => Promise<void> | void) { this.listeners[name] = listener; }, querySelector: () => undefined,
    focus: () => undefined, scrollIntoView: () => undefined, hasAttribute: (name: string) => attributes.has(name),
  };
}

describe('workbench', () => {
  it('varies the three deterministic samples by actual type before file order', () => {
    const samples = representativeItems([
      item('one', 'a/first.pdf', 'documents'), item('two', 'b/second.docx', 'documents'),
      item('three', 'c/photo.png', 'images'), item('four', 'd/notes.txt', 'text'),
    ]);
    expect(samples.map((value) => value.id)).toEqual(['one', 'two', 'three']);
  });

  it('escapes plan values and emits parsable browser JavaScript with real loopback routes', () => {
    const html = renderWorkbench(plan([item('x', 'x</script><img src=x onerror=alert(1)>.pdf', 'documents')]), { csrfToken: 'csrf</script>', apiBase: '' });
    expect(html).toContain('x&lt;/script&gt;&lt;img');
    expect(html).not.toContain('x</script><img');
    expect(html).toContain('/api/recipe/load');
    expect(html).toContain('/api/revise');
    const scripts = html.split('<script>').slice(1).map((part) => part.split('</script>')[0]);
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts[1]!)).not.toThrow();
  });

  it.each([true, false])('re-enables the save-recipe button after a %s request result', async (postSucceeds) => {
    const { saveButton: button } = await submitRecipe(postSucceeds);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('resolves explicit locale before browser locale and falls back for unsupported browser locales', async () => {
    await expect(submitRecipe(true, 'zh-TW', 'en-US')).resolves.toMatchObject({ locale: 'zh-TW' });
    await expect(submitRecipe(true, undefined, 'zh-TW')).resolves.toMatchObject({ locale: 'zh-TW' });
    await expect(submitRecipe(true, undefined, 'fr-FR')).resolves.toMatchObject({ locale: 'en' });
  });

  it('defines every UI key for every supported locale', () => {
    const englishKeys = Object.keys(uiStrings.en).sort();
    for (const locale of supportedUiLocales) expect(Object.keys(uiStrings[locale]).sort()).toEqual(englishKeys);
  });
});
