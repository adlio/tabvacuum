import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSearchService, validateTabIds, MAX_CLOSE_TABS } from '../src/search-service.js';

const BASE = 'moz-extension://uuid/';
const event = () => ({ addListener: vi.fn() });
function fixture() {
  const tabs = [
    { id: 1, windowId: 10, active: true, title: 'Current', url: 'https://example.org', lastAccessed: 1 },
    { id: 2, windowId: 20, active: true, title: 'Other', lastAccessed: 2 },
    { id: 3, windowId: 30, active: true, title: 'Private', incognito: true },
  ];
  const api = {
    runtime: { getURL: path => BASE + path },
    tabs: { query: vi.fn(async query => tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) &&
      (query.active === undefined || Boolean(tab.active) === query.active))),
      get: vi.fn(async id => tabs.find(tab => tab.id === id)), update: vi.fn(async () => {}),
      remove: vi.fn(async id => {
        const index = tabs.findIndex(tab => tab.id === id);
        if (index < 0) throw new Error('No tab');
        tabs.splice(index, 1);
      }),
      onActivated: event(), onRemoved: event() },
    windows: { get: vi.fn(async id => ({ id, focused: id === 10, incognito: id === 30 })),
      update: vi.fn(async () => {}), onFocusChanged: event() },
    storage: { local: { get: vi.fn(async () => ({ searchScope: 'all' })) },
      session: { get: vi.fn(async () => ({ 'search.focus.2': 100 })), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
  };
  return { api, tabs, service: createSearchService(api) };
}

