import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startPopup } from '../src/popup.js';

const html = readFileSync(new URL('../src/popup.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/popup.css', import.meta.url), 'utf8');

// Minimal DOM built from the real popup markup.
class El {
  constructor(tag, owner) {
    Object.assign(this, { tag, owner, id: '', hidden: false, parent: null, dataset: {}, text: '', listeners: {}, children: [] });
    this.attrs = new Map();
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
    };
  }
  get textContent() { return this.text; }
  set textContent(value) { this.text = String(value); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, target = this, extra = {}) {
    const event = { target, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return event;
  }
  append(...nodes) {
    for (const node of nodes) { node.parent = this; this.children.push(node); this.owner.all.push(node); }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  closest(selector) {
    if (selector !== 'button[data-criteria]') throw new Error(`unsupported selector ${selector}`);
    for (let node = this; node; node = node.parent) if (node.tag === 'button' && node.dataset.criteria) return node;
    return null;
  }
  querySelectorAll(selector) {
    if (selector !== 'button') throw new Error(`unsupported selector ${selector}`);
    return this.owner.all.filter(node => node.tag === 'button' && this.contains(node) && node !== this);
  }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  focus() { this.owner.activeElement = this; }
}

function setup(reply, apis = {}) {
  const document = { activeElement: null, all: [], listeners: {} };
  const byId = new Map();
  const stack = [];
  for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (close) { stack.pop(); continue; }
    const node = new El(tag, document);
    node.parent = stack.at(-1) ?? null;
    for (const [, name, value] of attrs.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)) {
      if (name === 'id') { node.id = value; byId.set(value, node); }
      else if (name === 'hidden') node.hidden = true;
      else if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      else node.setAttribute(name, value ?? '');
    }
    document.all.push(node);
    if (!/^(meta|link|path|circle|rect|input)$/.test(tag) && !attrs.endsWith('/')) stack.push(node);
  }
  document.body = document.all.find(node => node.tag === 'body');
  document.activeElement = document.body;
  document.getElementById = id => byId.get(id) ?? null;
  document.querySelector = selector => document.all.find(node => node.tag === selector) ?? null;
  document.createElement = tag => new El(tag, document);
  document.addEventListener = (type, fn) => (document.listeners[type] ??= []).push(fn);
  document.dispatch = El.prototype.dispatch;

  const window = new El('#window', document);
  window.close = vi.fn();
  const sendMessage = vi.fn(reply);
  startPopup({ document, window, browser: { runtime: { sendMessage }, ...apis }, locale: 'en-US' });

  const $ = id => byId.get(id);
  const sortButton = (criteria, direction) => document.all.find(node => node.dataset.criteria === criteria && node.dataset.direction === direction);
  const press = button => { button.focus(); button.dispatch('click'); };
  const chooseSort = (criteria, direction) => {
    const button = sortButton(criteria, direction);
    button.focus();
    $('sort-options').dispatch('click', button);
    return button;
  };
  const main = document.querySelector('main');
  const status = () => ({
    visible: $('status').classList.contains('visible'),
    tone: $('status').dataset.tone,
    title: $('status-title').textContent,
    detail: $('status-detail').hidden ? '' : $('status-detail').textContent,
    spinner: !$('status-spinner').hidden,
    closable: !$('status-close').hidden,
  });
  const actionButtons = () => document.all.filter(node => node.tag === 'button' && main.contains(node));
  return { $, document, window, sendMessage, press, chooseSort, main, status, actionButtons };
}

// A reply the test resolves by hand, so the pending state can be observed.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

const CLEANUP = [
  ['btn-dupes', 'closeDuplicates', 'Closing duplicate tabs...'],
  ['btn-merge', 'mergeWindows', 'Merging windows...'],
  ['btn-blank', 'closeBlankTabs', 'Closing blank tabs...'],
];

