import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startSearch } from '../src/search.js';

const html = readFileSync(new URL('../src/search.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../src/search.js', import.meta.url), 'utf8');

// Minimal DOM: enough for search.js, and it fails loudly if HTML parsing is used.
class El {
  constructor(tag, owner = null) {
    Object.assign(this, { tag, owner, id: '', className: '', hidden: false, value: '', children: [], parent: null, dataset: {} });
    this.attrs = new Map();
    this.listeners = {};
    this.text = '';
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = String(value); }
  set innerHTML(_) { throw new Error('innerHTML is forbidden'); }
  append(...nodes) {
    for (const node of nodes) {
      const moved = node.tag === '#fragment' ? node.children.splice(0) : [node];
      for (const child of moved) { child.parent = this; this.children.push(child); }
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = []; this.text = ''; this.append(...nodes);
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  // Supports the '[data-foo-bar]' selectors search.js uses.
  closest(selector) {
    const key = selector.slice(6, -1).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    let node = this;
    while (node && node.dataset[key] === undefined) node = node.parent;
    return node ?? null;
  }
  scrollIntoView() {}
  // Real focus tracking: the UI routes keys by document.activeElement.
  focus() {
    if (this.owner && this.owner.activeElement !== this) {
      this.owner.activeElement = this;
      this.dispatch('focus');
    }
  }
}

function setup({ top = false, search = '', noTabsApi = false, platform = 'Linux x86_64', platformInfo, closeResponse, initial } = {}) {
  const elements = new Map([...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => [id, Object.assign(new El('div'), { id })]));
  const document = Object.assign(new El('#document'), {
    activeElement: null,
    getElementById: id => elements.get(id) ?? null,
    createElement: tag => new El(tag, document),
    createDocumentFragment: () => new El('#fragment'),
  });
  for (const element of elements.values()) element.owner = document;
  const parent = { postMessage: vi.fn() };
  const window = Object.assign(new El('#window'), { location: { search }, navigator: { platform }, close: vi.fn(), postMessage: vi.fn(), setTimeout: (...args) => setTimeout(...args) });
  window.parent = top ? window : parent;
  const tabEvents = {};
  for (const name of ['onRemoved', 'onCreated', 'onAttached', 'onDetached', 'onUpdated']) {
    tabEvents[name] = { addListener: fn => { tabEvents[name].fn = fn; } };
  }
  const contexts = { good: initial ?? context() };
  const sendMessage = vi.fn(async msg => {
    if (msg.command === 'getSearchContext') return contexts[msg.token] ?? { error: 'Invalid search session' };
    if (msg.command === 'activateSearchTab' || msg.command === 'dismissSearch') return msg.token === 'good' ? { ok: true } : { error: 'no' };
    if (msg.command === 'closeSearchTabs') {
      if (msg.token !== 'good') return { error: 'Invalid search session' };
      const response = closeResponse ? await closeResponse(msg) : { ok: true, closedIds: msg.tabIds, skipped: [], failedIds: [] };
      // Simulates the backend: closed tabs disappear from later contexts.
      const gone = new Set(response?.closedIds ?? []);
      contexts.good = { ...contexts.good, tabs: contexts.good.tabs.filter(tab => !gone.has(tab.id)) };
      return response;
    }
  });
  const runtime = { sendMessage };
  if (platformInfo) runtime.getPlatformInfo = platformInfo;
  const browser = { runtime, tabs: noTabsApi ? undefined : tabEvents };
  startSearch({ document, window, browser });
  const $ = id => elements.get(id);
  const init = (token, source = parent) => window.dispatch('message', { source, data: { type: 'tabvacuum:init', token } });
  // Keys go to the focused element, as in a browser.
  const key = (k, extra = {}) => {
    const event = { key: k, target: document.activeElement ?? document, defaultPrevented: false, ...extra };
    const own = event.preventDefault;
    event.preventDefault = () => { event.defaultPrevented = true; own?.(); };
    document.dispatch('keydown', event);
    return event;
  };
  const keys = (...names) => { for (const name of names) key(name); };
  const rows = () => $('results').children;
  const option = i => rows()[i].children[0];
  const rowX = i => rows()[i].children[1].children[0];
  const focused = () => document.activeElement?.id;
  const type = text => { $('query').value = text; $('query').dispatch('input'); };
  const mode = () => $('palette').dataset.mode;
  // Clicks dispatch on the list, where the delegated handler lives.
  const click = target => $('results').dispatch('click', { target });
  return { $, window, parent, document, browser, sendMessage, tabEvents, contexts, init, key, keys, rows, option, rowX, focused, type, mode, click };
}

function context(overrides = {}) {
  return {
    windowId: 10, currentTabId: 1,
    tabs: [
      { id: 1, windowId: 10, title: 'Current', url: 'https://current.example', lastAccessed: 99 },
      { id: 2, windowId: 10, title: '<img src=x onerror=alert(1)>', url: 'https://www.evil.example/<b>', lastAccessed: 50 },
      { id: 3, windowId: 20, title: 'Roadmap', url: 'https://docs.example/plan', lastAccessed: 10 },
    ],
    ...overrides,
  };
}

const many = count => context({ tabs: Array.from({ length: count }, (_, i) => (
  { id: i + 1, windowId: 10, title: `Project ${i + 1}`, url: `https://p${i + 1}.example`, lastAccessed: 100 - i }
)), currentTabId: 999 });

const amazon = () => context({ currentTabId: 999, tabs: [
  ...Array.from({ length: 6 }, (_, i) => ({ id: 11 + i, windowId: 10, title: `Amazon ${i + 1}`, url: `https://amazon.example/${i + 1}`, lastAccessed: 90 - i })),
  { id: 30, windowId: 10, title: 'Weather', url: 'https://weather.example', lastAccessed: 95 },
  { id: 31, windowId: 10, title: 'Mail', url: 'https://mail.example', lastAccessed: 94 },
] });

const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const commands = sendMessage => sendMessage.mock.calls.map(([msg]) => msg);
const closes = ui => commands(ui.sendMessage).filter(msg => msg.command === 'closeSearchTabs');
const activations = ui => commands(ui.sendMessage).filter(msg => msg.command === 'activateSearchTab');
const ids = ui => ui.rows().map(row => Number(row.children[1].children[0].dataset.closeId));
const checkedIds = ui => ui.rows().filter(row => row.getAttribute('data-checked') === 'true').map(row => Number(row.children[1].children[0].dataset.closeId));
const activeId = ui => ids(ui)[ui.rows().findIndex(row => row.getAttribute('data-active') === 'true')];

async function ready(options) {
  const ui = setup(options);
  ui.init('good');
  await flush();
  return ui;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('search UI session handshake', () => {
  it('waits for a parent init message and sends only the token to the backend', async () => {
    const ui = setup();
    expect(ui.sendMessage).not.toHaveBeenCalled();
    expect(ui.$('message').textContent).toBe('Loading tabs…');
    ui.init('good', {}); // Not the direct parent.
    ui.window.dispatch('message', { source: ui.parent, data: { type: 'other', token: 'good' } });
    ui.window.dispatch('message', { source: ui.parent, data: 'tabvacuum:init' });
    await flush();
    expect(ui.sendMessage).not.toHaveBeenCalled();
    ui.init('good');
    await flush();
    expect(commands(ui.sendMessage)).toEqual([{ command: 'getSearchContext', token: 'good' }]);
    expect(ui.rows()).toHaveLength(3);
    expect(ui.parent.postMessage).not.toHaveBeenCalled();
    expect(ui.window.postMessage).not.toHaveBeenCalled();
  });

  it('retries after an invalid first token so the host page cannot win by posting first', async () => {
    const ui = setup();
    ui.init('forged');
    await flush();
    expect(ui.rows()).toHaveLength(0);
    expect(ui.$('message').dataset.state).toBe('loading');
    ui.init('good');
    await flush();
    expect(ui.rows()).toHaveLength(3);
  });

  it('never lets a late or slower candidate replace an accepted session', async () => {
    const ui = setup();
    let releaseSlow;
    ui.sendMessage.mockImplementationOnce(() => new Promise(resolve => { releaseSlow = resolve; }));
    ui.init('slow');
    ui.init('good');
    await flush();
    releaseSlow(context({ tabs: [] }));
    await flush();
    expect(ui.rows()).toHaveLength(3);
    const calls = ui.sendMessage.mock.calls.length;
    ui.init('late');
    await flush();
    expect(ui.sendMessage.mock.calls.length).toBe(calls); // Not even sent once a session exists.
    ui.key('Enter');
    await flush();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'activateSearchTab', token: 'good', tabId: 2 });
  });

  it('bounds init attempts and ignores malformed tokens', async () => {
    const ui = setup();
    ui.init(42); ui.init(''); ui.init('x'.repeat(513));
    for (let i = 0; i < 30; i++) ui.init(`bad-${i}`);
    await flush();
    expect(ui.sendMessage).toHaveBeenCalledTimes(16);
  });

  it('shows an accessible error if no valid init arrives, and still accepts a later one', async () => {
    const ui = setup();
    vi.advanceTimersByTime(5000);
    expect(ui.$('message').dataset.state).toBe('error');
    ui.init('good');
    await flush();
    expect(ui.$('message').hidden).toBe(true);
    expect(ui.rows()).toHaveLength(3);
  });

  it('reads the fallback window token from the URL and ignores posted messages', async () => {
    const ui = setup({ top: true, search: '?token=good' });
    ui.init('other', ui.window);
    await flush();
    expect(commands(ui.sendMessage)).toEqual([{ command: 'getSearchContext', token: 'good' }]);
    expect(ui.rows()).toHaveLength(3);
  });

  it('reports a missing or rejected fallback token', async () => {
    expect(setup({ top: true }).$('message').dataset.state).toBe('error');
    const ui = setup({ top: true, search: '?token=bad' });
    await flush();
    expect(ui.$('message').dataset.state).toBe('error');
  });
});

describe('search mode', () => {
  it('renders untrusted titles and URLs as literal text with context badges', async () => {
    const ui = await ready();
    const [first, second, third] = ui.rows();
    expect(first.textContent).toBe('E<img src=x onerror=alert(1)>https://www.evil.example/<b>');
    expect(second.textContent).toBe('DRoadmapOther windowhttps://docs.example/plan');
    expect(third.textContent).toContain('Current'); // Current tab listed last when the query is empty.
    expect(ui.rowX(0).getAttribute('aria-label')).toBe('Close tab: <img src=x onerror=alert(1)>');
    expect(ui.$('list-label').textContent).toBe('Recent tabs');
    expect(ui.$('result-count').textContent).toBe('3 tabs');
  });

  it('filters on input, labels matches, and explains URL-only matches', async () => {
    const ui = await ready();
    ui.type('docs');
    expect(ui.rows()).toHaveLength(1);
    expect(ui.rows()[0].textContent).toContain('URL match');
    expect(ui.$('list-label').textContent).toBe('Matches');
    ui.type('zzzz');
    expect(ui.$('message').textContent).toMatch(/No matching tabs/);
    expect(ui.$('message').hidden).toBe(false);
  });

  it('moves the highlight with arrows via aria-activedescendant and clamps at the ends', async () => {
    const ui = await ready();
    const query = ui.$('query');
    expect(query.getAttribute('aria-activedescendant')).toBe('option-0');
    ui.keys('ArrowDown', 'ArrowDown', 'ArrowDown');
    expect(query.getAttribute('aria-activedescendant')).toBe('option-2');
    expect(ui.option(2).getAttribute('aria-selected')).toBe('true');
    ui.key('ArrowUp');
    expect(query.getAttribute('aria-activedescendant')).toBe('option-1');
    ui.key('Enter');
    await flush();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'activateSearchTab', token: 'good', tabId: 3 });
    expect(ui.window.close).not.toHaveBeenCalled();
  });

