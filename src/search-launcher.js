// Opens tab search over the current page, or in a separate extension window
// where pages can't be scripted. Authorization is a random per-launch token:
// the injected script hands it only to the extension-origin iframe, and the
// first valid claim binds it to that frame. Sessions live in storage.session
// so they survive worker suspension, and expire.
import { mountSearchOverlay } from './search-overlay.js';
import { normalizeQuery, normalizeSources, withTimeout } from './search-sources-core.js';
import { validateTabIds } from './search-service.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const UNCLAIMED_MS = 60_000;
export const SESSION_MS = 60 * 60_000;
export const CLAIM_TIMEOUT_MS = 4000;
// Closing the tab that hosts an embedded search first moves search elsewhere.
// Each replacement gets READY_MS to initialize; the original stays inert for
// at most HANDOFF_MS, even if the worker restarts mid-handoff.
export const READY_MS = 4000;
export const HANDOFF_MS = 15_000;
export const HANDOFF_RESULT_MS = 30_000;
const MAX_STATE_TEXT = 8192;
const MODES = new Set(['search', 'tabs', 'select']);
const FOCUS = new Set(['query', 'list', 'row-close']);
const SIZE = { width: 640, height: 460, margin: 48 };

function randomId(bytes) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const newToken = () => randomId(32); // 43 characters, 256 bits

const denied = () => new Error('This search has expired. Reopen Search tabs.');
const ints = (value, max) => (Array.isArray(value) ? [...new Set(value.filter(Number.isSafeInteger))].slice(0, max) : []);

/**
 * What the replacement search restores: copied field by field from the
 * closing frame's request, so nothing else it sent is ever stored or replayed.
 */
