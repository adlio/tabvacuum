// stale-core.js — Pure stale-tab rules (R4). No browser API calls.
// Eligibility, age, scheduling arithmetic and storage-record validation live
// here so captions, previews and execution share one implementation, with the
// clock and policy passed in explicitly.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_THRESHOLD_MS = 7 * DAY_MS;

export const MAX_TRACKED_TABS = 10_000;  // per privacy context
export const MAX_PREVIEW_TABS = 10_000;  // candidates one preview may authorize
export const PREVIEW_LIST_LIMIT = 100;   // rows sent to the review list
export const MAX_PREVIEWS = 8;           // per privacy context
export const PREVIEW_TTL_MS = 2 * 60 * 1000;
export const MAX_LEASES = 32;
export const LEASE_TTL_MS = 15 * 1000;
export const INTENT_TTL_MS = 10 * 1000;

const isTime = t => Number.isFinite(t) && t > 0;
const isId = id => Number.isSafeInteger(id) && id >= 0;

/** A threshold the editor can write: a positive whole number of hours, in safe-integer milliseconds. */
export function isValidThreshold(ms) {
  return Number.isSafeInteger(ms) && ms >= HOUR_MS && ms % HOUR_MS === 0;
}

/**
 * Settings as stored, normalized for planning. A previously saved positive
 * threshold is preserved for manual cleanup even if the current editor would
 * not accept it; automatic cleanup requires isValidThreshold.
 * Anything not strictly true leaves automation off.
 */
export function normalizeRule(stored = {}) {
  const ms = stored.staleThresholdMs;
  return {
    // 0.5.3 could save fractional values (1.1 hours): keep them to the millisecond.
    staleThresholdMs: Number.isFinite(ms) && ms > 0
      ? Math.min(Math.max(Math.round(ms), 1), Number.MAX_SAFE_INTEGER) : DEFAULT_THRESHOLD_MS,
    autoCloseStaleEnabled: stored.autoCloseStaleEnabled === true,
    skipPinned: stored.skipPinned !== false,
    skipAudible: stored.skipAudible !== false,
    revision: typeof stored.staleRuleRevision === 'string' ? stored.staleRuleRevision : '',
  };
}

/**
 * Validates the stale-rule fields of a settings patch. Returns the accepted
 * fields, or { error } without partial acceptance.
 */
export function validateRulePatch(patch) {
  const out = {};
  if ('staleThresholdMs' in patch) {
    if (!isValidThreshold(patch.staleThresholdMs)) {
      return { error: 'Enter a positive whole number of hours or days.' };
    }
    out.staleThresholdMs = patch.staleThresholdMs;
  }
  if ('autoCloseStaleEnabled' in patch) {
    if (typeof patch.autoCloseStaleEnabled !== 'boolean') return { error: 'Automatic cleanup must be on or off.' };
    out.autoCloseStaleEnabled = patch.autoCloseStaleEnabled;
  }
  for (const key of ['skipPinned', 'skipAudible']) {
    if (key in patch) {
      if (typeof patch[key] !== 'boolean') return { error: `${key} must be true or false.` };
      out[key] = patch[key];
    }
  }
  return { fields: out };
}

const QUARTER_MS = 15 * 60 * 1000;