  it('keeps keys inert while loading', async () => {
    const ui = setup();
    ui.keys('ArrowDown', 'Enter', 'x', 'Escape');
    await flush();
    expect(ui.sendMessage).not.toHaveBeenCalled();
    expect(ui.window.close).not.toHaveBeenCalled();
    expect(ui.mode()).toBe('search');
    expect(ui.$('message').textContent).toBe('Loading tabs…');
  });

  it('ignores Enter while an IME composition is active', async () => {
    const ui = await ready();
    ui.key('Enter', { isComposing: true });
    ui.$('query').dispatch('compositionstart');
    ui.key('Enter');
    await flush();
    expect(activations(ui)).toEqual([]);
  });

  it('types x, m, a and editing keys literally and never closes from the query', async () => {
    const ui = await ready();
    ui.type('road');
    for (const [k, extra] of [['x', {}], ['m', {}], ['a', {}], ['j', {}], ['a', { ctrlKey: true }], ['a', { metaKey: true }],
      [' ', {}], ['Backspace', {}], ['Delete', {}], ['w', { metaKey: true }]]) {
      expect(ui.key(k, extra).defaultPrevented).toBe(false);
    }
    await flush();
    expect(closes(ui)).toEqual([]);
    expect(ui.mode()).toBe('search');
    expect(ui.focused()).toBe('query');
  });

