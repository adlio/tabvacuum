// Shared stale-tab presentation for the toolbar menu and Settings (R4, R5).
// Pure helpers plus one small lease client. The background owns eligibility
// and scheduling; this module only formats and validates what it reports.

export const ENABLED_TITLE = 'Stale Tabs (Auto-Close Enabled)';
export const DISABLED_TITLE = 'Stale Tabs';
export const REFRESH_MS = 5000;
export const LEASE_RENEW_MS = 5000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UNIT_MS = { days: DAY_MS, hours: HOUR_MS };

export const NO_REPLY = "Aaron's Tab Vacuum did not respond.";
export const UNKNOWN_AUTO_TEXT = 'Automatic cleanup status is unknown. You can still turn it off.';

export function describeUnavailable(enabled) {
  if (enabled === true) return "Couldn't check which tabs will close. Auto-close is enabled; turn it off above to stop it.";
  if (enabled === false) return "Couldn't check which tabs are stale. Auto-close is disabled.";
  return UNKNOWN_AUTO_TEXT;
}

export const tabCount = n => (n === 1 ? '1 tab' : `${n} tabs`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isCount = n => Number.isSafeInteger(n) && n >= 0;
const isTime = t => Number.isFinite(t) && t > 0;
const isThreshold = ms => Number.isSafeInteger(ms) && ms > 0;
const errorText = err => String(err?.message ?? err ?? 'Unknown error');

// Stale age is reported differently per browser, so the background states which
// basis applies through getStaleState's `ageBasis`. Firefox exposes a tab's
// last-viewed time; Chrome exposes when a tab was last activated (selected), so
// its clock starts at selection rather than when the tab is left. When the
// field is absent or unrecognised, neutral "used" wording claims neither.
const AGE_TERMS = {
  viewed: { idle: 'not viewed for', none: 'gone unviewed for', ago: 'Viewed', timeNoun: 'viewed time' },
  activated: { idle: 'not activated for', none: 'gone without activation for', ago: 'Activated', timeNoun: 'activation time' },
  used: { idle: 'not used for', none: 'gone unused for', ago: 'Used', timeNoun: 'used time' },
};

export function ageTerms(ageBasis) {
  return AGE_TERMS[ageBasis] ?? AGE_TERMS.used;
}

// Browser-appropriate label for the duration field, e.g. "Close tabs not viewed for".
export function ruleLabel(ageBasis) {
  return `Close tabs ${ageTerms(ageBasis).idle}`;
}

// Validates a typed duration: a positive whole number whose milliseconds stay
// a safe integer. There is no other upper limit.
export function parseDuration(raw, unit) {
  const unitMs = UNIT_MS[unit];
  const name = unitMs ? unit : 'days';
  const text = String(raw ?? '').trim();
  if (!unitMs || !/^\d+$/.test(text) || Number(text) < 1) return { error: `Enter a whole number of ${name}, 1 or more.` };
  const ms = Number(text) * unitMs;
  if (!Number.isSafeInteger(ms)) return { error: `Enter a smaller whole number of ${name}.` };
  return { ms };
}

// The same duration in another unit, as editor text. A result that is not a
// whole number (36 hours is 1.5 days) stays visible and fails validation, so
// nothing is saved until the user changes it. Null when the text is not valid.
export function convertDuration(raw, from, to) {
  const { ms } = parseDuration(raw, from);
  return ms && UNIT_MS[to] ? String(ms / UNIT_MS[to]) : null;
}

// Splits a saved threshold into the editor's fields. Values that are not whole
// hours are shown as-is so validation flags them instead of rounding silently.
export function durationFromMs(ms) {
  if (ms > 0 && ms % DAY_MS === 0) return { value: ms / DAY_MS, unit: 'days' };
  return { value: ms / HOUR_MS, unit: 'hours' };
}

export function durationText(ms) {
  const { value, unit } = durationFromMs(ms);
  return plural(value, unit.slice(0, -1));
}

// "10p", "10:30p" for English 12-hour locales; the locale's own clock otherwise.
// Adds "tomorrow" or a date when the run is not today.
export function formatRunTime(at, now, locale) {
  const date = new Date(at);
  const hourOptions = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
  const twelveHour = hourOptions.hourCycle ? /^h1[12]$/.test(hourOptions.hourCycle) : hourOptions.hour12;
  let time;
  if (twelveHour && /^en\b/i.test(hourOptions.locale)) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    time = `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${hours < 12 ? 'a' : 'p'}`;
  } else {
    time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  const today = new Date(now);
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()) -
      new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS,
  );
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} on ${new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(date)}`;
}

export function formatViewedAgo(lastViewedAt, now, locale, ageBasis) {
  const terms = ageTerms(ageBasis);
  if (!isTime(lastViewedAt) || lastViewedAt > now) return `Last ${terms.timeNoun} unknown`;
  const minutes = Math.floor((now - lastViewedAt) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  if (minutes < 60) return `${terms.ago} ${rtf.format(-Math.max(minutes, 1), 'minute')}`;
  if (minutes < 48 * 60) return `${terms.ago} ${rtf.format(-Math.floor(minutes / 60), 'hour')}`;
  return `${terms.ago} ${rtf.format(-Math.floor(minutes / (24 * 60)), 'day')}`;
}

export function domainOf(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return hostname || protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

// Accepts only a complete getStaleState reply. Anything else is "unknown",
// never a zero count.
export function isStaleState(reply) {
  const s = reply?.settings;
  const a = reply?.auto;
  const p = reply?.preview;
  return Boolean(
    s && a && p && !reply.error &&
    Number.isSafeInteger(s.staleThresholdMs) && s.staleThresholdMs > 0 &&
    typeof s.autoCloseStaleEnabled === 'boolean' &&
    typeof s.skipPinned === 'boolean' && typeof s.skipAudible === 'boolean' &&
    typeof a.enabled === 'boolean' && typeof a.available === 'boolean' &&
    (a.nextRunAt == null || Number.isFinite(a.nextRunAt)) &&
    (a.count == null || isCount(a.count)) &&
    (a.error == null || typeof a.error === 'string') &&
    typeof p.id === 'string' && p.id && Array.isArray(p.tabs) &&
    isCount(p.count) && p.tabs.length <= p.count &&
    (p.windowCount == null || isCount(p.windowCount)) &&
    (p.unknownCount == null || isCount(p.unknownCount)) &&
    p.tabs.every(tab => tab && Number.isSafeInteger(tab.id)),
  );
}

// A private-window menu must never show normal-window automation numbers,
// even if a reply carried them.
export function scopeState(state, incognito) {
  if (!incognito) return state;
  return { ...state, auto: { ...state.auto, available: false, count: null } };
}

// Automation can be scheduled and its projection is trustworthy.
const autoReady = auto => auto.available && !auto.error && isTime(auto.nextRunAt) && isCount(auto.count);

export function canEnableAuto(state) {
  return Boolean(state) && autoReady(state.auto);
}

// Collapsed main-menu row. `state` is the latest current reply (or null);
// `enabled` is the saved preference, which can be known without a valid state
// (true, false, or null while unknown); `error` marks the state unavailable.
export function describeMain({ state, enabled = state ? state.settings.autoCloseStaleEnabled : null, error, now, locale }) {
  const title = enabled === true ? ENABLED_TITLE : DISABLED_TITLE;
  if (error) {
    return { title, caption: enabled == null ? 'Automatic cleanup status unavailable.' : 'Stale-tab status unavailable.', tone: 'error' };
  }
  // Unknown is never shown as off.
  if (enabled == null || (enabled && !state)) return { title, caption: 'Checking…', tone: 'muted' };
  if (!enabled || !state.auto.available) return { title, caption: '', tone: '' };
  const { auto } = state;
  if (auto.error) return { title, caption: auto.error, tone: 'error' };
  if (!autoReady(auto)) return { title, caption: 'Automatic cleanup is not scheduled.', tone: 'error' };
  if (auto.count === 0) return { title, caption: '', tone: '' };
  return { title, caption: `Closing ${tabCount(auto.count)} automatically at ${formatRunTime(auto.nextRunAt, now, locale)}.`, tone: '' };
}

// Automation line beside the checkbox, explaining the first run before enabling.
export function describeAuto(state, now, locale) {
  if (!state) return { text: 'Checking the next cleanup…', tone: 'muted' };
  const { auto, settings } = state;
  if (!auto.available) return { text: 'Automatic cleanup runs in normal windows only. Private windows are not included.', tone: '' };
  if (auto.error) return { text: auto.error, tone: 'error' };
  if (!autoReady(auto)) return { text: 'Automatic cleanup is not scheduled.', tone: 'error' };
  const at = formatRunTime(auto.nextRunAt, now, locale);
  const horizon = auto.count > state.preview.count
    ? ` Includes tabs that reach ${durationText(settings.staleThresholdMs)} before then.` : '';
  if (settings.autoCloseStaleEnabled) {
    return { text: auto.count ? `Closing ${tabCount(auto.count)} automatically at ${at}.${horizon}` : `No tabs would close automatically at ${at}.`, tone: '' };
  }
  return {
    text: auto.count
      ? `If turned on, ${tabCount(auto.count)} would close automatically at ${at}.${horizon} Nothing closes before then.`
      : `If turned on, the first automatic cleanup is at ${at}. No tabs would close then.`,
    tone: '',
  };
}

// Manual "Close now" scope and protections. Kept distinct from the automatic count.
export function describeManual(state, incognito) {
  const { preview, settings } = state;
  const terms = ageTerms(state.ageBasis);
  const rule = durationText(settings.staleThresholdMs);
  const where = preview.windowCount == null ? '' : `, across ${plural(preview.windowCount, incognito ? 'private window' : 'window')}`;
  const count = preview.count
    ? `Close now: ${tabCount(preview.count)} ${terms.idle} ${rule}${where}.`
    : `Close now: no tabs have ${terms.none} ${rule}.`;
  const kept = [settings.skipPinned && 'pinned tabs', settings.skipAudible && 'tabs playing audio'].filter(Boolean);
  const notes = [kept.length ? `Close now keeps ${kept.join(' and ')}.` : 'Close now includes pinned tabs and tabs playing audio.'];
  if (preview.unknownCount) notes.push(`${tabCount(preview.unknownCount)} with an unknown last ${terms.timeNoun} ${preview.unknownCount === 1 ? 'is' : 'are'} kept.`);
  notes.push("Both keep each window's active tab and last tab, even when the active tab's age is past the limit. Automatic cleanup always keeps pinned tabs and tabs playing audio.");
  return { count, protections: notes.join(' ') };
}

// Requests issued later supersede earlier ones; stale replies are dropped.
export function createLatest() {
  let seq = 0;
  return {
    next() { const id = ++seq; return () => id === seq; },
    invalidate() { seq++; },
  };
}

// Saves the stale rule through `send(settings)` (setStaleRule). The background
// applies writes one at a time in arrival order, so every change is sent at
// once and the last one sent wins: turning automation off never waits for an
// earlier save, and an earlier enable cannot land after a later disable.
// `value(key)` is the latest unconfirmed value, else the confirmed one, else
// null (unknown). Reads are ignored while any write is unconfirmed.
export function createRuleWriter(send) {
  const saved = { staleThresholdMs: null, autoCloseStaleEnabled: null };
  const sent = new Map(); // key -> { id, value } of the latest write for that key
  let seq = 0;
  let writes = 0;
  return {
    get busy() { return writes > 0; },
    value: key => (sent.has(key) ? sent.get(key).value : saved[key]),
    saved: key => saved[key],
    // `fill` only sets keys still unknown, for a read that may be older than another.
    learn(settings, { fill = false } = {}) {
      if (writes) return;
      const ms = settings?.staleThresholdMs;
      const on = settings?.autoCloseStaleEnabled;
      if (isThreshold(ms) && !(fill && saved.staleThresholdMs != null)) saved.staleThresholdMs = ms;
      if (typeof on === 'boolean' && !(fill && saved.autoCloseStaleEnabled != null)) saved.autoCloseStaleEnabled = on;
    },
    async save(settings) {
      const id = ++seq;
      const entries = Object.entries(settings);
      writes++;
      for (const [key, value] of entries) sent.set(key, { id, value });
      let reply;
      try {
        reply = await send(settings);
      } catch (error) {
        reply = { error: errorText(error) };
      }
      writes--;
      const ok = !reply?.error && typeof reply?.message === 'string';
      for (const [key, value] of entries) {
        if (ok) saved[key] = value;
        if (sent.get(key)?.id === id) sent.delete(key);
      }
      return ok ? { ok } : { ok, error: String(reply?.error ?? NO_REPLY) };
    },
  };
}

// Short-lived editor lease: acquire on open, renew every five seconds, release
// on close. The background expires a lease that stops renewing, so a lost view
// cannot defer automation indefinitely. One lease client per page.
export function createEditorLease(send, { renewMs = LEASE_RENEW_MS } = {}) {
  let open = false;
  let editorId;
  let inflight = false;
  let timer;

  const call = async params => {
    try { return await send(params); } catch { return null; }
  };

  function release() {
    const id = editorId;
    editorId = undefined;
    if (id) call({ open: false, editorId: id });
  }

  async function beat() {
    if (!open || inflight) return;
    inflight = true;
    const reply = await call(editorId ? { open: true, editorId } : { open: true });
    inflight = false;
    editorId = typeof reply?.editorId === 'string' && reply.editorId ? reply.editorId : undefined;
    if (!open) release(); // closed while acquiring
  }

  return {
    open() {
      if (open) return;
      open = true;
      beat();
      timer = setInterval(beat, renewMs);
    },
    close() {
      if (!open) return;
      open = false;
      clearInterval(timer);
      if (!inflight) release();
    },
    get isOpen() { return open; },
  };
}

// Subscribes to browser events that can change stale state; returns an unsubscribe.
export function watchStaleSources(browser, onChange) {
  const events = [
    browser.tabs?.onCreated, browser.tabs?.onRemoved, browser.tabs?.onUpdated,
    browser.tabs?.onActivated, browser.tabs?.onAttached, browser.tabs?.onDetached,
    browser.storage?.onChanged,
  ].filter(event => typeof event?.addListener === 'function');
  for (const event of events) event.addListener(onChange);
  return () => { for (const event of events) event.removeListener?.(onChange); };
}
