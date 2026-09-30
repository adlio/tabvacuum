// TabVacuum popup UI
import { renderShortcuts } from './shortcuts.js';

const ACTIONS = {
  closeDuplicates: { busy: 'Closing duplicate tabs...', failed: 'Could not close duplicate tabs' },
  mergeWindows: { busy: 'Merging windows...', failed: 'Could not merge windows' },
  closeStaleTabs: { busy: 'Closing stale tabs...', failed: 'Could not close stale tabs' },
  closeBlankTabs: { busy: 'Closing blank tabs...', failed: 'Could not close blank tabs' },
  sortTabs: { failed: 'Could not sort tabs' },
  launchSearch: { failed: 'Could not open Search tabs' },
};

const SORT_LABELS = {
  'url:asc': 'URL, A → Z', 'url:desc': 'URL, Z → A',
  'title:asc': 'title, A → Z', 'title:desc': 'title, Z → A',
  'lastAccessed:desc': 'last accessed', 'visitCount:desc': 'most visited',
  'frecency:desc': 'frequent & recent',
};

// Sorts that look up every tab in history can take a while (R3).
const HISTORY_SORTS = new Set(['visitCount', 'frecency']);
const HISTORY_DETAIL = 'Reading browsing history. Press Esc to dismiss.';

const errorText = err => String(err?.message ?? err ?? 'Unknown error');

export function startPopup({ document, window, browser }) {
  const $ = id => document.getElementById(id);
  const main = document.querySelector('main');
  const sortOptions = $('sort-options');
  const actionButtons = [
    $('btn-search'), $('btn-merge'), $('btn-sort'), $('btn-dupes'), $('btn-stale'), $('btn-blank'),
    ...sortOptions.querySelectorAll('button'),
  ];
  const status = { box: $('status'), spinner: $('status-spinner'), title: $('status-title'), detail: $('status-detail'), close: $('status-close') };
  let pending = false;
  let dismissed = false;

  // A dismissed menu is gone for good: late replies must not touch it or reopen anything.
  window.addEventListener('pagehide', () => { dismissed = true; });

  function render({ tone, title, detail = '', busy = false, closable = false }) {
    status.box.dataset.tone = tone;
    status.box.classList.add('visible');
    status.spinner.hidden = !busy;
    status.title.textContent = title;
    status.detail.textContent = detail;
    status.detail.hidden = !detail;
    status.close.hidden = !closable;
  }

  function clearStatus() {
    status.box.classList.remove('visible');
    delete status.box.dataset.tone;
    status.spinner.hidden = true;
    status.title.textContent = '';
    status.detail.textContent = '';
    status.detail.hidden = true;
    status.close.hidden = true;
  }

  // aria-disabled keeps focus on the pressed control, so keyboard users are not dropped to <body>.
  function setBusy(busy) {
    pending = busy;
    if (busy) main.setAttribute('aria-busy', 'true');
    else main.removeAttribute('aria-busy');
    for (const button of actionButtons) {
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
  }

  function finishWithError(trigger, text) {
    setBusy(false);
    render({ tone: 'error', title: text, detail: 'Try again, or close this menu.', closable: true });
    if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
  }

  async function run(trigger, command, params, busyLabel) {
    if (pending || dismissed) return;
    // Keep progress visible within the browser's popup height limit. The status
    // names the selected sort, so its submenu can collapse while work runs.
    if (!sortOptions.hidden) {
      const focusInSort = sortOptions.contains(document.activeElement);
      if (sortOptions.contains(trigger)) trigger = $('btn-sort');
      sortOptions.hidden = true;
      $('btn-sort').setAttribute('aria-expanded', 'false');
      if (focusInSort) $('btn-sort').focus();
    }
    setBusy(true);
    if (busyLabel) render({ tone: 'busy', busy: true, ...busyLabel });
    else clearStatus();
    const failed = ACTIONS[command].failed;
    let result;
    try {
      result = await browser.runtime.sendMessage({ command, ...params });
    } catch (error) {
      if (!dismissed) finishWithError(trigger, `${failed}: ${errorText(error)}`);
      return;
    }
    if (dismissed) return;
    // Search errors are complete sentences from the background already.
    if (result?.error) return finishWithError(trigger, command === 'launchSearch' ? String(result.error) : `${failed}: ${result.error}`);
    const done = command === 'launchSearch' ? result && typeof result === 'object' : typeof result?.message === 'string' && result.message.trim();
    if (!done) return finishWithError(trigger, `${failed}: TabVacuum did not respond.`);
    if (result.notificationError) {
      // The work completed; only the system notification failed. Never present it as a failure.
      setBusy(false);
      render({ tone: 'done', title: result.message, detail: `System notification unavailable: ${result.notificationError}`, closable: true });
      if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
      return;
    }
    window.close();
  }

  const bind = (id, command, busy) => $(id).addEventListener('click', event => run(event.currentTarget ?? $(id), command, {}, busy));
  bind('btn-dupes', 'closeDuplicates', { title: ACTIONS.closeDuplicates.busy });
  bind('btn-merge', 'mergeWindows', { title: ACTIONS.mergeWindows.busy });
  bind('btn-stale', 'closeStaleTabs', { title: ACTIONS.closeStaleTabs.busy });
  bind('btn-blank', 'closeBlankTabs', { title: ACTIONS.closeBlankTabs.busy });
  // Opening the menu granted activeTab for this window's page; the background
  // shows search over it (or in a separate window) and this menu gets out of the way.
  bind('btn-search', 'launchSearch');

  $('btn-sort').addEventListener('click', () => {
    if (pending) return;
    const opening = sortOptions.hidden;
    sortOptions.hidden = !opening;
    $('btn-sort').setAttribute('aria-expanded', String(opening));
  });

  // Sort option buttons — each fires immediately
  sortOptions.addEventListener('click', event => {
    const button = event.target.closest('button[data-criteria]');
    if (!button) return;
    const { criteria, direction } = button.dataset;
    const label = SORT_LABELS[`${criteria}:${direction}`] ?? 'the selected order';
    run(button, 'sortTabs', { criteria, direction }, {
      title: `Sorting by ${label}...`,
      detail: HISTORY_SORTS.has(criteria) ? HISTORY_DETAIL : '',
    });
  });

  status.close.addEventListener('click', () => window.close());
}

if (globalThis.browser?.runtime && globalThis.document?.getElementById('btn-merge')) {
  startPopup({ document, window, browser });
  renderShortcuts(document, browser);
  document.body.classList.add('ready');
}
