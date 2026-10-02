// Browser wiring kept separate from pure ranking. Session storage survives worker
// suspension, but does not retain browsing metadata after the browser exits.
import { searchPageContent } from './search-content.js';
import {
  CONTENT_CONCURRENCY, CONTENT_LIMITS, CONTENT_TAB_LIMIT, CONTENT_TIMEOUT_MS, HISTORY_LIMIT,
  contentSkipReason, isSafeWebUrl, mapLimit, readContentResult, selectHistory, withTimeout,
} from './search-sources-core.js';

export const CONTENT_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);
const HISTORY_RECHECK_LIMIT = 1000;

export function createSearchService(api, { contentTimeoutMs = CONTENT_TIMEOUT_MS } = {}) {
  const prefix = api.extension?.inIncognitoContext ? 'search.focus.private.' : 'search.focus.';
  const focusKey = id => `${prefix}${id}`;
  const searchUrl = api.runtime.getURL('search.html');

  /** True for TabVacuum's own search page (overlay frame or fallback window). */
  function isSearchPage(url) {
    if (typeof url !== 'string' || !url.startsWith(searchUrl)) return false;
    const next = url[searchUrl.length];
    return next === undefined || next === '?' || next === '#';
  }

  async function recordFocus(tab, windowId, when = Date.now()) {
    if (isSearchPage(tab.url) || isSearchPage(tab.pendingUrl)) return;
    const window = await api.windows.get(windowId);
    if (window.focused) await api.storage.session.set({ [focusKey(tab.id)]: when });
  }

  function installFocusTracking() {
    api.tabs.onActivated.addListener(({ tabId, windowId }) => {
      const when = Date.now();
      // Tab/window may close meanwhile.
      api.tabs.get(tabId).then(tab => recordFocus(tab, windowId, when)).catch(() => {});
    });
    api.windows.onFocusChanged.addListener(windowId => {
      if (windowId < 0) return;
      const when = Date.now();
      api.tabs.query({ active: true, windowId }).then(([tab]) => {
        if (tab) return recordFocus(tab, windowId, when);
      }).catch(() => {});
    });
    api.tabs.onRemoved.addListener(tabId => {
      api.storage.session.remove(focusKey(tabId)).catch(() => {});
    });
  }

  // Tabs visible to a search from windowId: same privacy mode, optional
  // current-window scope, never TabVacuum's own search pages.
  async function loadScope(windowId) {
    if (!Number.isInteger(windowId)) throw new Error('Search window is no longer available. Reopen Search tabs.');
    const [window, { searchScope = 'all' }] = await Promise.all([
      api.windows.get(windowId), api.storage.local.get({ searchScope: 'all' }),
    ]);
    const tabs = (await api.tabs.query(searchScope === 'current' ? { windowId } : {}))
      .filter(tab => Boolean(tab.incognito) === Boolean(window.incognito) && !isSearchPage(tab.url));
    return { incognito: Boolean(window.incognito), current: searchScope === 'current', tabs };
  }

  /** currentTabId overrides "active tab of windowId", e.g. the page a search opened over. */
  async function getContext(windowId, { currentTabId } = {}) {
    const { tabs, incognito } = await loadScope(windowId);
    const current = currentTabId === undefined
      ? tabs.find(tab => tab.windowId === windowId && tab.active)
      : tabs.find(tab => tab.id === currentTabId);
    const [times, contentPermission] = await Promise.all([
      api.storage.session.get(tabs.map(tab => focusKey(tab.id))), hasContentPermission(),
    ]);
    return {
      windowId, currentTabId: current?.id,
      tabs: tabs.map(tab => ({
        id: tab.id, windowId: tab.windowId, title: tab.title || '', url: tab.url || '',
        lastAccessed: times[focusKey(tab.id)] ?? tab.lastAccessed ?? 0,
      })),
      incognito, contentPermission,
    };
  }

  /** The optional all-sites host permission; false when absent or unknown. */
  async function hasContentPermission() {
    try {
      return (await api.permissions?.contains?.({ origins: [...CONTENT_ORIGINS] })) === true;
    } catch {
      return false;
    }
  }

  /**
   * Browser history matches for a normal-window search. A private search never
   * reads history. Returns entries as the browser stores them (exact URLs).
   */
  async function searchHistory(query, windowId) {
    const { incognito } = await loadScope(windowId);
    if (incognito) return { results: [], coverage: { state: 'private', limited: false } };
    if (!query) return { results: [], coverage: { state: 'ready', limited: false } };
    try {
      const items = await api.history.search({ text: query, startTime: 0, maxResults: HISTORY_LIMIT + 1 });
      const { results, limited } = selectHistory(items);
      return { results, coverage: { state: 'ready', limited } };
    } catch {
      return { results: [], coverage: { state: 'error', limited: false } };
    }
  }

  /**
   * Opens a history result only if that exact URL is still in history. An
   * already-open tab with the exact URL in scope is focused instead.
   */
  async function activateHistory(url, windowId) {
    if (!isSafeWebUrl(url)) throw new Error('Choose a page from the results.');
    const scope = await loadScope(windowId);
    if (scope.incognito) throw new Error('History is not searched in private windows.');
    const items = await api.history.search({ text: url, startTime: 0, maxResults: HISTORY_RECHECK_LIMIT });
    if (!Array.isArray(items) || !items.some(item => item?.url === url)) {
      throw new Error('That page is no longer in your history.');
    }
    const open = scope.tabs.find(tab => tab.url === url && !isSearchPage(tab.pendingUrl));
    if (open) return activate(open.id, windowId);
    await api.tabs.create({ url, windowId, active: true });
    await api.windows.update(windowId, { focused: true });
    return { ok: true };
  }

  /** Is this tab still the same page, in this search's scope? */
  function sameScopedPage(tab, before, scope, windowId) {
    return Boolean(tab) && tab.id === before.id && tab.url === before.url &&
      Boolean(tab.incognito) === scope.incognito && !contentSkipReason(tab, isSearchPage) &&
      (!scope.current || tab.windowId === windowId);
  }

  /**
   * On-demand text search of loaded pages in scope, never activating, loading,
   * or fetching them. Needs the optional host permission. Coverage counts
   * exactly what was searched; nothing is retained after the call.
   */
  async function searchContent(query, windowId, { signal } = {}) {
    const noPermission = () => ({ results: [],
      coverage: { state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 } });
    if (!await hasContentPermission()) return noPermission();
    const coverage = { state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 };
    const scope = await loadScope(windowId);
    coverage.state = 'ready';
    coverage.total = scope.tabs.length;
    if (!query) return { results: [], coverage: { ...coverage, total: 0 } };
    const candidates = scope.tabs.filter(tab => !contentSkipReason(tab, isSearchPage)).slice(0, CONTENT_TAB_LIMIT);

    let revoked = false;
    const outcomes = await mapLimit(candidates, CONTENT_CONCURRENCY, async before => {
      try {
        const live = await api.tabs.get(before.id);
        if (!sameScopedPage(live, before, scope, windowId)) return undefined;
        // Rechecked per page: access may be revoked, or the search ended, mid-scan.
        if (!revoked && !await hasContentPermission()) revoked = true;
        if (revoked || signal?.aborted) return undefined; // Last check before injecting.
        const [injection] = await withTimeout(api.scripting.executeScript({
          target: { tabId: before.id, frameIds: [0] },
          func: searchPageContent,
          args: [query, CONTENT_LIMITS],
        }), contentTimeoutMs);
        if (signal?.aborted) return undefined; // Cannot preempt a running script; discard it.
        const result = readContentResult(injection?.result);
        // Discard anything from a page that navigated or moved meanwhile.
        const after = await api.tabs.get(before.id);
        if (!result || result.url !== before.url || !sameScopedPage(after, before, scope, windowId)) return undefined;
        return { tabId: before.id, ...result };
      } catch {
        return undefined; // Closed, restricted, or timed out: not searched.
      }
    }, signal);

    if (revoked) return noPermission(); // Never return snippets read before revocation.
    const searched = outcomes.filter(Boolean);
    coverage.searched = searched.length;
    coverage.skipped = coverage.total - searched.length;
    coverage.truncated = searched.filter(result => result.truncated).length;
    const results = searched.filter(result => result.match)
      .map(({ tabId, url, snippet }) => ({ tabId, url, snippet }));
    return { results, coverage };
  }

  async function activate(tabId, windowId) {
    if (!Number.isInteger(tabId)) throw new Error('Choose a tab from the results.');
    const scope = await loadScope(windowId);
    if (!scope.tabs.some(tab => tab.id === tabId)) throw new Error('That tab is no longer available in this search.');
    // Re-read the live tab: it might have moved since the list loaded.
    const tab = await api.tabs.get(tabId);
    if (Boolean(tab.incognito) !== scope.incognito || isSearchPage(tab.url) ||
        (scope.current && tab.windowId !== windowId)) {
      throw new Error('That tab is no longer available in this search.');
    }
    await api.tabs.update(tabId, { active: true });
    await api.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  }

  /**
   * Closes exactly the tabs the user selected in search. Never widens the set:
   * no query is re-run, and anything outside the search's scope is skipped.
   * The active tab (including the one search opened over) may be closed;
   * pinned/audible settings and the last tab of each window are still kept.
   * The origin tab closes last, because closing it can tear down the caller.
   * keepTabId is never removed: if it otherwise would be, it is skipped as
   * 'changed'. guard(tabId), when given, runs right before each removal; if
   * it returns false nothing more is removed, the rest is skipped as
   * 'changed', and the result has stopped: true.
   */
  async function closeSelected(tabIds, windowId, { originTabId, keepTabId, guard } = {}) {
    const ids = validateTabIds(tabIds); // Frozen copy: later caller edits change nothing.
    const { scope, settings, inScope } = await closePolicy(windowId);
    const order = [...ids.filter(id => id !== originTabId), ...ids.filter(id => id === originTabId)];

    const closedIds = [];
    const skipped = [];
    const failedIds = [];
    for (const [index, tabId] of order.entries()) {
      const reason = await skipReason(tabId, windowId, scope, settings, inScope) ??
        (tabId === keepTabId ? 'changed' : undefined);
      if (reason) {
        skipped.push({ tabId, reason });
        continue;
      }
      if (guard && !await guard(tabId)) {
        skipped.push(...order.slice(index).map(id => ({ tabId: id, reason: 'changed' })));
        return { ok: true, closedIds, skipped, failedIds, stopped: true };
      }
      try {
        await api.tabs.remove(tabId);
        closedIds.push(tabId);
      } catch {
        failedIds.push(tabId);
      }
    }
    return { ok: true, closedIds, skipped, failedIds };
  }

  // Scope and protection settings are independent reads.
  async function closePolicy(windowId) {
    const [scope, stored] = await Promise.all([
      loadScope(windowId), api.storage.local.get({ skipPinned: true, skipAudible: true }),
    ]);
    const settings = { skipPinned: stored.skipPinned !== false, skipAudible: stored.skipAudible !== false };
    const inScope = new Set(scope.tabs.filter(tab => !isSearchPage(tab.pendingUrl)).map(tab => tab.id));
    return { scope, settings, inScope };
  }

  async function skipReason(tabId, windowId, scope, settings, inScope) {
    // Re-read live: the tab may have moved, changed, or closed since selection.
    const tab = inScope.has(tabId) ? await api.tabs.get(tabId).catch(() => undefined) : undefined;
    return !tab || Boolean(tab.incognito) !== scope.incognito ||
        isSearchPage(tab.url) || isSearchPage(tab.pendingUrl) || (scope.current && tab.windowId !== windowId)
      ? 'unavailable' // Missing and out-of-scope look alike, so private tabs stay invisible.
      : tab.pinned && settings.skipPinned ? 'pinned'
        : tab.audible && settings.skipAudible ? 'audible'
          : await isLastInWindow(tab) ? 'last-tab'
            : undefined;
  }

  /**
   * Why closeSelected(closing) would keep this tab, closed last, or undefined
   * if it would close it. It is kept as the last tab when every other tab in
   * its window is in `closing` and would close first.
   */
  async function closeSkipReason(tabId, windowId, { closing = [] } = {}) {
    const { scope, settings, inScope } = await closePolicy(windowId);
    const reason = await skipReason(tabId, windowId, scope, settings, inScope);
    if (reason) return reason;
    const tab = await api.tabs.get(tabId);
    const others = (await api.tabs.query({ windowId: tab.windowId })).filter(other => other.id !== tabId);
    const set = new Set(closing);
    for (const other of others) {
      if (!set.has(other.id) || await skipReason(other.id, windowId, scope, settings, inScope)) return undefined;
    }
    return 'last-tab';
  }

  /** A loaded web page in the host's window and privacy mode that can carry search. */
  function canHostSearch(tab, host) {
    return Boolean(tab) && tab.id !== host.id && tab.windowId === host.windowId &&
      Boolean(tab.incognito) === Boolean(host.incognito) && tab.status === 'complete' &&
      !isSearchPage(tab.pendingUrl) && !contentSkipReason(tab, isSearchPage);
  }

  /**
   * Tabs that could host search after `host` closes, most recently used first.
   * Never one of `excludeIds`, the tabs about to close.
   */
  async function handoffTargets(host, excludeIds) {
    const exclude = new Set(excludeIds);
    const tabs = (await api.tabs.query({ windowId: host.windowId }))
      .filter(tab => !exclude.has(tab.id) && canHostSearch(tab, host));
    const times = await api.storage.session.get(tabs.map(tab => focusKey(tab.id)));
    const used = tab => times[focusKey(tab.id)] ?? tab.lastAccessed ?? 0;
    return tabs.sort((a, b) => used(b) - used(a));
  }

  async function isLastInWindow(tab) {
    const siblings = await api.tabs.query({ windowId: tab.windowId }).catch(() => []);
    return !siblings.some(other => other.id !== tab.id);
  }

  return {
    getContext, activate, closeSelected, installFocusTracking, isSearchPage,
    searchHistory, activateHistory, searchContent, hasContentPermission,
    closeSkipReason, canHostSearch, handoffTargets,
  };
}

export const MAX_CLOSE_TABS = 10_000;

/** A nonempty array of unique, non-negative safe integers, copied and frozen. */
export function validateTabIds(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0 || tabIds.length > MAX_CLOSE_TABS) {
    throw new Error('Choose between 1 and 10,000 tabs to close.');
  }
  const ids = Object.freeze([...tabIds]);
  if (!ids.every(id => Number.isSafeInteger(id) && id >= 0) || new Set(ids).size !== ids.length) {
    throw new Error('Choose tabs from the results.');
  }
  return ids;
}
