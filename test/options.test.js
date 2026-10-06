import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startOptions } from '../src/options.js';

const html = readFileSync(new URL('../src/options.html', import.meta.url), 'utf8');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 6, 21, 15).getTime();

// Minimal DOM built from the real settings markup.
class El {
  constructor(tag) {
    Object.assign(this, { tag, tagName: tag.toUpperCase(), id: '', hidden: false, parent: null, dataset: {}, textContent: '', listeners: {}, value: '', checked: false });
    this.attrs = new Map();
    this.classes = new Set();
    this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), contains: c => this.classes.has(c) };
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, ...extra }); }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
}

function setup(handlers = {}, { win = { id: 4, incognito: false } } = {}) {
  const byId = new Map();
  const stack = [];
  for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (close) { stack.pop(); continue; }
    const node = new El(tag);
    node.parent = stack.at(-1) ?? null;
    for (const [, name, value] of attrs.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)) {
      if (name === 'id') { node.id = value; byId.set(value, node); }
      else if (name === 'hidden') node.hidden = true;
      else node.setAttribute(name, value ?? '');
    }
    if (!/^(meta|link|input)$/.test(tag)) stack.push(node);
  }
  const document = new El('#document');
  document.getElementById = id => byId.get(id) ?? null;
  document.visibilityState = 'visible';
  document.activeElement = null;
  const window = new El('#window');
  const storage = { listeners: new Set() };
  const all = {
    getSettings: async () => ({ searchScope: 'all', staleThresholdMs: 3 * DAY, autoCloseStaleEnabled: false, ignoreFragments: true, ignoreQueryParams: false, skipPinned: true, skipAudible: false, blankNewTab: true, blankWelcome: true, blankSearchEngines: false, blankCustomUrls: ['https://a.example/'] }),
    getStaleState: async () => state(),
    staleEditor: async () => ({ editorId: 'opt-1' }),
    ...handlers,
  };
  const sendMessage = vi.fn(message => (all[message.command] ?? (async () => ({ message: 'ok' })))(message));
  const browser = {
    runtime: { sendMessage },
    windows: { getCurrent: async () => win },
    storage: { onChanged: { addListener: fn => storage.listeners.add(fn), removeListener: fn => storage.listeners.delete(fn) } },
  };
  const { ready } = startOptions({ document, window, browser, locale: 'en-US' });
  const $ = id => byId.get(id);
  const sent = command => sendMessage.mock.calls.map(([m]) => m).filter(m => m.command === command);
  return { $, window, document, sendMessage, sent, ready, storage };
}