describe('popup action feedback', () => {
  it.each(CLEANUP)('%s shows a busy label immediately, then closes on success', async (id, command, label) => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.press(ui.$(id));

    expect(ui.sendMessage).toHaveBeenCalledWith({ command });
    expect(ui.status()).toMatchObject({ visible: true, tone: 'busy', title: label, spinner: true, closable: false });
    expect(ui.main.getAttribute('aria-busy')).toBe('true');
    expect(ui.actionButtons().every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(ui.window.close).not.toHaveBeenCalled();

    reply.resolve({ message: 'Closed 3 tabs' });
    await settle();
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['url', 'asc', 'Sorting by URL, A → Z...', ''],
    ['url', 'desc', 'Sorting by URL, Z → A...', ''],
    ['title', 'asc', 'Sorting by title, A → Z...', ''],
    ['title', 'desc', 'Sorting by title, Z → A...', ''],
    ['lastAccessed', 'desc', 'Sorting by last accessed...', ''],
    ['visitCount', 'desc', 'Sorting by most visited...', 'Reading browsing history. Press Esc to dismiss.'],
    ['frecency', 'desc', 'Sorting by frequent & recent...', 'Reading browsing history. Press Esc to dismiss.'],
  ])('sort by %s %s names its criteria while pending', async (criteria, direction, title, detail) => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.press(ui.$('btn-sort'));
    expect(ui.$('sort-options').hidden).toBe(false);
    ui.chooseSort(criteria, direction);
    expect(ui.$('sort-options').hidden).toBe(true);
    expect(ui.$('btn-sort').getAttribute('aria-expanded')).toBe('false');
    expect(ui.document.activeElement).toBe(ui.$('btn-sort'));

    expect(ui.sendMessage).toHaveBeenCalledWith({ command: 'sortTabs', criteria, direction });
    expect(ui.status()).toMatchObject({ tone: 'busy', title, detail, spinner: true });
    // No invented progress.
    expect(ui.status().title).not.toMatch(/%/);
    reply.resolve({ message: 'Sorted 8 tabs' });
    await settle();
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('restores a visible sort control after a pointer click that did not focus the option', async () => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.press(ui.$('btn-sort'));
    ui.document.activeElement = ui.document.body;
    const option = ui.$('sort-options').querySelectorAll('button').find(button => button.dataset.criteria === 'frecency');
    // Firefox on macOS may leave focus on body after a pointer click.
    ui.$('sort-options').dispatch('click', option);
    expect(ui.$('sort-options').hidden).toBe(true);
    reply.resolve({ error: 'Unavailable', message: 'Error: Unavailable' });
    await settle();
    expect(ui.document.activeElement).toBe(ui.$('btn-sort'));
    expect(ui.window.close).not.toHaveBeenCalled();
  });

  it('closes after a successful no-op', async () => {
    const ui = setup(async () => ({ message: 'No duplicate tabs found' }));
    ui.press(ui.$('btn-dupes'));
    await settle();
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('blocks repeated and conflicting clicks while an action is pending', async () => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.press(ui.$('btn-merge'));
    // Programmatic clicks ignore aria-disabled, so the handler must refuse them.
    ui.press(ui.$('btn-merge'));
    ui.press(ui.$('btn-dupes'));
    ui.press(ui.$('btn-search'));
    ui.press(ui.$('btn-sort'));
    expect(ui.$('sort-options').hidden).toBe(true);
    expect(ui.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.document.activeElement).toBe(ui.$('btn-sort'));

    reply.resolve({ message: 'Merged 2 windows' });
    await settle();
    expect(ui.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('keeps an action error visible and actionable, then clears the busy state', async () => {
    vi.useFakeTimers();
    try {
      const ui = setup(async () => ({ error: 'Tabs API unavailable', message: 'Error: Tabs API unavailable' }));
      ui.press(ui.$('btn-blank'));
      await vi.runAllTimersAsync();
      vi.advanceTimersByTime(10_000);

      expect(ui.window.close).not.toHaveBeenCalled();
      expect(ui.status()).toMatchObject({
        visible: true, tone: 'error', spinner: false, closable: true,
        title: 'Could not close blank tabs: Tabs API unavailable',
        detail: 'Try again, or close this menu.',
      });
      expect(ui.main.getAttribute('aria-busy')).toBeNull();
      // The shared busy gate is cleared. The stale panel's own buttons stay gated
      // because this menu has no stale preview (no windows API in this fixture).
      const ownGated = [ui.$('stale-review'), ui.$('stale-close')];
      expect(ui.actionButtons().filter(button => !ownGated.includes(button)).some(button => button.getAttribute('aria-disabled'))).toBe(false);
      for (const button of ownGated) expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(ui.document.activeElement).toBe(ui.$('btn-blank'));

      // Retrying works once the error is shown.
      ui.press(ui.$('btn-blank'));
      expect(ui.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a send failure', () => Promise.reject(new Error('Receiving end does not exist')), 'Could not merge windows: Receiving end does not exist'],
    ['an empty reply', async () => undefined, "Could not merge windows: Aaron's Tab Vacuum did not respond."],
    ['a malformed reply', async () => ({ message: 42 }), "Could not merge windows: Aaron's Tab Vacuum did not respond."],
    ['a blank message', async () => ({ message: '  ' }), "Could not merge windows: Aaron's Tab Vacuum did not respond."],
  ])('stays open with an error after %s', async (_, reply, title) => {
    const ui = setup(reply);
    ui.press(ui.$('btn-merge'));
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({ tone: 'error', title, closable: true, spinner: false });
    expect(ui.main.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps a completed result with its count when only the notification failed', async () => {
    const ui = setup(async () => ({ message: 'Closed 4 duplicate tabs', notificationError: 'Notifications are blocked' }));
    ui.press(ui.$('btn-dupes'));
    await settle();

    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({
      tone: 'done', title: 'Closed 4 duplicate tabs', closable: true, spinner: false,
      detail: 'System notification unavailable: Notifications are blocked',
    });
    expect(ui.status().title).not.toMatch(/could not|fail|error/i);
    expect(ui.main.getAttribute('aria-busy')).toBeNull();
  });

  it('reports the action error, not success, when both the action and notification failed', async () => {
    const ui = setup(async () => ({ error: 'boom', message: 'Error: boom', notificationError: 'blocked' }));
    ui.press(ui.$('btn-blank'));
    await settle();
    expect(ui.status()).toMatchObject({ tone: 'error', title: 'Could not close blank tabs: boom' });
  });

  it('Close menu closes the popup', async () => {
    const ui = setup(async () => ({ error: 'boom' }));
    ui.press(ui.$('btn-dupes'));
    await settle();
    ui.press(ui.$('status-close'));
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('never touches a menu the user dismissed while the action ran', async () => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.chooseSort('frecency', 'desc');
    ui.window.dispatch('pagehide');
    reply.resolve({ message: 'Sorted 9 tabs', notificationError: 'blocked' });
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status().tone).toBe('busy');
  });

  it('keeps busy state off the live region so the status is announced at once', () => {
    const ui = setup(() => new Promise(() => {}));
    ui.press(ui.$('btn-merge'));
    const live = ui.document.all.find(node => node.getAttribute('role') === 'status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.contains(ui.$('status-title'))).toBe(true);
    expect(ui.main.contains(live)).toBe(false);
    for (let node = live; node; node = node.parent) expect(node.getAttribute('aria-busy')).toBeNull();
    expect(ui.$('status-spinner').getAttribute('aria-hidden')).toBe('true');
    expect(live.contains(ui.$('status-spinner'))).toBe(false);
  });

  it('uses theme tokens and leaves the spinner to the reduced-motion rule', () => {
    expect(css).toMatch(/@import "ui-theme\.css"/);
    expect(css).toMatch(/\.spinner\s*\{[^}]*var\(--accent\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

describe('popup search launch', () => {
  it('closes once search opens', async () => {
    const ui = setup(async () => ({ mode: 'overlay' }));
    ui.press(ui.$('btn-search'));
    expect(ui.sendMessage).toHaveBeenCalledWith({ command: 'launchSearch' });
    await settle();
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('shows the background search error without auto-hiding it', async () => {
    const message = "Could not open Search tabs. Try again from the Aaron's Tab Vacuum menu.";
    const ui = setup(async () => ({ error: message }));
    ui.press(ui.$('btn-search'));
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({ tone: 'error', title: message, closable: true });
  });

  it('shows a send failure and blocks a second launch while the first is pending', async () => {
    const reply = deferred();
    const ui = setup(() => reply.promise);
    ui.press(ui.$('btn-search'));
    ui.press(ui.$('btn-search'));
    expect(ui.sendMessage).toHaveBeenCalledTimes(1);
    reply.reject(new Error('Background unavailable'));
    await settle();
    expect(ui.status()).toMatchObject({ tone: 'error', title: 'Could not open Search tabs: Background unavailable' });
    expect(ui.main.getAttribute('aria-busy')).toBeNull();
  });
});

// ---- Stale Tabs (R4) ----
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 6, 21, 15).getTime();
const at = (hours, minutes = 0) => new Date(2026, 9, 6, hours, minutes).getTime();

function staleState({ settings, auto, preview } = {}) {
  return {
    settings: { staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: false, skipPinned: true, skipAudible: true, ...settings },
    auto: { enabled: false, available: true, nextRunAt: at(22), count: 0, error: null, ...auto },
    preview: { id: 'p1', tabs: [], count: 0, windowCount: 1, unknownCount: 0, ...preview },
  };
}

function browserEvent() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), fire: () => listeners.forEach(fn => fn()), get size() { return listeners.size; } };
}

// A popup with the stale APIs present. `handlers` answer messages by command.
function staleSetup(handlers = {}, { win = { id: 7, incognito: false } } = {}) {
  const tabs = { onCreated: browserEvent(), onRemoved: browserEvent(), onUpdated: browserEvent(), onActivated: browserEvent(), onAttached: browserEvent(), onDetached: browserEvent() };
  const storage = { onChanged: browserEvent() };
  const all = {
    getSettings: async () => ({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: false }),
    getStaleState: async () => staleState(), consumeStaleIntent: async () => ({ open: false }), staleEditor: async () => ({ editorId: 'e1' }), ...handlers,
  };
  const getCurrent = typeof win === 'function' ? win : vi.fn(async () => win);
  const ui = setup(message => (all[message.command] ?? (async () => ({ message: 'ok' })))(message), { windows: { getCurrent }, tabs, storage });
  const sent = command => ui.sendMessage.mock.calls.map(([message]) => message).filter(message => message.command === command);
  const stale = () => ({
    title: ui.$('stale-title').textContent,
    caption: ui.$('stale-caption').hidden ? '' : ui.$('stale-caption').textContent,
    captionTone: ui.$('stale-caption').dataset.tone,
    count: ui.$('stale-count').textContent,
    close: ui.$('stale-close').textContent,
    closeDisabled: ui.$('stale-close').getAttribute('aria-disabled') === 'true',
    autoDisabled: ui.$('stale-auto').getAttribute('aria-disabled') === 'true',
    detail: ui.$('stale-auto-detail').textContent,
    open: !ui.$('stale-panel').hidden,
  });
  const edit = (value, unit = ui.$('stale-unit').value) => {
    ui.$('stale-value').value = value;
    ui.$('stale-unit').value = unit;
    ui.$('stale-value').dispatch('input');
    ui.$('stale-value').dispatch('change');
  };
  const toggleAuto = checked => { ui.$('stale-auto').checked = checked; ui.$('stale-auto').dispatch('change'); };
  const key = name => ui.document.dispatch('keydown', ui.document, { key: name });
  return { ...ui, tabs, storage, sent, stale, edit, toggleAuto, key, getCurrent };
}

const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW });

describe('popup stale tabs: collapsed status', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('shows the off title with no caption, and opening the row closes nothing', async () => {
    const ui = staleSetup();
    await settle();
    expect(ui.getCurrent).toHaveBeenCalledTimes(1);
    expect(ui.sent('getStaleState')).toEqual([{ command: 'getStaleState', windowId: 7 }]);
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs', caption: '', open: false });

    ui.press(ui.$('btn-stale'));
    expect(ui.stale().open).toBe(true);
    expect(ui.$('btn-stale').getAttribute('aria-expanded')).toBe('true');
    expect(ui.$('btn-stale').getAttribute('aria-controls')).toBe('stale-panel');
    await settle();
    expect(ui.sent('closeStalePreview')).toEqual([]);
    expect(ui.sent('closeStaleTabs')).toEqual([]);
    expect(ui.window.close).not.toHaveBeenCalled();
    ui.press(ui.$('btn-stale'));
    expect(ui.stale().open).toBe(false);
  });

  it.each([
    [6, at(22), 'Closing 6 tabs automatically at 10p.'],
    [1, at(22), 'Closing 1 tab automatically at 10p.'],
    [3, at(22, 30), 'Closing 3 tabs automatically at 10:30p.'],
    [2, new Date(2026, 9, 7, 0, 0).getTime(), 'Closing 2 tabs automatically at 12a tomorrow.'],
  ])('enabled with %i projected tabs shows the agreed caption', async (count, nextRunAt, caption) => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count, nextRunAt } }) });
    await settle();
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption });
    expect(ui.stale().caption).not.toMatch(/due|rule|~|Auto on|day rule/);
  });

  it('enabled with zero projected tabs keeps the title and omits the caption', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count: 0 } }) });
    await settle();
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: '' });
  });

  it('uses the manual count for Close now and the projected count for the caption', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count: 6 }, preview: { count: 4, windowCount: 2 } }) });
    await settle();
    expect(ui.stale().caption).toBe('Closing 6 tabs automatically at 10p.');
    expect(ui.stale()).toMatchObject({ close: 'Close 4 tabs now', count: 'Close now: 4 tabs not viewed for 7 days, across 2 windows.' });
  });

  it('never flashes a zero count or disabled title while loading', async () => {
    const reply = deferred();
    const ui = staleSetup({ getStaleState: () => reply.promise, getSettings: async () => ({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: true }) });
    await settle();
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Checking…', count: 'Checking…', close: 'Close tabs now', closeDisabled: true, autoDisabled: false });
    expect(ui.stale().count).not.toMatch(/\b0\b/);
    reply.resolve(staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count: 2 } }));
    await settle();
    expect(ui.stale().caption).toBe('Closing 2 tabs automatically at 10p.');
  });

  it('marks status unavailable on a refresh failure and keeps actions gated', async () => {
    let fail = false;
    const ui = staleSetup({ getStaleState: async () => (fail ? { error: 'Tabs API unavailable', message: 'Error: Tabs API unavailable' } : staleState({ preview: { count: 3, tabs: [] } })) });
    await settle();
    expect(ui.stale().closeDisabled).toBe(false);
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.stale()).toMatchObject({ caption: 'Stale-tab status unavailable.', captionTone: 'error', closeDisabled: true, close: 'Close tabs now' });
    expect(ui.stale().count).toContain('Tabs API unavailable');
    expect(ui.stale().count).not.toMatch(/0 tabs/);
  });

  it.each([
    ['a malformed reply', async () => ({ settings: {}, auto: {}, preview: {} })],
    ['a rejected send', async () => { throw new Error('Receiving end does not exist'); }],
  ])('treats %s as unknown, not zero', async (_, getStaleState) => {
    const ui = staleSetup({ getStaleState });
    await settle();
    expect(ui.stale()).toMatchObject({ caption: 'Stale-tab status unavailable.', closeDisabled: true });
  });

  it('shows a truthful error when automation cannot be scheduled', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count: 4, error: 'Automatic cleanup could not be scheduled.' } }) });
    await settle();
    expect(ui.stale()).toMatchObject({ caption: 'Automatic cleanup could not be scheduled.', captionTone: 'error' });
    expect(ui.stale().caption).not.toMatch(/at \d/);
  });

  it('keeps unrelated actions working when the window or stale state is unavailable', async () => {
    const ui = staleSetup({}, { win: vi.fn(async () => { throw new Error('no window'); }) });
    await settle();
    expect(ui.sent('getStaleState')).toEqual([]);
    // Without a window nothing about automation is known, and it is not shown as off.
    expect(ui.stale().caption).toBe('Automatic cleanup status unavailable.');
    ui.press(ui.$('btn-dupes'));
    await settle();
    expect(ui.sent('closeDuplicates')).toHaveLength(1);
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('ignores normal-window automation numbers in a private window', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, available: true, count: 9 }, preview: { count: 1, windowCount: 1 } }) }, { win: { id: 3, incognito: true } });
    await settle();
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: '' });
    expect(ui.stale().detail).toMatch(/normal windows only/);
    expect(ui.stale().detail).not.toMatch(/9/);
    expect(ui.stale().count).toBe('Close now: 1 tab not viewed for 7 days, across 1 private window.');
    // The shared preference shows as on; turning it off stays allowed here.
    expect(ui.$('stale-auto').checked).toBe(true);
    expect(ui.stale().autoDisabled).toBe(false);
  });
});