/** True when `at` is on a whole local hour in the current time zone. */
export function isWholeLocalHour(at) {
  const date = new Date(at);
  return Number.isFinite(at) && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

/**
 * The next whole local hour strictly after `now`. Current zone offsets are
 * multiples of 15 minutes, so every whole local hour falls on a UTC quarter
 * hour. Scanning those handles 30-minute offsets, 30-minute DST (Lord Howe)
 * and the repeated fall-back hour. A zone with no whole hour in two days (a
 * historical offset) falls back to an hour after the current local hour began.
 */
export function nextLocalHour(now) {
  let at = Math.floor(now / QUARTER_MS) * QUARTER_MS + QUARTER_MS;
  for (let i = 0; i < 4 * 48; i++, at += QUARTER_MS) {
    if (isWholeLocalHour(at)) return at;
  }
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  at = start.getTime() + HOUR_MS;
  while (at <= now) at += HOUR_MS;
  return at;
}

/**
 * Is a scheduled run plausible for this clock and zone? Overdue runs stay
 * valid (a delayed alarm fires once on wake). A run more than an hour ahead
 * means the clock moved back, and one off the whole local hour means the time
 * zone changed; either is rescheduled.
 */
export function isPlausibleRun(at, now) {
  return isTime(at) && at <= nextLocalHour(now) && isWholeLocalHour(at);
}

/** Only ordinary web pages are automatic candidates. */
export function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Compact 53-bit string hash (cyrb53), so previews need not store URLs. */
export function urlHash(text) {
  const str = String(text ?? '');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Last time this tab was viewed, or null when unknown.
 *
 * record: this session's observation of the tab, { s: first observed,
 * v: last observed leaving/being active (0 if never), g: document generation }.
 *
 * nativeTrusted (Firefox): tab.lastAccessed records deselection and survives
 * restart, so it is used, together with any later observed leave.
 * Otherwise (Chromium) lastAccessed records selection only, so it can
 * overstate age; the first-observed baseline is used as a conservative
 * minimum, and native data can only make the tab younger.
 *
 * Any signal in the future means the clock or data is inconsistent: unknown.
 */
export function lastViewedAt(tab, record, { nativeTrusted, now }) {
  const native = isTime(tab?.lastAccessed) ? tab.lastAccessed : undefined;
  const signals = [];
  if (record && isTime(record.v)) signals.push(record.v);
  if (nativeTrusted && native !== undefined) {
    signals.push(native);
  } else {
    if (record && isTime(record.s)) signals.push(record.s);
    else return null; // no baseline: never proof of age
    if (native !== undefined) signals.push(native);
  }
  if (!signals.length || signals.some(t => t > now)) return null;
  return Math.max(...signals);
}

/**
 * Classifies one tab: 'protected' (never closes under this policy), 'unknown'
 * (age not established), 'fresh', or 'stale' at time `at`.
 *
 * ctx: { policy: 'manual'|'auto', at, now, thresholdMs, skipPinned,
 * skipAudible, nativeTrusted }. Automatic cleanup always protects pinned and
 * audible tabs, and anything whose safety state is not plainly known.
 */
export function classifyTab(tab, record, ctx) {
  const auto = ctx.policy === 'auto';
  if (!tab || !isId(tab.id) || !isId(tab.windowId)) return { status: 'protected' };
  for (const flag of ['active', 'pinned', 'audible']) {
    if (typeof tab[flag] !== 'boolean') return { status: 'protected' };
  }
  if (tab.active) return { status: 'protected' };
  if (tab.pinned && (auto || ctx.skipPinned)) return { status: 'protected' };
  if (tab.audible && (auto || ctx.skipAudible)) return { status: 'protected' };
  if (auto) {
    const sharing = tab.sharingState;
    if (tab.incognito !== false || !isWebUrl(tab.url) || tab.pendingUrl || tab.status === 'loading' ||
        tab.hidden === true || (sharing && (sharing.camera || sharing.microphone || sharing.screen))) {
      return { status: 'protected' };
    }
  }
  const viewed = lastViewedAt(tab, record, ctx);
  if (viewed === null) return { status: 'unknown', lastViewedAt: null };
  return { status: ctx.at - viewed >= ctx.thresholdMs ? 'stale' : 'fresh', lastViewedAt: viewed };
}

/**
 * Stale candidates among `tabs` (already limited to one privacy scope),
 * oldest first. A window contributes nothing unless its active tab is known,
 * and never loses its last tab. Duplicate URLs remain separate tabs.
 */
export function planStale(tabs, records, ctx) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  const candidates = [];
  let unknownCount = 0;
  for (const windowTabs of byWindow.values()) {
    if (!windowTabs.some(tab => tab.active === true)) continue;
    let remaining = windowTabs.length;
    for (const tab of windowTabs) {
      const verdict = classifyTab(tab, records?.[tab.id], ctx);
      if (verdict.status === 'unknown') unknownCount++;
      if (verdict.status !== 'stale' || remaining <= 1) continue;
      remaining--;
      candidates.push({
        id: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '',
        lastViewedAt: verdict.lastViewedAt, gen: records?.[tab.id]?.g ?? 0,
      });
    }
  }
  candidates.sort((a, b) => a.lastViewedAt - b.lastViewedAt || a.id - b.id);
  return { candidates, unknownCount, windowCount: new Set(candidates.map(c => c.windowId)).size };
}

// ---- Session records ----

const isRecord = r => r && typeof r === 'object' && isTime(r.s) &&
  (r.v === 0 || isTime(r.v)) && Number.isSafeInteger(r.g) && r.g >= 0;

/** Validated age store; anything malformed or oversized starts over (younger, so safe). */
export function readAgeStore(raw) {
  const store = { active: {}, tabs: {} };
  if (!raw || typeof raw !== 'object' || !raw.tabs || typeof raw.tabs !== 'object') return store;
  const entries = Object.entries(raw.tabs);
  if (entries.length > MAX_TRACKED_TABS) return store;
  for (const [id, record] of entries) {
    if (isId(Number(id)) && isRecord(record)) store.tabs[id] = { s: record.s, v: record.v, g: record.g };
  }
  for (const [windowId, tabId] of Object.entries(raw.active ?? {})) {
    if (isId(Number(windowId)) && isId(tabId)) store.active[windowId] = tabId;
  }
  return store;
}