  it('dismisses through the backend command with the session token', async () => {
    const ui = await ready({ top: true, search: '?token=good' });
    ui.key('Escape');
    await flush();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'dismissSearch', token: 'good' });
    expect(ui.window.close).not.toHaveBeenCalled();
  });

  it('lets a fallback window close itself before it has a session', () => {
    const ui = setup({ top: true });
    ui.key('Escape');
    expect(ui.window.close).toHaveBeenCalled();
  });

  it('activates a clicked row', async () => {
    const ui = await ready();
    ui.click(ui.option(1).children[1]); // Click lands on inner text.
    await flush();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'activateSearchTab', token: 'good', tabId: 3 });
  });

  it('refreshes and keeps prior results when activation fails', async () => {
    const ui = await ready();
    ui.sendMessage.mockImplementationOnce(async () => ({ error: 'gone' }));
    ui.key('Enter');
    await flush();
    expect(ui.$('message').dataset.state).toBe('error');
    expect(ui.rows()).toHaveLength(3);
  });

  it('refreshes on tab events with the accepted token, preserving the highlight', async () => {
    const ui = await ready();
    ui.key('ArrowDown'); // Roadmap (id 3)
    ui.contexts.good = context({ tabs: [...context().tabs, { id: 4, windowId: 10, title: 'New', url: 'https://new.example', lastAccessed: 100 }] });
    ui.tabEvents.onCreated.fn();
    await flush();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'getSearchContext', token: 'good' });
    expect(ui.rows()).toHaveLength(4);
    expect(activeId(ui)).toBe(3);
    ui.tabEvents.onUpdated.fn(1, { status: 'loading' });
    await flush();
    expect(ui.sendMessage).toHaveBeenCalledTimes(2); // Status-only updates don't refresh.
  });
});

