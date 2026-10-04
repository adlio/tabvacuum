import { composeSearchResults } from './search-sources-core.js';

const INIT_TYPE = 'tabvacuum:init';
const MAX_TOKEN_LENGTH = 512;
// A hostile page can post init messages too. Trying several candidates keeps it
// from winning by posting first; the backend decides which token is real.
const MAX_INIT_ATTEMPTS = 16;
const INIT_TIMEOUT_MS = 5000;
const MAX_LISTED_SKIPS = 3;
const MAX_SOURCE_QUERY = 256;
const SOURCE_DELAY_MS = 250;
// search: typing in the query. tabs: the tab menu, acting on the highlight.
// select: checking several tabs to close together.
const MODE_LABELS = { search: '', tabs: 'Tab menu', select: 'Select multiple' };
const MOVES = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

const isContext = value => Boolean(value) && typeof value === 'object' && !value.error && Array.isArray(value.tabs);
const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;
const idList = value => Array.isArray(value) ? value.filter(Number.isInteger) : [];
const tabLabel = tab => tab.title || tab.url || 'Untitled tab';
const isTab = result => result?.kind !== 'history' && Boolean(result);
const whole = value => Number.isInteger(value) && value >= 0 ? value : 0;
const noExtras = () => ({ query: '', history: [], content: [], coverage: {} });

function initial(tab) {
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* Not a URL. */ }
  const [char] = [...(host || tab.title || '')];
  return char && /\p{L}/u.test(char) ? char.toUpperCase() : '';
}

// Only picks help wording, so a coarse, non-sensitive guess is enough.
function guessMac(navigator) {
  const platform = navigator?.userAgentData?.platform || navigator?.platform || '';
  return /mac|iphone|ipad/i.test(platform);
}

// Backend replies are untrusted in shape: keep only well-formed entries for
// the sources that were asked for. A failed request reads as unavailable.
function acceptSources(response, wanted, query) {
  const ok = Boolean(response) && typeof response === 'object' && !response.error;
  const coverage = ok && response.coverage && typeof response.coverage === 'object' ? response.coverage : {};
  const state = name => !wanted[name] ? { state: 'off' } : ok && coverage[name] && typeof coverage[name] === 'object' ? coverage[name] : { state: 'error' };
  const history = wanted.history && ok && Array.isArray(response.history) ? response.history
    .filter(item => typeof item?.url === 'string' && item.url)
    .map(item => ({ url: item.url, title: typeof item.title === 'string' ? item.title : '', lastVisitTime: item.lastVisitTime })) : [];
  // Without website access no snippet survives, whatever else the reply holds.
  const content = wanted.content && ok && state('content').state !== 'permission' && Array.isArray(response.content) ? response.content
    .filter(item => Number.isInteger(item?.tabId) && typeof item.snippet === 'string')
    .map(item => ({ tabId: item.tabId, url: typeof item.url === 'string' ? item.url : '', snippet: item.snippet })) : [];
  return { query, history, content, coverage: { history: state('history'), content: state('content') } };
}

function historyPhrase(coverage = {}) {
  if (coverage.state === 'private') return 'History: not searched in private windows';
  if (coverage.state === 'error') return 'History: unavailable';
  if (coverage.state === 'ready' && coverage.limited) return 'History: latest 100 matches';
  return '';
}

function contentPhrase(coverage = {}) {
  if (coverage.state === 'permission') return 'Contents: website access needed';
  if (coverage.state === 'error') return 'Contents: unavailable';
  if (coverage.state !== 'ready') return '';
  const parts = [`Contents: ${whole(coverage.searched)} of ${plural(whole(coverage.total), 'tab')} searched`, 'Main pages only'];
  const skipped = whole(coverage.skipped);
  const truncated = whole(coverage.truncated);
  if (skipped) parts.push(`${skipped} skipped`);
  if (truncated) parts.push(`${plural(truncated, 'long page')} partly searched`);
  return parts.join(' · ');
}

/**
 * Runs the search UI. The session token stays in this closure: nothing is
 * exported to the host page, posted to other windows, or logged.
 */
