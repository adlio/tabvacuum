// Opens tab search over the current page, or in a separate extension window
// where pages can't be scripted. Authorization is a random per-launch token:
// the injected script hands it only to the extension-origin iframe, and the
// first valid claim binds it to that frame. Sessions live in storage.session
// so they survive worker suspension, and expire.
import { mountSearchOverlay } from './search-overlay.js';
import { normalizeQuery, normalizeSources } from './search-sources-core.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const UNCLAIMED_MS = 60_000;
export const SESSION_MS = 60 * 60_000;
export const CLAIM_TIMEOUT_MS = 4000;
const SIZE = { width: 640, height: 460, margin: 48 };

function randomId(bytes) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const newToken = () => randomId(32); // 43 characters, 256 bits

const denied = () => new Error('This search has expired. Reopen Search tabs.');

/** Center a width×height window over the origin window, when its bounds are known. */
export function placement(win) {
  const known = win && [win.left, win.top, win.width, win.height].every(Number.isFinite);
  if (!known) return { width: SIZE.width, height: SIZE.height };
  const width = Math.max(320, Math.min(SIZE.width, win.width - SIZE.margin));
  const height = Math.max(240, Math.min(SIZE.height, win.height - SIZE.margin));
  return {
    width, height,
    left: Math.round(win.left + (win.width - width) / 2),
    top: Math.round(win.top + (win.height - height) / 2),
  };
}

