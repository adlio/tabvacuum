import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { startPopup } from '../src/popup.js';

const html = readFileSync(new URL('../src/popup.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/popup.css', import.meta.url), 'utf8');

// Minimal DOM built from the real popup markup.
class El {
  constructor(tag, owner) {
    Object.assign(this, { tag, owner, id: '', hidden: false, parent: null, dataset: {}, text: '', listeners: {} });
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
  dispatch(type, target = this) {
    for (const fn of this.listeners[type] ?? []) fn({ target, currentTarget: this, preventDefault() {} });
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

function setup(reply) {
  const document = { activeElement: null, all: [] };
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
    if (!/^(meta|link|path|circle|rect)$/.test(tag) && !attrs.endsWith('/')) stack.push(node);
  }
  document.body = document.all.find(node => node.tag === 'body');
  document.activeElement = document.body;
  document.getElementById = id => byId.get(id) ?? null;
  document.querySelector = selector => document.all.find(node => node.tag === selector) ?? null;

  const window = new El('#window', document);
  window.close = vi.fn();
  const sendMessage = vi.fn(reply);
  startPopup({ document, window, browser: { runtime: { sendMessage } } });

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
  ['btn-stale', 'closeStaleTabs', 'Closing stale tabs...'],
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
      ui.press(ui.$('btn-stale'));
      await vi.runAllTimersAsync();
      vi.advanceTimersByTime(10_000);

      expect(ui.window.close).not.toHaveBeenCalled();
      expect(ui.status()).toMatchObject({
        visible: true, tone: 'error', spinner: false, closable: true,
        title: 'Could not close stale tabs: Tabs API unavailable',
        detail: 'Try again, or close this menu.',
      });
      expect(ui.main.getAttribute('aria-busy')).toBeNull();
      expect(ui.actionButtons().some(button => button.getAttribute('aria-disabled'))).toBe(false);
      expect(ui.document.activeElement).toBe(ui.$('btn-stale'));

      // Retrying works once the error is shown.
      ui.press(ui.$('btn-stale'));
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
