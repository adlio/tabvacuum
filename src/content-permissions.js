// Settings control for the optional website-access permission used by
// page-content search. It only asks for access when the user clicks the
// Allow button, and never reads page content itself.

export const CONTENT_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);

const IDS = {
  root: 'content-permissions',
  state: 'content-access-state',
  allow: 'content-access-allow',
  revoke: 'content-access-revoke',
  message: 'content-access-message',
};

const request = () => ({ origins: [...CONTENT_ORIGINS] });

export function startContentPermissions({ document, browser }) {
  const root = document.getElementById(IDS.root);
  const state = document.getElementById(IDS.state);
  const allow = document.getElementById(IDS.allow);
  const revoke = document.getElementById(IDS.revoke);
  const message = document.getElementById(IDS.message);
  if (!root || !state || !allow || !revoke || !message) return null;
  // Starting twice would register duplicate click and permission listeners.
  if (root.dataset.started === 'true') return null;
  root.dataset.started = 'true';

  const permissions = browser?.permissions;
  if (typeof permissions?.request !== 'function' || typeof permissions?.contains !== 'function') {
    state.textContent = 'Not available in this browser';
    allow.disabled = true;
    revoke.disabled = true;
    return null;
  }

  let checkId = 0;
  const say = text => { message.textContent = text; };

  async function refresh() {
    const id = ++checkId;
    try {
      const granted = await permissions.contains(request());
      if (id !== checkId) return;
      state.textContent = granted ? 'Allowed' : 'Not allowed';
      allow.disabled = granted;
      revoke.disabled = !granted || typeof permissions.remove !== 'function';
    } catch {
      if (id !== checkId) return;
      state.textContent = 'Could not check';
    }
  }

  function onAllowClick() {
    // Call request() before any await so the browser still sees the click
    // as the user gesture that permission prompts require.
    let pending;
    try {
      pending = permissions.request(request());
    } catch {
      say('Could not request website access.');
      return Promise.resolve();
    }
    say('Waiting for your browser…');
    return Promise.resolve(pending).then(
      granted => say(granted
        ? 'Website access allowed. Turn on page-content search in Search to use it.'
        : 'Website access was not allowed.'),
      () => say('Could not request website access.'),
    ).then(refresh);
  }

  async function onRevokeClick() {
    const confirm = document.defaultView?.confirm;
    if (typeof confirm === 'function' &&
        !confirm.call(document.defaultView, 'Remove website access? Page-content search will stop reading website tabs.')) {
      return;
    }
    try {
      const removed = await permissions.remove(request());
      say(removed ? 'Website access removed.' : 'Website access was not removed.');
    } catch {
      say('Could not remove website access.');
    }
    await refresh();
  }

  allow.addEventListener('click', onAllowClick);
  revoke.addEventListener('click', onRevokeClick);
  permissions.onAdded?.addListener?.(refresh);
  permissions.onRemoved?.addListener?.(refresh);

  const ready = refresh();
  return { refresh, ready, onAllowClick, onRevokeClick };
}

if (typeof document !== 'undefined' && typeof globalThis.browser !== 'undefined' &&
    document.getElementById(IDS.root)) {
  startContentPermissions({ document, browser: globalThis.browser });
}
