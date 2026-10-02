import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSearchService } from '../src/search-service.js';
import { createSearchLauncher, placement, newToken, handoffState, UNCLAIMED_MS, SESSION_MS, HANDOFF_MS, READY_MS } from '../src/search-launcher.js';
import { mountSearchOverlay } from '../src/search-overlay.js';
import { searchPageContent } from '../src/search-content.js';

const EXT = 'tabvacuum@adlio';
const BASE = 'moz-extension://uuid/';
const SEARCH = `${BASE}search.html`;
const event = () => ({ addListener: vi.fn() });

function fakeBrowser() {
  const tabs = [
    { id: 1, windowId: 10, active: true, title: 'Origin', url: 'https://example.org/' },
    { id: 2, windowId: 20, active: true, title: 'Other window', url: 'https://other.example/' },
    { id: 3, windowId: 30, active: true, title: 'Private', url: 'https://private.example/', incognito: true },
    { id: 4, windowId: 10, active: false, title: 'Background', url: 'https://example.org/b' },
  ];
  const windows = {
    10: { id: 10, left: 100, top: 50, width: 1200, height: 800, focused: true },
    20: { id: 20, left: 0, top: 0, width: 800, height: 600 },
    30: { id: 30, left: 0, top: 0, width: 800, height: 600, incognito: true },
  };
  let session = {};
  let nextId = 100;
  const api = {
    runtime: { id: EXT, getURL: path => BASE + path },
    storage: {
      local: { get: vi.fn(async () => ({ searchScope: 'all' })) },
      session: {
        // Round-trip through JSON, as the browser structured-clones storage.
        get: vi.fn(async keys => {
          const out = {};
          for (const key of [keys].flat()) if (key in session) out[key] = JSON.parse(JSON.stringify(session[key]));
          return out;
        }),
        set: vi.fn(async items => { session = { ...session, ...JSON.parse(JSON.stringify(items)) }; }),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      query: vi.fn(async q => tabs.filter(t => (q.windowId === undefined || t.windowId === q.windowId) &&
        (q.active === undefined || t.active === q.active) && (!q.lastFocusedWindow || t.windowId === 10))),
      get: vi.fn(async id => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      }),
      update: vi.fn(async () => {}),
      // Like the browser: gone at once, then onRemoved listeners fire.
      remove: vi.fn(async id => {
        const index = tabs.findIndex(t => t.id === id);
        if (index < 0) throw new Error('No tab');
        tabs.splice(index, 1);
        for (const [listener] of api.tabs.onRemoved.addListener.mock.calls) listener(id, {});
      }),
      sendMessage: vi.fn(async () => {}),
      onRemoved: event(), onActivated: event(), onUpdated: event(),
    },
    windows: {
      get: vi.fn(async id => windows[id]),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      create: vi.fn(async options => {
        const windowId = nextId++;
        const tab = { id: nextId++, windowId, active: true, url: options.url, incognito: Boolean(options.incognito) };
        tabs.push(tab);
        return { id: windowId, incognito: Boolean(options.incognito), tabs: [tab] };
      }),
      onFocusChanged: event(),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: 'mounted', documentId: 'doc-origin' }]) },
  };
  return { api, tabs, windows, stored: () => session['search.sessions'] ?? {} };
}

function setup({ now = () => 1_000_000 } = {}) {
  const env = fakeBrowser();
  const timers = [];
  const search = createSearchService(env.api);
  const options = { now, schedule: (fn, ms) => timers.push(Object.assign(fn, { ms })) };
  const launcher = createSearchLauncher(env.api, search, options);
  launcher.installCleanup();
  const send = (message, sender) => launcher.handleMessage(message, sender);
  const tokenOf = call => call[0].args[0];
  const lastToken = () => tokenOf(env.api.scripting.executeScript.mock.calls.at(-1));
  const windowToken = () => new URL(env.api.windows.create.mock.calls.at(-1)[0].url).searchParams.get('token');
  const restart = () => createSearchLauncher(env.api, createSearchService(env.api), options);
  return { ...env, launcher, send, timers, lastToken, windowToken, restart };
}

// Senders as the browser reports them.
const frame = (over = {}) => ({ id: EXT, tab: { id: 1, windowId: 10 }, frameId: 7, url: SEARCH, documentId: 'doc-frame', ...over });
const page = (over = {}) => ({ id: EXT, tab: { id: 1, windowId: 10 }, frameId: 0, url: 'https://example.org/', documentId: 'doc-origin', ...over });
const popupWindow = (tabId, token, over = {}) => ({ id: EXT, tab: { id: tabId }, frameId: 0, url: `${SEARCH}?token=${token}`, documentId: 'doc-window', ...over });

describe('overlay launch', () => {
  it('injects the top frame only, handing the token solely to the isolated script', async () => {
    const { api, launcher, lastToken, stored } = setup();
    expect(await launcher.launch(await api.tabs.get(1))).toEqual({ mode: 'overlay' });
    const [call] = api.scripting.executeScript.mock.calls[0];
    expect(call.target).toEqual({ tabId: 1 });
    expect(call.func).toBe(mountSearchOverlay);
    expect(call.files).toBeUndefined();
    const [token, id, url, origin] = call.args;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(token);
    expect(url).toBe(SEARCH); // No token in the frame URL.
    expect(origin).toBe('moz-extension://uuid');
    expect(Object.keys(stored())).toEqual([lastToken()]);
    expect(api.windows.create).not.toHaveBeenCalled();
  });

  it('gives the claimed frame the origin tab as current, whatever the client asks for', async () => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    const context = await send({ command: 'getSearchContext', token: lastToken(), windowId: 30 }, frame());
    expect(context.windowId).toBe(10);
    expect(context.currentTabId).toBe(1);
    expect(context.tabs.map(t => t.id)).toEqual([1, 2, 4]); // No private tab 3.
    expect(Object.keys(context).sort()).toEqual(['contentPermission', 'currentTabId', 'incognito', 'tabs', 'windowId']);
    expect(context).toMatchObject({ incognito: false, contentPermission: false }); // No permissions API: false.
  });

  it('launches from the active tab of the last-focused window when none is given', async () => {
    const { api, launcher } = setup();
    await launcher.launch();
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(api.scripting.executeScript.mock.calls[0][0].target.tabId).toBe(1);
  });

  it('keeps private searches private', async () => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(3));
    const sender = frame({ tab: { id: 3, windowId: 30, incognito: true } });
    const context = await send({ command: 'getSearchContext', token: lastToken() }, sender);
    expect(context.tabs.map(t => t.id)).toEqual([3]);
    await expect(send({ command: 'activateSearchTab', token: lastToken(), tabId: 2 }, sender)).rejects.toThrow();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('uses the origin tab’s live window after it moves', async () => {
    const { api, launcher, send, lastToken, tabs } = setup();
    await launcher.launch(await api.tabs.get(1));
    tabs[0].windowId = 20;
    expect((await send({ command: 'getSearchContext', token: lastToken() }, frame())).windowId).toBe(20);
  });
});

describe('token and sender validation', () => {
  const hostile = [undefined, null, '', 42, {}, [], '__proto__', 'constructor', 'hasOwnProperty',
    'x'.repeat(43), 'A'.repeat(43), `${'A'.repeat(42)}=`, 'A'.repeat(44)];
  it.each(hostile)('refuses token %j', async token => {
    const { api, launcher, send } = setup();
    await launcher.launch(await api.tabs.get(1));
    await expect(send({ command: 'getSearchContext', token }, frame())).rejects.toThrow('expired');
    await expect(send({ command: 'activateSearchTab', token, tabId: 2 }, frame())).rejects.toThrow();
    await expect(send({ command: 'dismissSearch', token }, page())).rejects.toThrow();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it.each([
    ['another extension', frame({ id: 'evil@ext' })],
    ['no tab', frame({ tab: undefined })],
    ['another tab', frame({ tab: { id: 2, windowId: 20 } })],
    ['the page itself (content script)', page()],
    ['the top frame at the search URL', frame({ frameId: 0 })],
    ['a query string on the overlay frame', frame({ url: `${SEARCH}?token=x` })],
    ['another extension page', frame({ url: `${BASE}options.html` })],
    ['a lookalike path', frame({ url: `${SEARCH}.evil` })],
    ['a web page frame', frame({ url: 'https://evil.example/search.html' })],
    ['a private tab with the same id', frame({ tab: { id: 1, incognito: true } })],
  ])('refuses data to %s', async (_label, sender) => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    await expect(send({ command: 'getSearchContext', token: lastToken() }, sender)).rejects.toThrow('expired');
    await expect(send({ command: 'activateSearchTab', token: lastToken(), tabId: 2 }, sender)).rejects.toThrow();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('binds the token to the first frame and document that claim it', async () => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    await send({ command: 'getSearchContext', token }, frame());
    await expect(send({ command: 'getSearchContext', token }, frame())).resolves.toBeDefined();
    await expect(send({ command: 'getSearchContext', token }, frame({ frameId: 8 }))).rejects.toThrow();
    await expect(send({ command: 'getSearchContext', token }, frame({ documentId: 'reloaded' }))).rejects.toThrow();
    await expect(send({ command: 'getSearchContext', token }, frame({ documentId: undefined }))).rejects.toThrow();
  });

  it('refuses activation of private, closed, malformed, or search-page targets', async () => {
    const { api, launcher, send, lastToken, tabs } = setup();
    tabs.push({ id: 9, windowId: 10, url: `${SEARCH}?token=x` });
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    for (const tabId of [3, 9, 999, '2', null, undefined, 2.5, { id: 2 }]) {
      await expect(send({ command: 'activateSearchTab', token, tabId }, frame())).rejects.toThrow();
    }
    expect(api.tabs.update).not.toHaveBeenCalled();
    // The session survives refused attempts so the user can pick again.
    await expect(send({ command: 'activateSearchTab', token, tabId: 2 }, frame())).resolves.toEqual({ ok: true });
  });

  it('lets the page’s own script dismiss, but never read or activate', async () => {
    const { api, launcher, send, lastToken, stored } = setup();
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    await expect(send({ command: 'getSearchContext', token }, page())).rejects.toThrow();
    await expect(send({ command: 'activateSearchTab', token, tabId: 2 }, page())).rejects.toThrow();
    await expect(send({ command: 'dismissSearch', token }, page({ tab: { id: 2 } }))).rejects.toThrow();
    await expect(send({ command: 'dismissSearch', token }, page({ documentId: 'other-document' }))).rejects.toThrow();
    await expect(send({ command: 'dismissSearch', token }, page({ frameId: 3 }))).rejects.toThrow();
    expect(await send({ command: 'dismissSearch', token }, page())).toEqual({ ok: true });
    expect(stored()).toEqual({});
    expect(api.tabs.sendMessage).not.toHaveBeenCalled(); // The page removed its own overlay.
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('ignores non-search commands so the background can gate them separately', () => {
    const { send } = setup();
    for (const message of [null, undefined, 'getSearchContext', {}, { command: 'closeDuplicates' },
      { command: 'toString' }, { command: '__proto__' }, { command: 'launch' }]) {
      expect(send(message, frame())).toBeUndefined();
    }
  });
});

describe('activation and dismissal', () => {
  it('activates, closes the origin overlay, and refuses replay', async () => {
    const { api, launcher, send, lastToken, stored } = setup();
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    const id = api.scripting.executeScript.mock.calls[0][0].args[1];
    await send({ command: 'getSearchContext', token }, frame());
    expect(await send({ command: 'activateSearchTab', token, tabId: 2 }, frame())).toEqual({ ok: true });
    expect(api.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(api.windows.update).toHaveBeenCalledWith(20, { focused: true });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'tabvacuum:close', id }, { frameId: 0 });
    // Closing the overlay must not pull focus back to the origin.
    expect(api.windows.update).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({});
    await expect(send({ command: 'activateSearchTab', token, tabId: 2 }, frame())).rejects.toThrow('expired');
    await expect(send({ command: 'getSearchContext', token }, frame())).rejects.toThrow('expired');
  });

  it('dismissal from the frame closes the overlay without changing tabs', async () => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    await send({ command: 'getSearchContext', token }, frame());
    expect(await send({ command: 'dismissSearch', token }, frame())).toEqual({ ok: true });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'tabvacuum:close' }), { frameId: 0 });
    expect(api.tabs.update).not.toHaveBeenCalled();
    expect(api.windows.update).not.toHaveBeenCalled();
    await expect(send({ command: 'dismissSearch', token }, frame())).rejects.toThrow();
  });

  it('does not let an unclaimed stranger frame dismiss via a claimed token', async () => {
    const { api, launcher, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    await send({ command: 'getSearchContext', token: lastToken() }, frame());
    await expect(send({ command: 'dismissSearch', token: lastToken() }, frame({ frameId: 9 }))).rejects.toThrow();
  });
});