export function createSearchLauncher(api, search, {
  now = Date.now, schedule = setTimeout, claimTimeoutMs = CLAIM_TIMEOUT_MS, overlay = mountSearchOverlay,
} = {}) {
  // Chrome split contexts have distinct workers but share storage.session.
  // Each worker must own a distinct key so read/modify/write cannot race.
  const SESSIONS = api.extension?.inIncognitoContext ? 'search.sessions.private' : 'search.sessions';
  const searchUrl = api.runtime.getURL('search.html');
  const extensionOrigin = api.runtime.getURL('').replace(/\/$/, '');

  // Serializes session reads/writes within this worker; not an authority.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function load() {
    const stored = (await api.storage.session.get(SESSIONS))[SESSIONS];
    const sessions = {};
    for (const [token, session] of Object.entries(stored ?? {})) {
      if (TOKEN.test(token) && session?.expiresAt > now()) sessions[token] = session;
    }
    return sessions;
  }
  // Latest in-flight source query per search id. Every path that ends a search
  // (dismiss, activate, relaunch, tab close, navigation, expiry) saves the
  // sessions without it, so save() is the one place that aborts its scan.
  const sourceQueries = new Map();
  const save = sessions => {
    const live = new Set(Object.values(sessions).map(session => session.id));
    for (const [id, controller] of sourceQueries) {
      if (live.has(id)) continue;
      sourceQueries.delete(id);
      controller.abort(denied());
    }
    return api.storage.session.set({ [SESSIONS]: sessions });
  };

  const closeOverlay = session =>
    api.tabs.sendMessage(session.originTabId, { type: 'tabvacuum:close', id: session.id }, { frameId: 0 }).catch(() => {});
  const closeWindow = session =>
    session.launcherWindowId === undefined ? undefined : api.windows.remove(session.launcherWindowId).catch(() => {});
  const closeUi = session => (session.mode === 'overlay' ? closeOverlay(session) : closeWindow(session));

  // Overlay needs a scriptable web page; everything else gets the window.
  const canOverlay = tab => /^https?:\/\//.test(tab.url ?? '') && tab.active !== false;

  function launch(tab) {
    return serial(() => launchNow(tab, false));
  }

  async function launchNow(tab, windowOnly) {
    tab ??= (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!Number.isInteger(tab?.id)) throw new Error('There is no tab to search from.');
    const sessions = await load();
    const values = Object.values(sessions);

    // The shortcut pressed in our own search window, or for an origin that
    // already has one: bring that window forward instead of opening another.
    const existing = values.find(s => s.mode === 'window' && s.launcherWindowId !== undefined &&
      (s.launcherTabId === tab.id || s.originTabId === tab.id));
    if (existing) {
      await api.windows.update(existing.launcherWindowId, { focused: true });
      return { mode: 'window' };
    }
    if (search.isSearchPage(tab.url)) return { mode: 'none' }; // Stale search window.

    // One search at a time: a new launch revokes every earlier token.
    await save({});
    await Promise.all(values.map(closeUi));

    const base = {
      id: randomId(16), originTabId: tab.id, originUrl: tab.url, incognito: Boolean(tab.incognito),
      createdAt: now(), expiresAt: now() + UNCLAIMED_MS,
    };
    if (!windowOnly && canOverlay(tab)) {
      const token = newToken();
      const session = { ...base, mode: 'overlay' };
      await save({ [token]: session });
      try {
        const [injection] = await api.scripting.executeScript({
          target: { tabId: tab.id },
          func: overlay,
          args: [token, session.id, searchUrl, extensionOrigin],
        });
        if (injection?.result !== 'mounted') throw new Error('Overlay did not mount.');
        if (injection.documentId) {
          session.originDocumentId = injection.documentId;
          await save({ [token]: session });
        }
        schedule(() => { ensureClaimed(session.id).catch(() => {}); }, claimTimeoutMs);
        return { mode: 'overlay' };
      } catch {
        await save({});
        await closeOverlay(session);
      }
    }
    return openWindow(tab, base);
  }

  async function openWindow(tab, base) {
    const token = newToken();
    const session = { ...base, mode: 'window' };
    await save({ [token]: session });
    const origin = await api.windows.get(tab.windowId).catch(() => undefined);
    let created;
    try {
      created = await api.windows.create({
        url: `${searchUrl}?token=${token}`, type: 'popup', incognito: session.incognito, ...placement(origin),
      });
      const launcherTab = created.tabs?.[0] ?? (await api.tabs.query({ windowId: created.id }))[0];
      // A browser may refuse private extension windows and open a normal one.
      if (Boolean(created.incognito) !== session.incognito || !launcherTab) throw new Error('Wrong window.');
      session.launcherWindowId = created.id;
      session.launcherTabId = launcherTab.id;
      await save({ [token]: session });
      return { mode: 'window' };
    } catch (error) {
      await save({});
      if (created) await api.windows.remove(created.id).catch(() => {});
      throw error;
    }
  }

  // An overlay whose frame never claimed its token (page CSP, blocked frame,
  // broken UI) becomes a separate window rather than a blank modal.
  function ensureClaimed(id) {
    return serial(async () => {
      const sessions = await load();
      const entry = Object.entries(sessions).find(([, s]) => s.id === id);
      if (!entry || entry[1].frameId !== undefined) return;
      await save({});
      await closeOverlay(entry[1]);
      const tab = await api.tabs.get(entry[1].originTabId);
      const originWindow = await api.windows.get(tab.windowId);
      if (tab.url !== entry[1].originUrl || !tab.active || !originWindow.focused) return;
      await launchNow(tab, true);
    });
  }

  const withoutQuery = url => (typeof url === 'string' ? url.split(/[?#]/, 1)[0] : undefined);

  // Returns the token's session only for the frame it was issued to.
  async function authorize(message, sender, { allowOriginPage = false } = {}) {
    const { token } = message;
    if (sender?.id !== api.runtime.id || typeof token !== 'string' || !TOKEN.test(token)) throw denied();
    const sessions = await load();
    if (!Object.hasOwn(sessions, token)) throw denied();
    const session = sessions[token];
    const tab = sender.tab;
    if (!tab || tab.id !== (session.mode === 'overlay' ? session.originTabId : session.launcherTabId) ||
        Boolean(tab.incognito) !== session.incognito) throw denied();

    // The overlay's own top-frame script may dismiss it, nothing else.
    if (allowOriginPage && session.mode === 'overlay' && sender.frameId === 0 &&
        !String(sender.url ?? '').startsWith(extensionOrigin) &&
        (!session.originDocumentId || sender.documentId === session.originDocumentId)) {
      return { token, session, sessions, fromPage: true };
    }
    const placed = session.mode === 'overlay'
      ? sender.url === searchUrl && sender.frameId > 0
      : withoutQuery(sender.url) === searchUrl && sender.frameId === 0;
    if (!placed) throw denied();

    const documentId = sender.documentId ?? null;
    if (session.frameId === undefined) {
      session.frameId = sender.frameId;
      session.documentId = documentId;
      session.expiresAt = now() + SESSION_MS;
      await save(sessions);
    } else if (session.frameId !== sender.frameId || session.documentId !== documentId) {
      throw denied();
    }
    return { token, session, sessions, fromPage: false };
  }

  // The origin tab, live: it may have moved windows since launch.
  async function originOf(session) {
    const origin = await api.tabs.get(session.originTabId).catch(() => undefined);
    if (!origin || Boolean(origin.incognito) !== session.incognito) throw denied();
    return origin;
  }

  async function getSearchContext(message, sender) {
    const { session } = await authorize(message, sender);
    const origin = await originOf(session);
    return search.getContext(origin.windowId, { currentTabId: origin.id });
  }

  async function activateSearchTab(message, sender) {
    const { token, session, sessions } = await authorize(message, sender);
    const origin = await originOf(session);
    await search.activate(message.tabId, origin.windowId);
    delete sessions[token]; // Single use: a replayed activation finds nothing.
    await save(sessions);
    await closeUi(session);
    return { ok: true };
  }

  async function dismissSearch(message, sender) {
    const { token, session, sessions, fromPage } = await authorize(message, sender, { allowOriginPage: true });
    delete sessions[token];
    await save(sessions);
    if (session.mode === 'overlay') {
      if (!fromPage) await closeOverlay(session);
    } else {
      // Return to the page the search was opened from, without navigating it.
      const origin = await api.tabs.get(session.originTabId).catch(() => undefined);
      if (origin) {
        await api.tabs.update(origin.id, { active: true }).catch(() => {});
        await api.windows.update(origin.windowId, { focused: true }).catch(() => {});
      }
      await closeWindow(session);
    }
    return { ok: true };
  }

  // Closes only the explicit IDs the user approved. The search stays open
  // for further work unless its origin tab was among those closed.
  async function closeSearchTabs(message, sender) {
    const { token, session, sessions } = await authorize(message, sender);
    const origin = await originOf(session);
    const result = await search.closeSelected(message.tabIds, origin.windowId, { originTabId: origin.id });
    if (result.closedIds.includes(origin.id)) {
      // Nothing to return to: revoke now rather than waiting for the queued
      // onRemoved cleanup, and don't leave a fallback window behind.
      delete sessions[token];
      await save(sessions);
      await closeUi(session);
    }
    return result;
  }

  // History result: opened (or focused) only if still in history. Single use, like a tab.
  async function activateHistoryResult(message, sender) {
    const { token, session, sessions } = await authorize(message, sender);
    if (session.incognito) throw new Error('History is not searched in private windows.');
    const origin = await originOf(session);
    await search.activateHistory(message.url, origin.windowId);
    delete sessions[token];
    await save(sessions);
    await closeUi(session);
    return { ok: true };
  }

  // Shows the options page, where the user can grant access. Grants nothing itself.
  async function openSearchPermissions(message, sender) {
    await authorize(message, sender);
    await api.runtime.openOptionsPage();
    return { ok: true };
  }

  const superseded = () => new Error('A newer search replaced this one.');
  const noContentPermission = () => ({ results: [],
    coverage: { state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 } });

  // Authorizes and snapshots inside the serialized queue, scans outside it so
  // slow pages never delay launch/close, then re-authorizes before answering.
  async function querySearchSources(message, sender) {
    const query = normalizeQuery(message.query);
    const sources = normalizeSources(message.sources);
    const snapshot = await serial(async () => {
      const { session } = await authorize(message, sender);
      const origin = await originOf(session);
      // Registered inside the queue, so any later save() that ends this search aborts it.
      sourceQueries.get(session.id)?.abort(superseded());
      const controller = new AbortController();
      sourceQueries.set(session.id, controller);
      return { id: session.id, incognito: session.incognito, windowId: origin.windowId, controller };
    });
    const { controller } = snapshot;
    const { signal } = controller;
    try {
      const off = { history: { state: 'off', limited: false },
        content: { state: 'off', searched: 0, total: 0, skipped: 0, truncated: 0 } };
      const [history, scanned] = await Promise.all([
        sources.history ? search.searchHistory(query, snapshot.windowId) : { results: [], coverage: off.history },
        sources.content ? search.searchContent(query, snapshot.windowId, { signal })
          : { results: [], coverage: off.content },
      ]);
      let content = scanned;
      if (signal.aborted) throw signal.reason;
      await serial(async () => {
        const { session } = await authorize(message, sender);
        const origin = await originOf(session);
        if (session.id !== snapshot.id || origin.windowId !== snapshot.windowId) throw denied();
      });
      // Website access may have been revoked after the pages were read.
      if (sources.content && content.coverage.state !== 'permission' && !await search.hasContentPermission()) {
        content = noContentPermission();
      }
      if (signal.aborted) throw signal.reason;
      return {
        history: history.results, content: content.results,
        coverage: { history: history.coverage, content: content.coverage },
        incognito: snapshot.incognito,
      };
    } finally {
      if (sourceQueries.get(snapshot.id) === controller) sourceQueries.delete(snapshot.id);
    }
  }

  const handlers = {
    getSearchContext, activateSearchTab, dismissSearch, closeSearchTabs,
    activateHistoryResult, openSearchPermissions, querySearchSources,
  };
  // Handlers that serialize their own critical sections.
  const unqueued = new Set(['querySearchSources']);

  /** Handles search commands; returns undefined for anything else. */
  function handleMessage(message, sender) {
    if (!Object.hasOwn(handlers, message?.command)) return undefined;
    if (sender?.id !== api.runtime.id || !sender.tab || typeof message.token !== 'string' || !TOKEN.test(message.token)) {
      return Promise.reject(denied());
    }
    // Unrelated public frames must not occupy the launch/activation queue.
    // This preflight is not authorization: recheck inside the serialized handler.
    return load().then(sessions => {
      const session = sessions[message.token];
      if (!session || sender.tab.id !== (session.mode === 'overlay' ? session.originTabId : session.launcherTabId)) {
        // A fallback page may load before windows.create returns its tab ID.
        if (!(session?.mode === 'window' && session.launcherTabId === undefined &&
            withoutQuery(sender.url) === searchUrl && sender.frameId === 0)) throw denied();
      }
      const handler = handlers[message.command];
      return unqueued.has(message.command) ? handler(message, sender) : serial(() => handler(message, sender));
    });
  }

  function installCleanup() {
    api.tabs.onUpdated.addListener((tabId, changes) => {
      if (changes.status !== 'loading') return;
      serial(async () => {
        const sessions = await load();
        const ended = Object.entries(sessions).filter(([, s]) => s.originTabId === tabId);
        if (!ended.length) return;
        for (const [token] of ended) delete sessions[token];
        await save(sessions);
        await Promise.all(ended.map(([, s]) => closeUi(s)));
      }).catch(() => {});
    });
    api.tabs.onRemoved.addListener(tabId => {
      serial(async () => {
        const sessions = await load();
        const ended = Object.entries(sessions).filter(([, s]) => s.originTabId === tabId || s.launcherTabId === tabId);
        if (!ended.length) return;
        for (const [token] of ended) delete sessions[token];
        await save(sessions);
        // A search window has nothing to return to once its origin is gone.
        await Promise.all(ended.filter(([, s]) => s.launcherTabId !== tabId).map(([, s]) => closeWindow(s)));
      }).catch(() => {});
    });
  }

  return { launch, handleMessage, installCleanup };
}
