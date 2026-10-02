import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startSearch } from '../src/search.js';

// No module mocks: every test runs the real composeSearchResults.

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
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  // Real focus tracking: the UI routes keys by document.activeElement.
  focus() {
    if (this.owner && this.owner.activeElement !== this) {
      this.owner.activeElement = this;
      this.dispatch('focus');
    }
  }
}

function setup({ top = false, search = '', noTabsApi = false, platform = 'Linux x86_64', platformInfo, closeResponse, initial, sources, bundle = true, handoff } = {}) {
  const elements = new Map([...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => [id, Object.assign(new El('div'), { id })]));
  // Record static nesting (parent links only) so containment checks see the real structure.
  const stack = [];
  for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (close) { stack.pop(); continue; }
    const node = elements.get(attrs.match(/\sid="([^"]+)"/)?.[1]) ?? new El(tag);
    node.parent = stack.at(-1) ?? null;
    if (!/^(input|meta|link|br|img|path|circle)$/.test(tag) && !attrs.endsWith('/')) stack.push(node);
  }
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
    if (msg.command === 'querySearchSources') return sources ? sources(msg) : { error: 'unexpected' };
    if (['activateHistoryResult', 'openSearchPermissions'].includes(msg.command)) return msg.token === 'good' ? { ok: true } : { error: 'no' };
    if (msg.command === 'activateSearchTab' || msg.command === 'dismissSearch') return msg.token === 'good' ? { ok: true } : { error: 'no' };
    if (msg.command === 'closeSearchTabs') {
      if (msg.token !== 'good') return { error: 'Invalid search session' };
      const response = closeResponse ? await closeResponse(msg) : { ok: true, closedIds: msg.tabIds, skipped: [], failedIds: [] };
      // Simulates the backend: closed tabs disappear from later contexts.
      const gone = new Set(response?.closedIds ?? []);
      contexts.good = { ...contexts.good, tabs: contexts.good.tabs.filter(tab => !gone.has(tab.id)) };
      // Like the backend, a successful close carries the fresh list.
      return bundle && response?.ok === true && !response.handedOff ? { ...response, context: contexts.good } : response;
    }
    if (msg.command === 'searchHandoffReady') return handoff ? handoff(msg) : { error: 'unexpected' };
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
  // Rows live inside labelled row groups; headings are not rows.
  const rows = () => $('results').children.flatMap(group => group.children.filter(child => child.getAttribute('role') === 'row'));
  const option = i => rows()[i].children[0];
  const rowX = i => rows()[i].children[1].children[0];
  // Sources are chosen through the Search in menu: open it, toggle, close it again.
  const toggleSource = (id, on) => {
    $('search-in').dispatch('click');
    $(id).checked = on;
    $(id).dispatch('change');
    $('search-in').dispatch('click');
  };
  const focused = () => document.activeElement?.id;
  const type = text => { $('query').value = text; $('query').dispatch('input'); };
  const mode = () => $('palette').dataset.mode;
  // Clicks dispatch on the list, where the delegated handler lives.
  const click = target => $('results').dispatch('click', { target });
  return { $, window, parent, document, browser, sendMessage, tabEvents, contexts, init, key, keys, rows, option, rowX, toggleSource, focused, type, mode, click };
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
const ids = ui => ui.rows().map(row => row.children[1].children[0] ? Number(row.children[1].children[0].dataset.closeId) : row.children[0].children[1].children[1].textContent);
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
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [2, 1], state: {
      query: '', mode: 'select', sources: { history: false, content: false }, highlight: 'tab:3', checked: [2, 1], focus: 'list',
    } }]);
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
    expect(walk(5)).toEqual(['results', 'row-close-0', 'select-toggle', 'search-in', 'query']);
    expect(walk(4, true)).toEqual(['search-in', 'select-toggle', 'row-close-0', 'results']);
    ui.keys('m', 'j');
    expect(walk(6)).toEqual(['row-close-1', 'select-toggle', 'close-tabs', 'search-in', 'query', 'results']);
    expect(ui.mode()).toBe('tabs'); // Passing through the query cleared select mode.
    expect(commands(ui.sendMessage)).toHaveLength(1);
  });

  it('Tab without rows skips the list and row X', async () => {
    const ui = await ready({ initial: context({ tabs: [] }) });
    const order = [];
    for (let i = 0; i < 3; i++) { ui.key('Tab'); order.push(ui.focused()); }
    expect(order).toEqual(['select-toggle', 'search-in', 'query']);
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
    const ui = await ready({ initial: amazon(), bundle: false });
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
    const ui = await ready({ bundle: false });
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
    expect(html).toMatch(/<button id="search-in"[^>]*type="button" aria-expanded="false" aria-controls="source-menu"/);
    expect(html).toMatch(/id="source-menu"[^>]*hidden/);
    expect(html).not.toMatch(/source-chip/);
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

describe('release input regressions', () => {
  it('never replays a close key pressed during a failed activation', async () => {
    const ui = await ready();
    const original = ui.sendMessage.getMockImplementation();
    let rejectActivation;
    ui.sendMessage.mockImplementation(msg => msg.command === 'activateSearchTab'
      ? new Promise((_, reject) => { rejectActivation = reject; }) : original(msg));
    ui.keys('Tab', 'Enter', 'x');
    rejectActivation(new Error('Tab switch failed')); await settle();
    expect(closes(ui)).toHaveLength(0);
    ui.keys('j', 'x'); await settle();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[3]]);
  });

  it.each(['mac', 'linux'])('Select All in the %s tab menu neither checks tabs nor selects page text', async os => {
    const ui = await ready({ platformInfo: async () => ({ os }) });
    ui.key('Tab');
    const modifiers = os === 'mac' ? { metaKey: true } : { ctrlKey: true };
    expect(ui.key('a', modifiers).defaultPrevented).toBe(true);
    expect(checkedIds(ui)).toEqual([]);
    ui.key('m');
    expect(ui.key('a', modifiers).defaultPrevented).toBe(true);
    expect(checkedIds(ui)).toHaveLength(3);
    ui.$('query').focus();
    expect(ui.key('a', modifiers).defaultPrevented).toBe(false);
  });
});
describe('mixed-source search (0.5.0)', () => {
  const sourceCalls = ui => commands(ui.sendMessage).filter(msg => msg.command === 'querySearchSources');
  const hist = (url, title = 'Old page') => ({ url, title, lastVisitTime: 5 });
  const reply = ({ history = [], content = [], content: _c, ...rest } = {}) => msg => ({
    history: msg.sources.history ? history : [],
    content: msg.sources.content ? content : [],
    coverage: {
      history: msg.sources.history ? { state: 'ready', limited: false } : { state: 'off' },
      content: msg.sources.content ? { state: 'ready', searched: 2, total: 3, skipped: 0, truncated: 0 } : { state: 'off' },
      ...rest.coverage,
    },
    incognito: false,
  });
  const archive = [hist('https://docs.example/plan', 'Duplicate of open tab'), hist('https://old.example/r', 'Roadmap archive'), hist('https://old.example/r', 'Roadmap archive')];
  const withHistory = async (options = {}) => {
    const ui = await ready({ sources: reply({ history: archive }), ...options });
    ui.toggleSource('source-history', true);
    ui.type('road');
    vi.advanceTimersByTime(250); await settle();
    return ui;
  };

  it('starts with only open tabs, sends nothing until an extra is chosen, then debounces', async () => {
    const ui = await ready({ sources: reply({ history: archive }) });
    expect(ui.$('source-history').checked).toBe(false);
    expect(ui.$('source-content').checked).toBe(false);
    expect(ui.$('palette').dataset.sources).toBe('tabs');
    ui.type('road'); vi.advanceTimersByTime(1000); await settle();
    expect(sourceCalls(ui)).toHaveLength(0);
    ui.toggleSource('source-history', true);
    vi.advanceTimersByTime(0); await settle();
    expect(sourceCalls(ui)).toEqual([{ command: 'querySearchSources', token: 'good', query: 'road', sources: { history: true, content: false } }]);
    expect(ui.$('palette').dataset.sources).toBe('tabs history');
    ui.type('roa'); ui.type('road map');
    expect(ids(ui)).toEqual([3]); // Open-tab matches never wait for sources.
    expect(ui.$('source-status').textContent).toBe('Searching history…');
    vi.advanceTimersByTime(249); await settle();
    expect(sourceCalls(ui)).toHaveLength(1);
    vi.advanceTimersByTime(1); await settle();
    expect(sourceCalls(ui).map(msg => msg.query)).toEqual(['road', 'road map']);
    expect(ui.$('query').value).toBe('road map');
  });

  it('lists open tabs first, then a labelled, deduplicated History group without close buttons', async () => {
    const ui = await withHistory();
    expect(ids(ui)).toEqual([3, 'https://old.example/r']);
    const groups = ui.$('results').children;
    expect(groups.map(g => [g.getAttribute('role'), g.getAttribute('aria-label')])).toEqual([['rowgroup', 'Open tabs'], ['rowgroup', 'History']]);
    expect(groups.map(g => [g.children[0].textContent, g.children[0].getAttribute('aria-hidden'), g.children[0].hidden])).toEqual([['Open tabs', 'true', false], ['History', 'true', false]]);
    expect(ui.$('results').getAttribute('aria-rowcount')).toBe('2');
    expect(ui.$('result-count').textContent).toBe('1 tab · 1 history');
    const history = ui.rows()[1];
    expect(history.textContent).toBe('ORoadmap archiveHistoryhttps://old.example/r');
    expect(history.getAttribute('aria-rowindex')).toBe('2');
    expect(history.children[1].getAttribute('role')).toBe('gridcell');
    expect(history.children[1].children).toHaveLength(0);
    expect(ui.$('enter-search').textContent).toBe('Switch');
    ui.key('ArrowDown');
    expect(ui.$('query').getAttribute('aria-activedescendant')).toBe('option-1');
    expect(ui.$('enter-search').textContent).toBe('Open page');
    ui.key('Enter'); await settle();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'activateHistoryResult', token: 'good', url: 'https://old.example/r' });
  });

  it('opens a clicked history row and never offers it for closing or selection', async () => {
    const ui = await withHistory();
    ui.keys('Tab', 'j');
    expect(ui.$('enter-tabs').textContent).toBe('Open page');
    ui.keys('x', 'Delete', 'Backspace'); await settle();
    expect(closes(ui)).toHaveLength(0);
    expect(ui.rows()).toHaveLength(2);
    ui.key('m');
    expect(ids(ui)).toEqual([3]);
    expect(ui.$('selection-status').textContent).toBe('0 of 1 selected · Only open tabs can be selected');
    ui.key('a');
    expect(ui.$('close-tabs').textContent).toBe('Close 1 tab');
    ui.key('Escape');
    expect(ids(ui)).toEqual([3, 'https://old.example/r']);
    ui.click(ui.option(1).children[1]); await settle();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'activateHistoryResult', token: 'good', url: 'https://old.example/r' });
    expect(closes(ui)).toHaveLength(0);
  });

  it('discards stale responses and keeps the highlighted item as results arrive', async () => {
    const pending = [];
    const ui = await ready({ sources: msg => new Promise(resolve => pending.push({ msg, resolve })) });
    ui.toggleSource('source-history', true);
    ui.type('e'); vi.advanceTimersByTime(250); await settle();
    ui.type('ex'); vi.advanceTimersByTime(250); await settle();
    // The superseded scan is told to stop while the next query waits out its debounce.
    expect(pending.map(p => p.msg.query)).toEqual(['e', '', 'ex']);
    const [first, , second] = pending;
    first.resolve(reply({ history: [hist('https://stale.example')] })(first.msg)); await settle();
    expect(ids(ui)).not.toContain('https://stale.example');
    ui.key('ArrowDown');
    const before = activeId(ui);
    second.resolve(reply({ history: [hist('https://a.example/x', 'A example')] })(second.msg)); await settle();
    expect(ids(ui).at(-1)).toBe('https://a.example/x');
    expect(activeId(ui)).toBe(before);
  });

  const held = options => {
    const pending = [];
    const sources = msg => new Promise(resolve => pending.push({ msg, resolve }));
    return { pending, options: { sources, ...options } };
  };
  const cancel = { command: 'querySearchSources', token: 'good', query: '', sources: { history: false, content: false } };
  // Content matches carry the URL the tab had when it was read.
  const urls = new Map([...context().tabs, ...amazon().tabs].map(tab => [tab.id, tab.url]));
  const planContent = tabIds => tabIds.map(tabId => ({ tabId, url: urls.get(tabId), snippet: `plan amazon ${tabId}` }));

  it('does not arm a different row when a late source drops a content-only highlight', async () => {
    const { pending, options } = held({ initial: context({ contentPermission: true }) });
    const ui = await ready(options);
    ui.toggleSource('source-content', true);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    pending[0].resolve(reply({ content: planContent([1, 2]) })(pending[0].msg)); await settle();
    expect(ids(ui)).toEqual([3, 1, 2]);
    ui.keys('Tab', 'j');
    expect(activeId(ui)).toBe(1); // Listed only for its contents.
    // An unrelated tab opens; the fresh content scan no longer matches tab 1.
    ui.contexts.good = context({ contentPermission: true, tabs: [...context().tabs, { id: 4, windowId: 10, title: 'Weather', url: 'https://weather.example', lastAccessed: 1 }] });
    ui.tabEvents.onCreated.fn(); await settle();
    vi.advanceTimersByTime(250); await settle();
    pending.at(-1).resolve(reply({ content: planContent([2]) })(pending.at(-1).msg)); await settle();
    expect(ids(ui)).toEqual([3, 2]);
    expect(activeId(ui)).toBe(2);
    ui.key('x'); await settle();
    expect(closes(ui)).toHaveLength(0);
    ui.keys('k', 'j', 'x'); await settle();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[2]]);
  });

  it('moves a focused row X to the list, not a neighbor, when a late source drops its row', async () => {
    const { pending, options } = held({ initial: context({ contentPermission: true }) });
    const ui = await ready(options);
    ui.toggleSource('source-content', true);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    pending[0].resolve(reply({ content: planContent([1, 2]) })(pending[0].msg)); await settle();
    ui.keys('Tab', 'j', 'Tab');
    expect(Number(ui.document.activeElement.dataset.closeId)).toBe(1);
    ui.contexts.good = context({ contentPermission: true, tabs: context().tabs.map(tab => ({ ...tab, title: `${tab.title} ` })) });
    ui.tabEvents.onCreated.fn(); await settle();
    vi.advanceTimersByTime(250); await settle();
    pending.at(-1).resolve(reply({ content: planContent([2]) })(pending.at(-1).msg)); await settle();
    expect(ui.focused()).toBe('results');
    ui.keys('x', ' '); await settle();
    expect(closes(ui)).toHaveLength(0);
  });

  it('drops a source reply that lands mid-close so queued keys replay on the closed list', async () => {
    let release;
    const { pending, options } = held({ initial: { ...amazon(), contentPermission: true }, closeResponse: () => new Promise(resolve => { release = resolve; }) });
    const ui = await ready(options);
    ui.toggleSource('source-content', true);
    ui.type('amazon'); vi.advanceTimersByTime(250); await settle();
    ui.keys('Tab', 'x', 'j', 'x');
    expect(closes(ui)).toHaveLength(1);
    pending[0].resolve(reply({ content: planContent([30]) })(pending[0].msg)); await settle();
    release({ ok: true, closedIds: [11], skipped: [], failedIds: [] }); await settle();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[11], [13]]);
    expect(ids(ui)).not.toContain(30);
    release({ ok: true, closedIds: [13], skipped: [], failedIds: [] }); await settle();
    expect(ids(ui)).toEqual([12, 14, 15, 16]);
    vi.advanceTimersByTime(0); await settle();
    expect(pending.at(-1).msg).toEqual({ command: 'querySearchSources', token: 'good', query: 'amazon', sources: { history: false, content: true } });
    pending.at(-1).resolve(reply({ content: planContent([30]) })(pending.at(-1).msg)); await settle();
    expect(ids(ui).at(-1)).toBe(30);
  });

  it('cancels an in-flight scan once per request with an empty query, never the long text', async () => {
    const { pending, options } = held();
    const ui = await ready(options);
    ui.type('road'); vi.advanceTimersByTime(1000); await settle();
    ui.type(''); ui.type('roadmap'); await settle();
    expect(sourceCalls(ui)).toHaveLength(0); // Tabs only: no source calls, no cancels.
    ui.toggleSource('source-history', true); vi.advanceTimersByTime(0); await settle();
    const long = 'roadmap '.repeat(40).trim();
    ui.type(long); ui.type(`${long} x`); await settle();
    expect(sourceCalls(ui)).toEqual([{ ...cancel, query: 'roadmap', sources: { history: true, content: false } }, cancel]);
    ui.type('road'); vi.advanceTimersByTime(250); await settle();
    ui.type(''); ui.type(''); await settle();
    ui.type('roa'); vi.advanceTimersByTime(250); await settle();
    ui.toggleSource('source-history', false); await settle();
    expect(sourceCalls(ui).map(msg => msg.query)).toEqual(['roadmap', '', 'road', '', 'roa', '']);
    expect(sourceCalls(ui).every(msg => msg.query.length <= 256)).toBe(true);
    // Every reply, cancels included, now arrives; none is shown.
    for (const { msg, resolve } of pending) resolve(reply({ history: [hist(`https://late.example/${msg.query}`, 'road late')] })({ ...msg, sources: { history: true, content: false } }));
    await settle();
    expect(ids(ui)).toEqual([3]);
    expect(ui.$('source-status').textContent).toBe('');
  });

  it('drops Contents and every snippet when a reply reports website access is gone', async () => {
    const coverage = { content: { state: 'permission' } };
    const ui = await ready({ initial: context({ contentPermission: true }), sources: reply({ content: planContent([1, 2]), coverage }) });
    ui.toggleSource('source-content', true);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    expect(ids(ui)).toEqual([3]);
    expect(ui.$('results').textContent).not.toContain('plan 1');
    expect(ui.$('source-content').checked).toBe(false);
    expect(ui.$('source-content').disabled).toBe(true);
    expect(ui.$('content-access-note').hidden).toBe(false);
    expect(ui.$('enable-content').hidden).toBe(false);
    vi.advanceTimersByTime(1000); await settle();
    expect(sourceCalls(ui)).toHaveLength(1);
  });

  it('clears a source the moment it is turned off, ignoring its in-flight reply, and closing never waits', async () => {
    let release;
    let calls = 0;
    const ui = await withHistory({ sources: msg => ++calls === 1 ? reply({ history: archive })(msg) : new Promise(resolve => { release = () => resolve(reply({ history: archive })(msg)); }) });
    expect(ui.rows()).toHaveLength(2);
    ui.type('roadm'); vi.advanceTimersByTime(250); await settle();
    ui.keys('Tab', 'x'); await settle(); // Closes Roadmap while history is still loading.
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[3]]);
    ui.toggleSource('source-history', false);
    expect(ui.rows()).toHaveLength(0);
    release(); await settle();
    expect(ui.rows()).toHaveLength(0);
    expect(ui.$('query').value).toBe('roadm');
    expect(ui.$('source-status').textContent).toBe('');
  });

  it('asks for website access only through Settings and still needs an explicit Contents choice', async () => {
    const ui = await ready();
    expect(ui.$('source-content').disabled).toBe(true);
    expect(ui.$('enable-content').hidden).toBe(false);
    expect(ui.$('content-access-note').hidden).toBe(false);
    ui.$('enable-content').dispatch('click'); await settle();
    expect(commands(ui.sendMessage).at(-1)).toEqual({ command: 'openSearchPermissions', token: 'good' });
    ui.contexts.good = context({ contentPermission: true });
    ui.window.dispatch('focus'); await settle();
    expect(ui.$('source-content').disabled).toBe(false);
    expect(ui.$('source-content').checked).toBe(false);
    expect(ui.$('enable-content').hidden).toBe(true);
    expect(sourceCalls(ui)).toHaveLength(0);
    expect(js).not.toMatch(/permissions\s*\.\s*request|localStorage|storage\.(local|sync|session)/);
  });

  it('adds snippets to content matches, reports coverage, and never resurrects a closed tab', async () => {
    const content = [{ tabId: 1, url: 'https://current.example', snippet: 'quarterly <b>plan</b> notes' }, { tabId: 2, url: 'https://www.evil.example/<b>', snippet: 'plan' }];
    const coverage = { content: { state: 'ready', searched: 2, total: 3, skipped: 1, truncated: 1 } };
    const ui = await ready({ initial: context({ contentPermission: true }), sources: reply({ content, coverage }) });
    ui.toggleSource('source-content', true);
    expect(ui.$('source-status').textContent).toBe('Type to search contents');
    expect(sourceCalls(ui)).toHaveLength(0);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    expect(ids(ui)).toEqual([3, 1, 2]);
    expect(ui.rows()[1].children[0].children[1].children[2].textContent).toBe('quarterly <b>plan</b> notes');
    expect(ui.rows()[0].children[0].children[1].children).toHaveLength(2); // No snippet line without a content match.
    expect(ui.$('source-status').textContent).toBe('Contents: 2 of 3 tabs searched · Main pages only · 1 skipped · 1 long page partly searched');
    ui.keys('Tab', 'j', 'j', 'x'); await settle();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[2]]);
    vi.advanceTimersByTime(0); await settle();
    expect(sourceCalls(ui)).toHaveLength(2); // One refresh after the close settled.
    expect(ids(ui)).toEqual([3, 1]);
    vi.advanceTimersByTime(5000); await settle();
    expect(sourceCalls(ui)).toHaveLength(2);
  });

  it('keeps history off in private windows and reports unavailable sources', async () => {
    const ui = await ready({ initial: context({ incognito: true, contentPermission: true }), sources: () => Promise.reject(new Error('down')) });
    expect(ui.$('source-history').disabled).toBe(true);
    expect(ui.$('history-private-note').hidden).toBe(false);
    ui.toggleSource('source-history', true);
    expect(ui.$('source-history').checked).toBe(false);
    ui.toggleSource('source-content', true);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    expect(sourceCalls(ui).map(msg => msg.sources)).toEqual([{ history: false, content: true }]);
    expect(ui.$('source-status').textContent).toBe('Contents: unavailable');
    expect(ids(ui)).toEqual([3]);
  });

  it('does not rerun source searches on unchanged Firefox polls', async () => {
    const ui = await ready({ noTabsApi: true, initial: context({ contentPermission: true }), sources: reply({ content: [] }) });
    ui.toggleSource('source-content', true);
    ui.type('plan'); vi.advanceTimersByTime(250); await settle();
    for (let i = 0; i < 3; i++) {
      // Focus times change on every poll; the open pages do not.
      ui.contexts.good = context({ contentPermission: true, tabs: context().tabs.map(tab => ({ ...tab, lastAccessed: tab.lastAccessed + i + 1 })) });
      vi.advanceTimersByTime(1000); await settle();
      expect(ui.$('source-status').dataset.busy).toBe('false');
    }
    expect(sourceCalls(ui)).toHaveLength(1);
    ui.contexts.good = context({ contentPermission: true, tabs: [...context().tabs, { id: 4, windowId: 10, title: 'Plan B', url: 'https://b.example/plan', lastAccessed: 1 }] });
    vi.advanceTimersByTime(1000); await settle();
    vi.advanceTimersByTime(250); await settle();
    expect(sourceCalls(ui)).toHaveLength(2); // A page actually opened.
  });
});