describe('repeat launches and expiry', () => {
  it('replaces an earlier overlay: old token revoked, old overlay told to close', async () => {
    const { api, launcher, send, lastToken, stored } = setup();
    await launcher.launch(await api.tabs.get(1));
    const first = lastToken();
    const firstId = api.scripting.executeScript.mock.calls[0][0].args[1];
    await launcher.launch(await api.tabs.get(1));
    expect(lastToken()).not.toBe(first);
    expect(Object.keys(stored())).toEqual([lastToken()]);
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'tabvacuum:close', id: firstId }, { frameId: 0 });
    await expect(send({ command: 'getSearchContext', token: first }, frame())).rejects.toThrow('expired');
  });

  it('serializes concurrent launches into one live session', async () => {
    const { api, launcher, stored } = setup();
    const tab = await api.tabs.get(1);
    await Promise.all([launcher.launch(tab), launcher.launch(tab), launcher.launch(tab)]);
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(3);
    expect(Object.keys(stored())).toHaveLength(1);
  });

  it('expires unclaimed tokens after a minute and claimed ones after an hour', async () => {
    let time = 1_000_000;
    const { api, launcher, send, lastToken } = setup({ now: () => time });
    await launcher.launch(await api.tabs.get(1));
    time += UNCLAIMED_MS;
    await expect(send({ command: 'getSearchContext', token: lastToken() }, frame())).rejects.toThrow('expired');

    await launcher.launch(await api.tabs.get(1));
    await send({ command: 'getSearchContext', token: lastToken() }, frame());
    time += SESSION_MS - 1;
    await expect(send({ command: 'getSearchContext', token: lastToken() }, frame())).resolves.toBeDefined();
    time += 1;
    await expect(send({ command: 'getSearchContext', token: lastToken() }, frame())).rejects.toThrow('expired');
  });

  it('survives worker suspension through storage.session', async () => {
    const { api, launcher, restart, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    const fresh = restart();
    await expect(fresh.handleMessage({ command: 'getSearchContext', token: lastToken() }, frame())).resolves.toBeDefined();
  });

  it('refuses once the origin tab is gone', async () => {
    const { api, launcher, send, lastToken, tabs } = setup();
    await launcher.launch(await api.tabs.get(1));
    tabs.splice(0, 1);
    await expect(send({ command: 'getSearchContext', token: lastToken() }, frame())).rejects.toThrow('expired');
  });

  it('cleans up when the origin tab closes', async () => {
    const { api, launcher, stored } = setup();
    await launcher.launch(await api.tabs.get(1));
    api.tabs.onRemoved.addListener.mock.calls.at(-1)[0](1);
    await vi.waitFor(() => expect(stored()).toEqual({}));
  });
});

describe('separate-window fallback', () => {
  it.each(['about:addons', 'chrome://settings/', 'file:///tmp/a.html', `${BASE}options.html`, 'view-source:https://a', '', undefined])(
    'opens a centered extension window for unscriptable %j', async url => {
      const { api, launcher, tabs } = setup();
      tabs[0].url = url;
      expect(await launcher.launch(await api.tabs.get(1))).toEqual({ mode: 'window' });
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
      const [options] = api.windows.create.mock.calls[0];
      expect(options).toEqual({
        url: expect.stringMatching(/^moz-extension:\/\/uuid\/search\.html\?token=[A-Za-z0-9_-]{43}$/),
        type: 'popup', incognito: false, width: 640, height: 460, left: 380, top: 220,
      });
    });

  it('falls back when injection is refused or does not mount', async () => {
    for (const failure of [
      () => Promise.reject(new Error('Missing host permission')),
      () => Promise.resolve([{ result: 'failed' }]),
      () => Promise.resolve([]),
    ]) {
      const { api, launcher, stored, windowToken } = setup();
      api.scripting.executeScript.mockImplementation(failure);
      expect(await launcher.launch(await api.tabs.get(1))).toEqual({ mode: 'window' });
      expect(Object.keys(stored())).toEqual([windowToken()]);
    }
  });

  it('opens a background-tab launch (context menu) as a window, not over a hidden page', async () => {
    const { api, launcher } = setup();
    expect(await launcher.launch(await api.tabs.get(4))).toEqual({ mode: 'window' });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('replaces an overlay whose frame never claimed its token', async () => {
    const { api, launcher, timers, lastToken, stored, windowToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    const overlayToken = lastToken();
    await timers[0]();
    await vi.waitFor(() => expect(api.windows.create).toHaveBeenCalled());
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'tabvacuum:close' }), { frameId: 0 });
    expect(Object.keys(stored())).toEqual([windowToken()]);
    expect(windowToken()).not.toBe(overlayToken);
  });

  it('leaves a claimed overlay alone at the timeout', async () => {
    const { api, launcher, timers, send, lastToken } = setup();
    await launcher.launch(await api.tabs.get(1));
    await send({ command: 'getSearchContext', token: lastToken() }, frame());
    timers[0]();
    await send({ command: 'getSearchContext', token: lastToken() }, frame());
    expect(api.windows.create).not.toHaveBeenCalled();
  });

  it('authorizes only the created window’s top frame', async () => {
    const { api, launcher, send, tabs, windowToken } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const token = windowToken();
    const launcherTab = tabs.at(-1).id;
    const context = await send({ command: 'getSearchContext', token }, popupWindow(launcherTab, token));
    expect(context.currentTabId).toBe(1); // The origin, not the search window.
    expect(context.tabs.map(t => t.id)).not.toContain(launcherTab);
    for (const sender of [
      popupWindow(launcherTab + 1, token), popupWindow(launcherTab, token, { frameId: 3 }),
      frame({ tab: { id: launcherTab } }), frame(), page(), popupWindow(launcherTab, token, { url: `${BASE}popup.html` }),
    ]) {
      await expect(send({ command: 'getSearchContext', token }, sender)).rejects.toThrow('expired');
    }
    // After the page drops the token from its address, the same frame still works.
    await expect(send({ command: 'getSearchContext', token }, popupWindow(launcherTab, token, { url: SEARCH }))).resolves.toBeDefined();
  });

  it('activation focuses the target before closing the search window', async () => {
    const { api, launcher, send, tabs, windowToken } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const created = await api.windows.create.mock.results[0].value;
    const token = windowToken();
    await send({ command: 'activateSearchTab', token, tabId: 2 }, popupWindow(created.tabs[0].id, token));
    expect(api.windows.update).toHaveBeenCalledWith(20, { focused: true });
    expect(api.windows.remove).toHaveBeenCalledWith(created.id);
    expect(api.windows.update.mock.invocationCallOrder.at(-1)).toBeLessThan(api.windows.remove.mock.invocationCallOrder[0]);
  });

  it('dismissal returns to the origin without navigating it', async () => {
    const { api, launcher, send, tabs, windowToken } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const created = await api.windows.create.mock.results[0].value;
    const token = windowToken();
    await send({ command: 'dismissSearch', token }, popupWindow(created.tabs[0].id, token));
    expect(api.tabs.update).toHaveBeenCalledWith(1, { active: true });
    expect(api.windows.update).toHaveBeenCalledWith(10, { focused: true });
    expect(api.windows.remove).toHaveBeenCalledWith(created.id);
    expect(api.windows.update.mock.invocationCallOrder[0]).toBeLessThan(api.windows.remove.mock.invocationCallOrder[0]);
    expect(api.tabs.update.mock.calls.flat().some(arg => typeof arg === 'object' && 'url' in arg)).toBe(false);
  });

  it('focuses the existing window instead of opening another', async () => {
    const { api, launcher, tabs } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const created = await api.windows.create.mock.results[0].value;
    await launcher.launch(await api.tabs.get(1));
    await launcher.launch(await api.tabs.get(created.tabs[0].id)); // Shortcut inside the search window.
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(api.windows.update).toHaveBeenCalledWith(created.id, { focused: true });
  });

  it('closes an earlier search window when searching from a different tab', async () => {
    const { api, launcher, tabs } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const created = await api.windows.create.mock.results[0].value;
    await launcher.launch(await api.tabs.get(2));
    expect(api.windows.remove).toHaveBeenCalledWith(created.id);
  });

  it('refuses a private search that the browser opened in a normal window', async () => {
    const { api, launcher, tabs, stored } = setup();
    tabs[2].url = 'about:privatebrowsing';
    api.windows.create.mockImplementationOnce(async () => ({ id: 77, incognito: false, tabs: [{ id: 78 }] }));
    await expect(launcher.launch(await api.tabs.get(3))).rejects.toThrow();
    expect(api.windows.create.mock.calls[0][0].incognito).toBe(true);
    expect(api.windows.remove).toHaveBeenCalledWith(77);
    expect(stored()).toEqual({});
  });

  it('closes the search window when its origin closes, and forgets it when it closes', async () => {
    const { api, launcher, tabs, stored } = setup();
    tabs[0].url = 'about:blank';
    await launcher.launch(await api.tabs.get(1));
    const created = await api.windows.create.mock.results[0].value;
    const onRemoved = api.tabs.onRemoved.addListener.mock.calls.at(-1)[0];
    onRemoved(1);
    await vi.waitFor(() => expect(api.windows.remove).toHaveBeenCalledWith(created.id));
    expect(stored()).toEqual({});

    await launcher.launch(await api.tabs.get(1));
    const second = await api.windows.create.mock.results[1].value;
    api.windows.remove.mockClear();
    onRemoved(second.tabs[0].id);
    await vi.waitFor(() => expect(stored()).toEqual({}));
    expect(api.windows.remove).not.toHaveBeenCalled();
  });
});