describe('popup stale tabs: refresh and ordering', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('lets only the latest reply update the count', async () => {
    const replies = [deferred(), deferred()];
    let call = 0;
    const ui = staleSetup({ getStaleState: () => replies[call++].promise });
    await settle();
    ui.tabs.onRemoved.fire();
    await vi.advanceTimersByTimeAsync(300);
    expect(ui.sent('getStaleState')).toHaveLength(2);
    replies[1].resolve(staleState({ preview: { id: 'new', count: 3 } }));
    await settle();
    replies[0].resolve(staleState({ preview: { id: 'old', count: 9 } }));
    await settle();
    expect(ui.stale().close).toBe('Close 3 tabs now');
  });

  it('debounces tab events and polls at most every five seconds', async () => {
    const ui = staleSetup();
    await settle();
    for (let i = 0; i < 20; i++) ui.tabs.onUpdated.fire();
    ui.storage.onChanged.fire();
    await vi.advanceTimersByTimeAsync(300);
    expect(ui.sent('getStaleState')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4699);
    expect(ui.sent('getStaleState')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.sent('getStaleState')).toHaveLength(3);
  });

  it('does not rebuild an unchanged review list or replace an unchanged caption', async () => {
    const tabs = [{ id: 1, title: 'Docs', url: 'https://docs.example.com/a', lastViewedAt: NOW - 8 * DAY }];
    const ui = staleSetup({ getStaleState: async () => staleState({ preview: { id: `p${Date.now()}`, count: 1, tabs } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-review'));
    const first = ui.$('stale-review-list').children[0];
    const caption = ui.$('stale-title');
    let writes = 0;
    Object.defineProperty(caption, 'textContent', { get: () => caption.text, set: value => { writes++; caption.text = value; } });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.$('stale-review-list').children[0]).toBe(first);
    expect(writes).toBe(0);
  });

  it('removes listeners, timers and the editor lease on pagehide', async () => {
    const ui = staleSetup();
    await settle();
    ui.press(ui.$('btn-stale'));
    await settle();
    expect(ui.tabs.onUpdated.size).toBe(1);
    ui.window.dispatch('pagehide');
    await settle();
    expect(ui.tabs.onUpdated.size).toBe(0);
    expect(ui.storage.onChanged.size).toBe(0);
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 7, open: false, editorId: 'e1' });
    const count = ui.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ui.sendMessage.mock.calls.length).toBe(count);
  });

  it('opens the stale controls once for a consumed keyboard or menu intent', async () => {
    const ui = staleSetup({ consumeStaleIntent: async () => ({ open: true }) });
    await settle();
    expect(ui.sent('consumeStaleIntent')).toEqual([{ command: 'consumeStaleIntent', windowId: 7 }]);
    expect(ui.stale().open).toBe(true);
    expect(ui.document.activeElement).toBe(ui.$('btn-stale'));
  });

  it('stays collapsed for an ordinary open', async () => {
    const ui = staleSetup();
    await settle();
    expect(ui.stale().open).toBe(false);
  });
});