describe('Search in menu', () => {
  const sourceCalls = ui => commands(ui.sendMessage).filter(msg => msg.command === 'querySearchSources');
  const reply = ({ history = [] } = {}) => msg => ({
    history: msg.sources.history ? history : [],
    content: [],
    coverage: {
      history: msg.sources.history ? { state: 'ready', limited: false } : { state: 'off' },
      content: msg.sources.content ? { state: 'ready', searched: 3, total: 3, skipped: 0, truncated: 0 } : { state: 'off' },
    },
  });
  const archive = [{ url: 'https://old.example/r', title: 'Roadmap archive', lastVisitTime: 5 }];
  const open = ui => ui.$('search-in').dispatch('click');
  const menuShown = ui => !ui.$('source-menu').hidden && ui.$('search-in').getAttribute('aria-expanded') === 'true';

  it('is one closed trigger on launch, with notes only inside the menu', async () => {
    const ui = await ready({ initial: context({ incognito: true }) });
    expect(menuShown(ui)).toBe(false);
    expect(ui.$('source-summary').textContent).toBe('');
    expect(ui.$('source-status').textContent).toBe('');
    expect(ui.$('source-menu').contains(ui.$('history-private-note'))).toBe(true);
    expect(ui.$('source-menu').contains(ui.$('content-access-note'))).toBe(true);
    expect(ui.$('source-menu').contains(ui.$('enable-content'))).toBe(true);
    expect(ui.$('source-history').getAttribute('aria-describedby')).toBe('history-private-note');
    const spoken = [ui.$('announcement').textContent, ui.$('source-status').textContent];
    open(ui);
    expect(menuShown(ui)).toBe(true);
    expect([ui.$('announcement').textContent, ui.$('source-status').textContent]).toEqual(spoken); // Opening announces nothing.
    expect(sourceCalls(ui)).toHaveLength(0);
  });

  it('toggles sources in place, keeps the query, and summarizes them on the closed trigger', async () => {
    const ui = await ready({ initial: context({ contentPermission: true }), sources: reply({ history: archive }) });
    ui.type('road');
    open(ui);
    ui.$('source-history').checked = true; ui.$('source-history').dispatch('change');
    expect(menuShown(ui)).toBe(true);
    expect(ui.$('query').value).toBe('road');
    expect(ui.$('source-summary').textContent).toBe('+ History');
    ui.$('source-content').checked = true; ui.$('source-content').dispatch('change');
    expect(ui.$('source-summary').textContent).toBe('+ History · Contents');
    ui.$('source-history').checked = false; ui.$('source-history').dispatch('change');
    expect(ui.$('source-summary').textContent).toBe('+ Contents');
    expect(ui.$('source-history').getAttribute('aria-describedby')).toBeNull();
    ui.$('search-in').dispatch('click');
    expect(menuShown(ui)).toBe(false);
    expect(ui.$('query').value).toBe('road');
  });

  it('keeps Tab inside the open menu, and Escape closes it first without changing mode', async () => {
    const ui = await ready();
    ui.keys('Tab', 'Tab', 'Tab', 'Tab');
    expect(ui.focused()).toBe('search-in');
    expect(ui.mode()).toBe('tabs');
    open(ui);
    const walk = Array.from({ length: 3 }, () => { ui.key('Tab'); return ui.focused(); });
    expect(walk).toEqual(['source-history', 'enable-content', 'search-in']); // Contents is disabled here.
    ui.key('Tab', { shiftKey: true });
    expect(ui.focused()).toBe('enable-content');
    ui.$('source-history').focus();
    for (const name of ['m', 'x', 'a', ' ', 'Enter']) expect(ui.key(name).defaultPrevented).toBe(false); // Native checkbox keys.
    expect(ui.mode()).toBe('tabs');
    ui.key('Escape');
    expect(menuShown(ui)).toBe(false);
    expect(ui.focused()).toBe('search-in');
    expect(ui.mode()).toBe('tabs');
    expect(ui.parent.postMessage).not.toHaveBeenCalled();
    ui.key('Tab');
    expect(ui.focused()).toBe('query');
    await flush();
    expect(closes(ui)).toEqual([]);
  });

  it('closes on an outside press inside the palette, but not on presses within the menu', async () => {
    const ui = await ready();
    open(ui);
    ui.$('palette').dispatch('mousedown', { target: ui.$('source-history') });
    expect(menuShown(ui)).toBe(true);
    ui.$('palette').dispatch('mousedown', { target: ui.option(0) });
    expect(menuShown(ui)).toBe(false);
  });

  it('never truncates a long query: tabs still match, sources wait with a notice', async () => {
    const ui = await ready({ sources: reply({ history: archive }) });
    ui.toggleSource('source-history', true);
    const exact = `road${' '.repeat(251)}r`; // 256 characters.
    ui.type(exact); vi.advanceTimersByTime(250); await settle();
    expect(sourceCalls(ui).at(-1).query).toBe(exact);
    const long = 'roadmap '.repeat(40).trim();
    ui.type(long); vi.advanceTimersByTime(1000); await settle();
    expect(sourceCalls(ui)).toHaveLength(1);
    expect(ids(ui)).toEqual([3]);
    expect(ui.$('source-status').textContent).toBe('History and contents support queries up to 256 characters');
    expect(ui.$('source-status').dataset.busy).toBe('false');
  });

  it('drops a revoked source, returns focus to the trigger, and keeps the query', async () => {
    const ui = await ready({ initial: context({ contentPermission: true }), sources: reply() });
    ui.type('plan');
    open(ui);
    ui.$('source-content').checked = true; ui.$('source-content').dispatch('change');
    ui.$('source-content').focus();
    ui.contexts.good = context({ contentPermission: false });
    ui.tabEvents.onRemoved.fn(); await settle();
    expect(ui.$('source-content').checked).toBe(false);
    expect(ui.$('source-content').disabled).toBe(true);
    expect(ui.focused()).toBe('search-in');
    expect(ui.$('source-summary').textContent).toBe('');
    expect(ui.$('source-status').textContent).toBe('');
    expect(ui.$('enable-content').hidden).toBe(false);
    expect(ui.$('query').value).toBe('plan');
  });

  it('cancels queued j/x keys when a source changes mid-close', async () => {
    let release;
    const ui = await ready({ initial: amazon(), sources: reply(), closeResponse: () => new Promise(resolve => { release = resolve; }) });
    ui.type('amazon');
    ui.keys('Tab', 'x', 'j', 'x');
    expect(closes(ui)).toHaveLength(1);
    ui.toggleSource('source-history', true);
    release({ ok: true, closedIds: [11], skipped: [], failedIds: [] }); await settle();
    await settle();
    expect(closes(ui)).toHaveLength(1);
  });

  it('ignores m with only history listed, and leaving select restores a history highlight', async () => {
    const ui = await ready({ sources: reply({ history: [...archive, { url: 'https://old.example/plan', title: 'Plan archive', lastVisitTime: 4 }] }) });
    ui.toggleSource('source-history', true);
    ui.type('archive'); vi.advanceTimersByTime(250); await settle();
    expect(ids(ui)).toEqual(['https://old.example/r', 'https://old.example/plan']);
    ui.key('Tab');
    ui.key('m');
    expect(ui.mode()).toBe('tabs');
    ui.type('road'); vi.advanceTimersByTime(250); await settle();
    expect(ids(ui)).toEqual([3, 'https://old.example/r']);
    ui.$('query').focus();
    ui.keys('Tab', 'j', 'm');
    expect(ui.mode()).toBe('select');
    expect(ids(ui)).toEqual([3]);
    ui.key('m');
    expect(activeId(ui)).toBe('https://old.example/r');
  });
});