describe('row structure and accessibility', () => {
  it('exposes each row as a grid row with text and a separate close-action cell', async () => {
    const ui = await ready();
    const [wrapper] = ui.rows();
    expect(wrapper.getAttribute('role')).toBe('row');
    expect(wrapper.children[1].getAttribute('role')).toBe('gridcell');
    expect(ui.$('results').getAttribute('aria-rowcount')).toBe('3');
    expect(ui.option(0).id).toBe('option-0');
    expect(ui.option(0).getAttribute('role')).toBe('gridcell');
    const x = ui.rowX(1);
    expect(x.tag).toBe('button');
    expect(x.type).toBe('button');
    expect(x.id).toBe('row-close-1');
    expect(x.getAttribute('tabindex')).toBe('-1'); // One trap stop for the active row, not one per row.
    expect(x.getAttribute('aria-label')).toBe('Close tab: Roadmap');
    expect(x.children[0].getAttribute('aria-hidden')).toBe('true');
    expect(x.textContent).toBe('');
    expect(ui.$('results').getAttribute('aria-activedescendant')).toBe('option-0');
  });

  it('shows one hint group per mode, with Toggle Selection in select mode', async () => {
    const ui = await ready();
    const visible = () => ['search', 'tabs', 'select'].filter(name => !ui.$(`hints-${name}`).hidden);
    expect(visible()).toEqual(['search']);
    expect(ui.$('mode-indicator').hidden).toBe(true);
    ui.key('Tab');
    expect(visible()).toEqual(['tabs']);
    expect(ui.$('mode-indicator').textContent).toBe('Tab menu');
    expect(ui.$('results').getAttribute('aria-describedby')).toBe('tabs-help');
    expect(ui.$('announcement').textContent).toBe('Tab menu');
    ui.key('m');
    expect(visible()).toEqual(['select']);
    expect(ui.$('mode-indicator').textContent).toBe('Select multiple');
    expect(ui.$('results').getAttribute('aria-describedby')).toBe('select-help');
    expect(ui.$('results').getAttribute('aria-multiselectable')).toBe('true');
    expect(html).toMatch(/<kbd>Space<\/kbd> Toggle Selection</);
    expect(html).toMatch(/id="hints-tabs"[\s\S]*<kbd>X<\/kbd><kbd>Del<\/kbd> Close tab[\s\S]*<kbd>M<\/kbd> Select multiple/);
    expect(html).toMatch(/id="hints-select"[\s\S]*<kbd>A<\/kbd> Select all[\s\S]*<kbd>X<\/kbd><kbd>Del<\/kbd> Close selected[\s\S]*<kbd>M<\/kbd> Done/);
  });

  it('has no header single Close button; #close-tabs appears only in select mode', async () => {
    const ui = await ready();
    expect(html).not.toMatch(/>Close tab</);
    expect(ui.$('close-tabs').hidden).toBe(true);
    ui.key('Tab');
    expect(ui.$('close-tabs').hidden).toBe(true);
    ui.key('m');
    expect(ui.$('close-tabs').hidden).toBe(false);
    expect(ui.$('close-tabs').textContent).toBe('Close 0 tabs');
    expect(ui.$('close-tabs').getAttribute('aria-disabled')).toBe('true');
    ui.key(' ');
    expect(ui.$('close-tabs').textContent).toBe('Close 1 tab');
    expect(ui.$('close-tabs').getAttribute('aria-disabled')).toBe('false');
  });

  it('describes select-all with the platform chord', async () => {
    const linux = await ready();
    expect(linux.$('select-help').textContent).toMatch(/A, or Control A, selects all/);
    const mac = await ready({ platformInfo: async () => ({ os: 'mac' }) });
    expect(mac.$('select-help').textContent).toMatch(/A, or Command A, selects all/);
    const guessed = await ready({ platform: 'MacIntel', platformInfo: () => { throw new Error('unsupported'); } });
    expect(guessed.$('select-help').textContent).toMatch(/Command A/);
  });
});

describe('tab menu mode', () => {
  it('Tab enters the tab menu without checkboxes; Enter switches', async () => {
    const ui = await ready();
    ui.key('Tab');
    expect(ui.focused()).toBe('results');
    expect(ui.mode()).toBe('tabs');
    expect(ui.$('results').getAttribute('aria-multiselectable')).toBe('false');
    expect(ui.$('selection-status').textContent).toBe('');
    ui.key('j');
    expect(ui.option(1).getAttribute('aria-selected')).toBe('true');
    expect(ui.key('Enter').defaultPrevented).toBe(true);
    await flush();
    expect(activations(ui)).toEqual([{ command: 'activateSearchTab', token: 'good', tabId: 3 }]);
  });

  it('query amazon, Tab, j x j x j x closes every other tab and stays in the tab menu', async () => {
    const ui = await ready({ initial: amazon() });
    ui.type('amazon');
    ui.key('Tab');
    const order = ids(ui);
    expect(order).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      ui.key('j');
      ui.key('x');
      await settle();
      expect(ui.mode()).toBe('tabs');
      expect(ui.focused()).toBe('results');
    }
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[order[1]], [order[3]], [order[5]]]);
    expect(ids(ui)).toEqual([order[0], order[2], order[4]]);
    expect(activeId(ui)).toBe(order[4]);
    expect(activations(ui)).toEqual([]);
  });

  it('x, Delete, and Backspace close only the highlighted tab', async () => {
    const ui = await ready();
    ui.key('Tab');
    ui.key('x');
    await settle();
    ui.key('Delete');
    await settle();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[2], [3]]);
    ui.key('Backspace');
    await settle();
    expect(closes(ui).at(-1).tabIds).toEqual([1]);
  });

  it('keeps the tab menu and list focus when closing empties the list', async () => {
    const ui = await ready({ initial: context({ tabs: [context().tabs[1]] }) });
    ui.key('Tab'); ui.key('x');
    await settle();
    expect(ui.rows()).toHaveLength(0);
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
    expect(ui.$('message').textContent).toBe('Closed 1 tab.');
    ui.key('x'); await settle();
    expect(closes(ui)).toHaveLength(1);
  });

  it('keeps the highlight at the same index after closing, moving up from the end', async () => {
    const ui = await ready();
    ui.keys('Tab', 'j', 'x');
    await settle();
    expect(activeId(ui)).toBe(1); // Took index 1.
    ui.key('x');
    await settle();
    expect(ids(ui)).toEqual([2]);
    expect(activeId(ui)).toBe(2);
  });

  it('ignores browser modifiers and IME input', async () => {
    const ui = await ready();
    ui.key('Tab');
    ui.key('x', { isComposing: true });
    ui.key('Delete', { keyCode: 229 });
    expect(ui.key('Backspace', { metaKey: true }).defaultPrevented).toBe(false);
    expect(ui.key('w', { metaKey: true }).defaultPrevented).toBe(false);
    expect(ui.key('m', { ctrlKey: true }).defaultPrevented).toBe(false);
    ui.$('query').dispatch('compositionstart');
    ui.key('x');
    await flush();
    expect(closes(ui)).toEqual([]);
    expect(ui.mode()).toBe('tabs');
  });

  it('does not arm the replacement of a tab closed externally', async () => {
    const ui = await ready(); ui.key('Tab');
    ui.contexts.good = context({ tabs: context().tabs.filter(tab => tab.id !== 2) });
    ui.tabEvents.onRemoved.fn(2); await flush();
    ui.key('x'); await flush();
    expect(closes(ui)).toHaveLength(0);
    ui.key('ArrowDown'); ui.key('x'); await flush();
    expect(closes(ui)).toHaveLength(1);
  });
});