describe('popup stale tabs: editor lease', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('acquires on expand, renews every five seconds and releases on collapse', async () => {
    const ui = staleSetup();
    await settle();
    expect(ui.sent('staleEditor')).toEqual([]);
    ui.press(ui.$('btn-stale'));
    await settle();
    expect(ui.sent('staleEditor')).toEqual([{ command: 'staleEditor', windowId: 7, open: true }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 7, open: true, editorId: 'e1' });
    ui.press(ui.$('btn-stale'));
    await settle();
    expect(ui.sent('staleEditor').at(-1)).toEqual({ command: 'staleEditor', windowId: 7, open: false, editorId: 'e1' });
    const count = ui.sent('staleEditor').length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ui.sent('staleEditor')).toHaveLength(count);
  });

  it('collapsing sort and stale controls is mutual', async () => {
    const ui = staleSetup();
    await settle();
    ui.press(ui.$('btn-sort'));
    ui.press(ui.$('btn-stale'));
    expect(ui.$('sort-options').hidden).toBe(true);
    expect(ui.$('btn-sort').getAttribute('aria-expanded')).toBe('false');
    ui.press(ui.$('btn-sort'));
    expect(ui.stale().open).toBe(false);
    expect(ui.$('btn-stale').getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape collapses the review list, then the controls', async () => {
    const ui = staleSetup();
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-review'));
    expect(ui.$('stale-review-list').hidden).toBe(false);
    expect(ui.key('Escape').defaultPrevented).toBe(true);
    expect(ui.$('stale-review-list').hidden).toBe(true);
    expect(ui.document.activeElement).toBe(ui.$('stale-review'));
    expect(ui.key('Escape').defaultPrevented).toBe(true);
    expect(ui.stale().open).toBe(false);
    expect(ui.document.activeElement).toBe(ui.$('btn-stale'));
    // Nothing nested is open, so the browser may dismiss the menu.
    expect(ui.key('Escape').defaultPrevented).toBe(false);
  });
});

