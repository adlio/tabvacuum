// Injected with scripting.executeScript({ func, args }) into the top frame only.
// It must stay self-contained: the browser serializes this function's source.
//
// The page sees only an empty custom element. Tab titles, URLs, and queries
// live in the extension-origin iframe; the launch token lives in this isolated
// world's closure and is posted only to the iframe, restricted to the extension
// origin. The iframe talks to the background directly; this script never
// relays data. It can only dismiss its own overlay.
export function mountSearchOverlay(token, sessionId, frameUrl, extensionOrigin) {
  const api = globalThis.browser ?? globalThis.chrome;
  if (window.top !== window) return 'refused';
  globalThis.__tabvacuumSearch?.remove({ notify: false });

  const previousFocus = document.activeElement;
  const host = document.createElement('tabvacuum-search');
  // Inline !important beats ordinary page resets such as `* { display: none }`.
  for (const [name, value] of [['display', 'block'], ['position', 'fixed'], ['width', '0'], ['height', '0']]) {
    host.style.setProperty(name, value, 'important');
  }
  const root = host.attachShadow({ mode: 'closed' });
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'Search tabs');
  const frame = document.createElement('iframe');
  frame.title = 'Search tabs';
  frame.setAttribute('referrerpolicy', 'no-referrer');

  // CSSOM and constructed sheets are not blocked by page style-src policies.
  const place = (element, styles) => {
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  place(dialog, {
    width: 'min(640px, calc(100vw - 48px))', height: 'min(460px, calc(100vh - 48px))',
    'max-width': 'none', 'max-height': 'none', margin: 'auto', padding: '0', border: '0',
    'border-radius': '12px', overflow: 'hidden', background: 'transparent',
    'box-shadow': '0 24px 64px rgba(0, 0, 0, 0.35)',
  });
  place(frame, { display: 'block', width: '100%', height: '100%', border: '0', background: 'transparent' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('dialog::backdrop { background: rgba(0, 0, 0, 0.35); }');
    root.adoptedStyleSheets = [sheet];
  } catch { /* Backdrop tint is cosmetic; the modal still isolates the page. */ }

  let removed = false;
  function remove({ notify = true } = {}) {
    if (removed) return;
    removed = true;
    window.removeEventListener('pagehide', onPageHide, true);
    window.removeEventListener('message', onFrameMessage, true);
    if (globalThis.__tabvacuumSearch?.id === sessionId) globalThis.__tabvacuumSearch = undefined;
    try { dialog.close(); } catch { /* Already closed. */ }
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    if (notify) api.runtime.sendMessage({ command: 'dismissSearch', token }).catch(() => {});
  }
  const onPageHide = () => remove();
  const onFrameMessage = event => {
    if (event.source === frame.contentWindow && event.origin === extensionOrigin &&
        event.data?.type === 'tabvacuum:escape') remove();
  };
  window.addEventListener('message', onFrameMessage, true);

  frame.addEventListener('load', () => {
    // Target origin keeps the token from a frame the page navigated elsewhere.
    frame.contentWindow?.postMessage({ type: 'tabvacuum:init', token }, extensionOrigin);
    frame.focus();
  }, { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); remove(); });
  // The frame fills the dialog, so a click on the dialog itself is the backdrop.
  dialog.addEventListener('click', event => { if (event.target === dialog) remove(); });
  window.addEventListener('pagehide', onPageHide, true);

  if (!globalThis.__tabvacuumCloseListener) {
    globalThis.__tabvacuumCloseListener = (message, sender) => {
      if (sender?.id !== api.runtime.id || message?.type !== 'tabvacuum:close') return;
      const current = globalThis.__tabvacuumSearch;
      if (current && current.id === message.id) current.remove({ notify: false });
    };
    api.runtime.onMessage.addListener(globalThis.__tabvacuumCloseListener);
  }
  globalThis.__tabvacuumSearch = { id: sessionId, remove };

  frame.src = frameUrl;
  dialog.append(frame);
  root.append(dialog);
  document.documentElement.append(host);
  try {
    dialog.showModal();
  } catch {
    remove({ notify: false });
    return 'failed';
  }
  return 'mounted';
}