describe('select multiple mode', () => {
  it('query amazon, Tab, m, a, x closes every match; Delete works too', async () => {
    for (const closeKey of ['x', 'Delete']) {
      const ui = await ready({ initial: amazon() });
      ui.type('amazon');
      ui.keys('Tab', 'm', 'a');
      const order = ids(ui);
      expect(ui.$('selection-status').textContent).toBe('6 of 6 selected');
      expect(ui.$('close-tabs').textContent).toBe('Close 6 tabs');
      ui.key(closeKey);
      await settle();
      expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: order }]);
      expect(ui.rows()).toHaveLength(0);
      expect(ui.mode()).toBe('select');
      expect(ui.focused()).toBe('results');
      expect(ui.$('close-tabs').getAttribute('aria-disabled')).toBe('true');
      expect(ui.contexts.good.tabs.map(tab => tab.id)).toEqual([30, 31]);
    }
  });

  it('keeps the highlight distinct from checked state', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm');
    expect(ui.rows()[0].getAttribute('data-active')).toBe('true');
    expect(ui.option(0).getAttribute('aria-selected')).toBe('false');
    ui.key(' ');
    expect(ui.option(0).getAttribute('aria-selected')).toBe('true');
    ui.key('j');
    expect(ui.rows()[0].getAttribute('data-active')).toBe('false');
    expect(ui.option(0).getAttribute('aria-selected')).toBe('true');
    ui.key('Enter'); // Enter toggles in select mode; it never switches tabs.
    expect(checkedIds(ui)).toEqual([2, 3]);
    await flush();
    expect(activations(ui)).toEqual([]);
    expect(ui.$('selection-status').textContent).toBe('2 of 3 selected');
  });

  it('closes only checked tabs, never the highlight when nothing is checked', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', 'x', 'Delete', 'Backspace');
    ui.$('close-tabs').dispatch('click');
    await settle();
    expect(closes(ui)).toEqual([]);
    ui.keys(' ', 'j', 'j', ' ', 'k'); // Check 2 and 1; highlight ends on 3.
    ui.key('x');
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [2, 1] }]);
    expect(ids(ui)).toEqual([3]);
    expect(ui.mode()).toBe('select');
    ui.key('x'); await settle();
    expect(closes(ui)).toHaveLength(1);
  });

  it('a and the Ctrl+A alias select only currently listed tabs', async () => {
    const ui = await ready({ initial: many(14) });
    ui.keys('Tab', 'm');
    expect(ui.key('a').defaultPrevented).toBe(true);
    expect(checkedIds(ui)).toHaveLength(10); // Empty query: only the recent results.
    ui.key('Escape');
    expect(checkedIds(ui)).toEqual([]);
    ui.key('m');
    expect(ui.key('a', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(checkedIds(ui)).toHaveLength(10);
    ui.$('query').focus();
    ui.type('project');
    ui.keys('Tab', 'm', 'a');
    expect(ui.$('close-tabs').textContent).toBe('Close 14 tabs');
    ui.key('Delete');
    await flush();
    expect(closes(ui)[0].tabIds).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('uses Command+A as the alias on Mac and leaves Ctrl+A alone there', async () => {
    const ui = await ready({ platformInfo: async () => ({ os: 'mac' }) });
    ui.keys('Tab', 'm');
    expect(ui.key('a', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(checkedIds(ui)).toHaveLength(0);
    ui.key('a', { metaKey: true });
    expect(checkedIds(ui)).toHaveLength(3);
  });

  it('m and Done return to the tab menu with checks cleared', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', ' ');
    expect(ui.$('select-toggle').textContent).toBe('Done');
    ui.key('m');
    expect(ui.mode()).toBe('tabs');
    expect(checkedIds(ui)).toEqual([]);
    ui.keys('m', ' ');
    ui.$('select-toggle').dispatch('click');
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
    expect(checkedIds(ui)).toEqual([]);
    expect(ui.$('select-toggle').textContent).toBe('Select multiple');
  });

  it('Select multiple button enters select mode directly for pointer users', async () => {
    const ui = await ready();
    ui.$('select-toggle').dispatch('click');
    expect(ui.mode()).toBe('select');
    expect(ui.focused()).toBe('results');
    ui.click(ui.option(1).children[1]);
    await flush();
    expect(checkedIds(ui)).toEqual([3]);
    expect(activeId(ui)).toBe(3);
    expect(activations(ui)).toEqual([]);
  });

  it('Select multiple is inert with no tabs', async () => {
    const ui = await ready({ initial: context({ tabs: [] }) });
    expect(ui.$('select-toggle').getAttribute('aria-disabled')).toBe('true');
    ui.$('select-toggle').dispatch('click');
    expect(ui.mode()).toBe('search');
  });

  it('does not check tabs that arrive after select all, and prunes vanished ones', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', 'a');
    ui.contexts.good = context({ tabs: [...context().tabs.filter(tab => tab.id !== 3), { id: 4, windowId: 10, title: 'Fresh', url: 'https://fresh.example', lastAccessed: 100 }] });
    ui.tabEvents.onCreated.fn(); await flush();
    expect(ui.rows()).toHaveLength(3);
    expect(checkedIds(ui)).not.toContain(4);
    expect(ui.$('selection-status').textContent).toBe('2 of 3 selected');
    ui.key('x'); await flush();
    expect(closes(ui)[0].tabIds.sort()).toEqual([1, 2]);
  });

  it('shows partial results with skip reasons and keeps unclosed checks', async () => {
    const ui = await ready({ closeResponse: async () => ({ ok: true, closedIds: [2], skipped: [{ tabId: 3, reason: 'pinned' }], failedIds: [1] }) });
    ui.keys('Tab', 'm', 'a', 'x');
    await settle();
    expect(ui.$('message').dataset.state).toBe('notice');
    expect(ui.$('message').textContent).toBe('Closed 1 of 3 tabs. Skipped 1: Roadmap (pinned tab). 1 tab could not be closed.');
    expect(ui.$('selection-status').textContent).toBe('2 of 2 selected');
    expect(closes(ui)).toHaveLength(1); // Never retried automatically.
    ui.contexts.good = { ...ui.contexts.good, tabs: [...ui.contexts.good.tabs] };
    ui.tabEvents.onUpdated.fn(3, { title: 'x' }); await flush();
    expect(ui.$('message').hidden).toBe(false); // Sticky across refreshes.
  });

  it('reports a rejected close without retrying and keeps the selection', async () => {
    const ui = await ready({ closeResponse: async () => ({ error: 'Invalid search session' }) });
    ui.keys('Tab', 'm', ' ', 'x');
    await settle();
    expect(ui.$('message').textContent).toMatch(/Could not close tabs/);
    expect(closes(ui)).toHaveLength(1);
    expect(checkedIds(ui)).toEqual([2]);
    expect(ui.rows()).toHaveLength(3);
  });
});

describe('row close button', () => {
  it('closes only its row from a nested icon click, even with other rows checked', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', ' ', 'j', 'j', ' '); // Check 2 and 1.
    ui.click(ui.rowX(1).children[0]);
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [3] }]);
    expect(activations(ui)).toEqual([]);
    expect(checkedIds(ui)).toEqual([2, 1]);
    expect(ui.mode()).toBe('select');
    expect(ui.focused()).toBe('results');
  });

  it('keeps query focus and search mode when clicked while searching', async () => {
    const ui = await ready();
    ui.type('o');
    const target = ids(ui)[0];
    ui.click(ui.rowX(0));
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [target] }]);
    expect(ui.focused()).toBe('query');
    expect(ui.mode()).toBe('search');
    expect(activations(ui)).toEqual([]);
  });

  it('bypasses the external-close guard because the clicked target is explicit', async () => {
    const ui = await ready(); ui.key('Tab');
    ui.contexts.good = context({ tabs: context().tabs.filter(tab => tab.id !== 2) });
    ui.tabEvents.onRemoved.fn(2); await flush();
    ui.click(ui.rowX(0));
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [3] }]);
  });

  it('keyboard: native Enter on the focused X, then focus returns to the surviving row X', async () => {
    const ui = await ready();
    ui.keys('Tab', 'j', 'Tab');
    expect(ui.focused()).toBe('row-close-1');
    const before = ui.document.activeElement;
    const enter = ui.key('Enter');
    expect(enter.defaultPrevented).toBe(false); // Native button activation.
    expect(ui.key('Enter', { repeat: true }).defaultPrevented).toBe(true);
    expect(ui.key(' ', { repeat: true }).defaultPrevented).toBe(true);
    await flush();
    expect(activations(ui)).toEqual([]);
    ui.click(before); // What the browser fires for Enter on a button.
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [3] }]);
    expect(ui.focused()).toBe('row-close-1');
    expect(ui.document.activeElement).toBe(ui.rowX(1));
    expect(ui.document.activeElement).not.toBe(before);
    expect(ui.mode()).toBe('tabs');
  });

  it('falls back to the list when the last row closes from its focused X', async () => {
    const ui = await ready({ initial: context({ tabs: [context().tabs[1]] }) });
    ui.keys('Tab', 'Tab');
    expect(ui.focused()).toBe('row-close-0');
    ui.click(ui.rowX(0));
    await settle();
    expect(ui.focused()).toBe('results');
    expect(ui.mode()).toBe('tabs');
  });
});