describe('placement and tokens', () => {
  it('centers within the origin window and shrinks for small ones', () => {
    expect(placement({ left: 0, top: 0, width: 1000, height: 1000 })).toEqual({ width: 640, height: 460, left: 180, top: 270 });
    expect(placement({ left: 10, top: 10, width: 500, height: 400 })).toEqual({ width: 452, height: 352, left: 34, top: 34 });
    expect(placement(undefined)).toEqual({ width: 640, height: 460 });
    expect(placement({ width: 800 })).toEqual({ width: 640, height: 460 });
  });
  it('mints unique 256-bit URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, newToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

// ---- Injected overlay, against a minimal DOM ----

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.parent = null;
    this.style = { props: {}, setProperty: (name, value, priority) => { this.style.props[name] = [value, priority]; } };
    this.focus = vi.fn();
    if (tag === 'dialog') {
      this.showModal = vi.fn(() => { this.open = true; });
      this.close = vi.fn(() => { this.open = false; });
    }
    if (tag === 'iframe') this.contentWindow = { postMessage: vi.fn() };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener, options) { (this.listeners[type] ??= []).push({ listener, once: options?.once }); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(l => l.listener !== listener); }
  dispatch(type, extra = {}) {
    const evt = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const entry of [...(this.listeners[type] ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener(evt);
    }
    return evt;
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  attachShadow(init) { this.shadowInit = init; this.shadow = new FakeElement('#shadow-root'); this.shadow.parent = this; return this.shadow; }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === globalThis.document.documentElement; }
}

function fakePage() {
  const documentElement = new FakeElement('html');
  const input = new FakeElement('input');
  documentElement.append(input);
  const win = new FakeElement('#window');
  win.top = win;
  const runtime = { id: EXT, sendMessage: vi.fn(async () => {}), onMessage: { addListener: vi.fn() } };
  vi.stubGlobal('document', { documentElement, activeElement: input, createElement: tag => new FakeElement(tag) });
  vi.stubGlobal('window', win);
  vi.stubGlobal('browser', { runtime });
  const host = () => documentElement.children.find(c => c.tagName === 'tabvacuum-search');
  const parts = h => {
    const dialog = h.shadow.children.find(c => c.tagName === 'dialog');
    return { dialog, iframe: dialog.children[0] };
  };
  const closeListener = () => runtime.onMessage.addListener.mock.calls.at(-1)[0];
  return { documentElement, input, win, runtime, host, parts, closeListener };
}

const TOKEN = 'T'.repeat(43);
const mount = (id = 'session-1') => mountSearchOverlay(TOKEN, id, SEARCH, 'moz-extension://uuid');

describe('injected overlay', () => {
  beforeEach(() => { delete globalThis.__tabvacuumSearch; delete globalThis.__tabvacuumCloseListener; });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts a closed-shadow modal whose page-visible DOM never holds the token', () => {
    const { host, parts } = fakePage();
    expect(mount()).toBe('mounted');
    const h = host();
    expect(h.shadowInit).toEqual({ mode: 'closed' });
    const { dialog, iframe } = parts(h);
    expect(dialog.showModal).toHaveBeenCalled();
    expect(iframe.src).toBe(SEARCH);
    expect(dialog.style.props.width[0]).toBe('min(640px, calc(100vw - 48px))');
    expect(dialog.style.props.height[0]).toBe('min(460px, calc(100vh - 48px))');
    const visible = JSON.stringify([h.attributes, h.style.props, dialog.attributes, iframe.attributes, iframe.src, iframe.title]);
    expect(visible).not.toContain(TOKEN);
    expect(globalThis.__tabvacuumSearch).not.toHaveProperty('token');
  });

  it('posts the token only to the frame, only for the extension origin, after load', () => {
    const { host, parts } = fakePage();
    mount();
    const { iframe } = parts(host());
    expect(iframe.contentWindow.postMessage).not.toHaveBeenCalled();
    iframe.dispatch('load');
    expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith({ type: 'tabvacuum:init', token: TOKEN }, 'moz-extension://uuid');
    expect(iframe.focus).toHaveBeenCalled();
    iframe.dispatch('load'); // A page-forced reload of the frame gets nothing.
    expect(iframe.contentWindow.postMessage).toHaveBeenCalledTimes(1);
  });

  it('dismisses on Escape or backdrop click, restoring page focus and telling the background', () => {
    for (const trigger of ['cancel', 'backdrop', 'pagehide']) {
      const page = fakePage();
      delete globalThis.__tabvacuumSearch;
      mount();
      const { dialog, iframe } = page.parts(page.host());
      if (trigger === 'cancel') expect(dialog.dispatch('cancel').defaultPrevented).toBe(true);
      else if (trigger === 'backdrop') { iframe.dispatch('click'); expect(page.host()).toBeDefined(); dialog.dispatch('click'); }
      else page.win.dispatch('pagehide');
      expect(page.host()).toBeUndefined();
      expect(page.input.focus).toHaveBeenCalledWith({ preventScroll: true });
      // A page teardown is reported as such, never as the user's dismissal.
      expect(page.runtime.sendMessage).toHaveBeenCalledWith(trigger === 'pagehide'
        ? { command: 'dismissSearch', token: TOKEN, reason: 'pagehide' } : { command: 'dismissSearch', token: TOKEN });
      expect(page.runtime.sendMessage).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it('closes only for its own session, from this extension', () => {
    const { host, closeListener, runtime } = fakePage();
    mount('mine');
    closeListener()({ type: 'tabvacuum:close', id: 'mine' }, { id: 'evil@ext' });
    closeListener()({ type: 'tabvacuum:close', id: 'other' }, { id: EXT });
    closeListener()({ type: 'other', id: 'mine' }, { id: EXT });
    expect(host()).toBeDefined();
    closeListener()({ type: 'tabvacuum:close', id: 'mine' }, { id: EXT });
    expect(host()).toBeUndefined();
    expect(runtime.sendMessage).not.toHaveBeenCalled(); // Background already knows.
  });

  it('replaces a previous overlay instead of stacking, with one close listener', () => {
    const { documentElement, runtime } = fakePage();
    mount('first');
    mount('second');
    expect(documentElement.children.filter(c => c.tagName === 'tabvacuum-search')).toHaveLength(1);
    expect(globalThis.__tabvacuumSearch.id).toBe('second');
    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses subframes and reports a failed modal so the background can fall back', () => {
    const page = fakePage();
    page.win.top = {};
    expect(mount()).toBe('refused');
    expect(page.host()).toBeUndefined();
    page.win.top = page.win;
    const create = document.createElement;
    document.createElement = tag => {
      const element = create(tag);
      if (tag === 'dialog') element.showModal = () => { throw new Error('InvalidStateError'); };
      return element;
    };
    expect(mount()).toBe('failed');
    expect(page.host()).toBeUndefined();
  });
});

describe('background message gating', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function loadBackground() {
    const { api } = fakeBrowser();
    Object.assign(api.runtime, { onMessage: event(), onInstalled: event() });
    api.tabs.remove = vi.fn(async () => {});
    api.storage.local.get = vi.fn(async defaults => defaults);
    api.contextMenus = { create: vi.fn(), onClicked: event() };
    api.commands = { onCommand: event() };
    api.notifications = { create: vi.fn() };
    vi.stubGlobal('browser', api);
    vi.resetModules();
    await import('../src/background.js');
    const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
    const send = (message, sender) => new Promise(resolve => {
      const pending = listener(message, sender, resolve);
      if (pending !== true) resolve('ignored');
    });
    return { api, send, onCommand: api.commands.onCommand.addListener.mock.calls[0][0] };
  }

  const popup = { id: EXT, url: `${BASE}popup.html` };
  const options = { id: EXT, url: `${BASE}options.html`, tab: { id: 50 } };

  it.each([
    ['a content script', page()],
    ['the search page embedded in a website', frame()],
    ['the fallback search window', popupWindow(101, 'x')],
    ['another extension', { ...popup, id: 'evil@ext' }],
    ['a lookalike page', { id: EXT, url: `${BASE}popup.html.evil` }],
    ['no sender URL', { id: EXT }],
  ])('ignores cleanup, settings, and launch commands from %s', async (_label, sender) => {
    const { api, send } = await loadBackground();
    for (const command of ['closeDuplicates', 'mergeWindows', 'closeStaleTabs', 'closeBlankTabs', 'sortTabs',
      'saveSettings', 'getSettings', 'launchSearch', 'takePopupMode']) {
      expect(await send({ command, settings: { skipPinned: false } }, sender)).toBe('ignored');
    }
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('serves the menu and settings pages, and launches search from the menu', async () => {
    const { api, send } = await loadBackground();
    expect(await send({ command: 'getSettings' }, options)).toHaveProperty('searchScope', 'all');
    expect(await send({ command: 'closeDuplicates' }, popup)).toHaveProperty('message');
    expect(await send({ command: 'launchSearch' }, popup)).toEqual({ mode: 'overlay' });
    expect(api.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 1 });
  });

  it('routes search commands by token, whatever page sent them', async () => {
    const { send } = await loadBackground();
    expect(await send({ command: 'getSearchContext', token: 'A'.repeat(43) }, page())).toHaveProperty('error');
  });

  it('launches over the tab the shortcut was pressed in', async () => {
    const { api, onCommand } = await loadBackground();
    await onCommand('search-tabs', { ...(await api.tabs.get(2)) });
    expect(api.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 2 });
  });
});

describe('overlay regression boundaries', () => {
  beforeEach(() => { delete globalThis.__tabvacuumSearch; delete globalThis.__tabvacuumCloseListener; });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a data-free Escape only from its own extension frame', () => {
    const page = fakePage();
    mount();
    const { iframe } = page.parts(page.host());
    const signal = { source: iframe.contentWindow, origin: 'moz-extension://uuid', data: { type: 'tabvacuum:escape' } };
    page.win.dispatch('message', { ...signal, origin: 'https://example.org' });
    page.win.dispatch('message', { ...signal, source: {} });
    expect(page.host()).toBeDefined();
    page.win.dispatch('message', signal);
    expect(page.host()).toBeUndefined();
    expect(page.runtime.sendMessage).toHaveBeenCalledWith({ command: 'dismissSearch', token: TOKEN });
  });

  it('revokes overlay sessions on navigation even if pagehide is lost', async () => {
    const { api, launcher, send, lastToken, stored, timers } = setup();
    await launcher.launch(await api.tabs.get(1));
    const token = lastToken();
    api.tabs.onUpdated.addListener.mock.calls[0][0](1, { status: 'loading' });
    await vi.waitFor(() => expect(stored()).toEqual({}));
    await expect(send({ command: 'getSearchContext', token }, frame())).rejects.toThrow('expired');
    timers[0]();
    await new Promise(resolve => setImmediate(resolve));
    expect(api.windows.create).not.toHaveBeenCalled();
  });

  it('does not open a late fallback after the originating tab navigates', async () => {
    const { api, launcher, timers, tabs, stored } = setup();
    await launcher.launch(await api.tabs.get(1));
    tabs[0].url = 'https://different.example/';
    timers[0]();
    await vi.waitFor(() => expect(stored()).toEqual({}));
    expect(api.windows.create).not.toHaveBeenCalled();
  });

  it('rejects unrelated public frames without waiting for an occupied launch queue', async () => {
    const { api, launcher, send, lastToken } = setup();
    let release;
    api.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const launching = launcher.launch(await api.tabs.get(1));
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(send({ command: 'getSearchContext', token: lastToken() }, frame({ tab: { id: 99 } }))).rejects.toThrow('expired');
    release([{ result: 'mounted' }]);
    await launching;
  });
});