/**
 * Brings records up to date with the live tabs of one privacy scope at `now`:
 * new tabs get a first-observed baseline (an existing baseline is never
 * reset), every active tab counts as viewed now, a missed deactivation is
 * recorded now, and closed tabs/windows are dropped. Returns true if changed.
 */
export function observeTabs(store, tabs, now) {
  let changed = false;
  const live = new Set();
  const activeByWindow = {};
  for (const tab of tabs) {
    if (!isId(tab.id)) continue;
    live.add(String(tab.id));
    if (!store.tabs[tab.id]) {
      if (live.size > MAX_TRACKED_TABS) continue;
      store.tabs[tab.id] = { s: now, v: 0, g: 0 };
      changed = true;
    }
    if (tab.active === true && isId(tab.windowId)) activeByWindow[tab.windowId] = tab.id;
  }
  for (const [windowId, tabId] of Object.entries(activeByWindow)) {
    if (!store.tabs[tabId]) continue;
    const before = store.active[windowId];
    if (before !== undefined && before !== tabId && store.tabs[before]) store.tabs[before].v = now;
    store.active[windowId] = tabId;
    store.tabs[tabId].v = now;
    changed = true;
  }
  for (const id of Object.keys(store.tabs)) {
    if (!live.has(id)) { delete store.tabs[id]; changed = true; }
  }
  for (const windowId of Object.keys(store.active)) {
    if (!(windowId in activeByWindow)) { delete store.active[windowId]; changed = true; }
  }
  return changed;
}

/** Records a tab switch in one window at `now`. previousTabId may be absent (Chromium). */
export function recordActivation(store, { tabId, windowId, previousTabId }, now) {
  if (!isId(tabId) || !isId(windowId)) return false;
  const leaving = isId(previousTabId) ? previousTabId : store.active[windowId];
  if (leaving !== undefined && leaving !== tabId) {
    store.tabs[leaving] ??= { s: now, v: 0, g: 0 };
    store.tabs[leaving].v = now;
  }
  store.tabs[tabId] ??= { s: now, v: 0, g: 0 };
  store.tabs[tabId].v = now;
  store.active[windowId] = tabId;
  return true;
}

// ---- Previews, leases, intents ----

/** Drops expired or clock-inconsistent previews, then the oldest beyond the cap. */
export function prunePreviews(previews, now) {
  const kept = Object.entries(previews && typeof previews === 'object' ? previews : {})
    .filter(([, p]) => p && isTime(p.exp) && p.exp > now && p.exp <= now + PREVIEW_TTL_MS &&
      Array.isArray(p.c) && p.c.length <= MAX_PREVIEW_TABS)
    .sort(([, a], [, b]) => b.exp - a.exp)
    .slice(0, MAX_PREVIEWS);
  return Object.fromEntries(kept);
}

export function pruneLeases(leases, now) {
  const kept = Object.entries(leases && typeof leases === 'object' ? leases : {})
    .filter(([, l]) => l && isTime(l.exp) && l.exp > now && l.exp <= now + LEASE_TTL_MS && isId(l.w))
    .sort(([, a], [, b]) => b.exp - a.exp)
    .slice(0, MAX_LEASES);
  return Object.fromEntries(kept);
}

export function isLiveIntent(intent, now) {
  return Boolean(intent) && isId(intent.w) && isTime(intent.exp) && intent.exp > now && intent.exp <= now + INTENT_TTL_MS;
}

// ---- Messages ----

const tabs = n => `${n} tab${n === 1 ? '' : 's'}`;

/** Result text for a manual close. Counts are what actually happened. */
export function manualCloseMessage({ closed, skipped, failed }) {
  const parts = [closed ? `Closed ${tabs(closed)} not viewed recently.` : 'No stale tabs were closed.'];
  if (skipped) parts.push(`Kept ${tabs(skipped)} that changed or ${skipped === 1 ? 'is' : 'are'} no longer stale.`);
  if (failed) parts.push(`Could not close ${tabs(failed)}.`);
  return parts.join(' ');
}

/** Automatic sweep notification, or '' when nothing changed. Never names tabs. */
export function autoCloseMessage({ closed, failed }) {
  if (!closed && !failed) return '';
  const parts = [];
  if (closed) parts.push(`Automatically closed ${tabs(closed)} not viewed recently.`);
  if (failed) parts.push(`Could not close ${tabs(failed)} automatically.`);
  return parts.join(' ');
}