describe('fast repeated closing (0.5.2)', () => {
  const contextCalls = ui => commands(ui.sendMessage).filter(msg => msg.command === 'getSearchContext');

  it('Tab, x, j, j, x closes the exact rows in order using each reply’s bundled list', async () => {
    const ui = await ready({ initial: amazon() });
    ui.type('amazon');
    const order = ids(ui);
    ui.keys('Tab', 'x', 'j', 'j', 'x'); // All pressed before the first close answers.
    for (let i = 0; i < 8; i++) await flush();
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[order[0]], [order[3]]]);
    expect(ids(ui)).toEqual([order[1], order[2], order[4], order[5]]);
    expect(activeId(ui)).toBe(order[4]);
    expect(contextCalls(ui)).toHaveLength(1); // Only the initial load.
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
    expect(activations(ui)).toEqual([]);
  });

  it('reads the list once, read-only, when the bundled list is missing, and says so if that fails', async () => {
    const ui = await ready({ closeResponse: msg => ({ ok: true, closedIds: msg.tabIds, skipped: [], failedIds: [], contextError: true }), bundle: false });
    const original = ui.sendMessage.getMockImplementation();
    ui.sendMessage.mockImplementation(msg => (msg.command === 'getSearchContext' ? Promise.reject(new Error('read failed')) : original(msg)));
    ui.keys('Tab', 'x', 'j', 'x');
    await settle();
    expect(closes(ui)).toHaveLength(1); // Never re-sent, and queued keys dropped.
    expect(contextCalls(ui)).toHaveLength(2);
    expect(ui.$('message').textContent).toBe('Closed 1 tab. The list may be out of date. Close and reopen search.');
    expect(ui.rows()).toHaveLength(2); // The confirmed close still leaves the list.
  });

  it('keeps unchanged row elements, renumbering their ids, indices and ARIA', async () => {
    const ui = await ready({ initial: amazon() });
    ui.type('amazon');
    const before = ui.rows();
    ui.keys('Tab', 'j', 'x');
    await settle();
    const after = ui.rows();
    expect(after).toEqual([before[0], ...before.slice(2)]);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[2]);
    for (const [i, row] of after.entries()) {
      expect(row.getAttribute('aria-rowindex')).toBe(String(i + 1));
      expect(row.children[0].id).toBe(`option-${i}`);
      expect(row.children[0].dataset.index).toBe(String(i));
      expect(row.children[1].children[0].id).toBe(`row-close-${i}`);
    }
    expect(ui.$('query').getAttribute('aria-activedescendant')).toBe('option-1');
    expect(after[1].getAttribute('aria-selected')).toBe('true');
    expect(ui.$('results').getAttribute('aria-rowcount')).toBe('5');
  });

  it('rebuilds only a row whose title changed, and keeps rows across mode changes', async () => {
    const ui = await ready({ initial: amazon() });
    ui.type('amazon');
    const before = ui.rows();
    ui.contexts.good = { ...ui.contexts.good, tabs: ui.contexts.good.tabs.map(tab => (tab.id === 12 ? { ...tab, title: 'Amazon renamed' } : tab)) };
    ui.tabEvents.onUpdated.fn(12, { title: 'Amazon renamed' }); await flush();
    const after = ui.rows();
    const changed = before.findIndex(row => row.children[1].children[0].dataset.closeId === '12');
    for (const [i, row] of after.entries()) {
      if (i === changed) expect(row).not.toBe(before[i]); else expect(row).toBe(before[i]);
    }
    expect(after[changed].textContent).toContain('Amazon renamed');
    expect(after[changed].children[1].children[0].getAttribute('aria-label')).toBe('Close tab: Amazon renamed');
    ui.keys('Tab', 'm', ' ');
    expect(ui.rows()).toEqual(after);
    expect(ui.$('results').getAttribute('aria-multiselectable')).toBe('true');
    expect(ui.option(0).getAttribute('aria-selected')).toBe('true'); // Checked, in select mode.
    expect(ui.option(1).getAttribute('aria-selected')).toBe('false');
  });
});

