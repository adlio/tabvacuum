import { rankTabs } from './search-core.js';

const INIT_TYPE = 'tabvacuum:init';
const MAX_TOKEN_LENGTH = 512;
// A hostile page can post init messages too. Trying several candidates keeps it
// from winning by posting first; the backend decides which token is real.
const MAX_INIT_ATTEMPTS = 16;
const INIT_TIMEOUT_MS = 5000;
const MAX_LISTED_SKIPS = 3;
// search: typing in the query. tabs: the tab menu, acting on the highlight.
// select: checking several tabs to close together.
const MODE_LABELS = { search: '', tabs: 'Tab menu', select: 'Select multiple' };
const MOVES = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

const isContext = value => Boolean(value) && typeof value === 'object' && !value.error && Array.isArray(value.tabs);
const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;
const idList = value => Array.isArray(value) ? value.filter(Number.isInteger) : [];
const tabLabel = tab => tab.title || tab.url || 'Untitled tab';

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
  const embedded = window.parent !== window;
  const tried = new Set();
  // Checked tab IDs in select mode. Highlight (`selected`) is separate.
  const checked = new Set();
  // Explicit list keystrokes arriving during a close are applied in order, not
  // dropped. Focus/mode changes and partial failures cancel the pending sequence.
  const pendingListKeys = [];
  const MAX_PENDING_KEYS = 64;
  let token;
  let context;
  let results = [];
  let rowCloses = [];
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

  function showMessage(state, text) {
    message.dataset.state = state;
    message.textContent = text;
    message.hidden = false;
  }

  // Empty state, then a sticky close notice, otherwise nothing.
  function showStatus() {
    const typed = Boolean(query.value.trim());
    if (notice) showMessage('notice', notice);
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

  // IDs are frozen here, at the moment the user asks to close. Select mode
  // closes only checked tabs: nothing checked means nothing closes.
  function closeTargets() {
    if (mode === 'select') return results.map(r => r.tab.id).filter(id => checked.has(id));
    if (!highlightCloseReady) return [];
    const target = results[selected]?.tab;
    return target ? [target.id] : [];
  }

  function paint() {
    const selecting = mode === 'select';
    for (const [i, row] of [...list.children].entries()) {
      const isChecked = checked.has(results[i]?.tab.id);
      row.setAttribute('data-active', String(i === selected));
      row.setAttribute('data-checked', String(isChecked));
      // Single-select: selection follows the highlight. Multi-select:
      // aria-selected means checked, and the highlight is the active descendant.
      const rowSelected = String(selecting ? isChecked : i === selected);
      row.setAttribute('aria-selected', rowSelected);
      row.children[0].setAttribute('aria-selected', rowSelected);
      rowCloses[i].setAttribute('aria-disabled', String(busy));
    }
    list.setAttribute('aria-rowcount', String(results.length));
    const active = list.children[selected]?.children[0];
    for (const owner of [query, list]) {
      if (active) owner.setAttribute('aria-activedescendant', active.id);
      else owner.removeAttribute('aria-activedescendant');
    }
    palette.dataset.mode = mode;
    list.setAttribute('aria-multiselectable', String(selecting));
    list.setAttribute('aria-describedby', selecting ? 'select-help' : 'tabs-help');
    for (const name of Object.keys(MODE_LABELS)) $(`hints-${name}`).hidden = name !== mode;
    modeIndicator.textContent = MODE_LABELS[mode];
    modeIndicator.hidden = mode === 'search';
    $('selection-status').textContent = selecting ? `${checked.size} of ${results.length} selected` : '';
    selectButton.textContent = selecting ? 'Done' : 'Select multiple';
    selectButton.setAttribute('aria-disabled', String(!selecting && !results.length));
    closeButton.hidden = !selecting;
    closeButton.textContent = `Close ${plural(checked.size, 'tab')}`;
    closeButton.setAttribute('aria-disabled', String(busy || !checked.size));
  }

  function setMode(next) {
    if (next !== 'select') checked.clear();
    const changed = next !== mode;
    if (changed) pendingListKeys.length = 0;
    // Entering the tab menu from search acts on the highlight the user can see.
    if (changed && mode === 'search') highlightCloseReady = true;
    mode = next;
    paint();
    if (changed && next !== 'search') announce(MODE_LABELS[next]);
  }

  function select(index, scroll = true) {
    selected = results.length ? Math.max(0, Math.min(index, results.length - 1)) : -1;
    paint();
    if (scroll) list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  // Titles and URLs are untrusted: text only, never HTML, never fetched icons.
  function el(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // Grid rows expose an option cell and an independently keyboard-accessible
  // close-action cell. A listbox cannot contain interactive sibling buttons.
  function row({ tab, matchType }, index) {
    const wrapper = el('div', 'result');
    wrapper.setAttribute('role', 'row');
    wrapper.setAttribute('aria-rowindex', String(index + 1));
    const option = el('div', 'result-option');
    option.id = `option-${index}`;
    option.dataset.index = String(index);
    option.setAttribute('role', 'gridcell');
    option.setAttribute('aria-selected', 'false');
    const letter = initial(tab);
    const tile = el('span', letter ? 'tile' : 'tile tile-fallback', letter);
    tile.setAttribute('aria-hidden', 'true');
    const line = el('div', 'line');
    line.append(el('span', 'title', tabLabel(tab)));
    // The URL is always shown, so only a URL-only match needs explaining.
    const badges = [];
    if (matchType === 'url') badges.push('URL match');
    if (tab.windowId !== context.windowId) badges.push('Other window');
    if (tab.id === context.currentTabId) badges.push('Current');
    for (const badge of badges) line.append(el('span', badge === 'URL match' ? 'badge badge-match' : 'badge', badge));
    const text = el('div', 'text');
    text.append(line, el('div', 'url', tab.url || 'Address unavailable'));
    // Drawn first via CSS order; last in the DOM so row text stays title-first.
    const box = el('span', 'check');
    box.setAttribute('aria-hidden', 'true');
    option.append(tile, text, box);
    // Reached by the dialog's own Tab order (active row only), never natively.
    const close = el('button', 'row-close');
    close.id = `row-close-${index}`;
    close.type = 'button';
    close.setAttribute('tabindex', '-1');
    close.setAttribute('title', 'Close tab');
    close.setAttribute('aria-label', `Close tab: ${tabLabel(tab)}`);
    close.dataset.closeId = String(tab.id);
    const icon = el('span', 'row-close-icon');
    icon.setAttribute('aria-hidden', 'true');
    close.append(icon);
    const actionCell = el('div', 'result-action');
    actionCell.setAttribute('role', 'gridcell');
    actionCell.append(close);
    wrapper.append(option, actionCell);
    return wrapper;
  }

  function render(preserveTabId, fallbackIndex = 0) {
    if (!context) return;
    // Rebuilding rows removes a focused row button; put focus back afterwards.
    const focusedClose = rowCloses.includes(document.activeElement) ? document.activeElement : null;
    const focusedTabId = focusedClose ? Number(focusedClose.dataset.closeId) : undefined;
    const typed = Boolean(query.value.trim());
    results = rankTabs(context.tabs, query.value, { currentTabId: context.currentTabId });
    const shown = new Set(results.map(result => result.tab.id));
    for (const id of checked) if (!shown.has(id)) checked.delete(id);
    const fragment = document.createDocumentFragment();
    rowCloses = [];
    for (const [index, result] of results.entries()) {
      const element = row(result, index);
      rowCloses.push(element.children[1].children[0]);
      fragment.append(element);
    }
    list.replaceChildren(fragment);
    list.setAttribute('aria-busy', 'false');
    $('list-label').textContent = typed ? 'Matches' : 'Recent tabs';
    $('result-count').textContent = plural(results.length, 'tab');
    showStatus();
    const kept = results.findIndex(result => result.tab.id === preserveTabId);
    select(kept === -1 ? fallbackIndex : kept);
    if (focusedClose) {
      const sameIndex = results.findIndex(result => result.tab.id === focusedTabId);
      // Only our own close may carry X-button focus onto a different tab.
      const nextClose = sameIndex >= 0 ? rowCloses[sameIndex] : closing ? rowCloses[selected] : null;
      (nextClose ?? (mode === 'search' ? query : list)).focus();
    }
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announcement.textContent = `${plural(results.length, 'tab')} found`;
    }, 180);
  }

  function setContext(next) {
    // Polling must not reset manual scroll or replace rows when nothing changed.
    if (context && JSON.stringify(context) === JSON.stringify(next)) return;
    const previousId = results[selected]?.tab.id;
    // An external close must not silently arm its replacement for deletion.
    if (!closing && previousId !== undefined && !next.tabs.some(tab => tab.id === previousId)) highlightCloseReady = false;
    context = next;
    // A closed highlight falls to the row that took its place, not the top.
    render(previousId, selected);
  }

  function toggle(index) {
    const id = results[index]?.tab.id;
    if (id === undefined) return;
    if (checked.has(id)) checked.delete(id); else checked.add(id);
    select(index, false);
  }

  function checkAll() {
    // A snapshot: tabs that arrive later are not checked.
    for (const { tab } of results) checked.add(tab.id);
    paint();
  }

  async function tryToken(candidate) {
    if (token || typeof candidate !== 'string' || !candidate || candidate.length > MAX_TOKEN_LENGTH) return;
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
    setContext(next);
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

  async function activate() {
    const target = results[selected]?.tab;
    if (!token || !target || busy) return;
    busy = true;
    try {
      const response = await send({ command: 'activateSearchTab', token, tabId: target.id });
      if (!response?.ok) throw new Error('Activation failed');
      // The backend switches tabs and closes this search surface.
    } catch {
      await refresh();
      showMessage('error', 'That tab could not be selected. Choose another result or reopen search.');
    } finally {
      busy = false;
    }
  }

  function describeClose(tabIds, response, titles) {
    const closed = idList(response.closedIds).length;
    const skipped = Array.isArray(response.skipped) ? response.skipped.filter(s => Number.isInteger(s?.tabId)) : [];
    const failed = idList(response.failedIds).length;
    if (!skipped.length && !failed) return `Closed ${plural(closed, 'tab')}.`;
    const parts = [`Closed ${closed} of ${plural(tabIds.length, 'tab')}.`];
    if (skipped.length) {
      const reasons = { pinned: 'pinned tab', audible: 'playing audio', 'last-tab': 'last tab in its window', unavailable: 'no longer in this search' };
      const named = skipped.slice(0, MAX_LISTED_SKIPS).map(({ tabId, reason }) =>
        `${titles.get(tabId) ?? 'A tab'} (${reasons[reason] || 'could not be closed'})`);
      const more = skipped.length - named.length;
      parts.push(`Skipped ${skipped.length}: ${named.join(', ')}${more ? `, and ${more} more` : ''}.`);
    }
    if (failed) parts.push(`${plural(failed, 'tab')} could not be closed.`);
    return parts.join(' ');
  }

  // Closes exactly the listed IDs asked for. Mode and focus stay where they are.
  async function closeTabs(requested) {
    if (!token || !context || busy) return;
    const listed = new Set(results.map(({ tab }) => tab.id));
    const tabIds = requested.filter(id => listed.has(id));
    if (!tabIds.length) return;
    const titles = new Map(results.map(({ tab }) => [tab.id, tabLabel(tab)]));
    busy = true;
    closing = true;
    awaitingClose = true;
    ++refreshVersion; // Discard any context request started before this close.
    notice = null;
    paint();
    let response;
    try { response = await send({ command: 'closeSearchTabs', token, tabIds }); } catch { /* Reported below. */ }
    // Sent once. A failure is reported, never retried automatically.
    if (response?.ok === true && Array.isArray(response.closedIds)) {
      const gone = new Set(idList(response.closedIds));
      for (const id of gone) checked.delete(id);
      notice = describeClose(tabIds, response, titles);
      // Remove confirmed closures even if the following refresh fails.
      setContext({ ...context, tabs: context.tabs.filter(tab => !gone.has(tab.id)) });
    } else {
      notice = 'Could not close tabs. Check the list and try again.';
    }
    awaitingClose = false;
    const refreshed = await refresh(true);
    closing = false;
    busy = false;
    if (!refreshed) notice = `${notice} The list may be out of date. Close and reopen search.`;
    if (!refreshed || response?.ok !== true || response.skipped?.length || response.failedIds?.length) pendingListKeys.length = 0;
    showStatus();
    paint();
    announce(notice);
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
  // a stop, so long lists don't add a stop per row.
  function focusOrder() {
    const order = [query];
    if (results.length || mode !== 'search') order.push(list);
    if (rowCloses[selected]) order.push(rowCloses[selected]);
    order.push(selectButton);
    if (mode === 'select') order.push(closeButton);
    return order;
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
    checked.clear();
    pendingListKeys.length = 0;
    highlightCloseReady = true;
    notice = null;
    render();
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
      if (event.repeat) return;
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
      if (!event.repeat) closeTabs(closeTargets());
    } else if (name === 'm') {
      event.preventDefault();
      if (!event.repeat) setMode(selecting ? 'tabs' : 'select');
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
      if (!event.repeat) back();
      return;
    }
    const focus = document.activeElement;
    // Buttons handle Enter and Space natively; never act on a hidden highlight.
    if (focus === selectButton || focus === closeButton || rowCloses.includes(focus)) {
      if (event.repeat && (key === 'Enter' || key === ' ')) event.preventDefault();
      return;
    }
    if (focus === list) onListKey(event, key); else onQueryKey(event, key);
  });

  selectButton.addEventListener('click', () => {
    if (mode === 'select') setMode('tabs');
    else if (results.length) setMode('select');
    else return;
    list.focus();
  });
  closeButton.addEventListener('click', () => { if (mode === 'select') closeTabs(closeTargets()); });

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
    const controls = [query, list, selectButton, closeButton, ...rowCloses];
    if (!controls.includes(document.activeElement)) (mode === 'search' ? query : list).focus();
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
