import {
  SOURCE_NAMES, composeSearchResults, differsFromDefault, normalizeSources, scopeSources, scopeSuggestions, scopeWord, startingSources,
} from './search-sources-core.js';
import { rankTabs } from './search-core.js';

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
const isTab = result => Boolean(result) && (result.kind ?? 'tab') === 'tab';
const whole = value => Number.isInteger(value) && value >= 0 ? value : 0;
const noExtras = () => ({ query: '', bookmarks: [], history: [], content: [], coverage: {}, counts: { bookmarks: null, history: null } });
const SOURCE_LABELS = { tabs: 'Tabs', bookmarks: 'Bookmarks', history: 'History', content: 'Contents' };
const TIPS = {
  tabs: 'Tip: type @t to search only open tabs', bookmarks: 'Tip: type @b to search only bookmarks',
  history: 'Tip: type @h to search only history', content: 'Tip: type @c to search only page contents',
};
const BOOKMARK_PERMISSION = { permissions: ['bookmarks'] };

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
  const bookmarks = wanted.bookmarks && ok && state('bookmarks').state === 'ready' && Array.isArray(response.bookmarks) ? response.bookmarks
    .filter(item => typeof item?.url === 'string' && item.url && (typeof item.id === 'string' || Number.isInteger(item.id)))
    .map(item => ({ id: String(item.id), url: item.url, title: typeof item.title === 'string' ? item.title : '',
      path: typeof item.path === 'string' ? item.path : '', folders: Number.isInteger(item.folders) ? item.folders : 0 })) : [];
  const raw = ok && response.counts && typeof response.counts === 'object' ? response.counts : {};
  const count = value => (value && Number.isInteger(value.count) && value.count >= 0 ? value : null);
  const marks = count(raw.bookmarks);
  const visits = count(raw.history);
  const counts = {
    bookmarks: marks && { count: marks.count, limited: marks.limited === true },
    history: visits && { count: visits.count, limited: visits.limited === true,
      withBookmarks: Number.isInteger(visits.withBookmarks) && visits.withBookmarks >= 0 ? visits.withBookmarks : visits.count },
  };
  const history = wanted.history && ok && Array.isArray(response.history) ? response.history
    .filter(item => typeof item?.url === 'string' && item.url)
    .map(item => ({ url: item.url, title: typeof item.title === 'string' ? item.title : '', lastVisitTime: item.lastVisitTime })) : [];
  // Without website access no snippet survives, whatever else the reply holds.
  const content = wanted.content && ok && state('content').state !== 'permission' && Array.isArray(response.content) ? response.content
    .filter(item => Number.isInteger(item?.tabId) && typeof item.snippet === 'string')
    .map(item => ({ tabId: item.tabId, url: typeof item.url === 'string' ? item.url : '', snippet: item.snippet })) : [];
  return { query, bookmarks, history, content, counts,
    coverage: { bookmarks: state('bookmarks'), history: state('history'), content: state('content') } };
}