describe('popup stale tabs: review', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('lists title, domain and time since last viewed, with a bounded remainder', async () => {
    const tabs = [
      { id: 1, title: 'Design doc', url: 'https://docs.example.com/a', lastViewedAt: NOW - 8 * DAY },
      { id: 2, title: '', url: 'https://news.example.org/', lastViewedAt: NOW - 30 * HOUR },
    ];
    const ui = staleSetup({ getStaleState: async () => staleState({ preview: { count: 5, tabs } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-review'));
    expect(ui.$('stale-review').getAttribute('aria-expanded')).toBe('true');
    const rows = ui.$('stale-review-list').children.map(row => row.children.length ? row.children.map(part => part.textContent) : [row.textContent]);
    expect(rows).toEqual([
      ['Design doc', 'docs.example.com · Viewed 8 days ago'],
      ['https://news.example.org/', 'news.example.org · Viewed 30 hours ago'],
      ['And 3 more tabs.'],
    ]);
    expect(ui.sent('closeStalePreview')).toEqual([]);
  });
});

describe('popup stale tabs: rule editing', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it.each([['0', 'days'], ['-1', 'days'], ['1.5', 'days'], ['abc', 'days'], ['', 'days'], ['104249992', 'days'], ['1e3', 'days']])('rejects %s %s inline without saving', async (value, unit) => {
    const ui = staleSetup({ getStaleState: async () => staleState({ preview: { count: 2 } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.edit(value, unit);
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([]);
    expect(ui.$('stale-rule-error').hidden).toBe(false);
    expect(ui.$('stale-rule-error').textContent).toMatch(/whole number/);
    expect(ui.$('stale-value').getAttribute('aria-invalid')).toBe('true');
    expect(ui.stale()).toMatchObject({ closeDisabled: true, close: 'Close tabs now', autoDisabled: true });
    ui.press(ui.$('stale-close'));
    expect(ui.sent('closeStalePreview')).toEqual([]);
  });

  it('saves a valid duration, ignores replies from before the save, and refreshes', async () => {
    const before = deferred();
    let saved = 7 * DAY;
    let calls = 0;
    const ui = staleSetup({
      getStaleState: () => (calls++ === 1 ? before.promise : Promise.resolve(staleState({ settings: { staleThresholdMs: saved }, preview: { id: `p${calls}`, count: saved === 12 * HOUR ? 5 : 2 } }))),
      setStaleRule: async ({ settings }) => { saved = settings.staleThresholdMs; return { message: 'Saved' }; },
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    expect(ui.$('stale-value').value).toBe('7');
    expect(ui.$('stale-unit').value).toBe('days');
    ui.tabs.onCreated.fire();
    await vi.advanceTimersByTimeAsync(300); // second refresh is now in flight
    ui.edit('12', 'hours');
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { staleThresholdMs: 12 * HOUR } }]);
    expect(ui.$('stale-rule-error').hidden).toBe(true);
    before.resolve(staleState({ preview: { id: 'old', count: 99 } }));
    await settle();
    expect(ui.stale().close).toBe('Close 5 tabs now');
    expect(ui.stale().count).toBe('Close now: 5 tabs not viewed for 12 hours, across 1 window.');
    expect(ui.sent('closeStalePreview')).toEqual([]);
  });

  it('a changed threshold invalidates the shown preview until the fresh one arrives', async () => {
    const save = deferred();
    const ui = staleSetup({ getStaleState: async () => staleState({ preview: { count: 2 } }), setStaleRule: () => save.promise });
    await settle();
    ui.press(ui.$('btn-stale'));
    expect(ui.stale().closeDisabled).toBe(false);
    ui.$('stale-value').value = '3';
    ui.$('stale-value').dispatch('input');
    expect(ui.stale()).toMatchObject({ closeDisabled: true, count: 'Updating count…' });
    ui.$('stale-value').dispatch('change');
    ui.press(ui.$('stale-close'));
    expect(ui.sent('closeStalePreview')).toEqual([]);
    save.resolve({ message: 'Saved' });
    await settle();
    expect(ui.stale().closeDisabled).toBe(false);
  });

  it('shows a save failure inline and restores the saved rule', async () => {
    const ui = staleSetup({ setStaleRule: async () => ({ error: 'Invalid threshold', message: 'Error: Invalid threshold' }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.edit('9');
    await settle();
    expect(ui.$('stale-message').textContent).toBe('Could not save the stale-tab rule: Invalid threshold');
    expect(ui.$('stale-value').value).toBe('7');
    expect(ui.window.close).not.toHaveBeenCalled();
  });
});

describe('popup stale tabs: automation checkbox', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('explains the first run before enabling and enables through setStaleRule', async () => {
    let enabled = false;
    const ui = staleSetup({
      getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: enabled }, auto: { enabled, count: 6 } }),
      setStaleRule: async ({ settings }) => { enabled = settings.autoCloseStaleEnabled; return { message: 'Saved' }; },
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    expect(ui.stale().detail).toBe('If turned on, 6 tabs would close automatically at 10p. Includes tabs that reach 7 days before then. Nothing closes before then.');
    expect(html).toMatch(/id="stale-warning"[^>]*>Tabs are closed, not archived\. Unsaved changes may be lost\.</);
    expect(ui.$('stale-auto').getAttribute('aria-describedby')).toContain('stale-warning');
    ui.toggleAuto(true);
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { autoCloseStaleEnabled: true } }]);
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Closing 6 tabs automatically at 10p.' });
    expect(ui.$('stale-auto').checked).toBe(true);
    expect(ui.sent('closeStalePreview')).toEqual([]);
    expect(ui.window.close).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', () => new Promise(() => {})],
    ['failed', async () => ({ error: 'boom' })],
    ['unschedulable', async () => staleState({ auto: { nextRunAt: null } })],
    ['scheduler error', async () => staleState({ auto: { error: 'Alarms unavailable' } })],
  ])('refuses to enable while state is %s', async (_, getStaleState) => {
    const ui = staleSetup({ getStaleState, getSettings: async () => ({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: false }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.toggleAuto(true);
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.sent('setStaleRule')).toEqual([]);
  });

  it('allows disabling after a refresh failure', async () => {
    let fail = false;
    const ui = staleSetup({ getStaleState: async () => (fail ? { error: 'boom' } : staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true } })) });
    await settle();
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    ui.press(ui.$('btn-stale'));
    ui.toggleAuto(false);
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { autoCloseStaleEnabled: false } }]);
  });

  it('reverts the checkbox when saving fails', async () => {
    const ui = staleSetup({ setStaleRule: async () => { throw new Error('Background unavailable'); } });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.toggleAuto(true);
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.$('stale-message').textContent).toBe('Could not save the stale-tab rule: Background unavailable');
  });
});