export function handoffState(raw, closing) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const text = value => (typeof value === 'string' && value.length <= MAX_STATE_TEXT ? value : '');
  const mode = MODES.has(state.mode) ? state.mode : 'tabs';
  const focus = FOCUS.has(state.focus) ? state.focus : 'list';
  return {
    query: text(state.query), mode,
    sources: normalizeSources(state.sources),
    highlight: text(state.highlight),
    checked: mode === 'select' ? ints(state.checked, closing.length + 10_000) : [],
    // The query owns focus only in search mode, as in the search page itself.
    focus: mode === 'search' || focus !== 'query' ? focus : 'list',
    focusTabId: Number.isSafeInteger(state.focusTabId) ? state.focusTabId : undefined,
    closing: [...closing],
  };
}

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
  // Replacement searches waiting to initialize, by replacement session id.
  // Memory only wakes a waiter; storage stays the authority.
  const handoffs = new Map();
  const save = sessions => {
    const live = new Set(Object.values(sessions).map(session => session.id));
    for (const [id, controller] of sourceQueries) {
      if (live.has(id)) continue;
      sourceQueries.delete(id);
      controller.abort(denied());
    }
    for (const [id, handoff] of handoffs) {
      if (!live.has(id) || !live.has(handoff.originalId)) handoff.settle(false);
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
    await createWindow(newToken(), { ...base, mode: 'window' }, tab.windowId, {});
    return { mode: 'window' };
  }

  // Adds a window session to `sessions` and opens its window. On failure,
  // removes both and rethrows. Callers hold the serialized queue.
  async function createWindow(token, session, windowId, sessions) {
    sessions[token] = session;
    await save(sessions);
    const origin = await api.windows.get(windowId).catch(() => undefined);
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
      await save(sessions);
    } catch (error) {
      delete sessions[token];
      await save(sessions);
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
  // A replacement still being prepared may only load and report readiness;
  // a search handing off may only be dismissed (which cancels the handoff).
  async function authorize(message, sender, { allowOriginPage = false, allowPending = false, allowHandingOff = false } = {}) {
    const { token } = message;
    if (sender?.id !== api.runtime.id || typeof token !== 'string' || !TOKEN.test(token)) throw denied();
    const sessions = await load();
    if (!Object.hasOwn(sessions, token)) throw denied();
    const session = sessions[token];
    if ((session.pending && !allowPending) || (handingOff(session) && !allowHandingOff)) throw denied();
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

  const handingOff = session => session.handoff?.until > now();

  // The origin tab, live: it may have moved windows since launch. A search
  // window that replaced a closed host keeps that host's window as its scope.
  async function originOf(session) {
    const origin = await api.tabs.get(session.originTabId).catch(() => undefined);
    if (origin && Boolean(origin.incognito) === session.incognito) return origin;
    if (origin || session.scopeWindowId === undefined) throw denied();
    const window = await api.windows.get(session.scopeWindowId).catch(() => undefined);
    if (!window || Boolean(window.incognito) !== session.incognito) throw denied();
    const [active] = await api.tabs.query({ windowId: session.scopeWindowId, active: true }).catch(() => []);
    return { id: active?.id, windowId: session.scopeWindowId };
  }

  const contextOf = async session => {
    const origin = await originOf(session);
    return search.getContext(origin.windowId, { currentTabId: origin.id });
  };

  async function getSearchContext(message, sender) {
    const { session, sessions } = await authorize(message, sender, { allowPending: true });
    if (!session.pending) return contextOf(session);
    // A replacement gets the closing search's state once, and only while its
    // destination is still valid.
    if (!await handoffTarget(session, sessions)) throw denied();
    const context = await contextOf(session);
    const restore = session.pending.delivered ? undefined : session.pending.state;
    session.pending.delivered = true;
    await save(sessions);
    return restore ? { ...context, restore } : context;
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

  // Dismissing a search that is handing off, or a replacement being
  // prepared, cancels the handoff: nothing closes.
  async function dismissSearch(message, sender) {
    const { token, session, sessions, fromPage } = await authorize(message, sender,
      { allowOriginPage: true, allowPending: true, allowHandingOff: true });
    delete sessions[token];
    await save(sessions);
    if (session.mode === 'overlay') {
      if (!fromPage) await closeOverlay(session);
    } else {
      // Return to the page the search was opened from, without navigating it.
      const origin = await originOf(session).catch(() => undefined);
      if (Number.isInteger(origin?.id)) {
        await api.tabs.update(origin.id, { active: true }).catch(() => {});
        await api.windows.update(origin.windowId, { focused: true }).catch(() => {});
      }
      await closeWindow(session);
    }
    return { ok: true };
  }

  // The fresh list a search shows after closing, read in the same reply so
  // the UI need not ask again. A failed read is reported, never retried here.
  async function withContext(result, session) {
    try {
      return { ...result, context: await contextOf(session) };
    } catch {
      return { ...result, contextError: true };
    }
  }

  // Closes only the explicit IDs the user approved. The search stays open
  // for further work. Closing the tab that hosts an embedded search first
  // moves the search (see handOff). A search window that closes its own
  // origin keeps working, scoped to that origin's window.
  async function closeSearchTabs(message, sender) {
    const plan = await serial(async () => {
      const { token, session, sessions } = await authorize(message, sender);
      const origin = await originOf(session);
      const ids = validateTabIds(message.tabIds);
      if (session.mode === 'overlay' && ids.includes(origin.id) &&
          await search.closeSkipReason(origin.id, origin.windowId, { closing: ids }) === undefined) {
        const attempt = { id: randomId(16), token, sessionId: session.id, hostId: origin.id,
          incognito: session.incognito, ids, state: handoffState(message.state, ids) };
        session.handoff = { id: attempt.id, until: now() + HANDOFF_MS };
        await save(sessions);
        return { attempt };
      }
      const result = await search.closeSelected(ids, origin.windowId, { originTabId: origin.id });
      if (result.closedIds.includes(origin.id) && session.mode === 'window') {
        // The window outlives an origin it closed itself, keeping that window
        // as its scope. Saved before the queued onRemoved cleanup runs.
        session.scopeWindowId ??= origin.windowId;
        await save(sessions);
      } else if (result.closedIds.includes(origin.id)) {
        // An overlay that could not hand off has nothing left: revoke now.
        delete sessions[token];
        await save(sessions);
        await closeUi(session);
        return { result };
      }
      return { result: await withContext(result, session) };
    });
    return plan.result ?? handOff(plan.attempt);
  }

  /**
   * Moves an embedded search off the tab about to close, then closes the
   * batch. Tries an overlay on an already-permitted surviving page in the
   * same window, then a separate search window. Nothing closes unless one
   * replacement has authenticated, received the state and reported ready.
   * Waiting happens outside the serialized queue, so the replacement's own
   * (serialized) messages cannot deadlock behind this close.
   */
  async function handOff(attempt) {
    for (const prepare of [prepareOverlay, prepareWindow]) {
      const target = await serial(() => prepare(attempt));
      if (!target) continue;
      const ready = await target.ready;
      const result = await serial(() => commit(attempt, target, ready));
      if (result) return result;
    }
    await serial(async () => {
      const sessions = await load();
      const original = sessions[attempt.token];
      if (original?.handoff?.id !== attempt.id) throw denied();
      delete original.handoff; // Usable again: the request failed as a whole.
      await save(sessions);
    });
    return { ok: false, handoffFailed: true, closedIds: [], skipped: [], failedIds: [] };
  }

  // The original search, if it is still handing off this attempt.
  function originalOf(attempt, sessions) {
    const original = sessions[attempt.token];
    return original?.handoff?.id === attempt.id && handingOff(original) ? original : undefined;
  }

  function track(session, originalId) {
    let settle;
    const ready = new Promise(resolve => { settle = resolve; });
    let deliver;
    const result = new Promise(resolve => { deliver = resolve; });
    const handoff = { originalId, ready, result, deliver, settle: value => settle(value) };
    handoffs.set(session.id, handoff);
    schedule(() => settle(false), READY_MS);
    return handoff;
  }

  function pendingSession(attempt, fields) {
    return {
      id: randomId(16), incognito: attempt.incognito, createdAt: now(), expiresAt: now() + HANDOFF_MS,
      pending: { attempt: attempt.id, state: attempt.state, delivered: false, ready: false }, ...fields,
    };
  }

  // Uses only website access the user already granted: activeTab does not
  // carry over to another tab, and nothing here may prompt.
  async function prepareOverlay(attempt) {
    const sessions = await load();
    if (!originalOf(attempt, sessions)) throw denied();
    const host = await api.tabs.get(attempt.hostId).catch(() => undefined);
    if (!host || !await search.hasContentPermission()) return undefined;
    const [tab] = await search.handoffTargets(host, attempt.ids);
    if (!tab) return undefined;
    const token = newToken();
    const session = pendingSession(attempt, { mode: 'overlay', originTabId: tab.id, originUrl: tab.url });
    sessions[token] = session;
    await save(sessions);
    const { ready } = track(session, attempt.sessionId);
    try {
      // Bounded: this holds the serialized queue, and a page may never answer.
      const [injection] = await withTimeout(api.scripting.executeScript({
        target: { tabId: tab.id },
        func: overlay,
        args: [token, session.id, searchUrl, extensionOrigin],
      }), READY_MS, schedule);
      if (injection?.result !== 'mounted') throw new Error('Overlay did not mount.');
      if (injection.documentId) {
        session.originDocumentId = injection.documentId;
        await save(sessions);
      }
    } catch {
      await drop(token, session);
      return undefined;
    }
    return { token, session, ready };
  }

  async function prepareWindow(attempt) {
    const sessions = await load();
    if (!originalOf(attempt, sessions)) throw denied();
    const host = await api.tabs.get(attempt.hostId).catch(() => undefined);
    if (!host) return undefined;
    const token = newToken();
    const session = pendingSession(attempt, { mode: 'window', originTabId: host.id, scopeWindowId: host.windowId });
    const { ready } = track(session, attempt.sessionId);
    try {
      await createWindow(token, session, host.windowId, sessions);
    } catch {
      await drop(token, session);
      return undefined;
    }
    return { token, session, ready };
  }

  // Ends a replacement that will not be used, and its UI.
  async function drop(token, session) {
    const handoff = handoffs.get(session.id);
    handoffs.delete(session.id);
    handoff?.settle(false);
    handoff?.deliver({ ok: false });
    const sessions = await load();
    if (sessions[token]?.id === session.id) {
      delete sessions[token];
      await save(sessions);
    }
    await closeUi(session);
  }

  // The replacement's destination, checked again at each step: still in the
  // host's window and privacy mode, still the same loaded page, and website
  // access still granted for an overlay. Returns the live host, or undefined.
  async function handoffTarget(session, sessions) {
    const original = Object.values(sessions).find(s => s.handoff?.id === session.pending?.attempt && handingOff(s));
    const host = original && await api.tabs.get(original.originTabId).catch(() => undefined);
    if (!host || Boolean(host.incognito) !== session.incognito) return undefined;
    if (session.mode === 'window') return host.windowId === session.scopeWindowId ? host : undefined;
    const tab = await api.tabs.get(session.originTabId).catch(() => undefined);
    if (!search.canHostSearch(tab, host) || tab.url !== session.originUrl) return undefined;
    return await search.hasContentPermission() ? host : undefined;
  }

  // Serialized. Hands the session over, then closes exactly the accepted IDs.
  // Returns undefined to try the next replacement; throws if the original
  // search ended meanwhile (dismissed, navigated, or replaced by a new launch).
  async function commit(attempt, target, ready) {
    const sessions = await load();
    const original = originalOf(attempt, sessions);
    if (!original) {
      await drop(target.token, target.session);
      throw denied();
    }
    const replacement = sessions[target.token];
    const host = ready && replacement?.id === target.session.id && replacement.pending?.ready &&
      replacement.frameId !== undefined && await handoffTarget(replacement, sessions);
    if (!host) {
      await drop(target.token, target.session);
      return undefined;
    }
    // From here the original frame holds nothing: its token is gone.
    delete sessions[attempt.token];
    delete replacement.pending;
    replacement.expiresAt = now() + SESSION_MS;
    await save(sessions);
    const handoff = handoffs.get(replacement.id);
    handoffs.delete(replacement.id);
    if (replacement.mode === 'overlay') await api.tabs.update(replacement.originTabId, { active: true }).catch(() => {});
    else await api.windows.update(replacement.launcherWindowId, { focused: true }).catch(() => {});
    let result;
    try {
      result = await search.closeSelected(attempt.ids, host.windowId, { originTabId: host.id });
    } catch {
      result = { ok: false, closedIds: [], skipped: [], failedIds: [...attempt.ids] };
    }
    // A protected host survives; its overlay must not stay behind, inert.
    if (!result.closedIds.includes(host.id)) await closeOverlay(original);
    handoff?.deliver(await withContext(result, replacement));
    return { ...result, handedOff: true };
  }

  // The replacement has applied the handed-over state. The reply waits
  // (bounded) for the close it continues, so it can show the outcome.
  async function searchHandoffReady(message, sender) {
    const handoff = await serial(async () => {
      const { session, sessions } = await authorize(message, sender, { allowPending: true });
      if (!session.pending?.delivered) throw denied();
      session.pending.ready = true;
      await save(sessions);
      const waiting = handoffs.get(session.id);
      waiting?.settle(true);
      return waiting;
    });
    if (!handoff) return { ok: false };
    return withTimeout(handoff.result, HANDOFF_RESULT_MS, schedule).catch(() => ({ ok: false }));
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
    activateHistoryResult, openSearchPermissions, querySearchSources, searchHandoffReady,
  };
  // Handlers that serialize their own critical sections.
  const unqueued = new Set(['querySearchSources', 'closeSearchTabs', 'searchHandoffReady']);

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
        // A window scoped past its origin (scopeWindowId) ends only with its own tab.
        const ended = Object.entries(sessions).filter(([, s]) => s.originTabId === tabId && s.scopeWindowId === undefined);
        if (!ended.length) return;
        for (const [token] of ended) delete sessions[token];
        await save(sessions);
        await Promise.all(ended.map(([, s]) => closeUi(s)));
      }).catch(() => {});
    });
    api.tabs.onRemoved.addListener(tabId => {
      serial(async () => {
        const sessions = await load();
        const ended = Object.entries(sessions).filter(([, s]) => s.launcherTabId === tabId ||
          (s.originTabId === tabId && s.scopeWindowId === undefined));
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
