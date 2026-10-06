// Exercises background.js through its real listeners: runtime messages,
// keyboard commands and context-menu clicks. All mocks are private to this file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const launcher = vi.hoisted(() => ({
  handleMessage: vi.fn(),
  launch: vi.fn(),
  installCleanup: vi.fn(),
}));

vi.mock('../src/search-service.js', () => ({
  createSearchService: () => ({ installFocusTracking: vi.fn() }),
}));
vi.mock('../src/search-launcher.js', () => ({
  createSearchLauncher: () => launcher,
}));

const EXT = 'tabvacuum@adlio';
const BASE = 'moz-extension://uuid/';
const POPUP = { id: EXT, url: `${BASE}popup.html` };
const OPTIONS = { id: EXT, url: `${BASE}options.html` };

let api;
let listeners;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const DAY = 24 * 60 * 60 * 1000;

function fakeBrowser() {
  listeners = {};
  // Calls every listener registered under a name (the stale service adds its
  // own); replies with the first defined return value.
  const registered = {};
  const on = name => ({
    addListener: fn => {
      (registered[name] ??= []).push(fn);
      listeners[name] = (...args) => {
        let result;
        for (const listener of registered[name]) {
          const value = listener(...args);
          if (result === undefined) result = value;
        }
        return result;
      };
    },
  });
  const old = Date.now() - 30 * DAY;
  const tab = (id, url, extra) => ({
    id, windowId: 1, index: id - 1, url, title: url, active: false, pinned: false, audible: false,
    incognito: false, status: 'complete', lastAccessed: old, ...extra,
  });
  const tabs = [
    tab(1, 'https://b.example/', { active: true, lastAccessed: Date.now() }),
    tab(2, 'https://a.example/'),
    tab(3, 'https://a.example/'),
  ];
  let local = {};
  let session = {};
  const read = (store, keys) => (keys && typeof keys === 'object' && !Array.isArray(keys)
    ? Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d]))
    : Object.fromEntries([keys].flat().filter(k => k in store).map(k => [k, store[k]])));
  const copy = value => JSON.parse(JSON.stringify(value));
  return {
    runtime: {
      id: EXT,
      getURL: path => BASE + path,
      onMessage: on('message'),
      onInstalled: on('installed'),
    },
    tabs: {
      query: vi.fn(async () => tabs.map(t => ({ ...t }))),
      get: vi.fn(async id => {
        const found = tabs.find(t => t.id === id);
        if (!found) throw new Error('No tab');
        return { ...found };
      }),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    },
    windows: {
      get: vi.fn(async (id, options) => (id === 1
        ? { id: 1, type: 'normal', incognito: false, ...(options?.populate ? { tabs: tabs.map(t => ({ ...t })) } : {}) }
        : Promise.reject(new Error('No window')))),
      getAll: vi.fn(async () => [{ id: 1, type: 'normal', incognito: false, tabs: tabs.map(t => ({ ...t })) }]),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      getLastFocused: vi.fn(async () => ({ id: 1, incognito: false })),
      remove: vi.fn(async () => {}),
    },
    history: { search: vi.fn(async () => []) },
    storage: {
      local: {
        get: vi.fn(async keys => read(local, keys)),
        set: vi.fn(async items => { local = { ...local, ...copy(items) }; }),
      },
      session: {
        get: vi.fn(async keys => copy(read(session, keys))),
        set: vi.fn(async items => { session = { ...session, ...copy(items) }; }),
        remove: vi.fn(async keys => { for (const k of [keys].flat()) delete session[k]; }),
      },
    },
    alarms: {
      create: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => true),
      onAlarm: on('alarm'),
    },
    action: { openPopup: vi.fn(async () => {}) },
    notifications: { create: vi.fn(async () => 'id') },
    contextMenus: { create: vi.fn(), onClicked: on('menu') },
    commands: { onCommand: on('command') },
  };
}