describe('popup stale tabs: manual close', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  const ready = handlers => staleSetup({ getStaleState: async () => staleState({ preview: { id: 'snap-1', count: 4 } }), ...handlers });

  it('closes only the shown preview with busy feedback, then closes the menu', async () => {
    const reply = deferred();
    const ui = ready({ closeStalePreview: () => reply.promise });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    expect(ui.sent('closeStalePreview')).toEqual([{ command: 'closeStalePreview', windowId: 7, previewId: 'snap-1' }]);
    expect(ui.status()).toMatchObject({ tone: 'busy', title: 'Closing stale tabs...', spinner: true });
    expect(ui.actionButtons().every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect([ui.$('stale-value'), ui.$('stale-unit')].every(control => control.disabled)).toBe(true);
    // The automation switch stays usable so it can be turned off; enabling stays gated.
    expect(ui.$('stale-auto').disabled).toBeFalsy();
    expect(ui.stale().autoDisabled).toBe(true);
    // Refresh pauses during the close; repeated clicks are refused.
    const refreshes = ui.sent('getStaleState').length;
    ui.tabs.onRemoved.fire();
    await vi.advanceTimersByTimeAsync(5000);
    ui.press(ui.$('stale-close'));
    ui.press(ui.$('btn-stale'));
    expect(ui.stale().open).toBe(true);
    expect(ui.sent('getStaleState')).toHaveLength(refreshes);
    expect(ui.sent('closeStalePreview')).toHaveLength(1);
    reply.resolve({ message: 'Closed 3 stale tabs; 1 skipped', closed: 3, skipped: 1, failed: 0 });
    await settle();
    expect(ui.window.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the menu open on failure and requires a fresh preview', async () => {
    let id = 0;
    const ui = staleSetup({
      getStaleState: async () => staleState({ preview: { id: `snap-${++id}`, count: 4 } }),
      closeStalePreview: async () => ({ error: 'Preview expired', message: 'Error: Preview expired' }),
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({ tone: 'error', title: 'Could not close stale tabs: Preview expired', closable: true });
    expect(ui.document.activeElement).toBe(ui.$('stale-close'));
    expect(ui.stale().open).toBe(true);
    ui.press(ui.$('stale-close'));
    await settle();
    expect(ui.sent('closeStalePreview').map(message => message.previewId)).toEqual(['snap-1', 'snap-2']);
  });

  it('reports actual results inline when only the notification failed', async () => {
    const ui = ready({ closeStalePreview: async () => ({ message: 'Closed 2 stale tabs; 2 skipped', closed: 2, skipped: 2, failed: 0, notificationError: 'Notifications are blocked' }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({ tone: 'done', title: 'Closed 2 stale tabs; 2 skipped', detail: 'System notification unavailable: Notifications are blocked' });
    expect(ui.status().title).not.toMatch(/4/);
  });

  it('is disabled at zero eligible tabs', async () => {
    const ui = staleSetup();
    await settle();
    ui.press(ui.$('btn-stale'));
    expect(ui.stale()).toMatchObject({ closeDisabled: true, close: 'Close 0 tabs now', count: 'Close now: no tabs have gone unviewed for 7 days.' });
    ui.press(ui.$('stale-close'));
    expect(ui.sent('closeStalePreview')).toEqual([]);
  });

  it('is refused while another action is running', async () => {
    const merge = deferred();
    const ui = ready({ mergeWindows: () => merge.promise });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('btn-merge'));
    ui.press(ui.$('stale-close'));
    ui.press(ui.$('stale-review'));
    expect(ui.sent('closeStalePreview')).toEqual([]);
    expect(ui.$('stale-review-list').hidden).toBe(true);
  });

  it('does nothing and reports nothing if the menu is dismissed before the reply', async () => {
    const reply = deferred();
    const ui = ready({ closeStalePreview: () => reply.promise });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    ui.window.dispatch('pagehide');
    reply.resolve({ message: 'Closed 4 stale tabs', notificationError: 'blocked' });
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status().tone).toBe('busy');
  });

  it('states manual protections and distinguishes them from automatic ones', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { skipPinned: false, skipAudible: false }, preview: { count: 2, unknownCount: 1 } }) });
    await settle();
    expect(ui.$('stale-protect').textContent).toBe(
      "Close now includes pinned tabs and tabs playing audio. 1 tab with an unknown last viewed time is kept. Both keep each window's active tab and last tab. Automatic cleanup always keeps pinned tabs and tabs playing audio.",
    );
  });
});

