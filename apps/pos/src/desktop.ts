// On a PC Nuskha should behave like software, not like a web page: no browser right-click menu
// (except in boxes you type in, for cut / copy / paste), no browser shortcuts such as Inspect,
// Find, Save page or the browser's own Print, no dragging pictures or links out, and no selecting
// the text of menus and buttons. Tables, receipts and messages can still be selected and copied.
// It is on in Nuskha Local, in Nuskha HQ and in an app window; a normal browser tab is left alone.

const BLOCKED = new Set(['i', 'j', 'c', 'k']); // with Ctrl+Shift: developer tools
const BLOCKED_CTRL = new Set(['u', 's', 'f', 'g', 'p', 'd', 'h', 'j', 'o', 'e', 'l']);

const editable = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/** An app window (Edge --app, an installed app): no browser toolbar. */
export const inAppWindow = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches ||
  window.toolbar?.visible === false;

export function softwareMode(always = false) {
  if (!always && !inAppWindow()) return;
  document.documentElement.classList.add('software');
  document.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', (e) => { if (!editable(e.target)) e.preventDefault(); }, true);
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    // F12 stays for "complete the sale" (the POS still receives it); it only stops the browser tools.
    if (e.key === 'F12' || e.key === 'F3' || e.key === 'F7' || e.key === 'BrowserSearch') { e.preventDefault(); return; }
    if (ctrl && e.shiftKey && BLOCKED.has(k)) { e.preventDefault(); e.stopPropagation(); return; }
    // Browser shortcuts (Find, Print page, Save page, View source, History …). Copy, cut, paste, undo
    // and select-all are not in the list; Nuskha's own Ctrl shortcuts (U, M, K, Delete) still arrive.
    if (ctrl && !e.shiftKey && !e.altKey && BLOCKED_CTRL.has(k)) e.preventDefault();
  }, true);
}