// Sends a message through the real onMessage listener; resolves with the reply.
function send(message, sender = POPUP) {
  let reply;
  const replied = new Promise(resolve => { reply = resolve; });
  const sendResponse = vi.fn(reply);
  const kept = listeners.message(message, sender, sendResponse);
  return { kept, replied, sendResponse };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const messages = () => api.notifications.create.mock.calls.map(([n]) => n.message);

beforeEach(async () => {
  vi.resetModules();
  launcher.handleMessage.mockReset().mockReturnValue(undefined);
  launcher.launch.mockReset().mockResolvedValue({ message: 'ok' });
  api = fakeBrowser();
  globalThis.browser = api;
  await import('../src/background.js');
  // Worker start observes tabs and reconciles the schedule; tests count calls after that.
  await flush();
  vi.clearAllMocks();
});

afterEach(() => {
  delete globalThis.browser;
});

describe('popup actions notify once and keep the reply shape', () => {
  it.each([
    ['closeDuplicates', {}],
    ['closeBlankTabs', {}],
    ['mergeWindows', {}],
    ['sortTabs', { criteria: 'url', direction: 'asc' }],
  ])('%s replies with its message after one notification', async (command, params) => {
    const { kept, replied } = send({ command, ...params });
    expect(kept).toBe(true);
    const result = await replied;
    expect(typeof result.message).toBe('string');
    expect(result.error).toBeUndefined();
    expect(result.notificationError).toBeUndefined();
    expect(messages()).toEqual([result.message]);
    expect(api.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'basic', title: "Aaron's Tab Vacuum", iconUrl: 'icons/icon-96.png' }));
  });

  it('closes the duplicate tab and notifies its message', async () => {
    const result = await send({ command: 'closeDuplicates' }).replied;
    expect(api.tabs.remove).toHaveBeenCalledWith([3]);
    expect(messages()).toEqual([result.message]);
  });

  it('notifies a no-op result', async () => {
    api.tabs.query.mockResolvedValue([{ id: 1, windowId: 1, index: 0, url: 'https://only.example/' }]);
    const result = await send({ command: 'closeDuplicates' }).replied;
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(messages()).toEqual([result.message]);
  });

  it('reports an action failure as an error and notifies it once', async () => {
    api.tabs.remove.mockRejectedValue(new Error('Tab is gone'));
    const result = await send({ command: 'closeDuplicates' }).replied;
    expect(result).toEqual({ error: 'Tab is gone', message: 'Error: Tab is gone' });
    expect(messages()).toEqual(['Error: Tab is gone']);
  });

  it('keeps completed work as success when the notification fails', async () => {
    api.notifications.create.mockRejectedValue(new Error('Notifications blocked'));
    const result = await send({ command: 'closeDuplicates' }).replied;
    expect(api.tabs.remove).toHaveBeenCalledWith([3]);
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/\S/);
    expect(result.notificationError).toBe('Notifications blocked');
    expect(api.notifications.create).toHaveBeenCalledTimes(1);
  });

  it('keeps an action error when the notification also fails', async () => {
    api.tabs.remove.mockRejectedValue(new Error('Tab is gone'));
    api.notifications.create.mockRejectedValue(new Error('Notifications blocked'));
    const result = await send({ command: 'closeDuplicates' }).replied;
    expect(result).toEqual({
      error: 'Tab is gone', message: 'Error: Tab is gone', notificationError: 'Notifications blocked',
    });
  });

  it('handles a synchronously throwing notifications API', async () => {
    api.notifications.create.mockImplementation(() => { throw new Error('No API'); });
    const result = await send({ command: 'closeBlankTabs' }).replied;
    expect(result.error).toBeUndefined();
    expect(result.notificationError).toBe('No API');
  });

  it('does not reply before the action and its notification finish', async () => {
    const removal = deferred();
    const shown = deferred();
    api.tabs.remove.mockReturnValue(removal.promise);
    api.notifications.create.mockReturnValue(shown.promise);
    const { replied, sendResponse } = send({ command: 'closeDuplicates' });

    await flush();
    expect(api.tabs.remove).toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();

    removal.resolve();
    await flush();
    expect(api.notifications.create).toHaveBeenCalledTimes(1);
    expect(sendResponse).not.toHaveBeenCalled();

    shown.resolve('id');
    const result = await replied;
    expect(result.error).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('finishes the action and notifies even when the caller has closed', async () => {
    const sendResponse = vi.fn(() => { throw new Error('Receiving end does not exist'); });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(listeners.message({ command: 'closeDuplicates' }, POPUP, sendResponse)).toBe(true);
      await flush(); await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(api.tabs.remove).toHaveBeenCalledWith([3]);
    expect(api.notifications.create).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('settings and search messages keep their behavior', () => {
  it('getSettings and saveSettings do not notify', async () => {
    const settings = await send({ command: 'getSettings' }, OPTIONS).replied;
    expect(settings.searchScope).toBe('all');
    const saved = await send({ command: 'saveSettings', settings: { skipPinned: false } }, OPTIONS).replied;
    expect(saved).toEqual({ message: 'Settings saved' });
    expect(api.storage.local.set).toHaveBeenCalledWith({ skipPinned: false, staleRuleRevision: expect.any(String) });
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('getSettings failure still replies with an error and does not notify', async () => {
    api.storage.local.get.mockRejectedValue(new Error('Storage down'));
    const result = await send({ command: 'getSettings' }, OPTIONS).replied;
    expect(result).toEqual({ error: 'Storage down', message: 'Error: Storage down' });
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('launchSearch success replies with the launcher result and does not notify', async () => {
    const result = await send({ command: 'launchSearch' }).replied;
    expect(result).toEqual({ message: 'ok' });
    expect(launcher.launch).toHaveBeenCalledWith(undefined);
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('launchSearch failure returns the error and notifies it once', async () => {
    launcher.launch.mockRejectedValue(new Error('denied'));
    const result = await send({ command: 'launchSearch' }).replied;
    expect(result.error).toMatch(/Could not open Search tabs/);
    expect(messages()).toEqual([result.error]);
  });

  it('launchSearch failure still replies when its notification fails', async () => {
    launcher.launch.mockRejectedValue(new Error('denied'));
    api.notifications.create.mockRejectedValue(new Error('blocked'));
    const result = await send({ command: 'launchSearch' }).replied;
    expect(result.error).toMatch(/Could not open Search tabs/);
  });

  it('token-authorized search messages still route to the launcher, untrusted senders included', async () => {
    const sender = { id: EXT, url: 'https://site.example/' };
    launcher.handleMessage.mockReturnValue(Promise.resolve({ closed: true }));
    const { kept, replied } = send({ command: 'closeSearch', token: 't' }, sender);
    expect(kept).toBe(true);
    expect(await replied).toEqual({ closed: true });
    expect(launcher.handleMessage).toHaveBeenCalledWith({ command: 'closeSearch', token: 't' }, sender);
    expect(api.notifications.create).not.toHaveBeenCalled();
  });
});

describe('untrusted senders stay restricted', () => {
  it.each([
    ['a content script', { id: EXT, url: 'https://site.example/' }],
    ['the embedded search page', { id: EXT, url: `${BASE}search.html` }],
    ['another extension', { id: 'other@ext', url: `${BASE}popup.html` }],
  ])('ignores tab actions from %s', async (_, sender) => {
    const sendResponse = vi.fn();
    expect(listeners.message({ command: 'closeDuplicates' }, sender, sendResponse)).toBeUndefined();
    await flush();
    expect(api.tabs.query).not.toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores unknown commands and inherited property names', () => {
    expect(listeners.message({ command: 'toString' }, POPUP, vi.fn())).toBeUndefined();
    expect(listeners.message({ command: 'nope' }, POPUP, vi.fn())).toBeUndefined();
  });
});

describe('keyboard commands', () => {
  it.each(['close-duplicates', 'merge-windows', 'sort-tabs', 'close-blank'])(
    '%s notifies its result once', async command => {
      await listeners.command(command, { id: 1 });
      expect(api.notifications.create).toHaveBeenCalledTimes(1);
      expect(messages()[0]).not.toMatch(/^Error/);
    });

  it('sort-tabs uses the saved sort settings', async () => {
    api.storage.local.get.mockImplementation(async d => ({ ...d, lastSortCriteria: 'title', lastSortDirection: 'desc' }));
    await listeners.command('sort-tabs', { id: 1 });
    expect(api.storage.local.set).toHaveBeenCalledWith({ lastSortCriteria: 'title', lastSortDirection: 'desc' });
  });

  it('an action failure is notified and does not reject the listener', async () => {
    api.tabs.remove.mockRejectedValue(new Error('Tab is gone'));
    await expect(listeners.command('close-duplicates', { id: 1 })).resolves.toBeUndefined();
    expect(messages()).toEqual(['Error: Tab is gone']);
  });

  it('a notification failure does not reject the listener', async () => {
    api.notifications.create.mockRejectedValue(new Error('blocked'));
    await expect(listeners.command('close-blank', { id: 1 })).resolves.toBeUndefined();
  });

  it('search-tabs launches with the command tab and does not notify on success', async () => {
    const tab = { id: 7 };
    await listeners.command('search-tabs', tab);
    expect(launcher.launch).toHaveBeenCalledWith(tab);
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('search-tabs failure does not reject even when notifying fails', async () => {
    launcher.launch.mockRejectedValue(new Error('denied'));
    api.notifications.create.mockRejectedValue(new Error('blocked'));
    await expect(listeners.command('search-tabs', { id: 7 })).resolves.toBeUndefined();
  });

  it('unknown commands do nothing', async () => {
    await listeners.command('unknown', { id: 1 });
    expect(api.notifications.create).not.toHaveBeenCalled();
  });
});

describe('context menu', () => {
  it.each(['tv-dupes', 'tv-merge', 'tv-sort-url', 'tv-sort-frecency', 'tv-blank'])(
    '%s notifies its result once', async menuItemId => {
      await listeners.menu({ menuItemId });
      expect(api.notifications.create).toHaveBeenCalledTimes(1);
      expect(messages()[0]).not.toMatch(/^Error/);
    });

  it('an action failure is notified and does not reject the listener', async () => {
    api.windows.getAll.mockRejectedValue(new Error('No windows'));
    await expect(listeners.menu({ menuItemId: 'tv-merge' })).resolves.toBeUndefined();
    expect(messages()).toEqual(['Error: No windows']);
  });

  it('a notification failure does not reject the listener', async () => {
    api.notifications.create.mockRejectedValue(new Error('blocked'));
    await expect(listeners.menu({ menuItemId: 'tv-dupes' })).resolves.toBeUndefined();
    expect(api.tabs.remove).toHaveBeenCalledWith([3]);
  });

  it('the parent Sort Tabs item does nothing', async () => {
    await listeners.menu({ menuItemId: 'tv-sort' });
    expect(api.notifications.create).not.toHaveBeenCalled();
  });
});

describe('stale tabs', () => {
  const STALE_COMMANDS = ['getStaleState', 'setStaleRule', 'closeStalePreview', 'staleEditor', 'consumeStaleIntent'];

  it('the immediate stale-close command is gone', async () => {
    expect(listeners.message({ command: 'closeStaleTabs' }, POPUP, vi.fn())).toBeUndefined();
    await flush();
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['a content script', { id: EXT, url: 'https://site.example/' }],
    ['the embedded search page', { id: EXT, url: `${BASE}search.html` }],
    ['another extension', { id: 'other@ext', url: `${BASE}popup.html` }],
  ])('ignores stale commands and settings writes from %s', async (_, sender) => {
    for (const command of [...STALE_COMMANDS, 'saveSettings']) {
      const message = { command, windowId: 1, previewId: 'p', settings: { autoCloseStaleEnabled: true }, open: true };
      expect(listeners.message(message, sender, vi.fn())).toBeUndefined();
    }
    await flush();
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.storage.local.set).not.toHaveBeenCalled();
    expect(api.action.openPopup).not.toHaveBeenCalled();
  });

  it('previews, then closes only after an explicit close, with one notification', async () => {
    const state = await send({ command: 'getStaleState', windowId: 1 }).replied;
    expect(state.preview).toMatchObject({ count: 2, windowCount: 1 });
    expect(state.auto).toMatchObject({ enabled: false, available: true, count: 2 });
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();

    const result = await send({ command: 'closeStalePreview', windowId: 1, previewId: state.preview.id }).replied;
    expect(result).toEqual({ message: 'Closed 2 tabs not viewed recently.', closed: 2, skipped: 0, failed: 0 });
    expect(api.tabs.remove.mock.calls).toEqual([[2], [3]]);
    expect(messages()).toEqual([result.message]);

    const replay = await send({ command: 'closeStalePreview', windowId: 1, previewId: state.preview.id }).replied;
    expect(replay.error).toMatch(/out of date/);
    expect(api.tabs.remove).toHaveBeenCalledTimes(2);
  });

  it('setStaleRule validates and saves only the stale rule', async () => {
    expect(await send({ command: 'setStaleRule', windowId: 1, settings: { staleThresholdMs: 0 } }).replied)
      .toMatchObject({ error: expect.stringMatching(/whole number/) });
    expect(await send({ command: 'setStaleRule', windowId: 1, settings: { searchScope: 'current' } }).replied)
      .toMatchObject({ error: expect.any(String) });
    expect(await send({ command: 'setStaleRule', windowId: 1, settings: { staleThresholdMs: 2 * DAY } }).replied)
      .toEqual({ message: 'Settings saved' });
    expect(api.storage.local.set).toHaveBeenCalledTimes(1);
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('setStaleRule will not enable automation on a legacy threshold the editor would reject', async () => {
    await api.storage.local.set({ staleThresholdMs: 90 * 60 * 1000 });
    vi.clearAllMocks();
    const reply = await send({ command: 'setStaleRule', windowId: 1, settings: { autoCloseStaleEnabled: true } }).replied;
    expect(reply.error).toMatch(/whole number of hours or days/);
    expect(api.storage.local.set).not.toHaveBeenCalled();
    expect(api.alarms.create).not.toHaveBeenCalled();
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it('the generic saveSettings goes through the same gate', async () => {
    const bad = await send({ command: 'saveSettings', settings: { staleThresholdMs: -1 } }, OPTIONS).replied;
    expect(bad.error).toMatch(/whole number/);
    const noWindow = await send({ command: 'saveSettings', settings: { autoCloseStaleEnabled: true } }, OPTIONS).replied;
    expect(noWindow.error).toMatch(/normal/);
    expect(api.storage.local.set).not.toHaveBeenCalled();
    const ok = await send({ command: 'setStaleRule', windowId: 1, settings: { autoCloseStaleEnabled: true } }).replied;
    expect(ok).toEqual({ message: 'Settings saved' });
    expect(api.alarms.create).toHaveBeenCalledWith('atv-stale-sweep', { when: expect.any(Number) });
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it('serves the editor lease and the one-shot intent', async () => {
    const { editorId } = await send({ command: 'staleEditor', windowId: 1, open: true }).replied;
    expect(editorId).toMatch(/\S/);
    expect(await send({ command: 'staleEditor', windowId: 1, editorId, open: false }).replied).toEqual({ editorId: null });
    expect(await send({ command: 'consumeStaleIntent', windowId: 1 }).replied).toEqual({ open: false });
  });

  it.each([
    ['keyboard shortcut', () => listeners.command('close-stale', { id: 1, windowId: 1, incognito: false })],
    ['context menu', () => listeners.menu({ menuItemId: 'tv-stale' }, { id: 1, windowId: 1, incognito: false })],
  ])('the %s opens the toolbar menu at once with stale controls, closing nothing', async (_, invoke) => {
    const done = invoke();
    // Called before any await, so the user gesture still applies.
    expect(api.action.openPopup).toHaveBeenCalledWith({ windowId: 1 });
    await done;
    expect(await send({ command: 'consumeStaleIntent', windowId: 1 }).replied).toEqual({ open: true });
    expect(await send({ command: 'consumeStaleIntent', windowId: 1 }).replied).toEqual({ open: false });
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('a refused popup explains the toolbar path, with no fallback window', async () => {
    api.action.openPopup.mockRejectedValue(new Error('not allowed'));
    await expect(listeners.command('close-stale', { id: 1, windowId: 1 })).resolves.toBeUndefined();
    expect(messages()).toEqual([expect.stringMatching(/toolbar button, then choose Stale Tabs/)]);
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(await send({ command: 'consumeStaleIntent', windowId: 1 }).replied).toEqual({ open: false });
  });

  it('labels the context-menu item as opening the controls', () => {
    listeners.installed({ reason: 'update' });
    expect(api.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'tv-stale', title: 'Review Stale Tabs…' }));
  });
});
