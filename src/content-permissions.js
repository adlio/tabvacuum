// Settings controls for the optional permissions Search uses: website access
// for page-content search, and bookmark access (R15). Each asks for access only
// when the user clicks its Allow button, and never reads pages or bookmarks itself.

export const CONTENT_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);

const CONTENT = {
  ids: {
    root: 'content-permissions',
    state: 'content-access-state',
    allow: 'content-access-allow',
    revoke: 'content-access-revoke',
    message: 'content-access-message',
  },
  request: () => ({ origins: [...CONTENT_ORIGINS] }),
  text: {
    name: 'website access',
    allowed: 'Website access allowed. Turn on page-content search in Search to use it.',
    denied: 'Website access was not allowed.',
    failed: 'Could not request website access.',
    confirm: 'Remove website access? Page-content search will stop reading website tabs.',
    removed: 'Website access removed.',
    notRemoved: 'Website access was not removed.',
    removeFailed: 'Could not remove website access.',
  },
};

const BOOKMARKS = {
  ids: {
    root: 'bookmark-permissions',
    state: 'bookmark-access-state',
    allow: 'bookmark-access-allow',
    revoke: 'bookmark-access-revoke',
    message: 'bookmark-access-message',
  },
  request: () => ({ permissions: ['bookmarks'] }),
  text: {
    allowed: 'Bookmark access allowed. Turn on Bookmarks in Search to use it.',
    denied: 'Bookmark access was not allowed.',
    failed: 'Could not request bookmark access.',
    confirm: 'Remove bookmark access? Search will stop listing bookmarks.',
    removed: 'Bookmark access removed.',
    notRemoved: 'Bookmark access was not removed.',
    removeFailed: 'Could not remove bookmark access.',
  },
};

function startPermissionControl({ document, browser }, { ids, request, text }) {
  const root = document.getElementById(ids.root);
  const state = document.getElementById(ids.state);
  const allow = document.getElementById(ids.allow);
  const revoke = document.getElementById(ids.revoke);
  const message = document.getElementById(ids.message);
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
  const say = value => { message.textContent = value; };

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
      say(text.failed);
      return Promise.resolve();
    }
    say('Waiting for your browser…');
    return Promise.resolve(pending).then(
      granted => say(granted ? text.allowed : text.denied),
      () => say(text.failed),
    ).then(refresh);
  }

  async function onRevokeClick() {
    const confirm = document.defaultView?.confirm;
    if (typeof confirm === 'function' && !confirm.call(document.defaultView, text.confirm)) return;
    try {
      const removed = await permissions.remove(request());
      say(removed ? text.removed : text.notRemoved);
    } catch {
      say(text.removeFailed);
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

export function startContentPermissions(env) {
  return startPermissionControl(env, CONTENT);
}

export function startBookmarkPermissions(env) {
  return startPermissionControl(env, BOOKMARKS);
}

if (typeof document !== 'undefined' && typeof globalThis.browser !== 'undefined') {
  if (document.getElementById(CONTENT.ids.root)) startContentPermissions({ document, browser: globalThis.browser });
  if (document.getElementById(BOOKMARKS.ids.root)) startBookmarkPermissions({ document, browser: globalThis.browser });
}
