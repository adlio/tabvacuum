// Browser wiring kept separate from pure ranking. Session storage survives worker
// suspension, but does not retain browsing metadata after the browser exits.
export function createSearchService(api) {
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
    const window = await api.windows.get(windowId);
    const { searchScope = 'all' } = await api.storage.local.get({ searchScope: 'all' });
    const tabs = (await api.tabs.query(searchScope === 'current' ? { windowId } : {}))
      .filter(tab => Boolean(tab.incognito) === Boolean(window.incognito) && !isSearchPage(tab.url));
    return { incognito: Boolean(window.incognito), current: searchScope === 'current', tabs };
  }

  /** currentTabId overrides "active tab of windowId", e.g. the page a search opened over. */
  async function getContext(windowId, { currentTabId } = {}) {
    const { tabs } = await loadScope(windowId);
    const current = currentTabId === undefined
      ? tabs.find(tab => tab.windowId === windowId && tab.active)
      : tabs.find(tab => tab.id === currentTabId);
    const times = await api.storage.session.get(tabs.map(tab => focusKey(tab.id)));
    return {
      windowId, currentTabId: current?.id,
      tabs: tabs.map(tab => ({
        id: tab.id, windowId: tab.windowId, title: tab.title || '', url: tab.url || '',
        lastAccessed: times[focusKey(tab.id)] ?? tab.lastAccessed ?? 0,
      })),
    };
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
   */
  async function closeSelected(tabIds, windowId, { originTabId } = {}) {
    const ids = validateTabIds(tabIds); // Frozen copy: later caller edits change nothing.
    const scope = await loadScope(windowId);
    const settings = await api.storage.local.get({ skipPinned: true, skipAudible: true });
    const skipPinned = settings.skipPinned !== false;
    const skipAudible = settings.skipAudible !== false;
    const inScope = new Set(scope.tabs.filter(tab => !isSearchPage(tab.pendingUrl)).map(tab => tab.id));
    const order = [...ids.filter(id => id !== originTabId), ...ids.filter(id => id === originTabId)];

    const closedIds = [];
    const skipped = [];
    const failedIds = [];
    for (const tabId of order) {
      // Re-read live: the tab may have moved, changed, or closed since selection.
      const tab = inScope.has(tabId) ? await api.tabs.get(tabId).catch(() => undefined) : undefined;
      const reason = !tab || Boolean(tab.incognito) !== scope.incognito ||
          isSearchPage(tab.url) || isSearchPage(tab.pendingUrl) || (scope.current && tab.windowId !== windowId)
        ? 'unavailable' // Missing and out-of-scope look alike, so private tabs stay invisible.
        : tab.pinned && skipPinned ? 'pinned'
          : tab.audible && skipAudible ? 'audible'
            : await isLastInWindow(tab) ? 'last-tab'
              : undefined;
      if (reason) {
        skipped.push({ tabId, reason });
        continue;
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

  async function isLastInWindow(tab) {
    const siblings = await api.tabs.query({ windowId: tab.windowId }).catch(() => []);
    return !siblings.some(other => other.id !== tab.id);
  }

  return { getContext, activate, closeSelected, installFocusTracking, isSearchPage };
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