export function startSearch({ document, window, browser }) {
  const $ = id => document.getElementById(id);
  const palette = $('palette');
  const query = $('query');
  const list = $('results');
  const message = $('message');
  const announcement = $('announcement');
  const modeIndicator = $('mode-indicator');
  const selectButton = $('select-toggle');
  const closeButton = $('close-tabs');
  const historyToggle = $('source-history');
  const contentToggle = $('source-content');
  const enableButton = $('enable-content');
  const sourceStatus = $('source-status');
  const trigger = $('search-in');
  const menu = $('source-menu');
  const menuControls = [historyToggle, contentToggle, enableButton];
  // Enter and Space belong to these natively.
  const nativeControls = [selectButton, closeButton, trigger, ...menuControls];
  const embedded = window.parent !== window;
  const tried = new Set();
  // Checked tab IDs in select mode. Highlight (`selected`) is separate.
  const checked = new Set();
  // Explicit list keystrokes arriving during a close are applied in order, not
  // dropped. Focus/mode changes and partial failures cancel the pending sequence.
  const pendingListKeys = [];
  const MAX_PENDING_KEYS = 64;
  // Extra sources start off on every launch and are never persisted.
  const sources = { history: false, content: false };
  let extras = noExtras();
  let sourceGeneration = 0;
  let sourceBusy = false;
  let sourceTimer;
  // A sent, unanswered request (its generation), and whether it was told to stop.
  let sourceInFlight = 0;
  let cancelSent = false;
  let menuOpen = false;
  // An outside press that closes the menu does only that, never a row action.
  let swallowClick = false;
  // Leaving select mode without moving returns to the pre-select highlight.
  let selectReturn = null;
  let token;
  // Set once this search hands its session to a replacement: it never acts again.
  let retired = false;
  let context;
  let results = [];
  let rowEls = [];
  let rowCloses = [];
  // Rendered rows by result key, reused while their content is unchanged.
  let rowCache = new Map();
  // Displayed position by result key for the current query. A list that
  // refreshes (after a close, a tab event, or a search handoff) keeps rows
  // where the user saw them, even when activation changes recency, so the
  // next row and the next key act on what is on screen. Typing a new query
  // starts a fresh ranking.
  let displayOrder = new Map();
  // Checked tabs, highlight and row-X focus restored from a handoff that
  // only appear once History or Contents results arrive. Held, never acted
  // on, until those results settle.
  let held = null;
  let hiddenHistory = 0;
  let selected = -1;
  let mode = 'search';
  let busy = false;
  let closing = false;
  // True only while a close request is in flight and the list may still show
  // tabs that are about to go. Movement waits; it resumes before the refresh.
  let awaitingClose = false;
  let highlightCloseReady = true;
  let composing = false;
  let notice = null;
  let mac = guessMac(window.navigator);
  let refreshVersion = 0;
  let announceTimer;
  let initTimer;

  const send = payload => browser.runtime.sendMessage(payload);
  const extrasOn = () => sources.history || sources.content;
  // Over-long queries are never truncated and sent as if complete.
  const sourceQuery = () => {
    const text = query.value.trim();
    return token && extrasOn() && text.length <= MAX_SOURCE_QUERY ? text : '';
  };
  // Content matches depend on which pages are open, not on focus times.
  const contentKey = ctx => JSON.stringify(ctx.tabs.map(t => [t.id, t.url, t.title, t.status, t.discarded]));
  const isRowClose = element => Boolean(element) && rowCloses.includes(element);
  const selectedKey = () => results[selected]?.key;

  function showMessage(state, text) {
    message.dataset.state = state;
    message.textContent = text;
    message.hidden = false;
  }

  // Empty state, then a sticky close notice, otherwise nothing.
  function showStatus() {
    const typed = Boolean(query.value.trim());
    if (notice) showMessage('notice', notice);
    else if (!results.length && typed && sourceBusy) showMessage('loading', 'Searching…');
    else if (!results.length && typed && extrasOn()) showMessage('empty', 'No matches. Try different words.');
    else if (!results.length) showMessage('empty', typed ? 'No matching tabs. Try a different title or URL.' : 'No tabs to show.');
    else message.hidden = true;
  }

  function announce(text) {
    clearTimeout(announceTimer);
    announcement.textContent = text;
  }

  function showPlatform() {
    $('select-help').textContent = 'Select multiple mode. Up and Down arrows, or J and K, move. ' +
      'Space or Enter toggles selection of the highlighted tab. ' +
      `A, or ${mac ? 'Command' : 'Control'} A, selects all listed tabs. ` +
      'X or Delete closes the selected tabs. M or Done returns to the tab menu. ' +
      'Escape clears the selection and returns to the tab menu.';
  }

  function sourceText() {
    if (!context || !extrasOn()) return '';
    const names = [sources.history && 'history', sources.content && 'contents'].filter(Boolean).join(' and ');
    const text = query.value.trim();
    if (!text) return `Type to search ${names}`;
    if (text.length > MAX_SOURCE_QUERY) return `History and contents support queries up to ${MAX_SOURCE_QUERY} characters`;
    if (sourceBusy) return `Searching ${names}…`;
    return [
      sources.history && historyPhrase(extras.coverage.history),
      sources.content && contentPhrase(extras.coverage.content),
    ].filter(Boolean).join(' · ');
  }

  function paintSources() {
    const ready = Boolean(context);
    historyToggle.checked = sources.history;
    contentToggle.checked = sources.content;
    historyToggle.disabled = !ready || context.incognito;
    contentToggle.disabled = !ready || !context.contentPermission;
    const needsAccess = ready && !context.contentPermission;
    const privateWindow = ready && context.incognito;
    enableButton.hidden = !needsAccess;
    // Notes live only in the menu, and describe a checkbox only while shown.
    for (const [box, note, shown] of [[historyToggle, 'history-private-note', privateWindow], [contentToggle, 'content-access-note', needsAccess]]) {
      $(note).hidden = !shown;
      if (shown) box.setAttribute('aria-describedby', note); else box.removeAttribute('aria-describedby');
    }
    menu.hidden = !menuOpen;
    trigger.setAttribute('aria-expanded', String(menuOpen));
    const names = [sources.history && 'History', sources.content && 'Contents'].filter(Boolean);
    $('source-summary').textContent = names.length ? `+ ${names.join(' · ')}` : '';
    // A control that closed, hid, or disabled under focus hands it to the trigger.
    const focus = document.activeElement;
    if (menuControls.includes(focus) && (!menuOpen || focus.disabled || focus.hidden)) trigger.focus();
    palette.dataset.sources = ['tabs', sources.history && 'history', sources.content && 'content'].filter(Boolean).join(' ');
    query.placeholder = extrasOn()
      ? `Search tabs, ${[sources.history && 'history', sources.content && 'contents'].filter(Boolean).join(' and ')}…`
      : 'Search tabs…';
    sourceStatus.textContent = sourceText();
    sourceStatus.dataset.busy = String(sourceBusy);
  }

  // IDs are frozen here, at the moment the user asks to close. Select mode
  // closes only checked tabs: nothing checked means nothing closes. History
  // entries are never close targets.
  function closeTargets() {
    if (mode === 'select') return results.filter(isTab).map(r => r.tab.id).filter(id => checked.has(id));
    if (!highlightCloseReady) return [];
    const target = results[selected];
    return isTab(target) ? [target.tab.id] : [];
  }

  function paint() {
    const selecting = mode === 'select';
    for (const [i, row] of rowEls.entries()) {
      const result = results[i];
      const isChecked = isTab(result) && checked.has(result.tab.id);
      row.setAttribute('data-active', String(i === selected));
      row.setAttribute('data-checked', String(isChecked));
      // Single-select: selection follows the highlight. Multi-select:
      // aria-selected means checked, and the highlight is the active descendant.
      const rowSelected = String(selecting ? isChecked : i === selected);
      row.setAttribute('aria-selected', rowSelected);
      row.children[0].setAttribute('aria-selected', rowSelected);
      rowCloses[i]?.setAttribute('aria-disabled', String(busy));
    }
    list.setAttribute('aria-rowcount', String(results.length));
    const active = rowEls[selected]?.children[0];
    for (const owner of [query, list]) {
      if (active) owner.setAttribute('aria-activedescendant', active.id);
      else owner.removeAttribute('aria-activedescendant');
    }
    const history = results[selected]?.kind === 'history';
    palette.dataset.mode = mode;
    palette.dataset.target = history ? 'history' : 'tab';
    for (const id of ['enter-search', 'enter-tabs']) $(id).textContent = history ? 'Open page' : 'Switch';
    list.setAttribute('aria-multiselectable', String(selecting));
    list.setAttribute('aria-describedby', selecting ? 'select-help' : 'tabs-help');
    for (const name of Object.keys(MODE_LABELS)) $(`hints-${name}`).hidden = name !== mode;
    modeIndicator.textContent = MODE_LABELS[mode];
    modeIndicator.hidden = mode === 'search';
    $('selection-status').textContent = selecting
      ? `${shownChecked()} of ${results.length} selected${hiddenHistory ? ' · Only open tabs can be selected' : ''}`
      : '';
    selectButton.textContent = selecting ? 'Done' : 'Select multiple';
    selectButton.setAttribute('aria-disabled', String(!selecting && !results.some(isTab)));
    closeButton.hidden = !selecting;
    closeButton.textContent = `Close ${plural(shownChecked(), 'tab')}`;
    closeButton.setAttribute('aria-disabled', String(busy || !shownChecked()));
    paintSources();
  }

  const shownChecked = () => results.filter(result => isTab(result) && checked.has(result.tab.id)).length;

  function setMode(next) {
    if (next !== 'select') checked.clear();
    const changed = next !== mode;
    if (changed) { pendingListKeys.length = 0; held = null; }
    // Entering the tab menu from search acts on the highlight the user can see.
    if (changed && mode === 'search') highlightCloseReady = true;
    // Select mode lists open tabs only, so entering or leaving it reshapes the list.
    const reshape = changed && (next === 'select' || mode === 'select');
    if (changed && next === 'select') selectReturn = { before: selectedKey() };
    let key = selectedKey();
    if (reshape && next !== 'select' && selectReturn && key === selectReturn.entered) key = selectReturn.before;
    mode = next;
    if (reshape) render(key, selected); else paint();
    if (changed && next === 'select') selectReturn.entered = selectedKey();
    if (changed && next !== 'search') announce(MODE_LABELS[next]);
  }

  function select(index, scroll = true) {
    selected = results.length ? Math.max(0, Math.min(index, results.length - 1)) : -1;
    paint();
    if (scroll) rowEls[selected]?.scrollIntoView({ block: 'nearest' });
  }

  // Titles, URLs and snippets are untrusted: text only, never HTML, never fetched icons.
  function el(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // Grid rows expose an option cell and an action cell. Open tabs get an
  // independently keyboard-accessible close button there; history rows keep
  // the cell empty so every row has the same two columns.
  function row({ tab, matchType, kind, snippet }) {
    const history = kind === 'history';
    const wrapper = el('div', history ? 'result result-history' : 'result');
    wrapper.setAttribute('role', 'row');
    const option = el('div', 'result-option');
    option.setAttribute('role', 'gridcell');
    option.setAttribute('aria-selected', 'false');
    const letter = initial(tab);
    const tile = el('span', letter ? 'tile' : 'tile tile-fallback', letter);
    tile.setAttribute('aria-hidden', 'true');
    const line = el('div', 'line');
    line.append(el('span', 'title', tabLabel(tab)));
    // The URL is always shown, so only a URL-only match needs explaining.
    const badges = [];
    if (history) badges.push(['History', 'badge badge-history']);
    else {
      if (matchType === 'url') badges.push(['URL match', 'badge badge-match']);
      if (tab.windowId !== context.windowId) badges.push(['Other window', 'badge']);
      if (tab.id === context.currentTabId) badges.push(['Current', 'badge']);
    }
    for (const [badge, className] of badges) line.append(el('span', className, badge));
    const text = el('div', 'text');
    text.append(line, el('div', 'url', tab.url || 'Address unavailable'));
    if (!history && typeof snippet === 'string' && snippet) text.append(el('div', 'snippet', snippet));
    // Drawn first via CSS order; last in the DOM so row text stays title-first.
    const box = el('span', 'check');
    box.setAttribute('aria-hidden', 'true');
    option.append(tile, text, box);
    const actionCell = el('div', 'result-action');
    actionCell.setAttribute('role', 'gridcell');
    let close = null;
    if (!history) {
      // Reached by the dialog's own Tab order (active row only), never natively.
      close = el('button', 'row-close');
      close.type = 'button';
      close.setAttribute('tabindex', '-1');
      close.setAttribute('title', 'Close tab');
      close.setAttribute('aria-label', `Close tab: ${tabLabel(tab)}`);
      close.dataset.closeId = String(tab.id);
      const icon = el('span', 'row-close-icon');
      icon.setAttribute('aria-hidden', 'true');
      close.append(icon);
      actionCell.append(close);
    }
    wrapper.append(option, actionCell);
    return { wrapper, option, close };
  }

  // Everything a row displays, so a changed title, URL, badge or snippet
  // rebuilds that row and nothing else.
  const rowSignature = ({ tab, matchType, kind, snippet }) => JSON.stringify([kind, matchType, tab.title, tab.url,
    kind === 'history' ? '' : snippet, tab.windowId !== context.windowId, tab.id === context.currentTabId]);

  function place({ wrapper, option, close }, index) {
    wrapper.setAttribute('aria-rowindex', String(index + 1));
    option.id = `option-${index}`;
    option.dataset.index = String(index);
    if (close) close.id = `row-close-${index}`;
  }

  // Moves nodes only when the order changed: a moved node loses focus.
  function setChildren(parent, children) {
    const current = parent.children;
    if (current.length === children.length && children.every((child, i) => current[i] === child)) return;
    parent.replaceChildren(...children);
  }

  // Row groups carry their labels; the visible headings are decorative so
  // they are never counted or navigated as rows.
  function group(label) {
    const element = el('div', 'result-group');
    element.setAttribute('role', 'rowgroup');
    element.setAttribute('aria-label', label);
    const heading = el('div', 'group-heading', label);
    heading.setAttribute('aria-hidden', 'true');
    element.append(heading);
    return { element, heading };
  }
  const groups = { tabs: group('Open tabs'), history: group('History') };

  // Open tabs always come first; content matches only for tabs still open.
  function compose() {
    const text = query.value.trim();
    const fresh = extrasOn() && Boolean(text) && extras.query === text;
    const open = new Set(context.tabs.map(tab => tab.id));
    return composeSearchResults({
      tabs: context.tabs,
      query: query.value,
      currentTabId: context.currentTabId,
      history: fresh && sources.history ? extras.history : [],
      content: fresh && sources.content ? extras.content.filter(item => open.has(item.tabId)) : [],
    });
  }

  // Keeps rows already shown in their displayed order; rows new to this
  // query follow in ranked order. Open tabs stay ahead of history.
  function arrange(composed) {
    if (!displayOrder.size) return composed;
    const known = composed.map((result, index) => ({ result, index, at: displayOrder.get(result.key) ?? Infinity }));
    const group = tabs => known.filter(item => isTab(item.result) === tabs)
      .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at)).map(item => item.result);
    return [...group(true), ...group(false)];
  }

  function render(preserveKey, fallbackIndex = 0) {
    if (!context) return;
    // Rebuilding rows removes a focused row button; put focus back afterwards.
    const focusedClose = isRowClose(document.activeElement) ? document.activeElement : null;
    const focusedTabId = focusedClose ? Number(focusedClose.dataset.closeId) : undefined;
    const typed = Boolean(query.value.trim());
    const all = arrange(compose());
    // The first source reply must still see the transferred positions of
    // content-only rows that are not in this initial title/URL list.
    if (!held) displayOrder = new Map(all.map((result, index) => [result.key, index]));
    results = mode === 'select' ? all.filter(isTab) : all;
    hiddenHistory = all.length - results.length;
    const shown = new Set(results.filter(isTab).map(result => result.tab.id));
    for (const id of checked) if (!shown.has(id) && !held?.checked.has(id)) checked.delete(id);
    const { tabs, history } = groups;
    const tabRows = [];
    const historyRows = [];
    const cache = new Map();
    rowEls = [];
    rowCloses = [];
    for (const [index, result] of results.entries()) {
      const signature = rowSignature(result);
      const kept = rowCache.get(result.key);
      const entry = kept?.signature === signature ? kept : { ...row(result), signature };
      place(entry, index);
      cache.set(result.key, entry);
      rowEls.push(entry.wrapper);
      rowCloses.push(entry.close);
      (isTab(result) ? tabRows : historyRows).push(entry.wrapper);
    }
    rowCache = cache;
    const historyCount = results.length - shown.size;
    tabs.heading.hidden = !historyCount;
    setChildren(tabs.element, [tabs.heading, ...tabRows]);
    setChildren(history.element, [history.heading, ...historyRows]);
    setChildren(list, [shown.size && tabs.element, historyCount && history.element].filter(Boolean));
    list.setAttribute('aria-busy', 'false');
    $('list-label').textContent = typed ? 'Matches' : 'Recent tabs';
    $('result-count').textContent = plural(shown.size, 'tab') + (historyCount ? ` · ${historyCount} history` : '');
    showStatus();
    const kept = results.findIndex(result => result.key === preserveKey);
    select(kept === -1 ? fallbackIndex : kept);
    if (focusedClose) {
      const sameIndex = results.findIndex(result => isTab(result) && result.tab.id === focusedTabId);
      // Only our own close may carry X-button focus onto a different tab.
      const nextClose = sameIndex >= 0 ? rowCloses[sameIndex] : closing ? rowCloses[selected] : null;
      (nextClose ?? (mode === 'search' ? query : list)).focus();
    }
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announcement.textContent = `${plural(shown.size, 'tab')}${historyCount ? ` and ${plural(historyCount, 'history result')}` : ''} found`;
    }, 180);
  }

  // Debounced; each new query, toggle, or relevant tab change supersedes any
  // request in flight. Nothing is sent unless an extra source is selected.
  function scheduleSources(delay = SOURCE_DELAY_MS) {
    clearTimeout(sourceTimer);
    const generation = ++sourceGeneration;
    const text = sourceQuery();
    sourceBusy = Boolean(text);
    // Stop a backend scan for an invalidated query, unless its replacement goes
    // out at once: the backend aborts older queries when a newer one arrives.
    if (!text || delay > 0) cancelSources();
    paintSources();
    if (sourceBusy) sourceTimer = setTimeout(() => searchSources(generation, text), delay);
  }

  // An empty query with no sources is the backend's cheap stop signal. Sent at
  // most once per request; its reply carries nothing and is never rendered.
  function cancelSources() {
    if (!sourceInFlight || cancelSent || !token) return;
    cancelSent = true;
    try {
      Promise.resolve(send({ command: 'querySearchSources', token, query: '', sources: { history: false, content: false } })).catch(() => {});
    } catch { /* Nothing to recover: the UI already ignores the old reply. */ }
  }

  async function searchSources(generation, text) {
    const wanted = { history: sources.history, content: sources.content };
    sourceInFlight = generation;
    cancelSent = false;
    let response;
    try {
      response = await send({ command: 'querySearchSources', token, query: text, sources: wanted });
    } catch { /* Shown as unavailable. */ }
    if (sourceInFlight === generation) { sourceInFlight = 0; cancelSent = false; }
    if (generation !== sourceGeneration) return;
    sourceBusy = false;
    // A close owns the list until it settles and asks for fresh sources after,
    // so a reply landing mid-close is dropped: queued keys never see it.
    if (closing) { paintSources(); return; }
    extras = acceptSources(response, wanted, text);
    if (wanted.content && extras.coverage.content.state === 'permission') {
      // Access was revoked: drop Contents now rather than waiting for a poll.
      dropSource('content');
      context = { ...context, contentPermission: false };
    }
    if (held) release(); else recompose(selectedKey());
    paintSources();
  }

  // The first History/Contents results after a handoff have settled: the
  // held identities either reappear (and are restored) or are gone.
  function release() {
    const { highlight, focusTabId } = held;
    held = null;
    if (highlight === undefined) recompose(selectedKey());
    else {
      render(highlight, selected);
      highlightCloseReady = selectedKey() === highlight;
      if (!highlightCloseReady) pendingListKeys.length = 0;
    }
    const close = focusTabId === undefined ? null
      : rowCloses.find(button => button && Number(button.dataset.closeId) === focusTabId);
    if (close && document.activeElement === list) close.focus();
  }

  // Automatic changes keep the highlighted item. If it vanished, the row that
  // takes its place is not armed for x, and keys queued against the old list
  // drop, until the user navigates again. Our own close sets `closing` and
  // keeps its adjacent target, so it never comes through here.
  function recompose(before) {
    render(before, selected);
    if (before !== undefined && selectedKey() !== before) {
      highlightCloseReady = false;
      pendingListKeys.length = 0;
    }
  }

  function dropSource(name) {
    sources[name] = false;
    extras[name] = [];
    extras.coverage = { ...extras.coverage, [name]: { state: 'off' } };
  }

  function setSource(name, on) {
    if (!context) return;
    held = null;
    const allowed = name === 'history' ? !context.incognito : context.contentPermission;
    const before = selectedKey();
    // Keys queued against the old list must not act on the new one.
    pendingListKeys.length = 0;
    if (on && allowed) sources[name] = true; else dropSource(name);
    recompose(before);
    scheduleSources(0);
  }

  function setContext(raw) {
    const next = { ...raw, incognito: raw.incognito === true, contentPermission: raw.contentPermission === true };
    // Polling must not reset manual scroll or replace rows when nothing changed.
    if (context && JSON.stringify(context) === JSON.stringify(next)) return;
    const previous = results[selected];
    const tabsChanged = !context || contentKey(context) !== contentKey(next);
    context = next;
    let dropped = false;
    for (const name of ['history', 'content']) {
      const allowed = name === 'history' ? !context.incognito : context.contentPermission;
      if (sources[name] && !allowed) {
        dropSource(name);
        dropped = true;
      }
    }
    if (dropped) pendingListKeys.length = 0;
    // A closed highlight falls to the row that took its place, not the top.
    // Only our own close may arm that replacement; an external change may not.
    if (closing) render(previous?.key, selected); else recompose(previous?.key);
    if (dropped || (tabsChanged && !closing && sources.content)) scheduleSources();
  }

  function toggle(index) {
    const result = results[index];
    if (!isTab(result)) return;
    const id = result.tab.id;
    if (checked.has(id)) checked.delete(id); else checked.add(id);
    select(index, false);
  }

  function checkAll() {
    // A snapshot of open tabs: tabs that arrive later are not checked.
    for (const result of results) if (isTab(result)) checked.add(result.tab.id);
    paint();
  }

  async function tryToken(candidate) {
    if (token || retired || typeof candidate !== 'string' || !candidate || candidate.length > MAX_TOKEN_LENGTH) return;
    if (tried.has(candidate) || tried.size >= MAX_INIT_ATTEMPTS) return;
    tried.add(candidate);
    let next;
    try { next = await send({ command: 'getSearchContext', token: candidate }); } catch { /* Rejected below. */ }
    if (token) return; // Another candidate already won; never replace it.
    if (!isContext(next)) {
      if (!embedded) showMessage('error', 'Could not load tabs. Close this window and reopen Search tabs.');
      return;
    }
    token = candidate;
    clearTimeout(initTimer);
    const { restore, ...fresh } = next;
    setContext(fresh);
    if (restore) resumeHandoff(restore);
    // Firefox exposes runtime but not tabs to embedded extension pages. Poll
    // only this authorized UI there; never relay metadata through the host.
    if (!browser.tabs?.onUpdated) {
      const poll = async () => {
        if (document.visibilityState !== 'hidden') await refresh();
        window.setTimeout(poll, 1000);
      };
      window.setTimeout(poll, 1000);
    } else {
      for (const name of ['onRemoved', 'onCreated', 'onAttached', 'onDetached']) {
        browser.tabs[name]?.addListener(() => { refresh(); });
      }
      browser.tabs.onUpdated.addListener((_id, changes) => {
        if ('title' in changes || 'url' in changes) refresh();
      });
    }
  }

  async function refresh(afterClose = false) {
    // The closing transaction owns its final refresh. Tab events raised during
    // removal must not supersede it and unlock an out-of-date result list.
    if (!token || (closing && !afterClose)) return false;
    const version = ++refreshVersion;
    try {
      const next = await send({ command: 'getSearchContext', token });
      if (version !== refreshVersion) return false;
      if (!isContext(next)) throw new Error('Invalid search context');
      setContext(next);
      return true;
    } catch {
      if (version !== refreshVersion) return false;
      showMessage('error', 'Could not refresh tabs. Close and reopen search to retry.');
      return false;
    }
  }

  // Website access is granted only from Settings; recheck when the user returns.
  function recheckAccess() {
    if (token && context && !context.contentPermission && !closing) refresh();
  }

  async function activate() {
    const target = results[selected];
    if (!token || !target || busy) return;
    const history = target.kind === 'history';
    busy = true;
    try {
      const response = await send(history
        ? { command: 'activateHistoryResult', token, url: target.tab.url }
        : { command: 'activateSearchTab', token, tabId: target.tab.id });
      if (!response?.ok) throw new Error('Activation failed');
      // The backend switches or opens the page and closes this search surface.
    } catch {
      await refresh();
      showMessage('error', history
        ? 'That page could not be opened. Choose another result or reopen search.'
        : 'That tab could not be selected. Choose another result or reopen search.');
    } finally {
      busy = false;
    }
  }

  async function openSettings() {
    if (!token || enableButton.hidden) return;
    let response;
    try { response = await send({ command: 'openSearchPermissions', token }); } catch { /* Reported below. */ }
    if (response?.ok !== true) showMessage('error', "Could not open Settings. Open Aaron's Tab Vacuum Settings to allow website access.");
  }

  function describeClose(tabIds, response, titles) {
    const closed = idList(response.closedIds).length;
    const skipped = Array.isArray(response.skipped) ? response.skipped.filter(s => Number.isInteger(s?.tabId)) : [];
    const failed = idList(response.failedIds).length;
    if (!skipped.length && !failed) return `Closed ${plural(closed, 'tab')}.`;
    const parts = [`Closed ${closed} of ${plural(tabIds.length, 'tab')}.`];
    if (skipped.length) {
      const reasons = { pinned: 'pinned tab', audible: 'playing audio', 'last-tab': 'last tab in its window',
        unavailable: 'no longer in this search', changed: 'changed while closing' };
      const named = skipped.slice(0, MAX_LISTED_SKIPS).map(({ tabId, reason }) =>
        `${titles.get(tabId) ?? 'A tab'} (${reasons[reason] || 'could not be closed'})`);
      const more = skipped.length - named.length;
      parts.push(`Skipped ${skipped.length}: ${named.join(', ')}${more ? `, and ${more} more` : ''}.`);
    }
    if (failed) parts.push(`${plural(failed, 'tab')} could not be closed.`);
    return parts.join(' ');
  }

  // Where focus is, as the replacement for a closing host should restore it.
  function focusState() {
    const focus = document.activeElement;
    if (focus === query) return { focus: 'query' };
    if (focus === closeButton) return { focus: 'close-tabs' };
    if (isRowClose(focus)) return { focus: 'row-close', focusTabId: Number(focus.dataset.closeId) };
    return { focus: 'list' };
  }

  function beginClose() {
    busy = true;
    closing = true;
    awaitingClose = true;
    ++refreshVersion; // Discard any context request started before this close.
    notice = null;
    paint();
  }

  // Closes exactly the listed tab IDs asked for. Mode and focus stay where they are.
  async function closeTabs(requested) {
    if (!token || !context || busy) return;
    const listedTabs = results.filter(isTab).map(({ tab }) => tab);
    const listed = new Set(listedTabs.map(tab => tab.id));
    const tabIds = requested.filter(id => listed.has(id));
    if (!tabIds.length) return;
    const titles = new Map(listedTabs.map(tab => [tab.id, tabLabel(tab)]));
    const request = { command: 'closeSearchTabs', token, tabIds };
    // Closing the page this search is embedded in moves search elsewhere
    // first; the backend restores this state there, never in the page.
    if (embedded && tabIds.includes(context.currentTabId)) {
      request.state = { query: query.value, mode, sources: { ...sources }, highlight: selectedKey() ?? '',
        checked: [...checked], order: displayedTabIds(), ...focusState() };
    }
    beginClose();
    let response;
    try { response = await send(request); } catch { /* Reported below. */ }
    if (response?.handedOff === true) { retire(); return; }
    await finishClose(tabIds, response, titles);
  }

  const displayedTabIds = () => [...displayOrder.keys()].filter(key => key.startsWith('tab:')).map(key => Number(key.slice(4)));

  // The replacement search now owns the session and the outcome. Nothing
  // queued here may act, and this frame is about to be removed.
  function retire() {
    retired = true;
    token = undefined;
    pendingListKeys.length = 0;
    clearTimeout(sourceTimer);
    sourceBusy = false;
    showMessage('notice', 'Search moved to another tab.');
  }

  // Continues a close started by the search this one replaced: same query,
  // mode, sources, highlight, checks and focus. Keys queued there do not
  // carry over. The backend closes the tabs once this reports ready.
  async function resumeHandoff(raw) {
    const state = raw && typeof raw === 'object' ? raw : {};
    const tabIds = idList(state.closing);
    pendingListKeys.length = 0;
    query.value = typeof state.query === 'string' ? state.query : '';
    sources.history = state.sources?.history === true && !context.incognito;
    sources.content = state.sources?.content === true && context.contentPermission;
    mode = MODE_LABELS[state.mode] === undefined ? 'tabs' : state.mode;
    checked.clear();
    if (mode === 'select') for (const id of idList(state.checked)) checked.add(id);
    // The order the user saw, so the row taking the closed one's place is the
    // same one, whatever the browser activated meanwhile.
    displayOrder = new Map(idList(state.order).map((id, index) => [`tab:${id}`, index]));
    const highlight = typeof state.highlight === 'string' && state.highlight ? state.highlight : undefined;
    const focusTabId = state.focus === 'row-close' && Number.isInteger(state.focusTabId) ? state.focusTabId : undefined;
    const closingIds = new Set(tabIds);
    // Rows that only History or Contents list are not here yet.
    held = extrasOn() && sourceQuery() ? {
      checked: new Set(checked),
      highlight: highlight && !closingIds.has(Number(highlight.slice(4))) ? highlight : undefined,
      focusTabId: closingIds.has(focusTabId) ? undefined : focusTabId,
    } : null;
    render(highlight, 0);
    // Never arm a row that merely took the place of one not yet listed.
    highlightCloseReady = highlight === undefined || selectedKey() === highlight;
    const rowFocus = focusTabId === undefined ? null
      : rowCloses.find(close => close && Number(close.dataset.closeId) === focusTabId);
    const control = state.focus === 'query' ? query : state.focus === 'close-tabs' && mode === 'select' ? closeButton : rowFocus;
    (control ?? (mode === 'search' ? query : list)).focus();
    if (mode !== 'search') announce(MODE_LABELS[mode]);
    const titles = new Map(context.tabs.map(tab => [tab.id, tabLabel(tab)]));
    beginClose();
    let response;
    try { response = await send({ command: 'searchHandoffReady', token }); } catch { /* Reported below. */ }
    await finishClose(tabIds, response, titles);
  }

  async function finishClose(tabIds, response, titles) {
    // Sent once. A failure is reported, never retried automatically.
    const ok = response?.ok === true && Array.isArray(response.closedIds);
    const bundled = ok && isContext(response.context);
    if (ok) {
      const gone = new Set(idList(response.closedIds));
      for (const id of gone) { checked.delete(id); held?.checked.delete(id); }
      notice = describeClose(tabIds, response, titles);
      // Remove confirmed closures even if the following refresh fails.
      setContext(bundled ? response.context : { ...context, tabs: context.tabs.filter(tab => !gone.has(tab.id)) });
    } else {
      notice = response?.handoffFailed === true
        ? 'Search could not stay open after closing this tab, so no tabs were closed.'
        : response?.cancelled === true ? 'Closing was cancelled. No tabs were closed.'
          : 'Could not close tabs. Check the list and try again.';
    }
    awaitingClose = false;
    // The reply usually carries the fresh list. Otherwise read it once; the
    // close itself is never sent again.
    const refreshed = bundled || await refresh(true);
    closing = false;
    busy = false;
    if (!refreshed) notice = `${notice} The list may be out of date. Close and reopen search.`;
    if (!refreshed || response?.ok !== true || response.skipped?.length || response.failedIds?.length) pendingListKeys.length = 0;
    showStatus();
    paint();
    announce(notice);
    // One source refresh once the list is final, never during the close.
    if (extrasOn()) scheduleSources(0);
    drainListKeys();
  }

  async function dismiss() {
    // Dismissal carries no capability, query or results. The isolated host
    // accepts this signal only from its own extension-origin frame, even if
    // initialization failed or the session has expired.
    if (embedded) {
      window.parent.postMessage({ type: 'tabvacuum:escape' }, '*');
      return;
    }
    if (!token) { window.close(); return; }
    try {
      const response = await send({ command: 'dismissSearch', token });
      if (response?.error || response?.ok === false) throw new Error('Dismiss failed');
    } catch {
      showMessage('error', 'Could not close search. Click outside it or close the window.');
    }
  }

  // Escape steps back one mode at a time: select → tabs → search → dismiss.
  function back() {
    if (mode === 'select') { setMode('tabs'); list.focus(); } else if (mode === 'tabs') { setMode('search'); query.focus(); } else dismiss();
  }

  // Focus never leaves the dialog. Only the highlighted row's close button is
  // a stop, so long lists don't add a stop per row. Search in comes last, so
  // Tab from the query still enters the tab menu. An open menu keeps Tab
  // among its own controls until it closes.
  function focusOrder() {
    if (menuOpen) return [...menuControls.filter(control => !control.disabled && !control.hidden), trigger];
    const order = [query];
    if (results.length || mode !== 'search') order.push(list);
    if (rowCloses[selected]) order.push(rowCloses[selected]);
    order.push(selectButton);
    if (mode === 'select') order.push(closeButton);
    order.push(trigger);
    return order;
  }

  function setMenu(open) {
    menuOpen = open;
    paintSources();
  }

  function moveFocus(backward) {
    pendingListKeys.length = 0;
    const order = focusOrder();
    const current = order.indexOf(document.activeElement);
    const next = current === -1 ? order.at(backward ? -1 : 0) :
      order[(current + (backward ? -1 : 1) + order.length) % order.length];
    if (next === list && mode === 'search') setMode('tabs');
    next.focus();
  }

  function onQueryInput() {
    if (composing) return;
    held = null;
    displayOrder = new Map(); // A new query is ranked afresh.
    checked.clear();
    pendingListKeys.length = 0;
    highlightCloseReady = true;
    notice = null;
    // Open-tab matches show at once; extra sources follow for this query only.
    extras = noExtras();
    sourceBusy = Boolean(sourceQuery());
    render();
    scheduleSources();
  }

  // Pointer or keyboard, returning to the query means searching again.
  query.addEventListener('focus', () => setMode('search'));
  query.addEventListener('blur', () => { composing = false; });
  query.addEventListener('compositionstart', () => { composing = true; });
  query.addEventListener('compositionend', () => { composing = false; onQueryInput(); });
  query.addEventListener('input', onQueryInput);

  function drainListKeys() {
    while (!busy && pendingListKeys.length) {
      const next = pendingListKeys.shift();
      if (document.activeElement !== list || mode !== next.mode || query.value !== next.query) {
        pendingListKeys.length = 0;
        return;
      }
      onListKey({ preventDefault() {}, repeat: false }, next.key);
    }
  }

  function onListKey(event, key) {
    const selecting = mode === 'select';
    const name = key.length === 1 ? key.toLowerCase() : key;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (busy && plain) {
      event.preventDefault();
      // Only a close owns a replay queue. A failed activation must not leave
      // destructive keystrokes waiting for an unrelated later close.
      if (!closing || event.repeat) return;
      if (name in MOVES || ['x', 'Delete', 'Backspace'].includes(name)) {
        if (pendingListKeys.length < MAX_PENDING_KEYS) pendingListKeys.push({ key: name, mode, query: query.value });
        else {
          pendingListKeys.length = 0;
          highlightCloseReady = false;
          notice = 'Too many pending keys. Wait for closing to finish, then navigate to continue.';
          showStatus();
        }
      } else pendingListKeys.length = 0;
      return;
    }
    // Plain A, or the platform's select-all chord as an alias.
    const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!selecting && name === 'a' && chord && !event.altKey && !event.shiftKey) {
      event.preventDefault(); // Do not select the palette's page text in tab-menu mode.
      return;
    }
    if (selecting && name === 'a' && !event.altKey && !event.shiftKey && (plain || chord)) {
      event.preventDefault();
      if (!event.repeat) checkAll();
      return;
    }
    if (!plain) return; // Browser shortcuts such as Cmd+W stay with the browser.
    if (name in MOVES) {
      event.preventDefault();
      if (awaitingClose) return;
      highlightCloseReady = true;
      select(selected + MOVES[name]);
    } else if (name === 'x' || name === 'Delete' || name === 'Backspace') {
      event.preventDefault();
      // A history highlight has no close target, so this is a no-op there.
      if (!event.repeat) closeTabs(closeTargets());
    } else if (name === 'm') {
      event.preventDefault();
      // Select mode lists open tabs only; with none there is nothing to select.
      if (!event.repeat && (selecting || results.some(isTab))) setMode(selecting ? 'tabs' : 'select');
    } else if (name === ' ' || name === 'Enter') {
      event.preventDefault();
      if (event.repeat || awaitingClose) return;
      if (selecting) toggle(selected);
      else if (name === 'Enter' && context) activate();
    }
  }

  function onQueryKey(event, key) {
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
    event.preventDefault();
    if (!context || busy) return; // Loading or switching: keys are inert, not lost to the page.
    if (key === 'Enter') activate();
    else {
      highlightCloseReady = true;
      select(selected + (key === 'ArrowDown' ? 1 : -1));
    }
  }

  document.addEventListener('keydown', event => {
    event.stopPropagation();
    const key = String(event.key ?? '');
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (key === 'Tab') { event.preventDefault(); moveFocus(event.shiftKey); return; }
    if (key === 'Escape') {
      event.preventDefault();
      if (event.repeat) return;
      // The menu closes first and hands focus back to its trigger; mode stays.
      if (menuOpen) { setMenu(false); trigger.focus(); } else back();
      return;
    }
    const focus = document.activeElement;
    // Buttons and checkboxes handle Enter and Space natively; never act on a hidden highlight.
    if (focus && (nativeControls.includes(focus) || isRowClose(focus))) {
      if (event.repeat && (key === 'Enter' || key === ' ')) event.preventDefault();
      return;
    }
    if (focus === list) onListKey(event, key); else onQueryKey(event, key);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') recheckAccess();
  });

  selectButton.addEventListener('click', () => {
    if (mode === 'select') setMode('tabs');
    else if (results.some(isTab)) setMode('select');
    else return;
    list.focus();
  });
  closeButton.addEventListener('click', () => { if (mode === 'select') closeTabs(closeTargets()); });
  historyToggle.addEventListener('change', () => setSource('history', historyToggle.checked));
  contentToggle.addEventListener('change', () => setSource('content', contentToggle.checked));
  enableButton.addEventListener('click', openSettings);
  trigger.addEventListener('click', () => setMenu(!menuOpen));
  // Pointer toggles keep focus (and typing) where it was.
  menu.addEventListener('mousedown', event => event.preventDefault());
  // Any other press inside the palette light-dismisses the open menu.
  palette.addEventListener('mousedown', event => {
    swallowClick = menuOpen && !menu.contains(event.target) && !trigger.contains(event.target);
    if (swallowClick) setMenu(false);
  });
  palette.addEventListener('click', event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  list.addEventListener('mousedown', event => event.preventDefault()); // Keep focus where it is.
  list.addEventListener('click', event => {
    pendingListKeys.length = 0;
    if (!context) return;
    // A row's X closes that row only: never activates, toggles, or widens to the checked set.
    const closer = event.target.closest('[data-close-id]');
    if (closer) { closeTabs([Number(closer.dataset.closeId)]); return; }
    const option = event.target.closest('[data-index]');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (mode === 'select') { toggle(index); list.focus(); return; }
    if (busy) return;
    select(index, false);
    activate();
  });

  // Restore focus only if it was lost, never away from a focused control.
  window.addEventListener('focus', () => {
    const controls = [query, list, ...nativeControls, ...rowCloses.filter(Boolean)];
    if (!controls.includes(document.activeElement)) (mode === 'search' ? query : list).focus();
    recheckAccess();
  });
  showMessage('loading', 'Loading tabs…');
  showPlatform();
  paint();

  // Embedded Firefox pages may lack getPlatformInfo; the navigator guess stands then.
  try {
    browser.runtime.getPlatformInfo?.().then(info => {
      if (info?.os) { mac = info.os === 'mac'; showPlatform(); }
    }, () => {});
  } catch { /* Keep the guess. */ }

  if (embedded) {
    // Untrusted until the backend accepts the token. Only the direct parent may offer one.
    window.addEventListener('message', event => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data && typeof data === 'object' && data.type === INIT_TYPE) tryToken(data.token);
    });
    initTimer = setTimeout(() => {
      if (!token) showMessage('error', 'Could not load tabs. Click outside search and reopen it.');
    }, INIT_TIMEOUT_MS);
  } else {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) tryToken(fromUrl);
    else showMessage('error', 'Could not load tabs. Close this window and reopen Search tabs.');
  }

  query.focus();
}

if (globalThis.browser?.runtime && globalThis.document?.getElementById('query')) {
  startSearch({ document, window, browser });
}