describe('search browser service', () => {
  it('searches all normal windows by default, excluding private tabs', async () => {
    const { service } = fixture();
    const context = await service.getContext(10);
    expect(context.currentTabId).toBe(1);
    expect(context.tabs.map(t => t.id)).toEqual([1, 2]);
    expect(context.tabs[1].lastAccessed).toBe(100);
  });
  it('does not mix normal results into private-window search', async () => {
    const { service } = fixture();
    expect((await service.getContext(30)).tabs.map(t => t.id)).toEqual([3]);
  });
  it('honors current-window scope from settings', async () => {
    const { api, service } = fixture();
    api.storage.local.get.mockResolvedValue({ searchScope: 'current' });
    expect((await service.getContext(10)).tabs.map(t => t.id)).toEqual([1]);
  });
  it('uses an explicit current tab (the page search opened over), not the active tab', async () => {
    const { service, tabs } = fixture();
    tabs.push({ id: 4, windowId: 10, active: false, title: 'Origin' });
    expect((await service.getContext(10, { currentTabId: 4 })).currentTabId).toBe(4);
    // A current tab outside the scope is not reported.
    expect((await service.getContext(10, { currentTabId: 3 })).currentTabId).toBeUndefined();
  });
  it('excludes its own search pages from results, but not other extension pages', async () => {
    const { service, tabs } = fixture();
    tabs.push({ id: 5, windowId: 40, url: `${BASE}search.html?token=x` },
      { id: 6, windowId: 10, url: `${BASE}search.html` },
      { id: 7, windowId: 10, url: `${BASE}options.html` },
      { id: 8, windowId: 10, url: `${BASE}search.html.evil` });
    expect((await service.getContext(10)).tabs.map(t => t.id)).toEqual([1, 2, 7, 8]);
    expect(service.isSearchPage(`${BASE}search.html#x`)).toBe(true);
    expect(service.isSearchPage('https://example.org/search.html')).toBe(false);
    expect(service.isSearchPage(undefined)).toBe(false);
  });
  it('activates the target then focuses its window without moving it', async () => {
    const { api, service } = fixture();
    expect(await service.activate(2, 10)).toEqual({ ok: true });
    expect(api.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(api.windows.update).toHaveBeenCalledWith(20, { focused: true });
    expect(api.tabs.update.mock.invocationCallOrder[0]).toBeLessThan(api.windows.update.mock.invocationCallOrder[0]);
  });
  it('allows selecting the current tab', async () => {
    expect(await fixture().service.activate(1, 10)).toEqual({ ok: true });
  });
  it.each([3, 999, '2', null, 1.5, NaN])('refuses unavailable or out-of-scope target %s', async id => {
    const { api, service } = fixture();
    await expect(service.activate(id, 10)).rejects.toThrow();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
  it.each([undefined, '10', null, {}])('refuses a missing or malformed window %s', async windowId => {
    const { api, service } = fixture();
    await expect(service.activate(2, windowId)).rejects.toThrow();
    await expect(service.getContext(windowId)).rejects.toThrow();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
  it('propagates closed-tab and focus errors', async () => {
    const { api, service } = fixture();
    api.tabs.get.mockRejectedValue(new Error('closed'));
    await expect(service.activate(2, 10)).rejects.toThrow('closed');
  });
  it('uses the target tab’s live window if it moved', async () => {
    const { api, service } = fixture();
    api.tabs.get.mockResolvedValue({ id: 2, windowId: 21 });
    await service.activate(2, 10);
    expect(api.windows.update).toHaveBeenCalledWith(21, { focused: true });
  });
  it('re-checks the live tab: refuses one that became private, a search page, or left current scope', async () => {
    for (const [live, scope] of [
      [{ id: 2, windowId: 20, incognito: true }, 'all'],
      [{ id: 2, windowId: 20, url: `${BASE}search.html` }, 'all'],
      [{ id: 1, windowId: 20 }, 'current'],
    ]) {
      const { api, service } = fixture();
      api.storage.local.get.mockResolvedValue({ searchScope: scope });
      api.tabs.get.mockResolvedValue(live);
      await expect(service.activate(live.id, 10)).rejects.toThrow('no longer available');
      expect(api.tabs.update).not.toHaveBeenCalled();
    }
  });
  it('tracks activation only in the focused window and removes closed-tab metadata', async () => {
    const { api, service } = fixture();
    service.installFocusTracking();
    const onActivated = api.tabs.onActivated.addListener.mock.calls[0][0];
    onActivated({ tabId: 1, windowId: 10 });
    await vi.waitFor(() => expect(api.storage.session.set).toHaveBeenCalledWith({ 'search.focus.1': expect.any(Number) }));
    api.storage.session.set.mockClear();
    onActivated({ tabId: 2, windowId: 20 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.storage.session.set).not.toHaveBeenCalled();
    api.tabs.onRemoved.addListener.mock.calls[0][0](2);
    expect(api.storage.session.remove).toHaveBeenCalledWith('search.focus.2');
  });
  it('never records focus for its own search window', async () => {
    const { api, service, tabs } = fixture();
    tabs.push({ id: 9, windowId: 10, active: true, url: '', pendingUrl: `${BASE}search.html?token=x` });
    service.installFocusTracking();
    api.tabs.onActivated.addListener.mock.calls[0][0]({ tabId: 9, windowId: 10 });
    tabs[0].active = false;
    api.windows.onFocusChanged.addListener.mock.calls[0][0](10);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.storage.session.set).not.toHaveBeenCalled();
  });
  it('tracks whole-window focus changes, not just active-tab changes', async () => {
    const { api, service } = fixture();
    service.installFocusTracking();
    api.windows.onFocusChanged.addListener.mock.calls[0][0](10);
    await vi.waitFor(() => expect(api.storage.session.set).toHaveBeenCalled());
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 10 });
    api.storage.session.set.mockClear();
    api.windows.onFocusChanged.addListener.mock.calls[0][0](-1);
    expect(api.storage.session.set).not.toHaveBeenCalled();
  });
});

describe('closing selected search results', () => {
  // Window 10: 1 (origin, active), 4, 5. Window 20: 2, 6. Window 30 (private): 3.
  function closing({ scope = 'all', skipPinned, skipAudible } = {}) {
    const env = fixture();
    env.tabs.push({ id: 4, windowId: 10 }, { id: 5, windowId: 10 }, { id: 6, windowId: 20 });
    env.api.storage.local.get.mockImplementation(async keys =>
      ('searchScope' in keys ? { searchScope: scope } : { skipPinned, skipAudible }));
    return env;
  }
  const removed = api => api.tabs.remove.mock.calls.map(([id]) => id);

  it('closes exactly the listed tabs, one by one, including the active origin (last)', async () => {
    const { api, service } = closing();
    expect(await service.closeSelected([1, 4, 2], 10, { originTabId: 1 })).toEqual(
      { ok: true, closedIds: [4, 2, 1], skipped: [], failedIds: [] });
    expect(removed(api)).toEqual([4, 2, 1]);
    // Only the scope snapshot and per-window survivor checks: no re-run search.
    expect(api.tabs.query.mock.calls.every(([query]) => Object.keys(query).every(key => key === 'windowId'))).toBe(true);
  });

  it.each([
    ['not an array', 1], ['a string', '1'], ['null', null], ['an object', { 0: 1, length: 1 }], ['empty', []],
    ['too many', Array.from({ length: 10_001 }, (_, i) => i)], ['duplicates', [4, 5, 4]],
    ['negative', [4, -1]], ['fractional', [4, 1.5]], ['a numeric string', [4, '5']], ['NaN', [NaN]],
    ['unsafe', [2 ** 53]], ['Infinity', [Infinity]], ['sparse', [4, , 5]], ['nested', [[4]]], ['null item', [null]],
  ])('rejects %s before touching any tab', async (_label, ids) => {
    const { api, service } = closing();
    await expect(service.closeSelected(ids, 10, { originTabId: 1 })).rejects.toThrow();
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.tabs.query).not.toHaveBeenCalled();
  });

  it('accepts the 10,000-tab boundary and freezes a copy', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => i);
    const frozen = validateTabIds(ids);
    expect(frozen).toHaveLength(MAX_CLOSE_TABS);
    expect(frozen).not.toBe(ids);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(validateTabIds([0])).toEqual([0]);
  });

  it('works from the frozen request set even if the caller’s array changes', async () => {
    const { api, service } = closing();
    const ids = [4];
    const pending = service.closeSelected(ids, 10, { originTabId: 1 });
    ids.push(5, 2);
    expect((await pending).closedIds).toEqual([4]);
    expect(removed(api)).toEqual([4]);
  });

  it('skips private, missing, and search-page tabs alike, without revealing which', async () => {
    const { api, service, tabs } = closing();
    tabs.push({ id: 7, windowId: 10, url: `${BASE}search.html?token=x` },
      { id: 8, windowId: 10, url: '', pendingUrl: `${BASE}search.html` });
    const result = await service.closeSelected([3, 999, 7, 8, 4], 10, { originTabId: 1 });
    expect(result.closedIds).toEqual([4]);
    expect(result.skipped).toEqual([3, 999, 7, 8].map(tabId => ({ tabId, reason: 'unavailable' })));
    expect(removed(api)).toEqual([4]);
  });

  it('keeps a private search to private tabs', async () => {
    const { api, service, tabs } = closing();
    tabs.push({ id: 9, windowId: 30, incognito: true });
    const result = await service.closeSelected([2, 9], 30, { originTabId: 3 });
    expect(result).toEqual({ ok: true, closedIds: [9], skipped: [{ tabId: 2, reason: 'unavailable' }], failedIds: [] });
    expect(removed(api)).toEqual([9]);
  });

  it('honors current-window scope', async () => {
    const { service } = closing({ scope: 'current' });
    const result = await service.closeSelected([2, 4], 10, { originTabId: 1 });
    expect(result.closedIds).toEqual([4]);
    expect(result.skipped).toEqual([{ tabId: 2, reason: 'unavailable' }]);
  });

  it('keeps pinned and audible tabs by default, and closes them when the settings allow', async () => {
    const first = closing();
    Object.assign(first.tabs.find(t => t.id === 4), { pinned: true });
    Object.assign(first.tabs.find(t => t.id === 5), { audible: true });
    expect(await first.service.closeSelected([4, 5], 10, { originTabId: 1 })).toEqual({
      ok: true, closedIds: [], failedIds: [],
      skipped: [{ tabId: 4, reason: 'pinned' }, { tabId: 5, reason: 'audible' }],
    });
    expect(first.api.tabs.remove).not.toHaveBeenCalled();

    const second = closing({ skipPinned: false, skipAudible: false });
    Object.assign(second.tabs.find(t => t.id === 4), { pinned: true });
    Object.assign(second.tabs.find(t => t.id === 5), { audible: true });
    expect((await second.service.closeSelected([4, 5], 10, { originTabId: 1 })).closedIds).toEqual([4, 5]);
  });

  it('never closes the last tab in a window, even when every tab there is selected', async () => {
    const { api, service } = closing();
    const result = await service.closeSelected([2, 6, 1, 4, 5], 10, { originTabId: 1 });
    expect(result.closedIds).toEqual([2, 4, 5]);
    expect(result.skipped).toEqual([{ tabId: 6, reason: 'last-tab' }, { tabId: 1, reason: 'last-tab' }]);
    expect(api.tabs.query).toHaveBeenCalledWith({ windowId: 20 });
  });

  it('re-checks each tab live before removal', async () => {
    const { api, service, tabs } = closing();
    const scope = await service.getContext(10);
    expect(scope.tabs.map(t => t.id)).toContain(4);
    api.tabs.get.mockImplementation(async id => {
      const tab = tabs.find(t => t.id === id);
      if (id === 4) return { ...tab, pinned: true };      // Pinned after selection.
      if (id === 5) return { ...tab, incognito: true };   // Swapped for a private tab.
      if (id === 6) throw new Error('closed');            // Closed meanwhile.
      return tab;
    });
    const result = await service.closeSelected([4, 5, 6, 2], 10, { originTabId: 1 });
    expect(result.closedIds).toEqual([2]);
    expect(result.skipped).toEqual([
      { tabId: 4, reason: 'pinned' }, { tabId: 5, reason: 'unavailable' }, { tabId: 6, reason: 'unavailable' }]);
  });

  it('reports failed removals and keeps going', async () => {
    const { api, service } = closing();
    api.tabs.remove.mockImplementationOnce(async () => { throw new Error('busy'); });
    const result = await service.closeSelected([4, 5, 2], 10, { originTabId: 1 });
    expect(result).toEqual({ ok: true, closedIds: [5, 2], skipped: [], failedIds: [4] });
  });

  it('treats an unreadable window as last-tab rather than risking it', async () => {
    const { api, service, tabs } = closing();
    api.tabs.query.mockImplementation(async query => {
      if (query.windowId !== undefined) throw new Error('gone');
      return [...tabs];
    });
    const result = await service.closeSelected([4], 10, { originTabId: 1 });
    expect(result.skipped).toEqual([{ tabId: 4, reason: 'last-tab' }]);
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it.each([undefined, '10', null])('refuses a malformed window %s', async windowId => {
    const { api, service } = closing();
    await expect(service.closeSelected([4], windowId)).rejects.toThrow();
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });
});

for (const browser of ['firefox', 'chrome']) {
  it(`${browser}: four defaults, search bound, stale and blank commands retained unbound`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`../src/manifest.${browser}.json`, import.meta.url)));
    expect(Object.values(manifest.commands).filter(c => c.suggested_key)).toHaveLength(4);
    expect(manifest.commands['search-tabs'].suggested_key.default).toBe('Ctrl+Shift+Period');
    expect(manifest.commands['close-stale'].suggested_key).toBeUndefined();
    expect(manifest.commands['close-blank']).toBeDefined();
  });
  it(`${browser}: overlay uses activeTab + scripting only, exposing just search.html`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`../src/manifest.${browser}.json`, import.meta.url)));
    expect(manifest.permissions).toEqual(expect.arrayContaining(['activeTab', 'scripting']));
    expect(manifest.permissions.filter(p => p.includes('://') || p === '<all_urls>')).toEqual([]);
    expect(manifest.host_permissions).toBeUndefined();
    // Website access is optional only: Chrome MV3 uses optional_host_permissions;
    // Firefox (min 115) takes origins in optional_permissions.
    const origins = ['http://*/*', 'https://*/*'];
    if (browser === 'chrome') {
      expect(manifest.optional_host_permissions).toEqual(origins);
      expect(manifest.optional_permissions).toBeUndefined();
    } else {
      expect(manifest.optional_permissions).toEqual(origins);
      expect(manifest.optional_host_permissions).toBeUndefined();
    }
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ['search.html'], matches: ['http://*/*', 'https://*/*'] },
    ]);
  });
}

