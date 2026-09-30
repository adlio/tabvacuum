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

function fakeBrowser() {
  listeners = {};
  const on = name => ({ addListener: fn => { listeners[name] = fn; } });
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: 'https://b.example/', title: 'B' },
    { id: 2, windowId: 1, index: 1, url: 'https://a.example/', title: 'A' },
    { id: 3, windowId: 1, index: 2, url: 'https://a.example/', title: 'A' },
  ];
  return {
    runtime: {
      id: EXT,
      getURL: path => BASE + path,
      onMessage: on('message'),
      onInstalled: on('installed'),
    },
    tabs: {
      query: vi.fn(async () => tabs.map(tab => ({ ...tab }))),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    },
    windows: {
      getAll: vi.fn(async () => [{ id: 1, tabs: tabs.map(tab => ({ ...tab })) }]),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      remove: vi.fn(async () => {}),
    },
    history: { search: vi.fn(async () => []) },
    storage: { local: { get: vi.fn(async defaults => defaults), set: vi.fn(async () => {}) } },
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
});

afterEach(() => {
  delete globalThis.browser;
});

describe('popup actions notify once and keep the reply shape', () => {
  it.each([
    ['closeDuplicates', {}],
    ['closeStaleTabs', {}],
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
      expect.objectContaining({ type: 'basic', title: 'TabVacuum', iconUrl: 'icons/icon-96.png' }));
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
    expect(api.storage.local.set).toHaveBeenCalledWith({ skipPinned: false });
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
  it.each(['close-duplicates', 'merge-windows', 'sort-tabs', 'close-stale', 'close-blank'])(
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
  it.each(['tv-dupes', 'tv-merge', 'tv-sort-url', 'tv-sort-frecency', 'tv-stale', 'tv-blank'])(
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
