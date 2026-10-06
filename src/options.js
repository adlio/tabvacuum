// TabVacuum settings page
import {
  NO_REPLY, REFRESH_MS, UNKNOWN_AUTO_TEXT, canEnableAuto, convertDuration, createEditorLease, createLatest,
  createRuleWriter, describeAuto, durationFromMs, isStaleState, parseDuration, scopeState, watchStaleSources,
} from './stale-ui.js';

const errorText = err => String(err?.message ?? err ?? 'Unknown error');

export function startOptions({ document, window, browser, locale }) {
  const $ = id => document.getElementById(id);
  // Saved together through the generic saveSettings message.
  const general = {
    searchScope: $('search-scope'),
    ignoreFragments: $('ignore-fragments'),
    ignoreQuery: $('ignore-query'),
    skipPinned: $('skip-pinned'),
    skipAudible: $('skip-audible'),
    blankNewTab: $('blank-newtab'),
    blankWelcome: $('blank-welcome'),
    blankSearchEngines: $('blank-search'),
    blankCustom: $('blank-custom'),
  };
  // Saved only through setStaleRule, which validates and reconciles scheduling.
  const stale = {
    fieldset: $('stale-fieldset'), value: $('stale-value'), unit: $('stale-unit'), error: $('stale-error'),
    auto: $('stale-auto'), detail: $('stale-auto-detail'), message: $('stale-message'),
  };
  const statusBox = $('status');

  let loaded = false;     // never save over settings that failed to load
  let windowId = null;
  let incognito = false;
  let state = null;
  let current = false;    // state follows every confirmed write
  let ruleDirty = false;  // the duration fields hold an uncommitted edit
  let shownUnit = stale.unit.value;
  let loadError = '';
  let disposed = false;
  let statusTimer;
  const latest = createLatest();
  const lease = createEditorLease(params => browser.runtime.sendMessage({ command: 'staleEditor', windowId, ...params }));
  const send = (command, params = {}) => browser.runtime.sendMessage({ command, windowId, ...params });
  const rule = createRuleWriter(settings => send('setStaleRule', { settings }));
  const ruleInput = () => parseDuration(stale.value.value, stale.unit.value);
  const enabled = () => rule.value('autoCloseStaleEnabled'); // true, false, or null when unknown
  const savedMs = () => rule.value('staleThresholdMs');

  function showStatus(message) {
    statusBox.textContent = message;
    statusBox.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusBox.classList.remove('visible'), 2000);
  }

  function setRuleError(text) {
    if (stale.error.textContent !== text) stale.error.textContent = text;
    stale.error.hidden = !text;
    if (text) stale.value.setAttribute('aria-invalid', 'true');
    else stale.value.removeAttribute('aria-invalid');
  }

  const canEnable = () => windowId != null && Boolean(state) && current && !loadError && !rule.busy && !ruleDirty && canEnableAuto(state);
  // Turning automation off never waits for a preview or another save.
  const canDisable = () => windowId != null;

  function renderStale() {
    // Never overwrite an edit, or fields that already show the saved duration.
    const ms = savedMs();
    if (!ruleDirty) {
      if (ms != null && ruleInput().ms !== ms) {
        const { value, unit } = durationFromMs(ms);
        stale.value.value = String(value);
        stale.unit.value = unit;
      }
      shownUnit = stale.unit.value;
      setRuleError('');
    }
    const on = enabled();
    stale.auto.indeterminate = on == null;
    stale.auto.checked = on === true;
    const allowed = on === false ? canEnable() : canDisable();
    if (allowed) stale.auto.removeAttribute('aria-disabled');
    else stale.auto.setAttribute('aria-disabled', 'true');
    const unknown = on == null && loadError ? ` ${UNKNOWN_AUTO_TEXT}` : '';
    const line = loadError ? { text: `Stale-tab status unavailable: ${loadError}${unknown}`, tone: 'error' }
      : state && !current ? { text: 'Updating…', tone: 'muted' }
      : describeAuto(state, Date.now(), locale);
    if (stale.detail.textContent !== line.text) stale.detail.textContent = line.text;
    if (line.tone) stale.detail.dataset.tone = line.tone;
    else delete stale.detail.dataset.tone;
  }

  async function refresh() {
    if (disposed || windowId == null || rule.busy) return;
    const isLatest = latest.next();
    let reply;
    try {
      reply = await send('getStaleState');
    } catch (error) {
      reply = { error: errorText(error) };
    }
    if (disposed || !isLatest()) return;
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

  // Sent at once, even while another save is pending: the background applies
  // setStaleRule writes in arrival order (createRuleWriter).
  async function save(settings) {
    current = false;
    latest.invalidate();
    stale.message.textContent = '';
    const saving = rule.save(settings);
    renderStale();
    const { ok, error } = await saving;
    if (disposed) return;
    if (ok) showStatus('Settings saved');
    else stale.message.textContent = `Could not save the stale-tab rule: ${error}`;
    renderStale();
    refresh();
  }

  stale.value.addEventListener('input', () => {
    ruleDirty = true;
    shownUnit = stale.unit.value;
    current = false;
    latest.invalidate();
    setRuleError(ruleInput().error ?? '');
    renderStale();
  });

  stale.value.addEventListener('change', () => {
    if (!ruleDirty) return;
    const parsed = ruleInput();
    if (parsed.error) { setRuleError(parsed.error); return; }
    if (windowId == null || savedMs() == null) return;
    ruleDirty = false;
    if (parsed.ms === savedMs()) {
      renderStale();
      refresh();
      return;
    }
    save({ staleThresholdMs: parsed.ms });
  });

  // Shows the same duration in the new unit and saves nothing.
  stale.unit.addEventListener('change', () => {
    const converted = convertDuration(stale.value.value, shownUnit, stale.unit.value);
    shownUnit = stale.unit.value;
    if (converted != null) stale.value.value = converted;
    const parsed = ruleInput();
    ruleDirty = parsed.ms !== savedMs();
    setRuleError(parsed.error ?? '');
    renderStale();
  });

  stale.auto.addEventListener('change', () => {
    // From on or unknown, the only change offered is turning automation off.
    const enabling = enabled() === false;
    if (enabling ? canEnable() : canDisable()) save({ autoCloseStaleEnabled: enabling });
    else renderStale();
  });

  // Hold the editor lease only while a stale control has focus in a visible
  // tab, so a sweep does not start under someone editing the rule, and a
  // hidden Settings tab cannot postpone automation.
  const editing = () => document.visibilityState !== 'hidden' && stale.fieldset.contains(document.activeElement);
  stale.fieldset.addEventListener('focusin', () => {
    if (windowId != null && !disposed && document.visibilityState !== 'hidden') lease.open();
  });
  stale.fieldset.addEventListener('focusout', event => {
    if (!stale.fieldset.contains(event.relatedTarget)) lease.close();
  });
  document.addEventListener('visibilitychange', () => {
    if (windowId != null && !disposed && editing()) lease.open();
    else lease.close();
  });

  async function loadSettings() {
    const settings = await browser.runtime.sendMessage({ command: 'getSettings' });
    general.searchScope.value = settings.searchScope === 'current' ? 'current' : 'all';
    general.ignoreFragments.checked = settings.ignoreFragments;
    general.ignoreQuery.checked = settings.ignoreQueryParams;
    general.skipPinned.checked = settings.skipPinned;
    general.skipAudible.checked = settings.skipAudible;
    general.blankNewTab.checked = settings.blankNewTab;
    general.blankWelcome.checked = settings.blankWelcome;
    general.blankSearchEngines.checked = settings.blankSearchEngines;
    general.blankCustom.value = (settings.blankCustomUrls || []).join('\n');
    // Also sets the automation switch, so it is right even if stale status fails.
    rule.learn(settings, { fill: true });
    renderStale();
    loaded = true;
  }

  // Never includes the stale threshold or automation preference.
  async function saveGeneral() {
    if (!loaded || disposed) return;
    const settings = {
      searchScope: general.searchScope.value,
      ignoreFragments: general.ignoreFragments.checked,
      ignoreQueryParams: general.ignoreQuery.checked,
      skipPinned: general.skipPinned.checked,
      skipAudible: general.skipAudible.checked,
      blankNewTab: general.blankNewTab.checked,
      blankWelcome: general.blankWelcome.checked,
      blankSearchEngines: general.blankSearchEngines.checked,
      blankCustomUrls: general.blankCustom.value.split('\n').filter(l => l.trim()),
    };
    await browser.runtime.sendMessage({ command: 'saveSettings', settings });
    showStatus('Settings saved');
  }

  let debounceTimer;
  const debouncedSave = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(saveGeneral, 400);
  };
  for (const element of Object.values(general)) {
    element.addEventListener('change', saveGeneral);
    if (element.tagName === 'TEXTAREA') element.addEventListener('input', debouncedSave);
  }

  async function startStale() {
    renderStale();
    let win;
    try {
      win = await browser.windows?.getCurrent?.();
    } catch {
      win = null;
    }
    if (disposed) return;
    if (!Number.isSafeInteger(win?.id)) {
      loadError = 'The current window is unavailable.';
      renderStale();
      return;
    }
    windowId = win.id;
    incognito = win.incognito === true;
    if (editing()) lease.open(); // focus arrived before the window was known
    let debounce;
    const unwatch = watchStaleSources(browser, () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 300);
    });
    const poll = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, REFRESH_MS);
    window.addEventListener('pagehide', () => {
      unwatch();
      clearInterval(poll);
      clearTimeout(debounce);
    });
    refresh();
  }

  window.addEventListener('pagehide', () => {
    disposed = true;
    lease.close();
    clearTimeout(statusTimer);
  });

  const ready = Promise.all([loadSettings().catch(() => {}), startStale()]);
  return { ready };
}

if (globalThis.browser?.runtime && globalThis.document?.getElementById('settings-form')) {
  startOptions({ document, window, browser });
}