describe('Chrome split-worker storage', () => {
  it('does not revoke or overwrite the other worker’s session during concurrent launches', async () => {
    const { api, launcher, send, lastToken } = setup();
    const privateApi = { ...api, extension: { inIncognitoContext: true } };
    const privateLauncher = createSearchLauncher(privateApi, createSearchService(privateApi), { schedule: () => {} });
    await Promise.all([launcher.launch(await api.tabs.get(1)), privateLauncher.launch(await api.tabs.get(3))]);
    let all = await api.storage.session.get(['search.sessions', 'search.sessions.private']);
    const normalToken = Object.keys(all['search.sessions'])[0];
    const privateToken = Object.keys(all['search.sessions.private'])[0];
    const privateSender = frame({ tab: { id: 3, windowId: 30, incognito: true } });
    expect((await send({ command: 'getSearchContext', token: normalToken }, frame())).tabs.map(t => t.id)).toEqual([1, 2, 4]);
    expect((await privateLauncher.handleMessage({ command: 'getSearchContext', token: privateToken }, privateSender)).tabs.map(t => t.id)).toEqual([3]);
    await expect(send({ command: 'getSearchContext', token: privateToken }, privateSender)).rejects.toThrow('expired');
    await launcher.launch(await api.tabs.get(1));
    all = await api.storage.session.get(['search.sessions', 'search.sessions.private']);
    expect(Object.keys(all['search.sessions'])).toEqual([lastToken()]);
    expect(Object.keys(all['search.sessions.private'])).toEqual([privateToken]);
  });
});

describe('closing selected tabs from search', () => {
  // Window 10: 1 (origin), 4, 6. Window 20: 2, 5. Window 30 (private): 3.
  async function closing(mode, { now } = {}) {
    const env = setup({ now });
    env.tabs.push({ id: 5, windowId: 20, url: 'https://five.example/' }, { id: 6, windowId: 10, url: 'https://six.example/' });
    if (mode === 'window') env.tabs[0].url = 'about:blank';
    await env.launcher.launch(await env.api.tabs.get(1));
    if (mode === 'overlay') return { ...env, token: env.lastToken(), sender: frame() };
    const created = await env.api.windows.create.mock.results[0].value;
    const token = env.windowToken();
    return { ...env, token, created, sender: popupWindow(created.tabs[0].id, token) };
  }
  const close = (env, tabIds, sender = env.sender, token = env.token) =>
    env.send({ command: 'closeSearchTabs', token, tabIds }, sender);
  const removed = api => api.tabs.remove.mock.calls.map(([id]) => id);

  describe.each(['overlay', 'window'])('%s', mode => {
    it('closes only the approved IDs, keeps the search usable, and bundles the fresh list', async () => {
      const env = await closing(mode);
      const result = await close(env, [2, 4]);
      expect(result).toMatchObject({ ok: true, closedIds: [2, 4], skipped: [], failedIds: [] });
      expect(Object.keys(result).sort()).toEqual(['closedIds', 'context', 'failedIds', 'ok', 'skipped']);
      expect(removed(env.api)).toEqual([2, 4]);
      expect(env.api.tabs.sendMessage).not.toHaveBeenCalled();
      expect(env.api.windows.remove).not.toHaveBeenCalled();
      const context = await env.send({ command: 'getSearchContext', token: env.token }, env.sender);
      expect(context.tabs.map(t => t.id)).toEqual([1, 5, 6]);
      expect(result.context).toEqual(context);
    });

    it('reports a failed list read after a completed close, without closing again', async () => {
      const env = await closing(mode);
      await env.send({ command: 'getSearchContext', token: env.token }, env.sender); // Claim first.
      const query = env.api.tabs.query.getMockImplementation();
      // The scope read before closing succeeds; the bundled read after it fails.
      env.api.tabs.query.mockImplementation(async q => {
        if (env.api.tabs.remove.mock.calls.length && q.windowId === undefined) throw new Error('read failed');
        return query(q);
      });
      const result = await close(env, [2]);
      expect(result).toEqual({ ok: true, closedIds: [2], skipped: [], failedIds: [], contextError: true });
      expect(removed(env.api)).toEqual([2]);
    });
  });

  describe('window', () => {
    it('closes the origin last and stays usable, scoped to the origin’s window', async () => {
      const env = await closing('window');
      const result = await close(env, [1, 2, 4]);
      expect(result).toMatchObject({ ok: true, closedIds: [2, 4, 1], skipped: [], failedIds: [] });
      expect(result.context).toMatchObject({ windowId: 10 });
      expect(result.context.tabs.map(t => t.id)).toEqual([5, 6]);
      expect(removed(env.api)).toEqual([2, 4, 1]);
      await new Promise(resolve => setImmediate(resolve)); // Queued onRemoved cleanup runs.
      expect(env.api.windows.remove).not.toHaveBeenCalled();
      expect(Object.keys(env.stored())).toEqual([env.token]);
      // Still authorized, and the last-tab safeguard still applies.
      await expect(close(env, [5])).resolves.toMatchObject({ closedIds: [], skipped: [{ tabId: 5, reason: 'last-tab' }] });
      await expect(env.send({ command: 'dismissSearch', token: env.token }, env.sender)).resolves.toEqual({ ok: true });
      expect(env.api.windows.remove).toHaveBeenCalledWith(env.created.id);
      expect(env.stored()).toEqual({});
    });
  });

  describe.each(['overlay', 'window'])('%s', mode => {
    it('keeps the search when the origin is protected as the last tab of its window', async () => {
      const env = await closing(mode);
      const result = await close(env, [1, 4, 6]);
      expect(result.closedIds).toEqual([4, 6]);
      expect(result.skipped).toEqual([{ tabId: 1, reason: 'last-tab' }]);
      await expect(env.send({ command: 'getSearchContext', token: env.token }, env.sender)).resolves.toBeDefined();
    });

    it('skips private and search-window tabs, and pinned/audible ones by default', async () => {
      const env = await closing(mode);
      Object.assign(env.tabs.find(t => t.id === 4), { pinned: true });
      Object.assign(env.tabs.find(t => t.id === 6), { audible: true });
      const ids = [3, 4, 6, 999];
      if (mode === 'window') ids.push(env.created.tabs[0].id);
      const result = await close(env, ids);
      expect(result.closedIds).toEqual([]);
      expect(result.skipped).toEqual([
        { tabId: 3, reason: 'unavailable' }, { tabId: 4, reason: 'pinned' }, { tabId: 6, reason: 'audible' },
        { tabId: 999, reason: 'unavailable' },
        ...(mode === 'window' ? [{ tabId: env.created.tabs[0].id, reason: 'unavailable' }] : []),
      ]);
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
    });

    it('reports partial failures instead of claiming success', async () => {
      const env = await closing(mode);
      env.api.tabs.remove.mockImplementationOnce(async () => { throw new Error('busy'); });
      expect(await close(env, [2, 4])).toMatchObject({ ok: true, closedIds: [4], skipped: [], failedIds: [2] });
    });

    it.each([
      [], [2, 2], [2, -1], [2.5], ['2'], null, undefined, 2, { 0: 2 }, Array.from({ length: 10_001 }, (_, i) => i),
    ])('rejects payload %j before closing anything, and the search survives', async tabIds => {
      const env = await closing(mode);
      await expect(close(env, tabIds)).rejects.toThrow();
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
      await expect(close(env, [4])).resolves.toMatchObject({ closedIds: [4] });
    });
  });

  it('refuses forged tokens, foreign frames, and the origin page itself', async () => {
    const env = await closing('overlay');
    await close(env, [5]); // Claims the token for frame().
    const tampered = env.token.slice(0, 42) + (env.token.endsWith('A') ? 'B' : 'A');
    for (const token of [undefined, null, '', 42, 'A'.repeat(43), tampered, '__proto__']) {
      await expect(env.send({ command: 'closeSearchTabs', token, tabIds: [4] }, frame())).rejects.toThrow('expired');
    }
    for (const sender of [
      frame({ id: 'evil@ext' }), frame({ tab: undefined }), frame({ tab: { id: 2, windowId: 20 } }),
      page(), frame({ frameId: 0 }), frame({ frameId: 8 }), frame({ documentId: 'reloaded' }),
      frame({ url: `${BASE}options.html` }), frame({ tab: { id: 1, incognito: true } }),
    ]) {
      await expect(close(env, [4], sender)).rejects.toThrow('expired');
    }
    expect(removed(env.api)).toEqual([5]);
  });

  it('refuses a stale token after relaunch and an expired one', async () => {
    let time = 1_000_000;
    const env = await closing('overlay', { now: () => time });
    await env.launcher.launch(await env.api.tabs.get(1));
    await expect(close(env, [4])).rejects.toThrow('expired');
    const fresh = env.lastToken();
    time += UNCLAIMED_MS; // Never claimed.
    await expect(close(env, [4], frame(), fresh)).rejects.toThrow('expired');
    expect(env.api.tabs.remove).not.toHaveBeenCalled();
  });

  it('may be the first claim, like any privileged command, then binds the frame', async () => {
    const env = await closing('overlay');
    await expect(close(env, [4])).resolves.toMatchObject({ closedIds: [4] });
    await expect(close(env, [6], frame({ frameId: 9 }))).rejects.toThrow('expired');
  });

  it('does not let a normal search close private tabs, or a private search close normal ones', async () => {
    const env = setup();
    env.tabs.push({ id: 7, windowId: 30, incognito: true, url: 'https://p7.example/' });
    await env.launcher.launch(await env.api.tabs.get(3));
    const sender = frame({ tab: { id: 3, windowId: 30, incognito: true } });
    const result = await env.send({ command: 'closeSearchTabs', token: env.lastToken(), tabIds: [1, 2, 7] }, sender);
    expect(result).toMatchObject({ ok: true, closedIds: [7], failedIds: [],
      skipped: [{ tabId: 1, reason: 'unavailable' }, { tabId: 2, reason: 'unavailable' }] });
    expect(result.context.tabs.map(t => t.id)).toEqual([3]);
  });

  it('honors current-window scope from settings', async () => {
    const env = await closing('overlay');
    env.api.storage.local.get.mockImplementation(async keys => ('searchScope' in keys ? { searchScope: 'current' } : {}));
    const result = await close(env, [2, 4]);
    expect(result.closedIds).toEqual([4]);
    expect(result.skipped).toEqual([{ tabId: 2, reason: 'unavailable' }]);
  });

  it('is serialized with launches, and origin cleanup listeners queue behind it without deadlock', async () => {
    const env = await closing('window');
    let release;
    const realRemove = env.api.tabs.remove.getMockImplementation();
    env.api.tabs.remove.mockImplementationOnce(id => new Promise(resolve => { release = () => resolve(realRemove(id)); }));
    const closingNow = close(env, [2, 1, 4]);
    await vi.waitFor(() => expect(release).toBeDefined());
    const relaunch = env.launcher.launch(await env.api.tabs.get(4));
    await new Promise(resolve => setImmediate(resolve));
    expect(env.api.windows.create).toHaveBeenCalledTimes(1); // Waiting for the close.
    release();
    expect(await closingNow).toMatchObject({ ok: true, closedIds: [2, 4, 1], skipped: [], failedIds: [] });
    await relaunch;
    expect(env.api.windows.create).toHaveBeenCalledTimes(2); // Background tab 4 → window.
  });
});

