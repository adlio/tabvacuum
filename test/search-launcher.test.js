import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSearchService } from '../src/search-service.js';
import { createSearchLauncher, placement, newToken, UNCLAIMED_MS, SESSION_MS } from '../src/search-launcher.js';
import { mountSearchOverlay } from '../src/search-overlay.js';

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
  const options = { now, schedule: fn => timers.push(fn) };
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
    expect(Object.keys(context).sort()).toEqual(['currentTabId', 'tabs', 'windowId']);
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
      expect(page.runtime.sendMessage).toHaveBeenCalledWith({ command: 'dismissSearch', token: TOKEN });
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
    it('closes only the approved IDs and keeps the search usable', async () => {
      const env = await closing(mode);
      expect(await close(env, [2, 4])).toEqual({ ok: true, closedIds: [2, 4], skipped: [], failedIds: [] });
      expect(removed(env.api)).toEqual([2, 4]);
      expect(env.api.tabs.sendMessage).not.toHaveBeenCalled();
      expect(env.api.windows.remove).not.toHaveBeenCalled();
      const context = await env.send({ command: 'getSearchContext', token: env.token }, env.sender);
      expect(context.tabs.map(t => t.id)).toEqual([1, 5, 6]);
    });

    it('closes the origin last, then revokes the search and closes its UI', async () => {
      const env = await closing(mode);
      expect(await close(env, [1, 2, 4])).toEqual({ ok: true, closedIds: [2, 4, 1], skipped: [], failedIds: [] });
      expect(removed(env.api)).toEqual([2, 4, 1]);
      expect(env.stored()).toEqual({});
      if (mode === 'window') expect(env.api.windows.remove).toHaveBeenCalledWith(env.created.id);
      else expect(env.api.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'tabvacuum:close' }), { frameId: 0 });
      await expect(env.send({ command: 'getSearchContext', token: env.token }, env.sender)).rejects.toThrow('expired');
      await expect(close(env, [5])).rejects.toThrow('expired');
    });

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
      expect(await close(env, [2, 4])).toEqual({ ok: true, closedIds: [4], skipped: [], failedIds: [2] });
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
    expect(result).toEqual({ ok: true, closedIds: [7], failedIds: [],
      skipped: [{ tabId: 1, reason: 'unavailable' }, { tabId: 2, reason: 'unavailable' }] });
  });

  it('honors current-window scope from settings', async () => {
    const env = await closing('overlay');
    env.api.storage.local.get.mockImplementation(async keys => ('searchScope' in keys ? { searchScope: 'current' } : {}));
    const result = await close(env, [2, 4]);
    expect(result.closedIds).toEqual([4]);
    expect(result.skipped).toEqual([{ tabId: 2, reason: 'unavailable' }]);
  });

  it('is serialized with launches, and origin cleanup listeners queue behind it without deadlock', async () => {
    const env = await closing('overlay');
    let release;
    const realRemove = env.api.tabs.remove.getMockImplementation();
    env.api.tabs.remove.mockImplementationOnce(id => new Promise(resolve => { release = () => resolve(realRemove(id)); }));
    const closingNow = close(env, [2, 1, 4]);
    await vi.waitFor(() => expect(release).toBeDefined());
    const relaunch = env.launcher.launch(await env.api.tabs.get(4));
    await new Promise(resolve => setImmediate(resolve));
    expect(env.api.scripting.executeScript).toHaveBeenCalledTimes(1); // Waiting for the close.
    release();
    expect(await closingNow).toEqual({ ok: true, closedIds: [2, 4, 1], skipped: [], failedIds: [] });
    await relaunch;
    expect(env.api.windows.create).toHaveBeenCalledTimes(1); // Background tab 4 → window.
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