// Regressions from the 0.6.0 UI review.
describe('popup stale tabs: review fixes', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  const enabledSettings = async () => ({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: true });
  const onState = (extra = {}) => staleState({ settings: { autoCloseStaleEnabled: true }, auto: { enabled: true, count: 2 }, ...extra });

  it('takes the enabled state from getSettings when getStaleState fails, and can still turn it off', async () => {
    const ui = staleSetup({ getSettings: enabledSettings, getStaleState: async () => ({ error: 'boom' }) });
    await settle();
    expect(ui.sent('getSettings')).toHaveLength(1);
    expect(ui.stale()).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Stale-tab status unavailable.' });
    expect(ui.$('stale-auto').checked).toBe(true);
    expect(ui.stale().autoDisabled).toBe(false);
    ui.press(ui.$('btn-stale'));
    ui.toggleAuto(false);
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { autoCloseStaleEnabled: false } }]);
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.stale().title).toBe('Stale Tabs');
  });

  it('shows an unknown preference as unknown, not off, while loading', async () => {
    const ui = staleSetup({ getSettings: () => new Promise(() => {}), getStaleState: () => new Promise(() => {}) });
    await settle();
    expect(ui.$('stale-auto').indeterminate).toBe(true);
    expect(ui.stale().caption).toBe('Checking…');
  });

  it('offers a safe disable when the preference cannot be read at all', async () => {
    const ui = staleSetup({ getSettings: async () => { throw new Error('gone'); }, getStaleState: async () => ({ error: 'boom' }) });
    await settle();
    expect(ui.$('stale-auto').indeterminate).toBe(true);
    expect(ui.stale()).toMatchObject({ caption: 'Automatic cleanup status unavailable.', autoDisabled: false });
    expect(ui.stale().detail).toBe('Automatic cleanup status is unknown. You can still turn it off.');
    ui.press(ui.$('btn-stale'));
    // A click on a mixed checkbox checks it; the only change offered is off.
    ui.toggleAuto(true);
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { autoCloseStaleEnabled: false } }]);
    expect(ui.$('stale-auto').checked).toBe(false);
  });

  it('turns off at once during an unconfirmed enable, and the earlier enable cannot win', async () => {
    const replies = [deferred(), deferred()];
    let enabled = false;
    let call = 0;
    const ui = staleSetup({
      getStaleState: async () => staleState({ settings: { autoCloseStaleEnabled: enabled }, auto: { enabled, count: 2 } }),
      setStaleRule: async ({ settings }) => { const reply = replies[call++]; await reply.promise; enabled = settings.autoCloseStaleEnabled; return { message: 'Saved' }; },
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.toggleAuto(true);
    ui.toggleAuto(false);
    expect(ui.sent('setStaleRule').map(m => m.settings)).toEqual([{ autoCloseStaleEnabled: true }, { autoCloseStaleEnabled: false }]);
    expect(ui.$('stale-auto').checked).toBe(false);
    replies[0].resolve();
    await settle();
    expect(ui.$('stale-auto').checked).toBe(false);
    expect(ui.stale().title).toBe('Stale Tabs');
    replies[1].resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.sent('setStaleRule')).toHaveLength(2);
    expect(enabled).toBe(false);
    expect(ui.$('stale-auto').checked).toBe(false);
  });

  it('turns off during a manual close without waiting for it', async () => {
    const close = deferred();
    const ui = staleSetup({ getStaleState: async () => onState({ preview: { id: 'snap', count: 4 } }), closeStalePreview: () => close.promise });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    expect(ui.$('stale-auto').disabled).toBeFalsy();
    expect(ui.stale().autoDisabled).toBe(false);
    ui.toggleAuto(false);
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { autoCloseStaleEnabled: false } }]);
  });

  it('does not send a switch change before the window is known', async () => {
    const ui = staleSetup({ getSettings: enabledSettings }, { win: vi.fn(async () => { throw new Error('no window'); }) });
    await settle();
    ui.toggleAuto(false);
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([]);
  });

  it('a unit change keeps the same duration and saves nothing', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ preview: { count: 2 } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.$('stale-unit').value = 'hours';
    ui.$('stale-unit').dispatch('change');
    expect(ui.$('stale-value').value).toBe('168');
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([]);
    expect(ui.$('stale-value').value).toBe('168');
    expect(ui.$('stale-unit').value).toBe('hours');
    expect(ui.stale().closeDisabled).toBe(false);
  });

  it('a unit change that is not whole stays an invalid draft until the number changes', async () => {
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { staleThresholdMs: 36 * HOUR }, preview: { count: 2 } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    expect(ui.$('stale-value').value).toBe('36');
    ui.$('stale-unit').value = 'days';
    ui.$('stale-unit').dispatch('change');
    expect(ui.$('stale-value').value).toBe('1.5');
    expect(ui.$('stale-rule-error').hidden).toBe(false);
    expect(ui.stale().closeDisabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.$('stale-value').value).toBe('1.5');
    expect(ui.sent('setStaleRule')).toEqual([]);
    ui.edit('2');
    expect(ui.sent('setStaleRule')).toEqual([{ command: 'setStaleRule', windowId: 7, settings: { staleThresholdMs: 2 * DAY } }]);
  });

  it('a refresh never overwrites a value being typed', async () => {
    let saved = 7 * DAY;
    const ui = staleSetup({ getStaleState: async () => staleState({ settings: { staleThresholdMs: saved } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.$('stale-value').value = '1';
    ui.$('stale-value').dispatch('input');
    saved = 3 * DAY; // Settings changed it meanwhile
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.$('stale-value').value).toBe('1');
  });

  it('keeps a second edit made while the first save is pending', async () => {
    const first = deferred();
    let call = 0;
    const ui = staleSetup({ setStaleRule: () => (call++ ? Promise.resolve({ message: 'Saved' }) : first.promise) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.edit('9');
    ui.$('stale-value').value = '10';
    ui.$('stale-value').dispatch('input');
    first.resolve({ message: 'Saved' });
    await settle();
    expect(ui.$('stale-value').value).toBe('10');
    ui.$('stale-value').dispatch('change');
    expect(ui.sent('setStaleRule').map(m => m.settings)).toEqual([{ staleThresholdMs: 9 * DAY }, { staleThresholdMs: 10 * DAY }]);
  });

  it.each([['the controls', false], ['the review list', true]])('Escape restores a half-typed value before collapsing %s, and saves nothing', async (_, review) => {
    const ui = staleSetup();
    await settle();
    ui.press(ui.$('btn-stale'));
    if (review) ui.press(ui.$('stale-review'));
    ui.$('stale-value').focus();
    ui.$('stale-value').value = '1';
    ui.$('stale-value').dispatch('input');
    ui.key('Escape');
    expect(ui.$('stale-value').value).toBe('7');
    expect(ui.$('stale-rule-error').hidden).toBe(true);
    // Moving focus blurs the field, which fires change.
    ui.$('stale-value').dispatch('change');
    await settle();
    expect(ui.sent('setStaleRule')).toEqual([]);
  });

  it('shows a partial close result with its error and stays open', async () => {
    const ui = staleSetup({
      getStaleState: async () => staleState({ preview: { id: 'snap', count: 4 } }),
      closeStalePreview: async () => ({ message: 'Closed 2 tabs not viewed recently.', closed: 2, skipped: 2, failed: 0, error: 'The stale-tab rule changed.' }),
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    await settle();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.status()).toMatchObject({ tone: 'error', title: 'Closed 2 tabs not viewed recently.', detail: 'The stale-tab rule changed.', closable: true, spinner: false });
    expect(ui.main.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the status visible over a tall menu and lets the review list take keyboard focus', () => {
    expect(css).toMatch(/#status\.visible\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/);
    expect(html).toMatch(/id="stale-review-list"[^>]*tabindex="0"/);
    expect(html).not.toMatch(/id="stale-value"[^>]*\smax=/);
  });
});

describe('stale close recovery', () => {
  it('offers read-only review after a lost reply, never claims zero closures or repeats the close', async () => {
    let count = 4;
    const ui = staleSetup({
      getStaleState: async () => staleState({ preview: { id: `remaining-${count}`, count } }),
      closeStalePreview: async () => { count = 2; throw new Error('Reply lost'); },
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    await settle();
    expect(ui.status().detail).toContain('could not be confirmed');
    expect(ui.status().detail).not.toContain('No tabs were closed');
    expect(ui.$('status-review').hidden).toBe(false);
    const reads = ui.sent('getStaleState').length;
    ui.press(ui.$('status-review'));
    await settle();
    expect(ui.sent('getStaleState').length).toBeGreaterThan(reads);
    expect(ui.sent('closeStalePreview')).toHaveLength(1);
    expect(ui.$('stale-panel').hidden).toBe(false);
    expect(ui.$('stale-review-list').hidden).toBe(false);
    expect(ui.document.activeElement).toBe(ui.$('stale-review-list'));
    expect(ui.window.close).not.toHaveBeenCalled();
  });

  it('explains that a saved enabled preference still needs turning off when preview loading fails', async () => {
    const ui = staleSetup({
      getSettings: async () => ({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: true }),
      getStaleState: async () => { throw new Error('Unavailable'); },
    });
    await settle();
    expect(ui.$('stale-auto-detail').textContent).toContain('Auto-close is enabled');
    expect(ui.$('stale-auto-detail').textContent).toContain('turn it off');
  });
});

describe('stale recovery refresh coordination', () => {
  beforeEach(fakeClock);
  afterEach(() => vi.useRealTimers());

  it('does not let periodic refresh steal a pending recovery read', async () => {
    const recovered = deferred();
    let hold = false;
    const ui = staleSetup({
      getStaleState: () => hold ? recovered.promise : Promise.resolve(staleState({ preview: { count: 2 } })),
      closeStalePreview: async () => { throw new Error('Reply lost'); },
    });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-close'));
    await settle();
    hold = true;
    const reads = ui.sent('getStaleState').length;
    ui.press(ui.$('status-review'));
    await settle();
    await vi.advanceTimersByTimeAsync(5500);
    expect(ui.sent('getStaleState').length).toBe(reads + 1);
    recovered.resolve(staleState({ preview: { id: 'fresh', count: 1 } }));
    await settle();
    expect(ui.document.activeElement).toBe(ui.$('stale-review-list'));
    expect(ui.sent('closeStalePreview')).toHaveLength(1);
  });

  it('hides an outdated review list after a refresh failure and refuses reopening it', async () => {
    let fail = false;
    const ui = staleSetup({ getStaleState: async () => fail ? { error: 'Read failed' } : staleState({ preview: { count: 2 } }) });
    await settle();
    ui.press(ui.$('btn-stale'));
    ui.press(ui.$('stale-review'));
    expect(ui.$('stale-review-list').hidden).toBe(false);
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(ui.$('stale-review-list').hidden).toBe(true);
    ui.press(ui.$('stale-review'));
    expect(ui.$('stale-review-list').hidden).toBe(true);
    expect(ui.stale().closeDisabled).toBe(true);
  });
});
