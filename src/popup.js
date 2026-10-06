// TabVacuum popup UI
import { renderShortcuts } from './shortcuts.js';
import {
  NO_REPLY, REFRESH_MS, UNKNOWN_AUTO_TEXT, canEnableAuto, convertDuration, createEditorLease, createLatest,
  createRuleWriter, describeAuto, describeMain, describeManual, domainOf, durationFromMs, formatViewedAgo,
  isStaleState, parseDuration, scopeState, tabCount, watchStaleSources,
} from './stale-ui.js';

const ACTIONS = {
  closeDuplicates: { busy: 'Closing duplicate tabs...', failed: 'Could not close duplicate tabs' },
  mergeWindows: { busy: 'Merging windows...', failed: 'Could not merge windows' },
  closeStalePreview: { busy: 'Closing stale tabs...', failed: 'Could not close stale tabs' },
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
const EVENT_DEBOUNCE_MS = 300;

const errorText = err => String(err?.message ?? err ?? 'Unknown error');

// Writes only on change, so unchanged refreshes cause no DOM or screen-reader churn.
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function startPopup({ document, window, browser, locale }) {
  const $ = id => document.getElementById(id);
  const main = document.querySelector('main');
  const sortOptions = $('sort-options');
  const actionButtons = [
    $('btn-search'), $('btn-merge'), $('btn-sort'), $('btn-dupes'), $('btn-stale'), $('btn-blank'),
    ...sortOptions.querySelectorAll('button'), $('stale-review'), $('stale-close'),
  ];
  const status = { box: $('status'), spinner: $('status-spinner'), title: $('status-title'), detail: $('status-detail'), close: $('status-close') };
  let pending = false;
  let dismissed = false;
  let teardown = () => {};

  // A dismissed menu is gone for good: late replies must not touch it or reopen anything.
  window.addEventListener('pagehide', () => { dismissed = true; teardown(); });

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
    renderStale();
  }

  function finishWithError(trigger, text) {
    setBusy(false);
    render({ tone: 'error', title: text, detail: 'Try again, or close this menu.', closable: true });
    if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
  }

  // Resolves to 'closed', 'done' (completed, notification failed), 'error', or undefined when refused.
  async function run(trigger, command, params, busyLabel) {
    if (pending || dismissed) return undefined;
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
      if (dismissed) return undefined;
      finishWithError(trigger, `${failed}: ${errorText(error)}`);
      return 'error';
    }
    if (dismissed) return undefined;
    // Search errors are complete sentences from the background already.
    if (result?.error) {
      // A stale close cut short still reports what it actually closed.
      if (command === 'closeStalePreview' && Number.isSafeInteger(result.closed) && typeof result.message === 'string' && result.message.trim()) {
        setBusy(false);
        render({ tone: 'error', title: result.message, detail: String(result.error), closable: true });
        if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
        return 'error';
      }
      finishWithError(trigger, command === 'launchSearch' ? String(result.error) : `${failed}: ${result.error}`);
      return 'error';
    }
    const done = command === 'launchSearch' ? result && typeof result === 'object' : typeof result?.message === 'string' && result.message.trim();
    if (!done) {
      finishWithError(trigger, `${failed}: ${NO_REPLY}`);
      return 'error';
    }
    if (result.notificationError) {
      // The work completed; only the system notification failed. Never present it as a failure.
      setBusy(false);
      render({ tone: 'done', title: result.message, detail: `System notification unavailable: ${result.notificationError}`, closable: true });
      if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
      return 'done';
    }
    window.close();
    return 'closed';
  }

  const bind = (id, command, busy) => $(id).addEventListener('click', event => run(event.currentTarget ?? $(id), command, {}, busy));
  bind('btn-dupes', 'closeDuplicates', { title: ACTIONS.closeDuplicates.busy });
  bind('btn-merge', 'mergeWindows', { title: ACTIONS.mergeWindows.busy });
  bind('btn-blank', 'closeBlankTabs', { title: ACTIONS.closeBlankTabs.busy });
  // Opening the menu granted activeTab for this window's page; the background
  // shows search over it (or in a separate window) and this menu gets out of the way.
  bind('btn-search', 'launchSearch');

  $('btn-sort').addEventListener('click', () => {
    if (pending) return;
    const opening = sortOptions.hidden;
    if (opening) setStaleOpen(false);
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

  // ---- Stale tabs (R4) ----
  // Opening, reviewing and editing never remove tabs. Only "Close N tabs now"
  // does, and only for the background-issued preview currently shown.
  const ui = {
    button: $('btn-stale'), panel: $('stale-panel'), title: $('stale-title'), caption: $('stale-caption'),
    value: $('stale-value'), unit: $('stale-unit'), ruleError: $('stale-rule-error'),
    auto: $('stale-auto'), autoDetail: $('stale-auto-detail'), count: $('stale-count'),
    protect: $('stale-protect'), review: $('stale-review'), close: $('stale-close'),
    list: $('stale-review-list'), message: $('stale-message'),
  };
  const formControls = [ui.value, ui.unit];
  let windowId = null;
  let incognito = false;
  let state = null;       // latest valid getStaleState reply
  let current = false;    // state follows every confirmed write and may authorize a close
  let loadError = '';
  let closing = false;
  let ruleDirty = false;  // the duration fields hold an uncommitted edit
  let shownUnit = ui.unit.value;
  let listed = '';
  const latest = createLatest();
  const lease = createEditorLease(params => browser.runtime.sendMessage({ command: 'staleEditor', windowId, ...params }));

  const send = (command, params = {}) => browser.runtime.sendMessage({ command, windowId, ...params });
  const rule = createRuleWriter(settings => send('setStaleRule', { settings }));
  const ruleInput = () => parseDuration(ui.value.value, ui.unit.value);
  const enabled = () => rule.value('autoCloseStaleEnabled'); // true, false, or null when unknown
  const savedMs = () => rule.value('staleThresholdMs');
  // The shown preview matches the saved rule and every write has settled.
  const settled = () => Boolean(state) && current && !loadError && !rule.busy && !ruleDirty;

  const canClose = () => settled() && !closing && !pending && state.preview.count > 0;
  const canEnable = () => windowId != null && settled() && !pending && !closing && canEnableAuto(state);
  // Turning automation off never waits for a preview, a save or a close.
  const canDisable = () => windowId != null;

  function setStaleOpen(open) {
    if (open === !ui.panel.hidden) return;
    ui.panel.hidden = !open;
    ui.button.setAttribute('aria-expanded', String(open));
    if (open) {
      sortOptions.hidden = true;
      $('btn-sort').setAttribute('aria-expanded', 'false');
      if (windowId != null) lease.open();
    } else {
      setReviewOpen(false);
      lease.close();
    }
  }

  function setReviewOpen(open) {
    ui.list.hidden = !open;
    ui.review.setAttribute('aria-expanded', String(open));
    if (open) renderList();
  }

  function renderList() {
    if (ui.list.hidden || !state) return;
    const now = Date.now();
    const { tabs, count } = state.preview;
    const rows = tabs.map(tab => ({
      title: String(tab.title || tab.url || 'Untitled tab'),
      meta: [domainOf(tab.url), formatViewedAgo(tab.lastViewedAt, now, locale)].filter(Boolean).join(' · '),
    }));
    const key = JSON.stringify([rows, count]);
    if (key === listed) return;
    listed = key;
    const items = rows.map(row => {
      const item = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'stale-tab-title';
      title.textContent = row.title;
      title.setAttribute('title', row.title);
      const meta = document.createElement('span');
      meta.className = 'stale-tab-meta';
      meta.textContent = row.meta;
      item.append(title, meta);
      return item;
    });
    const extra = count - tabs.length;
    if (!count || extra > 0) {
      const item = document.createElement('li');
      item.className = 'stale-tab-more';
      item.textContent = count ? `And ${extra} more ${extra === 1 ? 'tab' : 'tabs'}.` : 'No tabs to review.';
      items.push(item);
    }
    ui.list.replaceChildren(...items);
  }

  function setGate(node, allowed) {
    if (allowed) node.removeAttribute('aria-disabled');
    else node.setAttribute('aria-disabled', 'true');
  }

  function renderStale() {
    const now = Date.now();
    const on = enabled();
    const shown = current ? state : null;
    const head = describeMain({ state: shown, enabled: on, error: loadError, now, locale });
    setText(ui.title, head.title);
    setText(ui.caption, head.caption);
    ui.caption.hidden = !head.caption;
    if (head.tone) ui.caption.dataset.tone = head.tone;
    else delete ui.caption.dataset.tone;

    // Never overwrite an edit, or fields that already show the saved duration
    // (168 hours stays 168 hours rather than flipping to 7 days).
    const ms = savedMs();
    if (!ruleDirty) {
      if (ms != null && ruleInput().ms !== ms) {
        const { value, unit } = durationFromMs(ms);
        ui.value.value = String(value);
        ui.unit.value = unit;
      }
      shownUnit = ui.unit.value;
      setRuleError('');
    }
    // Shows the latest choice, including one not yet confirmed. Unknown is mixed, never off.
    ui.auto.indeterminate = on == null;
    ui.auto.checked = on === true;
    setGate(ui.auto, on === false ? canEnable() : canDisable());

    const autoLine = loadError ? { text: on == null ? UNKNOWN_AUTO_TEXT : '', tone: '' } : describeAuto(shown, now, locale);
    setText(ui.autoDetail, autoLine.text);
    if (autoLine.tone) ui.autoDetail.dataset.tone = autoLine.tone;
    else delete ui.autoDetail.dataset.tone;

    if (settled()) {
      const manual = describeManual(state, incognito);
      setText(ui.count, manual.count);
      setText(ui.protect, manual.protections);
      setText(ui.close, `Close ${tabCount(state.preview.count)} now`);
    } else {
      setText(ui.count, loadError ? `Stale-tab status unavailable: ${loadError}` : state ? 'Updating count…' : 'Checking…');
      setText(ui.close, 'Close tabs now');
    }
    // The shared busy gate (setBusy) covers these too; this adds their own conditions.
    setGate(ui.close, canClose());
    setGate(ui.review, Boolean(state) && !pending);
    for (const control of formControls) control.disabled = pending || closing;
    renderList();
  }

  function setRuleError(text) {
    setText(ui.ruleError, text);
    ui.ruleError.hidden = !text;
    if (text) ui.value.setAttribute('aria-invalid', 'true');
    else ui.value.removeAttribute('aria-invalid');
  }

  function showMessage(text) {
    setText(ui.message, text);
  }

  async function refresh() {
    if (dismissed || windowId == null || rule.busy || closing) return;
    const isLatest = latest.next();
    let reply;
    try {
      reply = await send('getStaleState');
    } catch (error) {
      reply = { error: errorText(error) };
    }
    if (dismissed || !isLatest()) return;
    if (isStaleState(reply)) {
      state = scopeState(reply, incognito);
      rule.learn(state.settings);
      current = true;
      loadError = '';
    } else {
      current = false;
      loadError = reply?.error ? String(reply.error) : NO_REPLY;
    }
    renderStale();
  }

  let debounce;
  function scheduleRefresh() {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, EVENT_DEBOUNCE_MS);
  }

  // Sent at once, even while another save or a close is running: the
  // background applies setStaleRule writes in arrival order (createRuleWriter).
  async function save(settings) {
    current = false;
    latest.invalidate();
    showMessage('');
    const saving = rule.save(settings);
    renderStale();
    const { ok, error } = await saving;
    if (dismissed) return;
    if (!ok) showMessage(`Could not save the stale-tab rule: ${error}`);
    renderStale();
    refresh();
  }

  function onRuleEdit() {
    ruleDirty = true;
    shownUnit = ui.unit.value;
    latest.invalidate();
    setRuleError(ruleInput().error ?? '');
    renderStale();
  }

  function commitRule() {
    if (!ruleDirty) return;
    const parsed = ruleInput();
    if (parsed.error) return setRuleError(parsed.error);
    if (windowId == null || savedMs() == null || pending || closing) return;
    ruleDirty = false;
    if (parsed.ms === savedMs()) {
      renderStale();
      refresh();
      return;
    }
    save({ staleThresholdMs: parsed.ms });
  }

  // Shows the same duration in the new unit and saves nothing. Choosing hours
  // on the way to typing 168 never saves 7 hours.
  function onUnitChange() {
    const converted = convertDuration(ui.value.value, shownUnit, ui.unit.value);
    shownUnit = ui.unit.value;
    if (converted != null) ui.value.value = converted;
    const parsed = ruleInput();
    ruleDirty = parsed.ms !== savedMs();
    latest.invalidate();
    setRuleError(parsed.error ?? '');
    renderStale();
  }

  // Escape abandons a half-typed duration instead of saving it on blur.
  function discardRuleEdit() {
    if (!ruleDirty) return;
    ruleDirty = false;
    renderStale();
  }

  ui.value.addEventListener('input', onRuleEdit);
  ui.value.addEventListener('change', commitRule);
  ui.unit.addEventListener('change', onUnitChange);

  ui.auto.addEventListener('change', () => {
    // From on or unknown, the only change offered is turning automation off.
    const enabling = enabled() === false;
    if (enabling ? canEnable() : canDisable()) save({ autoCloseStaleEnabled: enabling });
    else renderStale();
  });

  ui.button.addEventListener('click', () => {
    if (pending) return;
    setStaleOpen(ui.panel.hidden);
  });

  ui.review.addEventListener('click', () => {
    if (pending || !state) return;
    setReviewOpen(ui.list.hidden);
  });

  ui.close.addEventListener('click', async () => {
    if (dismissed || !canClose()) return;
    const previewId = state.preview.id;
    closing = true;
    latest.invalidate();
    const outcome = await run(ui.close, 'closeStalePreview', { windowId, previewId }, { title: ACTIONS.closeStalePreview.busy });
    closing = false;
    if (dismissed || outcome === 'closed') return;
    // A used preview never authorizes a second close; fetch a fresh one.
    current = false;
    renderStale();
    refresh();
  });

  // Escape collapses the review list, then the stale controls, before the browser dismisses the menu.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || pending) return;
    if (ui.list.hidden && ui.panel.hidden) return;
    discardRuleEdit();
    if (!ui.list.hidden) {
      setReviewOpen(false);
      ui.review.focus();
    } else {
      setStaleOpen(false);
      ui.button.focus();
    }
    event.preventDefault();
  });

  // The saved preference comes from plain settings too, so it is known (and
  // can be turned off) even when the stale-state reply fails.
  async function loadSettings() {
    let settings;
    try {
      settings = await browser.runtime.sendMessage({ command: 'getSettings' });
    } catch {
      return;
    }
    if (dismissed) return;
    rule.learn(settings, { fill: true });
    renderStale();
  }

  async function startStale() {
    renderStale();
    let win;
    try {
      win = await browser.windows?.getCurrent?.();
    } catch {
      win = null;
    }
    if (dismissed) return;
    if (!Number.isSafeInteger(win?.id)) {
      loadError = 'The current window is unavailable.';
      renderStale();
      return;
    }
    windowId = win.id;
    incognito = win.incognito === true;
    const unwatch = watchStaleSources(browser, scheduleRefresh);
    const poll = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, REFRESH_MS);
    teardown = () => {
      unwatch();
      clearInterval(poll);
      clearTimeout(debounce);
      lease.close();
    };
    if (!ui.panel.hidden) lease.open();
    loadSettings();
    refresh();
    let intent;
    try {
      intent = await send('consumeStaleIntent');
    } catch {
      intent = null;
    }
    if (!dismissed && !pending && intent?.open === true) {
      setStaleOpen(true);
      ui.button.focus();
    }
  }

  startStale();
}

if (globalThis.browser?.runtime && globalThis.document?.getElementById('btn-merge')) {
  startPopup({ document, window, browser });
  renderShortcuts(document, browser);
  document.body.classList.add('ready');
}
