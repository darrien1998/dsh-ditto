/** Shared inline keyboard controller; activation remains the native button's Enter/Space action. */
export function reviewKeyboardScript(approvalSelector: '#approve-button' | '#apply-button'): string {
  return String.raw`(() => {
    if (typeof document.addEventListener !== 'function') return;
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target && target.closest && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      if (event.shiftKey && event.key.toLowerCase() === 'a') {
        const button = document.querySelector(${JSON.stringify(approvalSelector)});
        if (!button || button.disabled || button.hidden || button.getAttribute('aria-busy') === 'true') return;
        event.preventDefault(); button.focus(); return;
      }
      if (event.shiftKey || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const samples = [...document.querySelectorAll('#sample-list article')].filter(node => !node.hidden);
      if (!samples.length) return;
      const current = samples.findIndex(node => node === document.activeElement || node.contains(document.activeElement));
      const index = current < 0 ? (event.key === 'ArrowDown' ? 0 : samples.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + samples.length) % samples.length;
      event.preventDefault(); const sample = samples[index]; sample.setAttribute('tabindex', '-1'); sample.focus();
      sample.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  })();`
}

export const REVIEW_KEYBOARD_HELP = 'Keyboard: Alt + ↓ / ↑ moves between samples. Alt + Shift + A focuses approval; Enter or Space activates it. Shortcuts stay inactive while typing.'