describe('closing the tab that hosts search (0.5.2)', () => {
  const contextCalls = ui => commands(ui.sendMessage).filter(msg => msg.command === 'getSearchContext');
  const readies = ui => commands(ui.sendMessage).filter(msg => msg.command === 'searchHandoffReady');

  it('sends the state only when closing the host, then retires without acting again', async () => {
    const ui = await ready({ closeResponse: msg => (msg.tabIds.includes(1)
      ? { ok: true, handedOff: true, closedIds: msg.tabIds, skipped: [], failedIds: [] }
      : { ok: true, closedIds: msg.tabIds, skipped: [], failedIds: [] }) });
    ui.keys('Tab', 'x'); // Tab 2 is listed first: not the host.
    await settle();
    expect(closes(ui)[0]).toEqual({ command: 'closeSearchTabs', token: 'good', tabIds: [2] });
    ui.keys('j', 'x', 'k', 'x'); // Closes the host (1); the rest is queued.
    await settle();
    expect(closes(ui)[1]).toEqual({ command: 'closeSearchTabs', token: 'good', tabIds: [1], state: {
      query: '', mode: 'tabs', sources: { history: false, content: false }, highlight: 'tab:1', checked: [], focus: 'list',
    } });
    expect(closes(ui)).toHaveLength(2);
    expect(ui.$('message').textContent).toBe('Search moved to another tab.');
    const sent = ui.sendMessage.mock.calls.length;
    ui.keys('x', 'Enter');
    ui.type('roadmap');
    ui.init('good');
    vi.advanceTimersByTime(1000);
    await settle();
    expect(ui.sendMessage.mock.calls.length).toBe(sent);
    expect(contextCalls(ui)).toHaveLength(1);
  });

  it('a standalone window never sends handoff state', async () => {
    const ui = setup({ top: true, search: '?token=good' });
    await flush();
    ui.keys('Tab', 'j', 'j', 'x'); // The current tab is listed last.
    await settle();
    expect(closes(ui)).toEqual([{ command: 'closeSearchTabs', token: 'good', tabIds: [1] }]);
  });

  it('explains a failed handoff, closes nothing, and stays usable', async () => {
    const ui = await ready({ closeResponse: () => ({ ok: false, handoffFailed: true, closedIds: [], skipped: [], failedIds: [] }) });
    ui.keys('Tab', 'j', 'j', 'x', 'k', 'x'); // The host is listed last.
    await settle();
    expect(ui.$('message').textContent).toBe('Search could not stay open after closing this tab, so no tabs were closed.');
    expect(ids(ui)).toEqual([2, 3, 1]);
    expect(closes(ui)).toHaveLength(1); // The queued k, x were cancelled.
    ui.keys('k', 'x'); await settle();
    expect(closes(ui).at(-1).tabIds).toEqual([3]);
  });

  const handedState = over => ({ query: 'amazon', mode: 'tabs', sources: { history: false, content: false },
    highlight: 'tab:12', checked: [], focus: 'list', closing: [12], ...over });
  const remaining = gone => ({ ...amazon(), tabs: amazon().tabs.filter(tab => !gone.includes(tab.id)) });

  it('restores query, mode, highlight and focus, then shows the continued close', async () => {
    let finish;
    const ui = await ready({ initial: { ...amazon(), restore: handedState() },
      handoff: () => new Promise(resolve => { finish = resolve; }) });
    expect(ui.$('query').value).toBe('amazon');
    expect(ui.mode()).toBe('tabs');
    expect(ui.focused()).toBe('results');
    expect(activeId(ui)).toBe(12);
    expect(readies(ui)).toEqual([{ command: 'searchHandoffReady', token: 'good' }]);
    const order = ids(ui);
    ui.keys('j', 'x'); // Busy until the continued close settles.
    expect(closes(ui)).toHaveLength(0);
    ui.contexts.good = remaining([12]);
    finish({ ok: true, closedIds: [12], skipped: [], failedIds: [], context: remaining([12]) });
    await settle();
    const next = order.indexOf(12) + 1;
    // The next row took 12's place; the queued j, x then closed the row after it.
    expect(closes(ui).map(msg => msg.tabIds)).toEqual([[order[next + 1]]]);
    expect(ids(ui)).toEqual(order.filter(id => id !== 12 && id !== order[next + 1]));
    expect(activeId(ui)).toBe(order[next + 2]);
    expect(contextCalls(ui)).toHaveLength(1);
  });

  it('keeps the remaining checks and row X focus in select mode', async () => {
    const ui = await ready({ initial: { ...amazon(), restore: handedState({ mode: 'select', checked: [11, 12, 13], focus: 'row-close', focusTabId: 12 }) },
      handoff: () => ({ ok: true, closedIds: [12], skipped: [], failedIds: [], context: remaining([12]) }) });
    await settle();
    expect(ui.mode()).toBe('select');
    expect(checkedIds(ui)).toEqual([11, 13]);
    expect(ui.$('selection-status').textContent).toBe('2 of 5 selected');
    expect(ui.$('message').textContent).toBe('Closed 1 tab.');
    expect(ui.focused()).toMatch(/^row-close-/);
    expect(ui.document.activeElement.dataset.closeId).not.toBe('12');
  });

  it('turns on only the sources this window allows, after the close', async () => {
    const sources = vi.fn(() => ({ history: [], content: [], coverage: { history: { state: 'ready' } } }));
    const ui = await ready({ initial: { ...amazon(), contentPermission: false, restore: handedState({ sources: { history: true, content: true } }) },
      handoff: () => ({ ok: true, closedIds: [12], skipped: [], failedIds: [], context: { ...remaining([12]), contentPermission: false } }), sources });
    await settle();
    vi.advanceTimersByTime(0); await settle();
    expect(ui.$('source-history').checked).toBe(true);
    expect(ui.$('source-content').checked).toBe(false);
    expect(sources.mock.calls.map(([msg]) => msg.sources)).toEqual([{ history: true, content: false }]);
  });

  it('reads the list once when the continued close cannot report back', async () => {
    const ui = await ready({ initial: { ...amazon(), restore: handedState() }, handoff: () => ({ ok: false }) });
    await settle();
    expect(contextCalls(ui)).toHaveLength(2);
    expect(ui.$('message').textContent).toBe('Could not close tabs. Check the list and try again.');
    expect(closes(ui)).toHaveLength(0);
  });
});