describe('focus and mode transitions', () => {
  it('Escape steps select → tabs → search → dismiss', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', ' ');
    ui.key('Escape');
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
    expect(checkedIds(ui)).toEqual([]);
    ui.key('Escape', { repeat: true }); // A held Escape does not keep stepping.
    expect(ui.mode()).toBe('tabs');
    ui.key('Escape');
    expect(ui.mode()).toBe('search');
    expect(ui.focused()).toBe('query');
    expect(ui.parent.postMessage).not.toHaveBeenCalled();
    ui.key('Escape');
    expect(ui.parent.postMessage).toHaveBeenCalledWith({ type: 'tabvacuum:escape' }, '*');
  });

  it('traps Tab through query, list, active row X, and buttons', async () => {
    const ui = await ready();
    const walk = (count, shiftKey = false) => Array.from({ length: count }, () => {
      expect(ui.key('Tab', { shiftKey }).defaultPrevented).toBe(true);
      return ui.focused();
    });
    expect(walk(5)).toEqual(['results', 'row-close-0', 'select-toggle', 'query', 'results']);
    expect(walk(4, true)).toEqual(['query', 'select-toggle', 'row-close-0', 'results']);
    ui.keys('m', 'j');
    expect(walk(5)).toEqual(['row-close-1', 'select-toggle', 'close-tabs', 'query', 'results']);
    expect(ui.mode()).toBe('tabs'); // Passing through the query cleared select mode.
    expect(commands(ui.sendMessage)).toHaveLength(1);
  });

  it('Tab without rows skips the list and row X', async () => {
    const ui = await ready({ initial: context({ tabs: [] }) });
    const order = [];
    for (let i = 0; i < 3; i++) { ui.key('Tab'); order.push(ui.focused()); }
    expect(order).toEqual(['select-toggle', 'query', 'select-toggle']);
    expect(ui.mode()).toBe('search');
  });

  it('focusing the query returns to search and clears checks', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', ' ', 'j', ' ');
    ui.$('query').focus();
    expect(ui.mode()).toBe('search');
    expect(checkedIds(ui)).toEqual([]);
    expect(ui.$('hints-search').hidden).toBe(false);
    expect(ui.$('selection-status').textContent).toBe('');
    expect(ui.option(1).getAttribute('aria-selected')).toBe('true'); // Follows the highlight again.
    expect(ui.option(0).getAttribute('aria-selected')).toBe('false');
  });

  it('window focus restores lost focus but never steals it from a button', async () => {
    const ui = await ready();
    ui.key('Tab');
    ui.$('select-toggle').focus();
    ui.window.dispatch('focus');
    expect(ui.focused()).toBe('select-toggle');
    ui.document.activeElement = null;
    ui.window.dispatch('focus');
    expect(ui.focused()).toBe('results');
  });

  it('prevents held Enter or Space from repeating on header buttons', async () => {
    const ui = await ready();
    ui.keys('Tab', 'm', ' ');
    ui.$('close-tabs').focus();
    expect(ui.key('Enter', { repeat: true }).defaultPrevented).toBe(true);
    expect(ui.key(' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(ui.key('Enter').defaultPrevented).toBe(false);
    ui.$('select-toggle').focus();
    expect(ui.key(' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(closes(ui)).toEqual([]);
  });

  it('ignores repeated x, m, a, and Space', async () => {
    const ui = await ready();
    ui.key('Tab');
    ui.key('x', { repeat: true });
    ui.key('m', { repeat: true });
    expect(ui.mode()).toBe('tabs');
    ui.key('m');
    ui.key('a', { repeat: true });
    ui.key(' ', { repeat: true });
    expect(checkedIds(ui)).toEqual([]);
    ui.key('j', { repeat: true }); // Movement may repeat.
    expect(activeId(ui)).toBe(3);
    await flush();
    expect(closes(ui)).toEqual([]);
  });
});

describe('closing refresh safety', () => {
  it('keeps closing locked through refresh and replays fast j/x keys in order', async () => {
    const ui = await ready({ initial: amazon() });
    ui.type('amazon');
    const before = ids(ui);
    const original = ui.sendMessage.getMockImplementation();
    let releaseClose;
    let releaseRefresh;
    let firstClose = true, firstRefresh = true;
    ui.sendMessage.mockImplementation(msg => {
      if (msg.command === 'closeSearchTabs' && firstClose) {
        firstClose = false;
        return new Promise(resolve => { releaseClose = () => resolve(original(msg)); });
      }
      if (msg.command === 'getSearchContext' && firstRefresh) {
        firstRefresh = false;
        return new Promise(resolve => { releaseRefresh = () => resolve(ui.contexts.good); });
      }
      return original(msg);
    });
    ui.keys('Tab', 'j', 'x', 'j', 'x', 'j', 'x');
    await flush();
    expect(activeId(ui)).toBe(before[1]);
    expect(closes(ui)).toHaveLength(1);
    const calls = ui.sendMessage.mock.calls.length;
    ui.tabEvents.onRemoved.fn(before[1]); await flush();
    expect(ui.sendMessage.mock.calls.length).toBe(calls);
    releaseClose(); await settle();
    expect(closes(ui)).toHaveLength(1);
    expect(ui.rowX(0).getAttribute('aria-disabled')).toBe('true');
    releaseRefresh();
    for (let i = 0; i < 8; i++) await flush();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[before[1]], [before[3]], [before[5]]]);
    expect(ids(ui)).toEqual([before[0], before[2], before[4]]);
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
  });

  it('removes known closed rows and reports failed refresh instead of hiding the error', async () => {
    const ui = await ready();
    const original = ui.sendMessage.getMockImplementation();
    ui.sendMessage.mockImplementation(msg => msg.command === 'getSearchContext'
      ? Promise.reject(new Error('refresh failed')) : original(msg));
    ui.keys('Tab', 'x'); await settle();
    expect(ui.rows()).toHaveLength(2);
    expect(ui.$('message').hidden).toBe(false);
    expect(ui.$('message').textContent).toContain('Closed 1 tab.');
    expect(ui.$('message').textContent).toContain('list may be out of date');
    expect(ui.mode()).toBe('tabs');
    expect(closes(ui)).toHaveLength(1);
  });
});