function state({ settings, auto } = {}) {
  return {
    settings: { staleThresholdMs: 3 * DAY, autoCloseStaleEnabled: false, skipPinned: true, skipAudible: false, ...settings },
    auto: { enabled: false, available: true, nextRunAt: new Date(2026, 9, 6, 22).getTime(), count: 2, error: null, ...auto },
    preview: { id: 'p', tabs: [], count: 0, windowCount: 1, unknownCount: 0 },
  };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

describe('settings: stale tabs', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('shows the shared rule, the first-run projection and the closing warning', async () => {
    const ui = setup();
    await ui.ready;
    await settle();
    expect(ui.$('stale-value').value).toBe('3');
    expect(ui.$('stale-unit').value).toBe('days');
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.$('stale-auto-detail').textContent).toBe('If turned on, 2 tabs would close automatically at 10p. Includes tabs that reach 3 days before then. Nothing closes before then.');
    expect(html).toContain('Tabs are closed, not archived. Unsaved changes may be lost.');
    expect(html).toContain('Close tabs not viewed for');
    expect(html).toContain('Automatically close stale tabs');
    expect(ui.sent('getStaleState')).toEqual([{ command: 'getStaleState', windowId: 4 }]);
  });

  it('generic auto-save never carries the stale rule or the automation preference', async () => {
    const ui = setup();
    await ui.ready;
    ui.$('ignore-query').checked = true;
    ui.$('ignore-query').dispatch('change');
    await settle();
    const [{ settings }] = ui.sent('saveSettings');
    expect(settings).toEqual({
      searchScope: 'all', ignoreFragments: true, ignoreQueryParams: true, skipPinned: true, skipAudible: false,
      blankNewTab: true, blankWelcome: true, blankSearchEngines: false, blankCustomUrls: ['https://a.example/'],
    });
    expect(settings).not.toHaveProperty('staleThresholdMs');
    expect(settings).not.toHaveProperty('autoCloseStaleEnabled');
  });

  it('does not save defaults over settings that failed to load', async () => {
    const ui = setup({ getSettings: async () => { throw new Error('no background'); } });
    await ui.ready;
    ui.$('skip-pinned').dispatch('change');
    await settle();
    expect(ui.sent('saveSettings')).toEqual([]);
  });

  it.each([['0'], ['2.5'], ['x'], ['104249992'], ['']])('rejects %s days inline and never saves it', async value => {
    const ui = setup();
    await ui.ready;
    await settle();
    ui.$('stale-value').value = value;
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
    await settle();
    expect(ui.$('stale-error').hidden).toBe(false);
    expect(ui.$('stale-error').textContent).toMatch(/whole number of days/);
    expect(ui.$('stale-value').getAttribute('aria-invalid')).toBe('true');
    expect(ui.sent('setStaleRule')).toEqual([]);
    expect(ui.sent('saveSettings')).toEqual([]);
  });

  it('accepts durations beyond a year, with no fixed upper limit', async () => {
    const ui = setup();
    await ui.ready;
    await settle();
    ui.$('stale-value').value = '400';
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 4, settings: { staleThresholdMs: 400 * DAY } }]);
    expect(html).not.toMatch(/id="stale-value"[^>]*\smax=/);
  });

  it('saves a valid duration through setStaleRule and refreshes', async () => {
    let saved = 3 * DAY;
    const ui = setup({
      getStaleState: async () => state({ settings: { staleThresholdMs: saved } }),
      setStaleRule: async ({ settings }) => { saved = settings.staleThresholdMs; return { message: 'Saved' }; },
    });
    await ui.ready;
    await settle();
    ui.$('stale-unit').value = 'hours';
    ui.$('stale-unit').dispatch('change');
    // The unit change alone keeps 3 days as 72 hours and saves nothing.
    expect(ui.$('stale-value').value).toBe('72');
    expect(ui.sent('setStaleRule')).toEqual([]);
    ui.$('stale-value').value = '36';
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 4, settings: { staleThresholdMs: 36 * HOUR } }]);
    expect(ui.sent('getStaleState').length).toBeGreaterThan(1);
    expect(ui.$('stale-value').value).toBe('36');
    expect(ui.$('stale-unit').value).toBe('hours');
  });

  it('enables only with a valid projection, and reverts on failure', async () => {
    const ui = setup({ setStaleRule: async () => ({ error: 'Alarms unavailable' }) });
    await ui.ready;
    await settle();
    ui.$('stale-auto').checked = true;
    ui.$('stale-auto').dispatch('change');
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 4, settings: { autoCloseStaleEnabled: true } }]);
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.$('stale-message').textContent).toBe('Could not save the stale-tab rule: Alarms unavailable');
  });

  it.each([
    ['unavailable state', async () => ({ error: 'boom' })],
    ['no schedule', async () => state({ auto: { nextRunAt: null } })],
    ['private context', async () => state({ auto: { available: false } })],
  ])('refuses to enable with %s', async (_, getStaleState) => {
    const ui = setup({ getStaleState });
    await ui.ready;
    await settle();
    ui.$('stale-auto').checked = true;
    ui.$('stale-auto').dispatch('change');
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.sent('setStaleRule')).toEqual([]);
  });

  it('holds an editor lease while the stale controls have focus', async () => {
    const ui = setup();
    await ui.ready;
    await settle();
    ui.$('stale-fieldset').dispatch('focusin');
    await settle();
    expect(ui.sent('staleEditor')).toEqual([{ command: 'staleEditor', windowId: 4, open: true }]);
    // Moving within the fieldset keeps the lease.
    ui.$('stale-fieldset').dispatch('focusout', { relatedTarget: ui.$('stale-auto') });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 4, open: true, editorId: 'opt-1' });
    ui.$('stale-fieldset').dispatch('focusout', { relatedTarget: ui.$('search-scope') });
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 4, open: false, editorId: 'opt-1' });
  });

  it('releases the lease and stops refreshing on pagehide', async () => {
    const ui = setup();
    await ui.ready;
    await settle();
    ui.$('stale-fieldset').dispatch('focusin');
    await settle();
    ui.window.dispatch('pagehide');
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toMatchObject({ open: false, editorId: 'opt-1' });
    expect(ui.storage.listeners.size).toBe(0);
    const count = ui.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ui.sendMessage.mock.calls.length).toBe(count);
  });

  // Regressions from the 0.6.0 UI review.
  const enabledSettings = async () => ({ searchScope: 'all', staleThresholdMs: 3 * DAY, autoCloseStaleEnabled: true, skipPinned: true, skipAudible: true, blankCustomUrls: [] });

  it('loads the automation switch from settings, and can turn it off when stale status fails', async () => {
    const ui = setup({ getSettings: enabledSettings, getStaleState: async () => ({ error: 'boom' }) });
    await ui.ready;
    await settle();
    expect(ui.$('stale-auto').checked).toBe(true);
    expect(ui.$('stale-auto').getAttribute('aria-disabled')).toBeNull();
    ui.$('stale-auto').checked = false;
    ui.$('stale-auto').dispatch('change');
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 4, settings: { autoCloseStaleEnabled: false } }]);
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
  });

  it('shows an unknown preference as unknown and still offers turning it off', async () => {
    const ui = setup({ getSettings: async () => { throw new Error('gone'); }, getStaleState: async () => ({ error: 'boom' }) });
    await ui.ready;
    await settle();
    expect(ui.$('stale-auto').indeterminate).toBe(true);
    expect(ui.$('stale-auto-detail').textContent).toContain('You can still turn it off.');
    ui.$('stale-auto').checked = true;
    ui.$('stale-auto').dispatch('change');
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 4, settings: { autoCloseStaleEnabled: false } }]);
  });

  it('turns off at once while another save is pending', async () => {
    const first = deferred();
    let on = true;
    let call = 0;
    // Like the background: writes apply in arrival order, so the disable lands after the first save.
    const ui = setup({
      getStaleState: async () => state({ settings: { autoCloseStaleEnabled: on }, auto: { enabled: on } }),
      setStaleRule: ({ settings }) => {
        const turn = call++ ? first.promise.then(() => ({ message: 'Saved' })) : first.promise;
        return turn.then(reply => { if ('autoCloseStaleEnabled' in settings) on = settings.autoCloseStaleEnabled; return reply; });
      },
    });
    await ui.ready;
    await settle();
    ui.$('stale-value').value = '5';
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
    ui.$('stale-auto').checked = false;
    ui.$('stale-auto').dispatch('change');
    expect(ui.sent('setStaleRule').map(m => m.settings)).toEqual([{ staleThresholdMs: 5 * DAY }, { autoCloseStaleEnabled: false }]);
    first.resolve({ message: 'Saved' });
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
  });

  it('keeps a second duration edit made while the first save is pending', async () => {
    const first = deferred();
    let call = 0;
    const ui = setup({ setStaleRule: () => (call++ ? Promise.resolve({ message: 'Saved' }) : first.promise) });
    await ui.ready;
    await settle();
    ui.$('stale-value').value = '5';
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
    ui.$('stale-value').value = '6';
    ui.$('stale-value').dispatch('input');
    first.resolve({ message: 'Saved' });
    await settle();
    expect(ui.$('stale-value').value).toBe('6');
    ui.$('stale-value').dispatch('change');
    expect(ui.sent('setStaleRule').map(m => m.settings)).toEqual([{ staleThresholdMs: 5 * DAY }, { staleThresholdMs: 6 * DAY }]);
  });

  it('a unit change that is not whole stays an invalid draft and saves nothing', async () => {
    const ui = setup({ getStaleState: async () => state({ settings: { staleThresholdMs: 36 * HOUR } }) });
    await ui.ready;
    await settle();
    expect(ui.$('stale-value').value).toBe('36');
    ui.$('stale-unit').value = 'days';
    ui.$('stale-unit').dispatch('change');
    expect(ui.$('stale-value').value).toBe('1.5');
    expect(ui.$('stale-error').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.$('stale-value').value).toBe('1.5');
    expect(ui.sent('setStaleRule')).toEqual([]);
  });

  it('releases the lease while the tab is hidden and reacquires only for a focused stale field', async () => {
    const ui = setup();
    await ui.ready;
    await settle();
    ui.document.activeElement = ui.$('stale-value');
    ui.$('stale-fieldset').dispatch('focusin', { target: ui.$('stale-value') });
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 4, open: true });
    ui.document.visibilityState = 'hidden';
    ui.document.dispatch('visibilitychange');
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 4, open: false, editorId: 'opt-1' });
    const released = ui.sent('staleEditor').length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ui.sent('staleEditor')).toHaveLength(released);
    ui.document.visibilityState = 'visible';
    ui.document.dispatch('visibilitychange');
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 4, open: true });
    // Visible again with focus elsewhere: no lease.
    ui.$('stale-fieldset').dispatch('focusout', { relatedTarget: ui.$('search-scope') });
    ui.document.activeElement = ui.$('search-scope');
    ui.document.visibilityState = 'hidden';
    ui.document.dispatch('visibilitychange');
    ui.document.visibilityState = 'visible';
    ui.document.dispatch('visibilitychange');
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toMatchObject({ open: false });
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