describe('expanded search sources', () => {
  function sources({ permission = true } = {}) {
    const env = fixture();
    const { api, tabs } = env;
    tabs[1].url = 'https://other.test/';
    tabs.push({ id: 4, windowId: 10, url: 'https://discarded.test/', discarded: true },
      { id: 5, windowId: 10, url: 'https://loading.test/', status: 'loading' },
      { id: 6, windowId: 10, url: 'about:blank' },
      { id: 7, windowId: 30, url: 'https://private2.test/', incognito: true });
    api.permissions = { contains: vi.fn(async () => permission) };
    api.history = { search: vi.fn(async () => [
      { url: 'https://h.test/?a=1#x', title: 'Hist', lastVisitTime: 2 },
      { url: 'https://h.test/?a=1#x', title: 'Hist', lastVisitTime: 9 },
      { url: 'javascript:alert(1)', title: 'evil', lastVisitTime: 10 },
    ]) };
    api.tabs.create = vi.fn(async () => ({ id: 99 }));
    api.scripting = { executeScript: vi.fn(async ({ target }) => {
      const tab = tabs.find(t => t.id === target.tabId);
      return [{ result: { url: tab.url, match: tab.id === 1, snippet: tab.id === 1 ? 'a match' : '', truncated: tab.id === 2 } }];
    }) };
    return env;
  }

  it('reports privacy and the optional host permission in context', async () => {
    const { api, service } = sources();
    expect(await service.getContext(10)).toMatchObject({ incognito: false, contentPermission: true });
    expect(api.permissions.contains).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    expect(await service.getContext(30)).toMatchObject({ incognito: true });
    api.permissions.contains.mockRejectedValue(new Error('x'));
    expect((await service.getContext(10)).contentPermission).toBe(false);
    delete api.permissions;
    expect((await service.getContext(10)).contentPermission).toBe(false);
  });

  it('searches full history with native matching, deduped and safe only', async () => {
    const { api, service } = sources();
    expect(await service.searchHistory('hist', 10)).toEqual({
      results: [{ url: 'https://h.test/?a=1#x', title: 'Hist', lastVisitTime: 9 }],
      coverage: { state: 'ready', limited: false },
    });
    expect(api.history.search).toHaveBeenCalledWith({ text: 'hist', startTime: 0, maxResults: 101 });
  });

  it('never reads history for a private search, or for an empty query', async () => {
    const { api, service } = sources();
    expect((await service.searchHistory('hist', 30)).coverage.state).toBe('private');
    expect((await service.searchHistory('', 10)).results).toEqual([]);
    expect(api.history.search).not.toHaveBeenCalled();
  });

  it('reports a history failure as an error state', async () => {
    const { api, service } = sources();
    api.history.search.mockRejectedValue(new Error('boom'));
    expect(await service.searchHistory('x', 10)).toEqual({ results: [], coverage: { state: 'error', limited: false } });
  });

  it('opens a history result only if that exact URL is still in history', async () => {
    const { api, service } = sources();
    expect(await service.activateHistory('https://h.test/?a=1#x', 10)).toEqual({ ok: true });
    expect(api.history.search).toHaveBeenCalledWith(expect.objectContaining({ text: 'https://h.test/?a=1#x', startTime: 0 }));
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'https://h.test/?a=1#x', windowId: 10, active: true });
    // A near-miss (normalized form) is not accepted.
    await expect(service.activateHistory('https://h.test/?a=1', 10)).rejects.toThrow();
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@h.test/', 'data:text/html,x', 42, undefined])(
    'refuses unsafe history URL %s before reading history', async url => {
      const { api, service } = sources();
      await expect(service.activateHistory(url, 10)).rejects.toThrow();
      expect(api.history.search).not.toHaveBeenCalled();
      expect(api.tabs.create).not.toHaveBeenCalled();
    });

  it('refuses private history activation before reading history', async () => {
    const { api, service } = sources();
    await expect(service.activateHistory('https://h.test/?a=1#x', 30)).rejects.toThrow();
    expect(api.history.search).not.toHaveBeenCalled();
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it('focuses an already-open tab with the exact URL instead of duplicating it', async () => {
    const { api, service } = sources();
    api.history.search.mockResolvedValue([{ url: 'https://other.test/', lastVisitTime: 1 }]);
    expect(await service.activateHistory('https://other.test/', 10)).toEqual({ ok: true });
    expect(api.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it('does not read page content without the host permission', async () => {
    const { api, service } = sources({ permission: false });
    expect(await service.searchContent('match', 10)).toEqual({
      results: [], coverage: { state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 },
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('searches loaded same-privacy pages top-frame only, with honest coverage', async () => {
    const { api, service } = sources();
    const { results, coverage } = await service.searchContent('match', 10);
    expect(results).toEqual([{ tabId: 1, url: 'https://example.org', snippet: 'a match' }]);
    // Tabs 1,2,4,5,6 in scope; discarded/loading/about:blank skipped; private 7 never touched.
    expect(coverage).toEqual({ state: 'ready', searched: 2, total: 5, skipped: 3, truncated: 1 });
    const targets = api.scripting.executeScript.mock.calls.map(([call]) => call.target);
    expect(targets).toEqual([{ tabId: 1, frameIds: [0] }, { tabId: 2, frameIds: [0] }]);
    expect(api.scripting.executeScript.mock.calls[0][0].args).toEqual(['match', expect.objectContaining({ maxChars: 100_000 })]);
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('keeps private content searches private', async () => {
    const { api, service } = sources();
    const { results } = await service.searchContent('x', 30);
    // Tab 3 has no web URL; normal tabs are never injected from a private search.
    expect(api.scripting.executeScript.mock.calls.map(([c]) => c.target.tabId)).toEqual([7]);
    expect(results).toEqual([]);
  });

  it('does not inject for an empty query', async () => {
    const { api, service } = sources();
    expect((await service.searchContent('', 10)).results).toEqual([]);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('discards a result from a page that navigated during the scan', async () => {
    const { api, tabs, service } = sources();
    api.scripting.executeScript.mockImplementation(async ({ target }) => {
      const tab = tabs.find(t => t.id === target.tabId);
      const url = tab.url;
      if (tab.id === 1) tab.url = 'https://elsewhere.test/';
      return [{ result: { url, match: true, snippet: 'secret', truncated: false } }];
    });
    const { results, coverage } = await service.searchContent('x', 10);
    expect(results.map(r => r.tabId)).toEqual([2]);
    expect(coverage.searched).toBe(1);
  });

  it('discards a result whose reported URL differs from the tab', async () => {
    const { api, service } = sources();
    api.scripting.executeScript.mockResolvedValue([{ result: { url: 'https://spoof.test/', match: true, snippet: 's' } }]);
    expect((await service.searchContent('x', 10)).results).toEqual([]);
  });

  it('bounds each injection by a timeout and counts it as not searched', async () => {
    const { api } = sources();
    const service = createSearchService(api, { contentTimeoutMs: 5 });
    api.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
    const { coverage } = await service.searchContent('x', 10);
    expect(coverage).toMatchObject({ searched: 0, total: 5, skipped: 5 });
  });

  function manyTabs(env) {
    for (let id = 20; id < 30; id++) env.tabs.push({ id, windowId: 10, url: `https://t${id}.test/` });
    return env;
  }
  const hit = (tabs, target) => [{ result: { url: tabs.find(t => t.id === target.tabId).url, match: true, snippet: 'secret' } }];

  it('checks the abort signal after the live re-read, immediately before each injection', async () => {
    const { api, service } = sources();
    const controller = new AbortController();
    const waiting = [];
    api.permissions.contains.mockImplementation(async () => {
      if (api.permissions.contains.mock.calls.length > 1) await new Promise(resolve => waiting.push(resolve));
      return true;
    });
    const pending = service.searchContent('x', 10, { signal: controller.signal });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    controller.abort();
    waiting.forEach(resolve => resolve());
    expect((await pending).results).toEqual([]);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('discards a result from a script already running at abort, and starts no more', async () => {
    const { api, tabs, service } = manyTabs(sources());
    const controller = new AbortController();
    api.scripting.executeScript.mockImplementation(async ({ target }) => {
      controller.abort();
      return hit(tabs, target);
    });
    const { results } = await service.searchContent('x', 10, { signal: controller.signal });
    expect(results).toEqual([]);
    expect(api.scripting.executeScript.mock.calls.length).toBeLessThanOrEqual(4); // Of 12 candidates.
  });

  it('rechecks website access per page, returning no stale snippets once revoked', async () => {
    const { api, tabs, service } = manyTabs(sources());
    api.scripting.executeScript.mockImplementation(async ({ target }) => {
      api.permissions.contains.mockResolvedValue(false);
      return hit(tabs, target);
    });
    expect(await service.searchContent('x', 10)).toEqual({
      results: [], coverage: { state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 },
    });
    expect(api.scripting.executeScript.mock.calls.length).toBeLessThanOrEqual(4); // Of 12 candidates.
  });

  it('caps concurrent injections at four', async () => {
    const { api, tabs, service } = sources();
    for (let id = 20; id < 30; id++) tabs.push({ id, windowId: 10, url: `https://t${id}.test/` });
    let active = 0;
    let peak = 0;
    api.scripting.executeScript.mockImplementation(async ({ target }) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return [{ result: { url: tabs.find(t => t.id === target.tabId).url, match: false } }];
    });
    await service.searchContent('x', 10);
    expect(peak).toBe(4);
  });
});