describe('closing the tab that hosts an embedded search', () => {
  const STATE = { query: 'secret query', mode: 'tabs', sources: { history: true, content: true }, highlight: 'tab:1', focus: 'list' };
  // Window 10: 1 (host), 4 (loaded, most recent), 6 (loaded). Window 20: 2, 5.
  async function hosted({ permission = true, now } = {}) {
    const env = setup({ now });
    env.tabs.push({ id: 5, windowId: 20, url: 'https://five.example/' },
      { id: 6, windowId: 10, url: 'https://six.example/', status: 'complete', lastAccessed: 5 });
    Object.assign(env.tabs.find(t => t.id === 4), { status: 'complete', lastAccessed: 9 });
    let granted = permission;
    env.api.permissions = { contains: vi.fn(async () => granted) };
    await env.launcher.launch(await env.api.tabs.get(1));
    const token = env.lastToken();
    await env.send({ command: 'getSearchContext', token }, frame()); // Claimed.
    return { ...env, token, grant: value => { granted = value; } };
  }
  const startClose = (env, tabIds, state = STATE) =>
    env.send({ command: 'closeSearchTabs', token: env.token, tabIds, state }, frame());
  const at = (tabId, over = {}) => frame({ tab: { id: tabId, windowId: 10 }, frameId: 3, documentId: `doc-${tabId}`, ...over });
  const removed = api => api.tabs.remove.mock.calls.map(([id]) => id);
  const injected = async (env, count = 2) => {
    await vi.waitFor(() => expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(count));
    return env.lastToken();
  };
  const windowOpened = async env => {
    await vi.waitFor(() => expect(env.api.windows.create).toHaveBeenCalled());
    const created = await env.api.windows.create.mock.results.at(-1).value;
    const token = env.windowToken();
    return { created, token, sender: popupWindow(created.tabs[0].id, token) };
  };
  // Every replacement readiness wait so far ends, as if READY_MS passed.
  const readyTimeout = env => { for (const timer of env.timers.filter(t => t.ms === READY_MS)) timer(); };
  const overlayClosed = (env, tabId) => env.api.tabs.sendMessage.mock.calls.some(([id, msg]) => id === tabId && msg.type === 'tabvacuum:close');

  it('readies an overlay on a permitted loaded tab in the same window before closing anything', async () => {
    const env = await hosted();
    const closing = startClose(env, [1, 2]);
    const token = await injected(env);
    const [call] = env.api.scripting.executeScript.mock.calls[1];
    expect(call.target).toEqual({ tabId: 4 }); // Most recently used, not 6, never 2 (closing) or 5 (other window).
    expect(call.args[2]).toBe(SEARCH); // No token or state in the page or its frame URL.
    expect(JSON.stringify(call.args)).not.toContain('secret query');
    expect(token).not.toBe(env.token);

    // Not usable for anything but loading until it reports ready.
    await expect(env.send({ command: 'closeSearchTabs', token, tabIds: [6] }, at(4))).rejects.toThrow('expired');
    await expect(env.send({ command: 'searchHandoffReady', token }, at(4))).rejects.toThrow('expired');
    const loaded = await env.send({ command: 'getSearchContext', token }, at(4));
    expect(loaded.restore).toEqual({ ...STATE, checked: [], order: [], closing: [1, 2] });
    expect(loaded.currentTabId).toBe(4);
    expect(loaded.tabs.map(t => t.id)).toEqual([1, 2, 4, 5, 6]);
    expect((await env.send({ command: 'getSearchContext', token }, at(4))).restore).toBeUndefined(); // Delivered once.
    // The original frame can no longer act while handing off.
    await expect(env.send({ command: 'getSearchContext', token: env.token }, frame())).rejects.toThrow('expired');
    await expect(startClose(env, [6])).rejects.toThrow('expired');
    expect(env.api.tabs.remove).not.toHaveBeenCalled();

    const ready = env.send({ command: 'searchHandoffReady', token }, at(4));
    expect(await closing).toEqual({ ok: true, handedOff: true, closedIds: [2, 1], skipped: [], failedIds: [] });
    expect(env.api.tabs.update).toHaveBeenCalledWith(4, { active: true });
    expect(env.api.tabs.update.mock.invocationCallOrder[0]).toBeLessThan(env.api.tabs.remove.mock.invocationCallOrder[0]);
    const reply = await ready;
    expect(reply).toMatchObject({ ok: true, closedIds: [2, 1], skipped: [], failedIds: [] });
    expect(reply.context).toMatchObject({ windowId: 10, currentTabId: 4 });
    expect(reply.context.tabs.map(t => t.id)).toEqual([4, 5, 6]);
    expect(Object.keys(env.stored())).toEqual([token]);
    await expect(env.send({ command: 'getSearchContext', token: env.token }, frame())).rejects.toThrow('expired');
    await expect(env.send({ command: 'dismissSearch', token: env.token }, page())).rejects.toThrow('expired');
    await expect(env.send({ command: 'searchHandoffReady', token }, at(4))).rejects.toThrow('expired'); // No replay.
    expect(env.stored()[token].expiresAt).toBe(1_000_000 + SESSION_MS);
  });

  it('chains: the replacement can hand off again when its own host closes', async () => {
    const env = await hosted();
    const first = startClose(env, [1]);
    const token = await injected(env);
    await env.send({ command: 'getSearchContext', token }, at(4));
    env.send({ command: 'searchHandoffReady', token }, at(4));
    await first;
    const second = env.send({ command: 'closeSearchTabs', token, tabIds: [4], state: STATE }, at(4));
    const next = await injected(env, 3);
    expect(env.api.scripting.executeScript.mock.calls[2][0].target).toEqual({ tabId: 6 });
    await env.send({ command: 'getSearchContext', token: next }, at(6));
    const ready = env.send({ command: 'searchHandoffReady', token: next }, at(6));
    expect(await second).toMatchObject({ handedOff: true, closedIds: [4] });
    expect((await ready).context.tabs.map(t => t.id)).toEqual([2, 5, 6]);
    expect(removed(env.api)).toEqual([1, 4]);
  });

  it('keeps the remaining checks, and a protected host is not handed off', async () => {
    const env = await hosted();
    const closing = startClose(env, [1], { ...STATE, mode: 'select', checked: [1, 4, 6], focus: 'row-close', focusTabId: 1 });
    const token = await injected(env);
    const loaded = await env.send({ command: 'getSearchContext', token }, at(4));
    expect(loaded.restore).toMatchObject({ mode: 'select', checked: [1, 4, 6], focus: 'row-close', focusTabId: 1, closing: [1] });
    env.send({ command: 'searchHandoffReady', token }, at(4));
    await closing;

    const pinned = await hosted();
    Object.assign(pinned.tabs.find(t => t.id === 1), { pinned: true });
    expect(await startClose(pinned, [1, 2])).toMatchObject({ closedIds: [2], skipped: [{ tabId: 1, reason: 'pinned' }] });
    expect(pinned.api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(pinned.api.windows.create).not.toHaveBeenCalled();
  });

  it('closes the old overlay if the host becomes protected before the batch closes', async () => {
    const env = await hosted();
    const closing = startClose(env, [1, 2]);
    const token = await injected(env);
    await env.send({ command: 'getSearchContext', token }, at(4));
    Object.assign(env.tabs.find(t => t.id === 1), { audible: true });
    env.send({ command: 'searchHandoffReady', token }, at(4));
    expect(await closing).toMatchObject({ handedOff: true, closedIds: [2], skipped: [{ tabId: 1, reason: 'audible' }] });
    expect(overlayClosed(env, 1)).toBe(true);
  });

  async function viaWindow(env, closing) {
    const { created, token, sender } = await windowOpened(env);
    expect(env.api.tabs.remove).not.toHaveBeenCalled();
    const loaded = await env.send({ command: 'getSearchContext', token }, sender);
    expect(loaded.restore).toMatchObject({ query: 'secret query', closing: [1] });
    const ready = env.send({ command: 'searchHandoffReady', token }, sender);
    expect(await closing).toMatchObject({ handedOff: true, closedIds: [1] });
    expect((await ready).context.tabs.map(t => t.id)).toEqual([2, 4, 5, 6]);
    // The window keeps working after its old host is gone.
    expect(await env.send({ command: 'closeSearchTabs', token, tabIds: [4] }, sender)).toMatchObject({ closedIds: [4] });
    expect(env.api.windows.remove).not.toHaveBeenCalledWith(created.id);
    expect(Object.keys(env.stored())).toEqual([token]);
    return { created, token, sender };
  }

  it('falls back to a search window without website access, injecting nothing else', async () => {
    const env = await hosted({ permission: false });
    const closing = startClose(env, [1]);
    await viaWindow(env, closing);
    expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(env.api.windows.create.mock.calls[0][0]).toMatchObject({ type: 'popup', incognito: false });
  });

  it('falls back when access is revoked after the replacement loaded', async () => {
    const env = await hosted();
    const closing = startClose(env, [1]);
    const token = await injected(env);
    await env.send({ command: 'getSearchContext', token }, at(4));
    env.grant(false);
    env.send({ command: 'searchHandoffReady', token }, at(4));
    await viaWindow(env, closing);
    expect(overlayClosed(env, 4)).toBe(true);
  });

  it.each([
    ['injection is refused', env => env.api.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access'))],
    ['the overlay does not mount', env => env.api.scripting.executeScript.mockResolvedValueOnce([{ result: 'failed' }])],
  ])('falls back when %s', async (_label, fail) => {
    const env = await hosted();
    fail(env);
    const closing = startClose(env, [1]);
    await viaWindow(env, closing);
    expect(overlayClosed(env, 4)).toBe(true);
  });

  it('bounds an injection that never answers, then falls back', async () => {
    const env = await hosted();
    env.api.scripting.executeScript.mockImplementationOnce(() => new Promise(() => {}));
    const closing = startClose(env, [1]);
    await vi.waitFor(() => expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(2));
    readyTimeout(env);
    await viaWindow(env, closing);
  });

  it('falls back when the replacement frame never initializes, or its page changes', async () => {
    for (const change of [() => {}, env => { env.tabs.find(t => t.id === 4).url = 'https://example.org/elsewhere'; }]) {
      const env = await hosted();
      const closing = startClose(env, [1]);
      const token = await injected(env);
      change(env);
      if (change.length) await expect(env.send({ command: 'getSearchContext', token }, at(4))).rejects.toThrow('expired');
      readyTimeout(env);
      await viaWindow(env, closing);
      expect(overlayClosed(env, 4)).toBe(true);
    }
  });

  it('closes nothing and explains when neither replacement becomes ready', async () => {
    const env = await hosted({ permission: false });
    const closing = startClose(env, [1, 2]);
    const { created } = await windowOpened(env);
    readyTimeout(env); // The window never initializes.
    expect(await closing).toEqual({ ok: false, handoffFailed: true, closedIds: [], skipped: [], failedIds: [] });
    expect(env.api.tabs.remove).not.toHaveBeenCalled();
    expect(env.api.windows.remove).toHaveBeenCalledWith(created.id);
    expect(Object.keys(env.stored())).toEqual([env.token]);
    expect(await startClose(env, [2])).toMatchObject({ closedIds: [2] }); // Usable again.

    const blocked = await hosted({ permission: false });
    blocked.api.windows.create.mockRejectedValueOnce(new Error('no windows'));
    expect(await startClose(blocked, [1])).toMatchObject({ ok: false, handoffFailed: true });
    expect(blocked.api.tabs.remove).not.toHaveBeenCalled();
  });

  it('authorizes the replacement frame only: no other tab, frame, document, or privacy mode', async () => {
    const env = await hosted();
    startClose(env, [1]);
    const token = await injected(env);
    for (const sender of [frame(), at(2), at(4, { tab: { id: 4, incognito: true } }), at(4, { frameId: 0 }),
      at(4, { url: `${BASE}options.html` }), at(4, { id: 'evil@ext' })]) {
      await expect(env.send({ command: 'getSearchContext', token }, sender)).rejects.toThrow('expired');
    }
    await env.send({ command: 'getSearchContext', token }, at(4));
    await expect(env.send({ command: 'getSearchContext', token }, at(4, { frameId: 8 }))).rejects.toThrow('expired');
    await expect(env.send({ command: 'searchHandoffReady', token }, at(4, { documentId: 'reloaded' }))).rejects.toThrow('expired');
    expect(env.api.tabs.remove).not.toHaveBeenCalled();
  });

  it('accepts a window page that loads before the window is recorded', async () => {
    const env = await hosted({ permission: false });
    const create = env.api.windows.create.getMockImplementation();
    let early;
    env.api.windows.create.mockImplementationOnce(async options => {
      const created = await create(options);
      const token = new URL(options.url).searchParams.get('token');
      early = env.send({ command: 'getSearchContext', token }, popupWindow(created.tabs[0].id, token));
      return created;
    });
    const closing = startClose(env, [1]);
    const { token, sender } = await windowOpened(env);
    expect((await early).restore.closing).toEqual([1]);
    env.send({ command: 'searchHandoffReady', token }, sender);
    expect(await closing).toMatchObject({ handedOff: true, closedIds: [1] });
  });

  it.each([
    ['the original is dismissed', env => env.send({ command: 'dismissSearch', token: env.token }, page())],
    ['the host navigates', env => env.api.tabs.onUpdated.addListener.mock.calls[0][0](1, { status: 'loading' })],
    ['the host closes elsewhere', env => {
      env.tabs.splice(env.tabs.findIndex(t => t.id === 1), 1);
      for (const [listener] of env.api.tabs.onRemoved.addListener.mock.calls) listener(1, {});
    }],
  ])('cancels without closing anything or stranding the replacement when %s', async (_label, end) => {
    const env = await hosted();
    const closing = startClose(env, [1, 2]);
    const token = await injected(env);
    await env.send({ command: 'getSearchContext', token }, at(4));
    env.api.tabs.remove.mockClear();
    await end(env);
    await expect(closing).rejects.toThrow('expired');
    expect(removed(env.api)).toEqual([]);
    expect(overlayClosed(env, 4)).toBe(true);
    expect(env.stored()).toEqual({});
    await expect(env.send({ command: 'searchHandoffReady', token }, at(4))).rejects.toThrow('expired');
  });

  it('a newer launch cancels the handoff and keeps the new search', async () => {
    const env = await hosted();
    const closing = startClose(env, [1, 2]);
    const token = await injected(env);
    await env.launcher.launch(await env.api.tabs.get(6));
    const fresh = env.lastToken();
    await expect(closing).rejects.toThrow('expired');
    expect(env.api.tabs.remove).not.toHaveBeenCalled();
    expect(Object.keys(env.stored())).toEqual([fresh]);
    await expect(env.send({ command: 'getSearchContext', token }, at(4))).rejects.toThrow('expired');
  });

  // Replacement destination 4 (overlay) loads, and reports ready.
  async function readyOverlay(env) {
    const token = await injected(env);
    await env.send({ command: 'getSearchContext', token }, at(4));
    return { token, ready: env.send({ command: 'searchHandoffReady', token }, at(4)) };
  }
  // Runs `change` once, the next time close policy reads the pinned/audible settings.
  const duringPolicyRead = (env, change) => {
    const get = env.api.storage.local.get.getMockImplementation();
    let done = false;
    env.api.storage.local.get.mockImplementation(async keys => {
      if (!done && keys && 'skipPinned' in keys && env.api.tabs.update.mock.calls.length + env.api.windows.update.mock.calls.length) { done = true; await change(); }
      return get(keys);
    });
  };
  const usable = env => env.send({ command: 'getSearchContext', token: env.token }, frame());

  describe('the host never closes without a ready replacement (no-handoff branch)', () => {
    it('keeps the host when a whole-window batch loses a sibling, so the host is no longer last', async () => {
      const env = await hosted();
      const remove = env.api.tabs.remove.getMockImplementation();
      env.api.tabs.remove.mockImplementation(async id => { if (id === 4) throw new Error('busy'); return remove(id); });
      const result = await startClose(env, [1, 4, 6]);
      expect(result).toMatchObject({ ok: true, closedIds: [6], failedIds: [4], skipped: [{ tabId: 1, reason: 'changed' }] });
      expect(removed(env.api)).toEqual([4, 6]); // Never 1.
      expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(1);
      expect(env.api.windows.create).not.toHaveBeenCalled();
      await expect(usable(env)).resolves.toMatchObject({ windowId: 10 });
    });

    it('keeps the host when its protection lifts mid-batch', async () => {
      const env = await hosted();
      const host = env.tabs.find(t => t.id === 1);
      host.pinned = true;
      const remove = env.api.tabs.remove.getMockImplementation();
      env.api.tabs.remove.mockImplementation(async id => { host.pinned = false; return remove(id); });
      const result = await startClose(env, [2, 1]);
      expect(result).toMatchObject({ closedIds: [2], skipped: [{ tabId: 1, reason: 'changed' }] });
      expect(removed(env.api)).toEqual([2]);
      await expect(usable(env)).resolves.toBeDefined();
    });
  });

  describe('standalone handoff does not select a sleeping successor', () => {
    async function finishWindow(env, closing) {
      const { token, sender } = await windowOpened(env);
      await env.send({ command: 'getSearchContext', token }, sender);
      const ready = env.send({ command: 'searchHandoffReady', token }, sender);
      expect(await closing).toMatchObject({ handedOff: true });
      await ready;
    }

    it('activates a loaded protected survivor before closing the active host', async () => {
      const env = await hosted({ permission: false });
      env.tabs.find(tab => tab.id === 4).discarded = true;
      const protectedTab = env.tabs.find(tab => tab.id === 6);
      protectedTab.url = 'about:blank';
      const closing = startClose(env, [1, 2]);
      await finishWindow(env, closing);
      expect(env.api.tabs.update).toHaveBeenCalledWith(6, { active: true });
      expect(env.api.tabs.update).not.toHaveBeenCalledWith(4, { active: true });
      const activated = env.api.tabs.update.mock.calls.findIndex(([id]) => id === 6);
      expect(env.api.tabs.update.mock.invocationCallOrder[activated]).toBeLessThan(env.api.tabs.remove.mock.invocationCallOrder[0]);
    });

    it('never activates a closing or discarded tab when no loaded survivor exists', async () => {
      const env = await hosted({ permission: false });
      env.tabs.find(tab => tab.id === 4).discarded = true;
      const closing = startClose(env, [1, 6]);
      await finishWindow(env, closing);
      expect(env.api.tabs.update).not.toHaveBeenCalled();
    });
  });

  describe('the destination is checked again at every destructive step', () => {
    it('falls back to the window when activating the overlay destination fails', async () => {
      const env = await hosted();
      env.api.tabs.update.mockRejectedValueOnce(new Error('No tab'));
      const closing = startClose(env, [1]);
      await readyOverlay(env);
      await viaWindow(env, closing);
      expect(overlayClosed(env, 4)).toBe(true);
    });

    it('closes nothing when activating the replacement window fails', async () => {
      const env = await hosted({ permission: false });
      env.api.windows.update.mockRejectedValueOnce(new Error('No window'));
      const closing = startClose(env, [1, 2]);
      const { created, token, sender } = await windowOpened(env);
      await env.send({ command: 'getSearchContext', token }, sender);
      env.send({ command: 'searchHandoffReady', token }, sender);
      expect(await closing).toMatchObject({ ok: false, handoffFailed: true, closedIds: [] });
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
      expect(env.api.windows.remove).toHaveBeenCalledWith(created.id);
      expect(env.api.tabs.update).toHaveBeenCalledWith(4, { active: true });
      expect(env.api.tabs.update).toHaveBeenLastCalledWith(1, { active: true });
      expect(env.api.windows.update).toHaveBeenLastCalledWith(10, { focused: true });
      await expect(usable(env)).resolves.toBeDefined();
    });

    it.each([
      ['navigates', env => { env.tabs.find(t => t.id === 4).url = 'https://example.org/elsewhere'; }],
      ['moves to another window', env => { env.tabs.find(t => t.id === 4).windowId = 20; }],
      ['loses website access', env => env.grant(false)],
    ])('falls back to the window, closing nothing first, when the overlay destination %s during close policy reads', async (_label, change) => {
      const env = await hosted();
      const closing = startClose(env, [1, 2]);
      await readyOverlay(env);
      duringPolicyRead(env, () => change(env));
      const { token, sender } = await windowOpened(env);
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
      expect(overlayClosed(env, 4)).toBe(true);
      await env.send({ command: 'getSearchContext', token }, sender);
      env.send({ command: 'searchHandoffReady', token }, sender);
      expect(await closing).toMatchObject({ handedOff: true, closedIds: [2, 1] });
    });

    it('closes nothing when the replacement window closes during close policy reads', async () => {
      const env = await hosted({ permission: false });
      const closing = startClose(env, [1, 2]);
      const { created, token, sender } = await windowOpened(env);
      await env.send({ command: 'getSearchContext', token }, sender);
      duringPolicyRead(env, () => { env.tabs.splice(env.tabs.findIndex(t => t.id === created.tabs[0].id), 1); });
      env.send({ command: 'searchHandoffReady', token }, sender);
      expect(await closing).toMatchObject({ ok: false, handoffFailed: true, closedIds: [] });
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
      await expect(usable(env)).resolves.toBeDefined();
    });

    it('keeps the host and the original search when the destination is lost mid-batch, reporting what closed', async () => {
      const env = await hosted();
      const closing = startClose(env, [2, 1]);
      const { ready } = await readyOverlay(env);
      const remove = env.api.tabs.remove.getMockImplementation();
      env.api.tabs.remove.mockImplementation(async id => {
        await remove(id);
        env.tabs.find(t => t.id === 4).url = 'https://example.org/elsewhere';
      });
      const result = await closing;
      expect(result).toMatchObject({ ok: true, closedIds: [2], skipped: [{ tabId: 1, reason: 'changed' }], failedIds: [] });
      expect(result.handedOff).toBeUndefined();
      expect(result.context.tabs.map(t => t.id)).toEqual([1, 4, 5, 6]);
      expect(removed(env.api)).toEqual([2]);
      expect(await ready).toEqual({ ok: false });
      expect(overlayClosed(env, 4)).toBe(true);
      expect(env.api.tabs.update).toHaveBeenLastCalledWith(1, { active: true });
      expect(Object.keys(env.stored())).toEqual([env.token]);
      await expect(usable(env)).resolves.toBeDefined();
    });
  });

  describe('dismissing a replacement cancels the close', () => {
    const pageAt = tabId => page({ tab: { id: tabId, windowId: 10 }, url: 'https://example.org/b' });
    it.each([
      ['its frame', (env, token) => env.send({ command: 'dismissSearch', token }, at(4))],
      ['its page (Escape or backdrop)', (env, token) => env.send({ command: 'dismissSearch', token }, pageAt(4))],
    ])('overlay, through %s: no fallback, nothing closes, the original is usable', async (_label, dismiss) => {
      const env = await hosted();
      const closing = startClose(env, [1, 2]);
      const token = await injected(env);
      await env.send({ command: 'getSearchContext', token }, at(4));
      await dismiss(env, token);
      expect(await closing).toEqual({ ok: false, cancelled: true, closedIds: [], skipped: [], failedIds: [] });
      expect(env.api.windows.create).not.toHaveBeenCalled();
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
      await expect(usable(env)).resolves.toBeDefined();
      expect(Object.keys(env.stored())).toEqual([env.token]);
    });

    it('overlay torn down by its page (pagehide) is a failed destination, not a cancellation', async () => {
      const env = await hosted();
      const closing = startClose(env, [1]);
      const token = await injected(env);
      await env.send({ command: 'dismissSearch', token, reason: 'pagehide' }, pageAt(4));
      await viaWindow(env, closing);
    });

    it.each([
      ['its page', (env, token, sender) => env.send({ command: 'dismissSearch', token }, sender)],
      ['closing the window', (env, _token, sender) => env.api.tabs.remove(sender.tab.id)],
    ])('window, through %s: nothing closes and the original is usable', async (_label, dismiss) => {
      const env = await hosted({ permission: false });
      const closing = startClose(env, [1, 2]);
      const { token, sender } = await windowOpened(env);
      await env.send({ command: 'getSearchContext', token }, sender);
      await dismiss(env, token, sender);
      expect(await closing).toMatchObject({ ok: false, cancelled: true, closedIds: [] });
      expect(removed(env.api)).not.toContain(1);
      expect(removed(env.api)).not.toContain(2);
      await expect(usable(env)).resolves.toBeDefined();
    });
  });

  describe('bounded and restart-safe', () => {
    it('a claimed replacement keeps its short lifetime until it takes over', async () => {
      for (const permission of [true, false]) {
        const env = await hosted({ permission });
        startClose(env, [1]);
        const { token, sender } = permission ? { token: await injected(env), sender: at(4) } : await windowOpened(env);
        await env.send({ command: 'getSearchContext', token }, sender);
        expect(env.stored()[token].expiresAt).toBe(1_000_000 + HANDOFF_MS);
      }
    });

    it('after a restart the original is usable at once and an orphan overlay is removed when it next speaks', async () => {
      const env = await hosted();
      startClose(env, [1]);
      const token = await injected(env);
      await env.send({ command: 'getSearchContext', token }, at(4));
      const restarted = env.restart();
      await expect(restarted.handleMessage({ command: 'searchHandoffReady', token }, at(4))).rejects.toThrow('expired');
      expect(overlayClosed(env, 4)).toBe(true);
      expect(Object.keys(env.stored())).toEqual([env.token]);
      await expect(restarted.handleMessage({ command: 'getSearchContext', token: env.token }, frame())).resolves.toMatchObject({ windowId: 10 });
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
    });

    it('after a restart the original is usable at once, and a relaunch is not captured by an orphan window', async () => {
      const env = await hosted({ permission: false });
      startClose(env, [1]);
      const { created, token, sender } = await windowOpened(env);
      await env.send({ command: 'getSearchContext', token }, sender);
      const restarted = env.restart();
      await expect(restarted.handleMessage({ command: 'getSearchContext', token: env.token }, frame())).resolves.toBeDefined();
      expect(env.api.windows.remove).toHaveBeenCalledWith(created.id); // Reconciled with the original.
      expect(Object.keys(env.stored())).toEqual([env.token]);
      expect(await restarted.launch(await env.api.tabs.get(1))).toEqual({ mode: 'overlay' });
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
    });

    it('a relaunch closes every earlier search UI, including a pending window', async () => {
      const env = await hosted({ permission: false });
      const closing = startClose(env, [1]);
      const { created } = await windowOpened(env);
      expect(await env.launcher.launch(await env.api.tabs.get(1))).toEqual({ mode: 'overlay' });
      await expect(closing).rejects.toThrow('expired');
      expect(env.api.windows.remove).toHaveBeenCalledWith(created.id);
      expect(env.api.tabs.remove).not.toHaveBeenCalled();
    });

    it('withholds the state if the destination moves while its context is read', async () => {
      const env = await hosted();
      startClose(env, [1]);
      const token = await injected(env);
      const get = env.api.storage.session.get.getMockImplementation();
      // The context's recency read happens after the first destination check.
      env.api.storage.session.get.mockImplementation(async keys => {
        if (Array.isArray(keys)) env.tabs.find(t => t.id === 4).windowId = 20;
        return get(keys);
      });
      await expect(env.send({ command: 'getSearchContext', token }, at(4))).rejects.toThrow('expired');
      expect(Object.values(env.stored()).find(s => s.pending)?.pending.delivered).toBe(false);
    });

    it('falls back to the window when looking up an in-page destination fails', async () => {
      const env = await hosted();
      const get = env.api.storage.session.get.getMockImplementation();
      let failed = false;
      env.api.storage.session.get.mockImplementation(async keys => {
        // The destination lookup's recency read is the first list read after the close starts.
        if (Array.isArray(keys) && !failed) { failed = true; throw new Error('storage busy'); }
        return get(keys);
      });
      const closing = startClose(env, [1]);
      await viaWindow(env, closing);
      expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(1);
    });
  });

  it('stores only well-formed state fields', () => {
    const hostile = { query: 'x'.repeat(9000), mode: 'admin', sources: { history: 'yes', content: true, evil: true },
      highlight: { key: 1 }, checked: [1, 1, '2', 2.5, -0, 3], focus: 'page', focusTabId: '4', script: 'alert(1)' };
    expect(handoffState(hostile, [1])).toEqual({ query: '', mode: 'tabs', sources: { history: false, content: true },
      highlight: '', checked: [], order: [], focus: 'list', focusTabId: undefined, closing: [1] });
    expect(handoffState({ mode: 'tabs', focus: 'close-tabs', order: [3, 3, 'x', 1, 2.5] }, [1])).toMatchObject({ focus: 'list', order: [3, 1] });
    expect(handoffState({ mode: 'select', focus: 'close-tabs' }, [1])).toMatchObject({ focus: 'close-tabs' });
    expect(handoffState({ mode: 'search', focus: 'row-close', focusTabId: 4 }, [1])).toMatchObject({ mode: 'search', focus: 'row-close', focusTabId: 4 });
    expect(handoffState({ mode: 'select', checked: [1, 1, '2', 3], focus: 'query' }, [1]))
      .toMatchObject({ mode: 'select', checked: [1, 3], focus: 'list' });
    expect(handoffState(null, [1])).toMatchObject({ mode: 'tabs', focus: 'list' });
  });
});

describe('background routing for search closing', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('answers a forged close with an error and closes nothing', async () => {
    const { api } = fakeBrowser();
    Object.assign(api.runtime, { onMessage: event(), onInstalled: event() });
    api.tabs.remove = vi.fn(async () => {});
    api.storage.local.get = vi.fn(async defaults => defaults);
    api.contextMenus = { create: vi.fn(), onClicked: event() };
    api.commands = { onCommand: event() };
    api.notifications = { create: vi.fn() };
    vi.stubGlobal('browser', api);
    vi.resetModules();
    await import('../src/background.js');
    const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
    const reply = await new Promise(resolve => listener({ command: 'closeSearchTabs', token: 'A'.repeat(43), tabIds: [2] }, page(), resolve));
    expect(reply).toHaveProperty('error');
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('expanded search sources', () => {
  function sourcesSetup({ permission = true } = {}) {
    const env = setup();
    const { api, tabs } = env;
    api.permissions = { contains: vi.fn(async () => permission) };
    api.history = { search: vi.fn(async ({ text }) => [{ url: 'https://h.test/p?q=1#f', title: `H ${text}`, lastVisitTime: 5 }]) };
    api.runtime.openOptionsPage = vi.fn(async () => {});
    api.tabs.create = vi.fn(async () => ({ id: 77 }));
    const overlayExecute = api.scripting.executeScript.getMockImplementation();
    env.pageScan = vi.fn(async ({ target }) => {
      const tab = tabs.find(t => t.id === target.tabId);
      return [{ result: { url: tab.url, match: true, snippet: `in ${tab.title}`, truncated: false } }];
    });
    api.scripting.executeScript.mockImplementation(call =>
      (call.func === searchPageContent ? env.pageScan(call) : overlayExecute(call)));
    const scans = () => api.scripting.executeScript.mock.calls.filter(([c]) => c.func === searchPageContent);
    return { ...env, scans };
  }
  async function open(env, tabId = 1) {
    await env.launcher.launch(await env.api.tabs.get(tabId));
    return env.lastToken();
  }
  const both = { history: true, content: true };
  const privateFrame = () => frame({ tab: { id: 3, windowId: 30, incognito: true } });

  it('reports the host permission in context', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    expect(await env.send({ command: 'getSearchContext', token }, frame())).toMatchObject({ incognito: false, contentPermission: true });
  });

  it('returns history and page content with consistent coverage', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const reply = await env.send({ command: 'querySearchSources', token, query: '  report ', sources: both }, frame());
    expect(reply).toEqual({
      history: [{ url: 'https://h.test/p?q=1#f', title: 'H report', lastVisitTime: 5 }],
      content: [
        { tabId: 1, url: 'https://example.org/', snippet: 'in Origin' },
        { tabId: 2, url: 'https://other.example/', snippet: 'in Other window' },
        { tabId: 4, url: 'https://example.org/b', snippet: 'in Background' },
      ],
      coverage: {
        history: { state: 'ready', limited: false },
        content: { state: 'ready', searched: 3, total: 3, skipped: 0, truncated: 0 },
      },
      incognito: false,
    });
    expect(env.api.history.search).toHaveBeenCalledWith({ text: 'report', startTime: 0, maxResults: 101 });
    expect(env.api.history.deleteUrl).toBeUndefined();
    expect(env.api.storage.session.set.mock.calls.flat().some(item => JSON.stringify(item).includes('report'))).toBe(false);
  });

  it('honors source toggles', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const reply = await env.send({ command: 'querySearchSources', token, query: 'x', sources: { history: false, content: false } }, frame());
    expect(reply.coverage).toEqual({ history: { state: 'off', limited: false },
      content: { state: 'off', searched: 0, total: 0, skipped: 0, truncated: 0 } });
    expect(env.api.history.search).not.toHaveBeenCalled();
    expect(env.scans()).toHaveLength(0);
  });

  it('does no lookup or injection for an empty query, and rejects an over-long one', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const reply = await env.send({ command: 'querySearchSources', token, query: ' \t ', sources: both }, frame());
    expect(reply).toMatchObject({ history: [], content: [] });
    await expect(env.send({ command: 'querySearchSources', token, query: 'x'.repeat(257), sources: both }, frame())).rejects.toThrow();
    expect(env.api.history.search).not.toHaveBeenCalled();
    expect(env.scans()).toHaveLength(0);
  });

  it('never reads history, or normal pages, from a private search', async () => {
    const env = sourcesSetup();
    const token = await open(env, 3);
    const reply = await env.send({ command: 'querySearchSources', token, query: 'x', sources: both }, privateFrame());
    expect(reply.incognito).toBe(true);
    expect(reply.coverage.history).toEqual({ state: 'private', limited: false });
    expect(reply.content.map(r => r.tabId)).toEqual([3]);
    expect(env.api.history.search).not.toHaveBeenCalled();
    expect(env.scans().map(([c]) => c.target.tabId)).toEqual([3]);
  });

  it('does not read content without the host permission', async () => {
    const env = sourcesSetup({ permission: false });
    const token = await open(env);
    const reply = await env.send({ command: 'querySearchSources', token, query: 'x', sources: both }, frame());
    expect(reply.coverage.content.state).toBe('permission');
    expect(reply.content).toEqual([]);
    expect(env.scans()).toHaveLength(0);
  });

  it.each([
    ['forged token', m => ({ ...m, token: 'A'.repeat(43) }), frame()],
    ['origin page', m => m, page()],
    ['another frame', m => m, frame({ frameId: 9 })],
    ['another document', m => m, frame({ documentId: 'doc-other' })],
  ])('gives no data to a %s', async (_name, change, sender) => {
    const env = sourcesSetup();
    const token = await open(env);
    await env.send({ command: 'getSearchContext', token }, frame()); // Claim first.
    await expect(env.send(change({ command: 'querySearchSources', token, query: 'x', sources: both }), sender)).rejects.toThrow();
    expect(env.api.history.search).not.toHaveBeenCalled();
    expect(env.scans()).toHaveLength(0);
  });

  it('scans outside the launch queue, then withholds results if the search was revoked meanwhile', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const releases = [];
    const release = () => releases.forEach(fn => fn());
    env.pageScan.mockImplementation(({ target }) => new Promise(resolve => {
      releases.push(() => resolve([{ result: { url: env.tabs.find(t => t.id === target.tabId).url, match: true, snippet: 's' } }]));
    }));
    const pending = env.send({ command: 'querySearchSources', token, query: 'x', sources: { content: true } }, frame());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    // The serialized queue is free: dismissal completes while the scan hangs.
    expect(await env.send({ command: 'dismissSearch', token }, frame())).toEqual({ ok: true });
    release();
    await expect(pending).rejects.toThrow(/expired/);
  });

  it('cancels a superseded query for the same search', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    let release;
    env.pageScan.mockImplementationOnce(({ target }) => new Promise(resolve => {
      release = () => resolve([{ result: { url: env.tabs.find(t => t.id === target.tabId).url, match: true, snippet: 'old' } }]);
    }));
    const first = env.send({ command: 'querySearchSources', token, query: 'a', sources: { content: true } }, frame());
    await vi.waitFor(() => expect(env.scans().length).toBeGreaterThan(0));
    const second = await env.send({ command: 'querySearchSources', token, query: 'ab', sources: { content: true } }, frame());
    expect(second.content.length).toBeGreaterThan(0);
    release();
    await expect(first).rejects.toThrow(/newer search/);
  });

  // Holds every per-page permission recheck (after the live tab re-read) until released.
  function holdPageChecks(env) {
    const waiting = [];
    env.api.permissions.contains.mockImplementation(async () => {
      if (env.api.permissions.contains.mock.calls.length === 1) return true; // Up-front check.
      await new Promise(resolve => waiting.push(resolve));
      return true;
    });
    return { waiting, release: () => waiting.splice(0).forEach(resolve => resolve()) };
  }
  const fire = (event, ...args) => event.addListener.mock.calls.forEach(([listener]) => listener(...args));

  it.each([
    ['dismissal', env => env.send({ command: 'dismissSearch', token: env.token }, frame())],
    ['activation', env => env.send({ command: 'activateSearchTab', token: env.token, tabId: 2 }, frame())],
    ['a replacement launch', async env => env.launcher.launch(await env.api.tabs.get(1))],
    ['closing the origin tab', env => fire(env.api.tabs.onRemoved, 1, {})],
    ['origin navigation', env => fire(env.api.tabs.onUpdated, 1, { status: 'loading' })],
  ])('stops a scan on %s without waiting for it, injecting nothing further', async (_name, end) => {
    const env = sourcesSetup();
    env.token = await open(env);
    const held = holdPageChecks(env);
    const pending = env.send({ command: 'querySearchSources', token: env.token, query: 'x', sources: { content: true } }, frame());
    pending.catch(() => {});
    await vi.waitFor(() => expect(held.waiting).toHaveLength(3));
    await end(env); // Completes while every page task is still waiting.
    await vi.waitFor(() => expect(env.stored()[env.token]).toBeUndefined());
    held.release();
    await expect(pending).rejects.toThrow(/expired/);
    expect(env.scans()).toHaveLength(0);
  });

  it('cancels a prior scan when content is switched off, injecting nothing further', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const held = holdPageChecks(env);
    const first = env.send({ command: 'querySearchSources', token, query: 'x', sources: { content: true } }, frame());
    await vi.waitFor(() => expect(held.waiting).toHaveLength(3));
    const off = await env.send({ command: 'querySearchSources', token, query: '', sources: { history: false, content: false } }, frame());
    expect(off.content).toEqual([]);
    held.release();
    await expect(first).rejects.toThrow(/newer search/);
    expect(env.scans()).toHaveLength(0);
    expect(Object.keys(env.stored())).toEqual([token]); // The search itself stays open.
  });

  it('returns no snippets when website access is removed while a scan is in flight', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const releases = [];
    env.pageScan.mockImplementation(({ target }) => new Promise(resolve => {
      releases.push(() => resolve([{ result: { url: env.tabs.find(t => t.id === target.tabId).url, match: true, snippet: 'secret' } }]));
    }));
    const pending = env.send({ command: 'querySearchSources', token, query: 'x', sources: { content: true } }, frame());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    env.api.permissions.contains.mockResolvedValue(false);
    releases.forEach(fn => fn());
    const reply = await pending;
    expect(reply.content).toEqual([]);
    expect(reply.coverage.content).toEqual({ state: 'permission', searched: 0, total: 0, skipped: 0, truncated: 0 });
    expect(JSON.stringify(reply)).not.toContain('secret');
  });

  it('opens a history result in the origin window, then revokes the search', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    const url = 'https://h.test/p?q=1#f';
    expect(await env.send({ command: 'activateHistoryResult', token, url }, frame())).toEqual({ ok: true });
    expect(env.api.history.search).toHaveBeenCalledWith(expect.objectContaining({ text: url, startTime: 0 }));
    expect(env.api.tabs.create).toHaveBeenCalledWith({ url, windowId: 10, active: true });
    expect(env.api.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'tabvacuum:close' }), { frameId: 0 });
    expect(env.stored()).toEqual({});
    await expect(env.send({ command: 'activateHistoryResult', token, url }, frame())).rejects.toThrow();
    expect(env.api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@h.test/', 'moz-extension://uuid/options.html',
    'https://not-in-history.test/', 'https://h.test/p?q=1'])('refuses to open %s', async url => {
    const env = sourcesSetup();
    const token = await open(env);
    await expect(env.send({ command: 'activateHistoryResult', token, url }, frame())).rejects.toThrow();
    expect(env.api.tabs.create).not.toHaveBeenCalled();
    expect(Object.keys(env.stored())).toEqual([token]); // Still usable.
  });

  it('refuses private history activation before reading history', async () => {
    const env = sourcesSetup();
    const token = await open(env, 3);
    await expect(env.send({ command: 'activateHistoryResult', token, url: 'https://h.test/p?q=1#f' }, privateFrame())).rejects.toThrow();
    expect(env.api.history.search).not.toHaveBeenCalled();
    expect(env.api.tabs.create).not.toHaveBeenCalled();
  });

  it('opens the options page for an authorized frame only, keeping the search open', async () => {
    const env = sourcesSetup();
    const token = await open(env);
    await expect(env.send({ command: 'openSearchPermissions', token }, page())).rejects.toThrow();
    expect(env.api.runtime.openOptionsPage).not.toHaveBeenCalled();
    expect(await env.send({ command: 'openSearchPermissions', token }, frame())).toEqual({ ok: true });
    expect(env.api.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(env.api.permissions.request).toBeUndefined();
    expect(Object.keys(env.stored())).toEqual([token]);
  });
});
