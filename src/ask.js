// ask.js — Ask first prompt (R14.11). Shown in a new tab whose page is already
// open. The page names no URL or tab: the background looks both up from the
// tab this page runs in, and decides what Switch and Keep both do.

export function startAsk({ document, browser, location = globalThis.location }) {
  const $ = id => document.getElementById(id);
  const form = $('ask-form');
  const status = $('ask-status');
  const buttons = [$('ask-switch'), $('ask-keep')];
  let busy = false;

  const showStatus = text => { status.hidden = false; status.textContent = text; };

  function show(reply) {
    if (reply?.state !== 'ask') {
      form.hidden = true;
      showStatus(reply?.error ? `Could not load this prompt: ${reply.error}`
        : reply?.state === 'lost' ? 'This prompt has expired, and the page it was for is no longer in this tab. Open the page again from where you found it.'
          : 'Opening the page…');
      return;
    }
    $('ask-title').textContent = reply.title;
    $('ask-detail').textContent = `${reply.host} is already open${reply.otherWindow ? ' in another window' : ''}. Switch to it, or keep this tab too.`;
    form.hidden = false;
    status.hidden = true;
    $('ask-switch').focus();
  }

  async function choose(choice) {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    try {
      const reply = await browser.runtime.sendMessage({ command: 'dupeAskChoice', choice });
      if (reply?.error) throw new Error(reply.error);
      // Keep both: replace the prompt with the page, leaving no prompt in history.
      if (reply?.state === 'kept' && /^https?:\/\//i.test(reply.url ?? '')) { location.replace(reply.url); return; }
      showStatus(choice === 'switch' ? 'Switching…' : 'Opening the page…');
      form.hidden = true;
    } catch (err) {
      busy = false;
      for (const b of buttons) b.disabled = false;
      showStatus(`Something went wrong: ${err?.message ?? err}`);
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); choose('switch'); });
  $('ask-keep').addEventListener('click', () => choose('keep'));

  const ready = browser.runtime.sendMessage({ command: 'dupeAskInfo' })
    .then(show, err => show({ error: String(err?.message ?? err) }));
  return { ready, choose };
}

if (globalThis.browser?.runtime && globalThis.document?.getElementById('ask-form')) {
  startAsk({ document, browser });
}