function bookmarkPhrase(coverage = {}) {
  if (coverage.state === 'permission') return 'Bookmarks: access needed';
  if (coverage.state === 'error') return 'Bookmarks: unavailable';
  if (coverage.state === 'ready' && coverage.limited) return 'Bookmarks: best 50 matches';
  return '';
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
  const sourceButtons = Object.fromEntries(SOURCE_NAMES.map(name => [name, $(`source-${name}`)]));
  const saveButton = $('save-default');
  const toolbarControls = [...Object.values(sourceButtons), saveButton];
  const enableBookmarks = $('enable-bookmarks');
  const enableButton = $('enable-content');
  const includeLine = $('include-line');
  const includeButton = $('include-sources');
  const chip = $('scope-chip');
  const chipRemove = $('scope-chip-remove');
  const scopeList = $('scope-list');
  const tip = $('tip');
  const sourceStatus = $('source-status');
  // Enter and Space belong to these natively.
  const nativeControls = [selectButton, closeButton, ...toolbarControls, enableBookmarks, enableButton, includeButton, chipRemove];
  // Firefox gives a framed extension page no permissions API, so the
  // request can only start here where the API exists (R15).
  const permissionsApi = browser.permissions;
  const canRequest = typeof permissionsApi?.request === 'function';
  const embedded = window.parent !== window;
  const tried = new Set();
  // Checked tab IDs in select mode. Highlight (`selected`) is separate.
  const checked = new Set();
  // Explicit list keystrokes arriving during a close are applied in order, not
  // dropped. Focus/mode changes and partial failures cancel the pending sequence.
  const pendingListKeys = [];
  const MAX_PENDING_KEYS = 64;
  // Starts from the saved default once the first context arrives (R15).
  const sources = { tabs: true, bookmarks: false, history: false, content: false };
  let sourcesChosen = false;
  // A scope word's chip: { entry, before } where before is what the row showed.
  let scope = null;
  // Backspace right after a conversion puts this text back (R15).
  let restoreLiteral = null;
  // A scope word the user chose to search as plain text.
  let literalPrefix = null;
  let scopeOpen = false;
  let scopeIndex = 0;
  let scopeDismissed = null;
  // Sources the user tried to turn on that still need access.
  const needsAccess = new Set();
  // After "Include them", no row is armed until the user moves (R15).
  let noHighlight = false;
  let roving = 0;
  let hintsNoted = false;
  let shownTips = new Set();
  let bookmarkedIds = new Set();
  let mixedList = false;
  let extras = noExtras();
  let sourceGeneration = 0;
  let sourceBusy = false;
  let sourceTimer;
  // A sent, unanswered request (its generation), and whether it was told to stop.
  let sourceInFlight = 0;
  let cancelSent = false;
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
  let failure = null;
  let mac = guessMac(window.navigator);
  let refreshVersion = 0;
  let announceTimer;
  let initTimer;

  const send = payload => browser.runtime.sendMessage(payload);
  const extrasOn = () => sources.bookmarks || sources.history || sources.content;
  const allowed = name => Boolean(context) && (name === 'tabs' || (name === 'bookmarks' ? context.bookmarkPermission
    : name === 'history' ? !context.incognito : context.contentPermission));
  // Off sources counted per settled query: cheap ones only, never Contents.
  const countWanted = () => ({
    bookmarks: Boolean(context?.bookmarkPermission) && !sources.bookmarks,
    history: Boolean(context) && !context.incognito && !sources.history,
  });
  const counting = () => { const c = countWanted(); return c.bookmarks || c.history; };
  // A bare @ prefix (`@`, `@b`) is a scope word being typed: nothing is ranked or counted on it.
  const barePrefix = () => {
    const text = query.value.trim();
    return text !== literalPrefix && text !== scopeDismissed && scopeSuggestions(text).length > 0;
  };
  const searchText = () => (barePrefix() ? '' : query.value.trim());
  // Over-long queries are never truncated and sent as if complete.
  const sourceQuery = () => {
    const text = searchText();
    return token && (extrasOn() || counting()) && text.length <= MAX_SOURCE_QUERY ? text : '';
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

  // Matches each off source would add for the current query: Tabs counted
  // here, Bookmarks and History from the reply for this exact query only.
  // `together` counts History as included along with Bookmarks, as the
  // empty-list action does, so a page is never counted twice (R15.5).
  function offCounts({ together = false } = {}) {
    const text = searchText();
    const out = [];
    if (!context || !text) return out;
    const item = (name, n, limited, word) => ({ name, n, limited, label: `${n}${limited ? '+' : ''}`,
      text: limited ? `${n}+ ${word}s` : plural(n, word) });
    if (!sources.tabs) {
      const n = rankTabs(context.tabs, text).length;
      if (n) out.push(item('tabs', n, false, 'open tab'));
    }
    if (extras.query !== text) return out;
    const { bookmarks, history } = extras.counts;
    const addsBookmarks = !sources.bookmarks && bookmarks?.count > 0;
    if (addsBookmarks) out.push(item('bookmarks', bookmarks.count, bookmarks.limited, 'bookmark'));
    const visits = together && addsBookmarks ? history?.withBookmarks : history?.count;
    if (!sources.history && visits) out.push(item('history', visits, history.limited, 'history page'));
    return out;
  }

  // "No open tabs match. 3 bookmarks and 12 history pages do."
  function includeOffer() {
    const found = offCounts({ together: true });
    if (!found.length || results.length || sourceBusy) return null;
    const names = { tabs: 'open tabs', bookmarks: 'bookmarks', history: 'history pages', content: 'page contents' };
    const on = SOURCE_NAMES.filter(name => sources[name]).map(name => names[name]).join(' or ');
    const list = found.map(item => item.text);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0];
    const one = found.length === 1 && found[0].n === 1;
    return { names: found.map(item => item.name), text: `No ${on} match. ${joined} ${one ? 'does' : 'do'}.` };
  }

  // An activation failure, then the empty state or a sticky close notice, otherwise nothing.
  function showStatus() {
    if (failure) { includeLine.hidden = true; showMessage('error', failure); return; }
    const typed = Boolean(searchText());
    const offer = !notice && typed ? includeOffer() : null;
    includeLine.hidden = !offer;
    if (offer) includeButton.textContent = 'Include them';
    if (notice) showMessage('notice', notice);
    else if (!results.length && typed && sourceBusy) showMessage('loading', 'Searching…');
    else if (offer) showMessage('empty', offer.text);
    else if (!results.length && typed && (extrasOn() || !sources.tabs)) showMessage('empty', 'No matches. Try different words.');
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

  const extraNames = () => [sources.bookmarks && 'bookmarks', sources.history && 'history', sources.content && 'contents'].filter(Boolean);
  const andList = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '');

  function sourceText() {
    if (!context || !extrasOn()) return '';
    const names = andList(extraNames());
    const text = searchText();
    if (!text) return `Type to search ${names}`;
    if (text.length > MAX_SOURCE_QUERY) return `Bookmarks, history and contents support queries up to ${MAX_SOURCE_QUERY} characters`;
    if (sourceBusy) return `Searching ${names}…`;
    return [
      sources.bookmarks && bookmarkPhrase(extras.coverage.bookmarks),
      sources.history && historyPhrase(extras.coverage.history),
      sources.content && contentPhrase(extras.coverage.content),
    ].filter(Boolean).join(' · ');
  }

  // The visible count on an off source's button, e.g. "3" or "100+".
  function countLabel(name) {
    if (sources[name] || name === 'content') return '';
    const found = offCounts().find(item => item.name === name);
    if (!found) return '';
    return found.label;
  }

  // Each button's accessible description: never its name, never announced per keystroke.
  function sourceDescription(name) {
    if (!context) return '';
    if (name === 'history' && context.incognito) return 'Not searched in private windows';
    if (!allowed(name)) return name === 'bookmarks' ? 'Needs bookmark access' : 'Needs website access';
    if (sources[name]) return 'On';
    if (name === 'content') return 'Search page contents';
    const count = countLabel(name);
    return count ? `${count} more ${count === '1' ? 'match' : 'matches'}` : 'Off';
  }

  const visibleToolbar = () => toolbarControls.filter(control => !control.hidden);
  const rovingControl = () => { const list = visibleToolbar(); return list[Math.min(roving, list.length - 1)]; };

  function paintSources() {
    const ready = Boolean(context);
    for (const [name, button] of Object.entries(sourceButtons)) {
      const on = sources[name];
      button.setAttribute('aria-pressed', String(on));
      button.dataset.state = on ? 'on' : ready && !allowed(name) ? 'locked' : 'off';
      $(`source-${name}-badge`).textContent = countLabel(name);
      $(`source-${name}-count`).textContent = sourceDescription(name);
    }
    $('bookmarks-new').hidden = !(ready && context.hints?.bookmarksNew);
    saveButton.hidden = !ready || !differsFromDefault(sources, context.defaultSources);
    // One tab stop in the toolbar, on the control last moved to.
    const stop = rovingControl();
    for (const control of toolbarControls) control.tabIndex = control === stop ? 0 : -1;
    chip.hidden = !scope;
    $('scope-chip-label').textContent = scope?.entry.label ?? '';
    chipRemove.setAttribute('aria-label', scope ? `Remove filter: ${scope.entry.label.toLowerCase()}` : 'Remove filter');
    // Enable actions show only for a source the user asked for.
    $('bookmarks-access').hidden = !needsAccess.has('bookmarks') || !ready || context.bookmarkPermission;
    $('content-access').hidden = !needsAccess.has('content') || !ready || context.contentPermission;
    $('history-private-note').hidden = !needsAccess.has('history') || !ready || !context.incognito;
    $('source-access').hidden = ['bookmarks-access', 'content-access', 'history-private-note'].every(id => $(id).hidden);
    enableBookmarks.textContent = canRequest ? 'Allow bookmarks' : 'Enable in Settings';
    $('bookmarks-access-note').textContent = canRequest
      ? "Search only reads bookmarks; the browser's prompt also mentions changing them."
      : "Search only reads bookmarks; the browser's prompt also mentions changing them. Opens Settings in a new tab.";
    // A control that hid under focus hands it back to the query.
    const focus = document.activeElement;
    // Only the source controls; mode changes own focus for the list and header buttons.
    if ([saveButton, enableBookmarks, enableButton, includeButton, chipRemove].includes(focus) && !isShown(focus)) query.focus();
    palette.dataset.sources = SOURCE_NAMES.filter(name => sources[name]).join(' ');
    const names = [sources.tabs && 'tabs', ...extraNames()].filter(Boolean);
    query.placeholder = `Search ${andList(names)} · type @ for more`;
    sourceStatus.textContent = sourceText();
    sourceStatus.dataset.busy = String(sourceBusy);
    paintScopeList();
  }

  // Whether a control is on screen: it and the panel holding it are shown.
  const holders = () => new Map([[includeButton, [includeLine]], [enableBookmarks, [$('bookmarks-access'), $('source-access')]],
    [enableButton, [$('content-access'), $('source-access')]], [chipRemove, [chip]]]);
  const isShown = element => Boolean(element) && !element.hidden && !(holders().get(element) ?? []).some(holder => holder.hidden);

  // The @ list: a second popup for the combobox, wired only while open.
  function paintScopeList() {
    const options = scopeOpen ? scopeSuggestions(query.value.trim()) : [];
    scopeList.hidden = !options.length;
    scopeIndex = Math.max(0, Math.min(scopeIndex, options.length - 1));
    scopeList.replaceChildren(...options.map((entry, index) => {
      const option = el('li', 'scope-option');
      option.id = `scope-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === scopeIndex));
      option.dataset.scope = entry.word;
      option.append(el('kbd', 'scope-word', `@${entry.word}`), el('span', 'scope-short', `@${entry.short}`), el('span', 'scope-label', entry.label));
      return option;
    }));
    if (options.length) {
      query.setAttribute('aria-controls', 'scope-list');
      query.setAttribute('aria-haspopup', 'listbox');
      query.setAttribute('aria-activedescendant', `scope-option-${scopeIndex}`);
    } else {
      query.setAttribute('aria-controls', 'results');
      query.setAttribute('aria-haspopup', 'grid');
    }
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
    const target = results[selected];
    const page = Boolean(target) && !isTab(target);
    palette.dataset.mode = mode;
    palette.dataset.target = page ? 'history' : 'tab';
    for (const id of ['enter-search', 'enter-tabs']) $(id).textContent = page && target.openTabId === undefined ? 'Open page' : 'Switch';
    // Without tab rows there is nothing to close or select (R15).
    const tabRows = results.some(isTab);
    for (const id of ['hint-close-tab', 'hint-select-tabs']) $(id).hidden = !tabRows;
    list.setAttribute('aria-multiselectable', String(selecting));
    list.setAttribute('aria-describedby', selecting ? 'select-help' : 'tabs-help');
    for (const name of Object.keys(MODE_LABELS)) $(`hints-${name}`).hidden = name !== mode;
    modeIndicator.textContent = MODE_LABELS[mode];
    modeIndicator.hidden = mode === 'search';
    $('selection-status').textContent = selecting
      ? `${shownChecked()} of ${results.length} selected${hiddenHistory ? ' · Only open tabs can be selected' : ''}`
      : '';
    selectButton.textContent = selecting ? 'Done' : 'Select multiple';
    selectButton.hidden = !selecting && !tabRows;
    selectButton.setAttribute('aria-disabled', 'false');
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
    noHighlight = false;
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
  function row({ tab, matchType, kind, snippet, path, folders, openTabId }) {
    // History and bookmark rows are pages: opened, never closed or selected.
    const history = kind === 'history' || kind === 'bookmark';
    const wrapper = el('div', kind === 'bookmark' ? 'result result-history result-bookmark' : history ? 'result result-history' : 'result');
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
    if (kind === 'bookmark') badges.push(['Bookmark', 'badge badge-source badge-bookmark']);
    else if (history) badges.push(['History', 'badge badge-source badge-history']);
    if (history && openTabId !== undefined) badges.push(['Open', 'badge badge-open']);
    if (!history) {
      // Each row names its source once the list mixes sources (R15).
      if (mixedList) badges.push(['Tab', 'badge badge-source badge-tab']);
      if (bookmarkedIds.has(tab.id)) {
        const star = el('span', 'star', '★');
        star.setAttribute('aria-hidden', 'true');
        line.append(star, el('span', 'sr-only', 'Bookmarked'));
      }
      if (matchType === 'url') badges.push(['URL match', 'badge badge-match']);
      if (tab.windowId !== context.windowId) badges.push(['Other window', 'badge']);
      if (tab.id === context.currentTabId) badges.push(['Current', 'badge']);
    }
    for (const [badge, className] of badges) line.append(el('span', className, badge));
    const text = el('div', 'text');
    text.append(line, el('div', 'url', tab.url || 'Address unavailable'));
    if (kind === 'bookmark' && path) text.append(el('div', 'path', folders ? `${path} · +${plural(folders, 'folder')}` : path));
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
  const rowSignature = ({ tab, matchType, kind, snippet, path, folders, openTabId }) => JSON.stringify([kind, matchType, tab.title, tab.url,
    isTab({ kind }) ? snippet : '', tab.windowId !== context.windowId, tab.id === context.currentTabId,
    isTab({ kind }) && bookmarkedIds.has(tab.id), path, folders, openTabId, isTab({ kind }) && mixedList]);

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
  const groups = { tabs: group('Open tabs'), bookmarks: group('Bookmarks'), history: group('History') };
  const groupOf = result => (isTab(result) ? 'tabs' : result.kind === 'bookmark' ? 'bookmarks' : 'history');

  // Open tabs always come first; content matches only for tabs still open.
  function compose() {
    const text = searchText();
    const fresh = extrasOn() && Boolean(text) && extras.query === text;
    const open = new Set(context.tabs.map(tab => tab.id));
    return composeSearchResults({
      tabs: context.tabs,
      query: text,
      currentTabId: context.currentTabId,
      sources,
      bookmarks: fresh && sources.bookmarks ? extras.bookmarks : [],
      history: fresh && sources.history ? extras.history : [],
      content: fresh && sources.content ? extras.content.filter(item => open.has(item.tabId)) : [],
    });
  }

  // Keeps rows already shown in their displayed order; rows new to this
  // query follow in ranked order. Open tabs stay ahead of history.
  function arrange(composed) {
    if (!displayOrder.size) return composed;
    const known = composed.map((result, index) => ({ result, index, at: displayOrder.get(result.key) ?? Infinity }));
    const group = name => known.filter(item => groupOf(item.result) === name)
      .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at)).map(item => item.result);
    return [...group('tabs'), ...group('bookmarks'), ...group('history')];
  }

  function render(preserveKey, fallbackIndex = 0) {
    if (!context) return;
    // Rebuilding rows removes a focused row button; put focus back afterwards.
    const focusedClose = isRowClose(document.activeElement) ? document.activeElement : null;
    const focusedTabId = focusedClose ? Number(focusedClose.dataset.closeId) : undefined;
    const typed = Boolean(searchText());
    const all = arrange(compose());
    // The first source reply must still see the transferred positions of
    // content-only rows that are not in this initial title/URL list.
    if (!held) displayOrder = new Map(all.map((result, index) => [result.key, index]));
    results = mode === 'select' ? all.filter(isTab) : all;
    hiddenHistory = all.length - results.length;
    mixedList = results.some(isTab) && results.some(result => !isTab(result));
    const shown = new Set(results.filter(isTab).map(result => result.tab.id));
    for (const id of checked) if (!shown.has(id) && !held?.checked.has(id)) checked.delete(id);
    const rowsBy = { tabs: [], bookmarks: [], history: [] };
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
      rowsBy[groupOf(result)].push(entry.wrapper);
    }
    rowCache = cache;
    const tabCount = rowsBy.tabs.length;
    const markCount = rowsBy.bookmarks.length;
    const historyCount = rowsBy.history.length;
    // A heading only when there is more than one group.
    const mixed = [tabCount, markCount, historyCount].filter(Boolean).length > 1;
    for (const [name, { element, heading }] of Object.entries(groups)) {
      heading.hidden = name === 'tabs' && !mixed;
      setChildren(element, [heading, ...rowsBy[name]]);
    }
    setChildren(list, Object.keys(groups).filter(name => rowsBy[name].length).map(name => groups[name].element));
    list.setAttribute('aria-busy', 'false');
    $('list-label').textContent = typed ? 'Matches' : 'Recent tabs';
    const countText = [(tabCount || (!markCount && !historyCount)) && plural(tabCount, 'tab'),
      markCount && plural(markCount, 'bookmark'), historyCount && `${historyCount} history`].filter(Boolean).join(' · ');
    $('result-count').textContent = countText;
    showStatus();
    const kept = results.findIndex(result => result.key === preserveKey);
    if (noHighlight) { selected = -1; highlightCloseReady = false; paint(); } else select(kept === -1 ? fallbackIndex : kept);
    if (focusedClose) {
      const sameIndex = results.findIndex(result => isTab(result) && result.tab.id === focusedTabId);
      // Only our own close may carry X-button focus onto a different tab.
      const nextClose = sameIndex >= 0 ? rowCloses[sameIndex] : closing ? rowCloses[selected] : null;
      (nextClose ?? (mode === 'search' ? query : list)).focus();
    }
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const found = [plural(tabCount, 'tab'), markCount && plural(markCount, 'bookmark'), historyCount && plural(historyCount, 'history result')].filter(Boolean);
      announcement.textContent = `${andList(found)} found`;
    }, 180);
  }

  // Debounced; each new query, toggle, or relevant tab change supersedes any
  // request in flight. Nothing is sent unless an extra source is selected.
  function scheduleSources(delay = SOURCE_DELAY_MS) {
    clearTimeout(sourceTimer);
    const generation = ++sourceGeneration;
    const text = sourceQuery();
    // Counting alone shows no "Searching…": counts only repaint the buttons.
    sourceBusy = Boolean(text) && extrasOn();
    // Stop a backend scan for an invalidated query, unless its replacement goes
    // out at once: the backend aborts older queries when a newer one arrives.
    if (!text || delay > 0) cancelSources();
    paintSources();
    if (text) sourceTimer = setTimeout(() => searchSources(generation, text), delay);
  }

  // The backend's stop signal has its own command, since a query with every
  // source off is now a real count request. Sent at most once per request.
  function cancelSources() {
    if (!sourceInFlight || cancelSent || !token) return;
    cancelSent = true;
    try {
      Promise.resolve(send({ command: 'cancelSearchSources', token })).catch(() => {});
    } catch { /* Nothing to recover: the UI already ignores the old reply. */ }
  }

  async function searchSources(generation, text) {
    const wanted = { ...sources };
    const count = countWanted();
    const listing = extrasOn();
    sourceInFlight = generation;
    cancelSent = false;
    let response;
    try {
      response = await send({ command: 'querySearchSources', token, query: text, sources: wanted, count });
    } catch { /* Shown as unavailable. */ }
    if (sourceInFlight === generation) { sourceInFlight = 0; cancelSent = false; }
    if (generation !== sourceGeneration) return;
    sourceBusy = false;
    // A close owns the list until it settles and asks for fresh sources after,
    // so a reply landing mid-close is dropped: queued keys never see it.
    if (closing) { paintSources(); return; }
    extras = acceptSources(response, wanted, text);
    let revoked = false;
    if (wanted.content && extras.coverage.content.state === 'permission') {
      // Access was revoked: drop Contents now rather than waiting for a poll.
      dropSource('content');
      context = { ...context, contentPermission: false };
      revoked = true;
    }
    if (wanted.bookmarks && extras.coverage.bookmarks.state === 'permission') {
      dropSource('bookmarks');
      context = { ...context, bookmarkPermission: false };
      bookmarkedIds = new Set();
      revoked = true;
    }
    if (revoked) keepOneSource();
    // A counts-only reply never re-renders the list or arms a row (R15).
    if (listing || revoked) { if (held) release(); else recompose(selectedKey()); } else showStatus();
    paintSources();
    // Announce the offer only when it is what the screen shows.
    const offer = includeOffer();
    if (offer && !includeLine.hidden) announce(offer.text);
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
    if (name === 'tabs') return;
    extras[name] = [];
    extras.coverage = { ...extras.coverage, [name]: { state: 'off' } };
  }

  // At least one source always stays on.
  function keepOneSource() {
    if (!SOURCE_NAMES.some(name => sources[name])) sources.tabs = true;
  }

  // Turns one source on or off for this search. A source that needs access
  // shows its enable action instead. Returns whether anything changed.
  function setSource(name, on, { fromScope = false } = {}) {
    if (!context) return false;
    // Any action on the sources replaces an old activation failure (R15.5).
    failure = null;
    if (on && !allowed(name)) { needsAccess.add(name); showStatus(); paintSources(); return false; }
    needsAccess.delete(name);
    if (!on && sources[name] && SOURCE_NAMES.filter(other => sources[other]).length === 1) {
      showStatus();
      announce('At least one source stays on.');
      return false;
    }
    if (sources[name] === on) { showStatus(); paintSources(); return false; }
    held = null;
    const before = selectedKey();
    // Keys queued against the old list must not act on the new one.
    pendingListKeys.length = 0;
    if (on) sources[name] = true; else dropSource(name);
    // A button press replaces the chip with the row's own state.
    if (!fromScope) scope = null;
    if (on && name === 'bookmarks') noteBookmarksUsed();
    recompose(before);
    scheduleSources(0);
    return true;
  }

  function onSourceButton(name) {
    if (!context) return;
    setSource(name, !sources[name]);
    showTip(name);
  }

  // A scope word or @ list choice: only that source (or every source for
  // @all) for this search. Sources that need access show their enable action.
  function applyScope(entry) {
    if (!context) return;
    failure = null;
    const before = scope ? scope.before : { ...sources };
    const want = scopeSources(entry.scope);
    for (const name of SOURCE_NAMES) if (want[name] && !allowed(name)) needsAccess.add(name);
    const next = Object.fromEntries(SOURCE_NAMES.map(name => [name, want[name] && allowed(name)]));
    held = null;
    pendingListKeys.length = 0;
    // Nothing usable yet: keep searching what was on until access arrives.
    if (SOURCE_NAMES.some(name => next[name])) {
      for (const name of SOURCE_NAMES) if (next[name]) sources[name] = true; else dropSource(name);
    }
    if (next.bookmarks) noteBookmarksUsed();
    scope = { entry, before };
    announce(`${entry.label}. Backspace removes the filter.`);
  }

  function removeScope() {
    if (!scope) return;
    failure = null;
    const { before } = scope;
    scope = null;
    for (const name of SOURCE_NAMES) {
      needsAccess.delete(name);
      if (before[name] && allowed(name)) sources[name] = true; else dropSource(name);
    }
    keepOneSource();
    announce('Filter removed.');
  }

  // "Include them": adds the counted sources for this search, with no row armed.
  // Acts only on the offer the user can see.
  function include() {
    const offer = includeOffer();
    if (!offer || !context || includeLine.hidden) return;
    failure = null;
    held = null;
    pendingListKeys.length = 0;
    for (const name of offer.names) if (allowed(name)) sources[name] = true;
    if (sources.bookmarks) noteBookmarksUsed();
    scope = null;
    noHighlight = true;
    render();
    scheduleSources(0);
    query.focus();
  }

  function showTip(name) {
    if (!context || shownTips.has(name) || !TIPS[name]) return;
    shownTips.add(name);
    tip.textContent = TIPS[name];
    tip.hidden = false;
    announce(TIPS[name]);
    note({ tip: name });
  }

  function noteBookmarksUsed() {
    if (!context?.hints?.bookmarksNew) return;
    context = { ...context, hints: { ...context.hints, bookmarksNew: false } };
    note({ usedBookmarks: true });
  }

  function note(hints) {
    if (!token) return;
    try { Promise.resolve(send({ command: 'noteSearchHints', token, hints })).catch(() => {}); } catch { /* Hints are best effort. */ }
  }

  function setContext(raw) {
    const hints = raw.hints && typeof raw.hints === 'object' ? raw.hints : {};
    const next = { ...raw, incognito: raw.incognito === true, contentPermission: raw.contentPermission === true,
      bookmarkPermission: raw.bookmarkPermission === true, bookmarked: idList(raw.bookmarked),
      defaultSources: raw.defaultSources && typeof raw.defaultSources === 'object' ? raw.defaultSources : { tabs: true },
      // The New mark is local once shown, so a poll never brings it back.
      hints: { tipsShown: Array.isArray(hints.tipsShown) ? hints.tipsShown : [],
        bookmarksNew: hints.bookmarksNew === true && context?.hints?.bookmarksNew !== false } };
    // Polling must not reset manual scroll or replace rows when nothing changed.
    if (context && JSON.stringify(context) === JSON.stringify(next)) return;
    const previous = results[selected];
    const tabsChanged = !context || contentKey(context) !== contentKey(next);
    const first = !context;
    context = next;
    bookmarkedIds = new Set(next.bookmarked);
    if (first) shownTips = new Set(next.hints.tipsShown);
    if (!sourcesChosen) {
      Object.assign(sources, startingSources(next.defaultSources, next));
      sourcesChosen = true;
    }
    let dropped = false;
    for (const name of ['bookmarks', 'history', 'content']) {
      if (sources[name] && !allowed(name)) {
        dropSource(name);
        dropped = true;
      }
    }
    // Access granted while Search is open: the source the user asked for turns on.
    for (const name of [...needsAccess]) {
      if (!allowed(name) || name === 'history') continue;
      needsAccess.delete(name);
      const want = scope ? scopeSources(scope.entry.scope) : null;
      if (want && !want[name]) continue;
      // A scope that could not apply yet applies in full now.
      if (want) for (const other of SOURCE_NAMES) if (want[other] && allowed(other)) sources[other] = true; else dropSource(other);
      else sources[name] = true;
      if (name === 'bookmarks') noteBookmarksUsed();
      dropped = true;
    }
    if (dropped) { keepOneSource(); pendingListKeys.length = 0; }
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
    // Counts down the Bookmarks "New" mark: one write per launch at most.
    else if (!hintsNoted && context.hints.bookmarksNew) { hintsNoted = true; note({ opened: true }); }
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

  // Access may be granted in Settings or a browser prompt; recheck when the user returns.
  function recheckAccess() {
    if (token && context && (!context.contentPermission || !context.bookmarkPermission) && !closing) refresh();
  }

  async function activate() {
    const target = results[selected];
    if (!token || !target || busy) return;
    const history = !isTab(target);
    busy = true;
    let response;
    try {
      response = await send(target.kind === 'bookmark'
        ? { command: 'activateBookmarkResult', token, bookmarkId: target.bookmarkId }
        : history ? { command: 'activateHistoryResult', token, url: target.tab.url }
          : { command: 'activateSearchTab', token, tabId: target.tab.id });
      if (!response?.ok) throw new Error('Activation failed');
      // The backend switches or opens the page and closes this search surface.
    } catch {
      // The background's own reason for a bookmark (e.g. deleted since it was listed).
      const reason = target.kind === 'bookmark' && typeof response?.error === 'string' && response.error.length <= 200 ? response.error : '';
      // Kept until the next query, source action or close, so a list refresh never hides it.
      failure = reason ? `${reason} Choose another result.` : history
        ? 'That page could not be opened. Choose another result or reopen search.'
        : 'That tab could not be selected. Choose another result or reopen search.';
      await refresh();
      showStatus();
    } finally {
      busy = false;
    }
  }

  async function openSettings() {
    if (!token) return;
    let response;
    try { response = await send({ command: 'openSearchPermissions', token }); } catch { /* Reported below. */ }
    if (response?.ok !== true) showMessage('error', "Could not open Settings. Open Aaron's Tab Vacuum Settings to allow access.");
  }

  // Must run inside the click: the browser accepts the request only as part of
  // the user's own action, so nothing is awaited before it (R15).
  function requestBookmarks() {
    if (!canRequest) { openSettings(); return; }
    let pending;
    try { pending = permissionsApi.request(BOOKMARK_PERMISSION); } catch {
      showMessage('error', 'Could not ask for bookmark access. Allow it in Settings.');
      return;
    }
    Promise.resolve(pending).then(granted => {
      if (granted) refresh(); else announce('Bookmark access was not allowed.');
    }, () => showMessage('error', 'Could not ask for bookmark access. Allow it in Settings.'));
  }

  async function saveDefault() {
    if (!token || !context) return;
    let response;
    try { response = await send({ command: 'saveSearchDefault', token, sources: { tabs: sources.tabs, bookmarks: sources.bookmarks, history: sources.history } }); } catch { /* Reported below. */ }
    if (response?.ok !== true || !response.defaultSources) { showMessage('error', 'Could not save the default sources.'); return; }
    context = { ...context, defaultSources: response.defaultSources };
    const focused = document.activeElement === saveButton;
    paintSources();
    if (focused) rovingControl()?.focus();
    announce('Saved as default.');
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
    failure = null;
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
    // Sources carry over; any that lost access meanwhile drop, as on a poll.
    const carried = normalizeSources(state.sources);
    for (const name of SOURCE_NAMES) sources[name] = carried[name] && allowed(name);
    keepOneSource();
    sourcesChosen = true;
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
  // a stop, so long lists don't add a stop per row. The source toolbar comes
  // last and is one stop, so Tab from the query still enters the tab menu and
  // Shift+Tab from the query reaches the sources (R15).
  function focusOrder() {
    const order = [query];
    if (results.length || mode !== 'search') order.push(list);
    if (rowCloses[selected]) order.push(rowCloses[selected]);
    if (!selectButton.hidden) order.push(selectButton);
    if (mode === 'select') order.push(closeButton);
    for (const control of [includeButton, enableBookmarks, enableButton, chipRemove]) if (isShown(control)) order.push(control);
    const stop = rovingControl();
    if (stop) order.push(stop);
    return order;
  }

  function closeScopeList() {
    scopeOpen = false;
    // A dismissed prefix is plain text from now on, so it is searched.
    scopeDismissed = query.value.trim();
    render(selectedKey(), selected);
    scheduleSources();
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
    const text = query.value.trim();
    if (literalPrefix !== null && !text.startsWith(literalPrefix)) literalPrefix = null;
    if (scopeDismissed !== null && text !== scopeDismissed) scopeDismissed = null;
    const opening = !scope && scopeSuggestions(text).length > 0 && text !== literalPrefix && text !== scopeDismissed;
    if (opening && !scopeOpen) scopeIndex = 0;
    scopeOpen = opening;
    noHighlight = false;
    held = null;
    displayOrder = new Map(); // A new query is ranked afresh.
    checked.clear();
    pendingListKeys.length = 0;
    highlightCloseReady = true;
    notice = null;
    failure = null;
    // Open-tab matches show at once; extra sources follow for this query only.
    extras = noExtras();
    sourceBusy = Boolean(sourceQuery()) && extrasOn();
    render();
    scheduleSources();
  }

  // Pointer or keyboard, returning to the query means searching again.
  query.addEventListener('focus', () => setMode('search'));
  query.addEventListener('blur', () => { composing = false; });
  query.addEventListener('compositionstart', () => { composing = true; });
  query.addEventListener('compositionend', () => { composing = false; onQueryInput(); });
  // A scope word converts only when the whole query so far is one and the
  // user then types a space; never on paste, drop, autocomplete or IME (R15).
  query.addEventListener('input', event => {
    if (composing) return;
    const text = query.value;
    if (event.inputType === 'insertText' && event.data === ' ' && text.endsWith(' ') && (query.selectionStart ?? text.length) === text.length) {
      const entry = text.slice(0, -1) === literalPrefix ? undefined : scopeWord(text.slice(0, -1));
      if (entry) {
        query.value = '';
        applyScope(entry);
        restoreLiteral = text;
        onQueryInput();
        return;
      }
    }
    restoreLiteral = null;
    onQueryInput();
  });

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

  function pickScope(index) {
    const entry = scopeSuggestions(query.value.trim())[index];
    if (!entry) return;
    query.value = '';
    restoreLiteral = null;
    applyScope(entry);
    onQueryInput();
  }

  function onQueryKey(event, key) {
    // Backspace in an empty query: right after a conversion it restores the
    // typed text, searched as plain text; otherwise it removes the chip.
    if (key === 'Backspace' && !query.value && scope && !event.repeat) {
      event.preventDefault();
      const literal = restoreLiteral;
      restoreLiteral = null;
      removeScope();
      if (literal) { query.value = literal; literalPrefix = literal.trim(); }
      onQueryInput();
      return;
    }
    if (scopeOpen && !scopeList.hidden && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter')) {
      event.preventDefault();
      if (key === 'Enter') { if (!event.repeat) pickScope(scopeIndex); return; }
      const count = scopeSuggestions(query.value.trim()).length;
      scopeIndex = (scopeIndex + (key === 'ArrowDown' ? 1 : -1) + count) % count;
      paintSources();
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
    event.preventDefault();
    if (!context || busy) return; // Loading or switching: keys are inert, not lost to the page.
    // The empty-list action takes a fresh Enter only, never a repeat (R15).
    if (key === 'Enter' && !results.length) { if (!event.repeat) include(); return; }
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
    if (key === 'Tab') {
      event.preventDefault();
      // Tab closes the @ list and keeps its usual meaning.
      if (scopeOpen) closeScopeList();
      moveFocus(event.shiftKey);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      if (event.repeat) return;
      // The @ list closes first; mode stays.
      if (scopeOpen && !scopeList.hidden) closeScopeList(); else back();
      return;
    }
    const focus = document.activeElement;
    // The toolbar: arrow keys move along it; Space and Enter press natively.
    if (toolbarControls.includes(focus) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      event.preventDefault();
      const shown = visibleToolbar();
      const at = shown.indexOf(focus);
      const next = key === 'Home' ? 0 : key === 'End' ? shown.length - 1 : (at + (key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length;
      roving = next;
      paintSources();
      shown[next].focus();
      return;
    }
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
  for (const [name, button] of Object.entries(sourceButtons)) {
    button.addEventListener('click', () => {
      roving = visibleToolbar().indexOf(button);
      onSourceButton(name);
    });
  }
  saveButton.addEventListener('click', saveDefault);
  enableButton.addEventListener('click', openSettings);
  enableBookmarks.addEventListener('click', requestBookmarks);
  includeButton.addEventListener('click', () => include());
  chipRemove.addEventListener('click', () => { restoreLiteral = null; removeScope(); onQueryInput(); query.focus(); });
  // Pointer presses on source buttons keep focus (and typing) in the query.
  for (const control of toolbarControls) control.addEventListener('mousedown', event => { if (document.activeElement === query) event.preventDefault(); });
  scopeList.addEventListener('mousedown', event => {
    event.preventDefault();
    const option = event.target.closest('[data-scope]');
    if (option) pickScope([...scopeList.children].indexOf(option));
  });

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