describe('search UI static contract', () => {
  it('declares dialog, combobox, grid, and help semantics', () => {
    expect(html).toMatch(/role="dialog"[^>]*aria-labelledby="dialog-title"/);
    expect(html).toMatch(/role="combobox"[^>]*aria-controls="results"/);
    expect(html).toMatch(/id="query"[^>]*aria-describedby="query-help"/);
    expect(html).toMatch(/id="results" role="grid"[^>]*aria-describedby="tabs-help"/);
    expect(html).toContain('aria-haspopup="grid"');
    expect(html).toMatch(/id="selection-status" role="status" aria-live="polite"/);
    expect(html).toMatch(/<button id="select-toggle"[^>]*type="button"/);
    expect(html).toMatch(/<button id="close-tabs"[^>]*type="button" hidden/);
    expect(html).toMatch(/<footer id="help" aria-hidden="true">/);
  });
  it('loads no network resources and uses no unsafe DOM or cross-window APIs', () => {
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|console\.|fetch\(|localStorage|runtime\.onMessage/);
    expect(js.match(/\.postMessage\(/g)).toHaveLength(1);
    expect(js).toContain("window.parent.postMessage({ type: 'tabvacuum:escape' }, '*')");
  });
});

describe('embedded browser regressions', () => {
  it('does not subscribe to tab events until authorization succeeds', async () => {
    const ui = setup();
    expect(ui.tabEvents.onUpdated.fn).toBeUndefined();
    ui.init('bad'); await flush();
    expect(ui.tabEvents.onUpdated.fn).toBeUndefined();
    ui.init('good'); await flush();
    expect(ui.tabEvents.onUpdated.fn).toBeTypeOf('function');
  });

  it('Escape before authentication sends only a data-free close signal', () => {
    const ui = setup();
    ui.key('Escape');
    expect(ui.parent.postMessage).toHaveBeenCalledWith({ type: 'tabvacuum:escape' }, '*');
    expect(ui.sendMessage).not.toHaveBeenCalled();
  });

  it('refreshes authorized Firefox frames without browser.tabs and skips hidden frames', async () => {
    const ui = setup({ noTabsApi: true });
    ui.init('good'); await flush();
    ui.contexts.good = context({ tabs: [context().tabs[0]] });
    vi.advanceTimersByTime(1000); await flush();
    expect(ui.rows()).toHaveLength(1);
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'getSearchContext', token: 'good' });
    ui.sendMessage.mockClear();
    ui.document.visibilityState = 'hidden';
    vi.advanceTimersByTime(1000); await flush();
    expect(ui.sendMessage).not.toHaveBeenCalled();
  });

  it('does not rebuild unchanged rows on periodic refresh', async () => {
    const ui = setup({ noTabsApi: true });
    ui.init('good'); await flush();
    ui.type('roadmap');
    const filteredRow = ui.rows()[0];
    const scroll = vi.spyOn(filteredRow, 'scrollIntoView');
    vi.advanceTimersByTime(1000); await flush();
    expect(ui.rows()[0]).toBe(filteredRow);
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('local tab identity tiles', () => {
  it('uses a decorative page icon for numeric hosts or missing labels, never a dot or remote image', async () => {
    const ui = await ready({ initial: context({ tabs: [
      { id: 1, windowId: 10, title: '', url: 'http://127.0.0.1:1234/' },
      { id: 2, windowId: 10, title: 'Notes', url: 'https://www.example.org' },
      { id: 3, windowId: 10, title: '', url: '' },
    ] }) });
    const tiles = ui.rows().map((_, i) => ui.option(i).children[0]);
    expect(tiles.filter(tile => tile.className === 'tile tile-fallback')).toHaveLength(2);
    expect(tiles.filter(tile => tile.className === 'tile tile-fallback').every(tile => tile.textContent === '')).toBe(true);
    expect(tiles.find(tile => tile.className === 'tile').textContent).toBe('E');
    expect(tiles.every(tile => tile.tag === 'span' && tile.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});

describe('three-mode async and focus safeguards', () => {
  it('cancels queued list actions when Escape changes mode', async () => {
    let release;
    const ui = await ready({ closeResponse: msg => new Promise(resolve => { release = () => resolve({ ok: true, closedIds: msg.tabIds, skipped: [], failedIds: [] }); }) });
    ui.keys('Tab', 'x', 'j', 'x', 'Escape');
    release(); await settle();
    expect(closes(ui)).toHaveLength(1);
    expect(ui.mode()).toBe('search');
  });

  it('cancels queued closes after a protected-tab skip rather than changing targets', async () => {
    let release;
    const ui = await ready({ closeResponse: msg => new Promise(resolve => { release = () => resolve({ ok: true, closedIds: [], skipped: [{ tabId: msg.tabIds[0], reason: 'pinned' }], failedIds: [] }); }) });
    ui.keys('Tab', 'x', 'j', 'x');
    release(); await settle();
    expect(closes(ui)).toHaveLength(1);
    expect(ui.$('message').textContent).toContain('pinned tab');
  });

  it('does not move focus onto a different row X when a tab closes externally', async () => {
    const ui = await ready();
    ui.keys('Tab', 'Tab');
    expect(ui.focused()).toBe('row-close-0');
    ui.contexts.good = context({ tabs: context().tabs.filter(tab => tab.id !== 2) });
    ui.tabEvents.onRemoved.fn(2); await flush();
    expect(ui.focused()).toBe('results');
    ui.key(' '); await flush();
    expect(closes(ui)).toHaveLength(0);
  });

  it('keeps focused row X attached to the same tab through external reordering', async () => {
    const ui = await ready();
    ui.keys('Tab', 'Tab');
    const target = Number(ui.rowX(0).dataset.closeId);
    ui.contexts.good = context({ tabs: context().tabs.map(tab => ({ ...tab, lastAccessed: tab.id === 3 ? 999 : 1 })) });
    ui.tabEvents.onCreated.fn(); await flush();
    expect(Number(ui.document.activeElement.dataset.closeId)).toBe(target);
  });

  it('lets the IME own Tab while composing and recovers on blur', async () => {
    const ui = await ready();
    ui.$('query').dispatch('compositionstart');
    expect(ui.key('Tab').defaultPrevented).toBe(false);
    expect(ui.mode()).toBe('search');
    ui.$('query').dispatch('blur');
    ui.key('Tab');
    expect(ui.mode()).toBe('tabs');
  });
});