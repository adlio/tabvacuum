import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DAY_MS, HOUR_MS, DEFAULT_THRESHOLD_MS, LEASE_TTL_MS, MAX_PREVIEWS, MAX_TRACKED_TABS, PREVIEW_TTL_MS,
  autoCloseMessage, classifyTab, isLiveIntent, isPlausibleRun, isValidThreshold, isWholeLocalHour, lastViewedAt,
  manualCloseMessage, nextLocalHour, normalizeRule, observeTabs, planStale, pruneLeases, prunePreviews,
  readAgeStore, recordActivation, urlHash, validateRulePatch,
} from '../src/stale-core.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const WEEK = 7 * DAY_MS;

const tab = (id, extra = {}) => ({
  id, windowId: 1, active: false, pinned: false, audible: false, incognito: false,
  status: 'complete', url: `https://site.example/${id}`, title: `T${id}`, ...extra,
});
const ctx = (extra = {}) => ({
  policy: 'manual', at: NOW, now: NOW, thresholdMs: WEEK, skipPinned: true, skipAudible: true,
  nativeTrusted: true, ...extra,
});
const active = (id = 99, extra = {}) => tab(id, { active: true, lastAccessed: NOW, ...extra });

describe('lastViewedAt', () => {
  it('trusts native Firefox age, and a later observed leave only makes a tab younger', () => {
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, undefined, { nativeTrusted: true, now: NOW })).toBe(NOW - WEEK);
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, { s: NOW - 2 * WEEK, v: NOW - DAY_MS, g: 0 },
      { nativeTrusted: true, now: NOW })).toBe(NOW - DAY_MS);
  });

  it('trusts Chromium native last-activation, corrected only younger', () => {
    const chrome = { nativeTrusted: false, now: NOW };
    // Native last-activation is the age, even with no session record.
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, undefined, chrome)).toBe(NOW - WEEK);
    // The journal corrector can only raise it (younger), never lower it.
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, undefined, { ...chrome, correctAnchor: () => NOW - DAY_MS })).toBe(NOW - DAY_MS);
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, undefined, { ...chrome, correctAnchor: () => NOW - 2 * WEEK })).toBe(NOW - WEEK);
    // Age is measured from the activation; a later deselection does NOT fold in.
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, { s: NOW - 2 * WEEK, v: NOW - DAY_MS, g: 0 }, chrome)).toBe(NOW - WEEK);
    // A replaced/discarded document (u) distrusts native and falls back to the baseline.
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, { s: NOW - HOUR_MS, v: 0, g: 0, u: 1 }, chrome)).toBe(NOW - HOUR_MS);
    // No native: the first-observed baseline is the conservative fallback.
    expect(lastViewedAt({}, { s: NOW - HOUR_MS, v: 0, g: 0 }, chrome)).toBe(NOW - HOUR_MS);
    expect(lastViewedAt({}, undefined, chrome)).toBeNull();
  });

  it('Chromium measures from the last activation while Firefox resets on the leave', () => {
    // Selected over a week ago, deselected a day ago.
    const tab = { lastAccessed: NOW - WEEK - DAY_MS };
    const record = { s: NOW - 2 * WEEK, v: NOW - DAY_MS, g: 0 };
    // Chrome: the deselection does not reset the age; it stays at the activation.
    expect(lastViewedAt(tab, record, { nativeTrusted: false, now: NOW })).toBe(NOW - WEEK - DAY_MS);
    // Firefox: native lastAccessed is the deselection itself, so observe-leave applies.
    expect(lastViewedAt(tab, record, { nativeTrusted: true, now: NOW })).toBe(NOW - DAY_MS);
  });

  it('a future native anchor keeps the tab, never dropping to an older baseline', () => {
    // Clock skew/restore can report a native in the future. With an older
    // same-session baseline present it must still read as unknown (keep), not
    // fall back to the baseline and become closable.
    const record = { s: NOW - 3 * WEEK, v: 0, g: 0 };
    expect(lastViewedAt({ lastAccessed: NOW + HOUR_MS }, record, { nativeTrusted: false, now: NOW })).toBeNull();
    expect(lastViewedAt({ lastAccessed: NOW + HOUR_MS }, record, { nativeTrusted: true, now: NOW })).toBeNull();
  });

  it.each([
    ['missing', undefined], ['zero', 0], ['negative', -5], ['NaN', NaN], ['Infinity', Infinity], ['string', '1'],
  ])('a %s timestamp is not proof of age', (_, lastAccessed) => {
    expect(lastViewedAt({ lastAccessed }, undefined, { nativeTrusted: true, now: NOW })).toBeNull();
  });

  it('a future signal makes age unknown', () => {
    expect(lastViewedAt({ lastAccessed: NOW + 1 }, undefined, { nativeTrusted: true, now: NOW })).toBeNull();
    expect(lastViewedAt({}, { s: NOW + 1, v: 0, g: 0 }, { nativeTrusted: false, now: NOW })).toBeNull();
    expect(lastViewedAt({ lastAccessed: NOW - WEEK }, { s: 1, v: NOW + 5, g: 0 }, { nativeTrusted: true, now: NOW })).toBeNull();
  });
});

describe('classifyTab', () => {
  it('equality qualifies; one millisecond short does not', () => {
    expect(classifyTab(tab(1, { lastAccessed: NOW - WEEK }), undefined, ctx()).status).toBe('stale');
    expect(classifyTab(tab(1, { lastAccessed: NOW - WEEK + 1 }), undefined, ctx()).status).toBe('fresh');
    expect(classifyTab(tab(1, { lastAccessed: NOW - WEEK - 1 }), undefined, ctx()).status).toBe('stale');
  });

  it('projects eligibility to a later run time', () => {
    const t = tab(1, { lastAccessed: NOW - WEEK + 30 * 60_000 });
    expect(classifyTab(t, undefined, ctx()).status).toBe('fresh');
    expect(classifyTab(t, undefined, ctx({ at: NOW + HOUR_MS })).status).toBe('stale');
  });

  it('unknown age is reported as unknown, never stale', () => {
    expect(classifyTab(tab(1), undefined, ctx())).toEqual({ status: 'unknown', lastViewedAt: null });
  });

  const old = { lastAccessed: NOW - 2 * WEEK };
  it.each([
    ['active', { active: true }],
    ['pinned (setting on)', { pinned: true }],
    ['audible (setting on)', { audible: true }],
    ['missing safety flags', { audible: undefined }],
    ['a bad id', { id: -1 }],
  ])('manual cleanup protects %s tabs', (_, extra) => {
    expect(classifyTab(tab(1, { ...old, ...extra }), undefined, ctx()).status).toBe('protected');
  });

  it('manual cleanup follows the pinned/audible settings when they are off', () => {
    const off = ctx({ skipPinned: false, skipAudible: false });
    expect(classifyTab(tab(1, { ...old, pinned: true }), undefined, off).status).toBe('stale');
    expect(classifyTab(tab(1, { ...old, audible: true }), undefined, off).status).toBe('stale');
  });

  it.each([
    ['pinned, whatever the setting', { pinned: true }],
    ['audible, whatever the setting', { audible: true }],
    ['private', { incognito: true }],
    ['unknown privacy', { incognito: undefined }],
    ['extension pages', { url: 'moz-extension://x/search.html' }],
    ['internal pages', { url: 'about:preferences' }],
    ['navigating', { pendingUrl: 'https://next.example/' }],
    ['loading', { status: 'loading' }],
    ['hidden', { hidden: true }],
    ['sharing the camera', { sharingState: { camera: true } }],
  ])('automatic cleanup protects %s tabs', (_, extra) => {
    const auto = ctx({ policy: 'auto', skipPinned: false, skipAudible: false });
    expect(classifyTab(tab(1, { ...old, ...extra }), undefined, auto).status).toBe('protected');
  });

  it('automatic cleanup closes ordinary old web pages', () => {
    expect(classifyTab(tab(1, old), undefined, ctx({ policy: 'auto' })).status).toBe('stale');
  });

  it('Chrome counts a long-ago selection as stale even if left recently; Firefox keeps it', () => {
    const t = tab(1, { lastAccessed: NOW - WEEK - DAY_MS }); // last selected over a week ago
    const record = { s: NOW - 2 * WEEK, v: NOW - DAY_MS, g: 0 }; // but deselected only a day ago
    expect(classifyTab(t, record, ctx({ nativeTrusted: false })).status).toBe('stale');
    expect(classifyTab(t, record, ctx({ nativeTrusted: true })).status).toBe('fresh');
  });
});

describe('planStale', () => {
  it('keeps duplicate URLs as separate tabs and lists the oldest first', () => {
    const tabs = [
      active(),
      tab(1, { url: 'https://same.example/', lastAccessed: NOW - WEEK }),
      tab(2, { url: 'https://same.example/', lastAccessed: NOW - 3 * WEEK }),
      tab(3, { url: 'https://same.example/', lastAccessed: NOW - DAY_MS }),
    ];
    const plan = planStale(tabs, {}, ctx());
    expect(plan.candidates.map(c => c.id)).toEqual([2, 1]);
    expect(plan.windowCount).toBe(1);
  });

  it('never takes the last tab, and skips windows without a known active tab', () => {
    const lone = [tab(1, { lastAccessed: NOW - 2 * WEEK })];
    expect(planStale(lone, {}, ctx()).candidates).toEqual([]);
    const noActive = [tab(1, { lastAccessed: NOW - 2 * WEEK }), tab(2, { lastAccessed: NOW - 2 * WEEK })];
    expect(planStale(noActive, {}, ctx()).candidates).toEqual([]);
  });

  it('counts unknown-age tabs separately and keeps them', () => {
    const plan = planStale([active(), tab(1), tab(2, { lastAccessed: NOW - 2 * WEEK })], {}, ctx());
    expect(plan.candidates.map(c => c.id)).toEqual([2]);
    expect(plan.unknownCount).toBe(1);
  });

  it('carries the document generation for preview binding', () => {
    const plan = planStale([active(), tab(1, { lastAccessed: NOW - 2 * WEEK })], { 1: { s: 1, v: 0, g: 4 } }, ctx());
    expect(plan.candidates[0]).toMatchObject({ id: 1, gen: 4, lastViewedAt: NOW - 2 * WEEK });
  });

  it('trusts Chromium native last-activation, with the journal correcting only younger', () => {
    const records = { 1: { s: NOW - HOUR_MS, v: 0, g: 0, a: NOW - 30 * DAY_MS } };
    const tabs = [active(), tab(1, { lastAccessed: NOW - 30 * DAY_MS })];
    // Native says 30 days since last activation: stale now, even just-observed.
    expect(planStale(tabs, records, ctx({ nativeTrusted: false })).candidates.map(c => c.id)).toEqual([1]);
    // A journal correction to a recent floor keeps it.
    expect(planStale(tabs, records, ctx({ nativeTrusted: false, correctAnchor: () => NOW - HOUR_MS })).candidates).toEqual([]);
  });

  it('uses the first-observed baseline when native age is untrusted (a replaced tab)', () => {
    const records = { 1: { s: NOW - HOUR_MS, v: 0, g: 0, u: 1 } };
    const tabs = [active(), tab(1, { lastAccessed: NOW - 30 * DAY_MS })];
    expect(planStale(tabs, records, ctx({ nativeTrusted: false })).candidates).toEqual([]);
    expect(planStale(tabs, records, ctx({ nativeTrusted: false, at: NOW - HOUR_MS + WEEK })).candidates).toHaveLength(1);
  });
});

describe('observed records', () => {
  it('starts a baseline once and never resets it by re-checking', () => {
    const store = readAgeStore(undefined);
    observeTabs(store, [active(9), tab(1)], NOW);
    observeTabs(store, [active(9), tab(1)], NOW + HOUR_MS);
    expect(store.tabs[1]).toEqual({ s: NOW, v: 0, g: 0 });
    expect(store.tabs[9].v).toBe(NOW + HOUR_MS);
  });

  it('records a missed deactivation at the time it is noticed and drops closed tabs', () => {
    const store = readAgeStore(undefined);
    observeTabs(store, [active(9), tab(1)], NOW);
    observeTabs(store, [tab(9), active(1)], NOW + 5);
    expect(store.tabs[9].v).toBe(NOW + 5);
    expect(store.active).toEqual({ 1: 1 });
    observeTabs(store, [active(1)], NOW + 6);
    expect(store.tabs[9]).toBeUndefined();
  });

  it('records leaving a tab without previousTabId using the window map (Chromium)', () => {
    const store = readAgeStore(undefined);
    recordActivation(store, { tabId: 1, windowId: 1 }, NOW);
    recordActivation(store, { tabId: 2, windowId: 1 }, NOW + 10);
    expect(store.tabs[1].v).toBe(NOW + 10);
    expect(store.tabs[2].v).toBe(NOW + 10);
    expect(store.active[1]).toBe(2);
  });

  it('prefers previousTabId when the browser gives it', () => {
    const store = readAgeStore(undefined);
    recordActivation(store, { tabId: 3, windowId: 1, previousTabId: 7 }, NOW);
    expect(store.tabs[7].v).toBe(NOW);
  });

  it('tracks the native anchor and emits a supersession only when it advances', () => {
    const store = readAgeStore(undefined);
    const events = [];
    observeTabs(store, [active(9, { lastAccessed: NOW })], NOW, events);
    expect(store.tabs[9].a).toBe(NOW);
    expect(events).toEqual([]); // first sighting records the anchor, no supersession
    observeTabs(store, [active(9, { lastAccessed: NOW + HOUR_MS })], NOW + HOUR_MS, events);
    expect(store.tabs[9].a).toBe(NOW + HOUR_MS);
    expect(events).toEqual([[NOW, NOW + HOUR_MS]]);
    // A backward native move is ignored; the newest activation stands.
    observeTabs(store, [active(9, { lastAccessed: NOW })], NOW + 2 * HOUR_MS, events);
    expect(store.tabs[9].a).toBe(NOW + HOUR_MS);
    expect(events).toHaveLength(1);
  });

  it('recordActivation anchors on the browser native value, emits a native-valued supersession and clears untrusted', () => {
    const store = { active: {}, tabs: { 1: { s: NOW - DAY_MS, v: 0, g: 0, a: NOW - DAY_MS, u: 1 } } };
    const events = [];
    const nativeAnchor = NOW - 25; // browser clock, >drift from the event clock NOW
    recordActivation(store, { tabId: 1, windowId: 1 }, NOW, events, nativeAnchor);
    expect(store.tabs[1].a).toBe(nativeAnchor);          // native, never the event clock
    expect(store.tabs[1].u).toBeUndefined();             // genuine activation clears untrusted
    expect(store.tabs[1].v).toBe(NOW);                   // the event timestamp is the leave/observed signal
    expect(events).toEqual([[NOW - DAY_MS, nativeAnchor]]); // supersession is native-valued
  });

  it('recordActivation does not invent an anchor from the event clock when native is unavailable', () => {
    const store = { active: {}, tabs: { 1: { s: NOW - DAY_MS, v: 0, g: 0, a: NOW - DAY_MS } } };
    const events = [];
    recordActivation(store, { tabId: 1, windowId: 1 }, NOW, events); // no native anchor
    expect(store.tabs[1].a).toBe(NOW - DAY_MS);          // unchanged: no event-clock stamp
    expect(store.tabs[1].v).toBe(NOW);
    expect(events).toEqual([]);                          // no churned supersession
    // A future native anchor is also ignored (the newest activation stands).
    recordActivation(store, { tabId: 1, windowId: 1 }, NOW, events, NOW + 1000);
    expect(store.tabs[1].a).toBe(NOW - DAY_MS);
    expect(events).toEqual([]);
  });

  it('preserves native-anchor and untrusted fields through readAgeStore', () => {
    const store = readAgeStore({ active: {}, tabs: {
      1: { s: NOW, v: 0, g: 0, a: NOW - DAY_MS },
      2: { s: NOW, v: 0, g: 0, u: 1 },
      3: { s: NOW, v: 0, g: 0, a: -1 },  // bad anchor: whole record dropped
      4: { s: NOW, v: 0, g: 0, u: 2 },   // bad flag: whole record dropped
    } });
    expect(store.tabs[1]).toEqual({ s: NOW, v: 0, g: 0, a: NOW - DAY_MS });
    expect(store.tabs[2]).toEqual({ s: NOW, v: 0, g: 0, u: 1 });
    expect(store.tabs[3]).toBeUndefined();
    expect(store.tabs[4]).toBeUndefined();
  });

  it('drops malformed records and resets an oversized store', () => {
    const store = readAgeStore({
      active: { 1: 2, x: 3, 4: 'no' },
      tabs: { 1: { s: NOW, v: 0, g: 0 }, 2: { s: 0, v: 0, g: 0 }, x: { s: NOW, v: 0, g: 0 }, 3: { s: NOW, v: -1, g: 0 }, 4: 'bad' },
    });
    expect(store).toEqual({ active: { 1: 2 }, tabs: { 1: { s: NOW, v: 0, g: 0 } } });
    const huge = { tabs: Object.fromEntries(Array.from({ length: MAX_TRACKED_TABS + 1 }, (_, i) => [i, { s: NOW, v: 0, g: 0 }])) };
    expect(readAgeStore(huge).tabs).toEqual({});
    expect(readAgeStore('garbage')).toEqual({ active: {}, tabs: {} });
  });
});

describe('rule validation', () => {
  it('accepts positive whole hours with no arbitrary upper limit', () => {
    expect(isValidThreshold(HOUR_MS)).toBe(true);
    expect(isValidThreshold(400 * DAY_MS)).toBe(true);
    for (const bad of [0, -HOUR_MS, HOUR_MS / 2, HOUR_MS + 1, 1.5 * HOUR_MS, Number.MAX_VALUE, NaN, '3600000', 2 ** 53 * HOUR_MS]) {
      expect(isValidThreshold(bad)).toBe(false);
    }
  });

  it('validates the patch as a whole', () => {
    expect(validateRulePatch({ staleThresholdMs: 2 * HOUR_MS, autoCloseStaleEnabled: true }))
      .toEqual({ fields: { staleThresholdMs: 2 * HOUR_MS, autoCloseStaleEnabled: true } });
    expect(validateRulePatch({ staleThresholdMs: 0, autoCloseStaleEnabled: true }).error).toMatch(/whole number/);
    expect(validateRulePatch({ autoCloseStaleEnabled: 'yes' }).error).toBeTruthy();
    expect(validateRulePatch({ skipPinned: 1 }).error).toBeTruthy();
  });

  it('preserves a legacy positive threshold and defaults automation off', () => {
    expect(normalizeRule({ staleThresholdMs: 90 * 60_000 })).toMatchObject({ staleThresholdMs: 90 * 60_000, autoCloseStaleEnabled: false });
    expect(normalizeRule({ staleThresholdMs: 0 }).staleThresholdMs).toBe(DEFAULT_THRESHOLD_MS);
    expect(normalizeRule({ autoCloseStaleEnabled: 'true' }).autoCloseStaleEnabled).toBe(false);
    expect(normalizeRule({})).toMatchObject({ skipPinned: true, skipAudible: true, revision: '' });
  });

  it('keeps fractional or oversized legacy thresholds as safe integers instead of resetting them', () => {
    expect(normalizeRule({ staleThresholdMs: 1.1 * HOUR_MS }).staleThresholdMs).toBe(3_960_000);
    expect(normalizeRule({ staleThresholdMs: 0.3 }).staleThresholdMs).toBe(1);
    expect(normalizeRule({ staleThresholdMs: 1e20 }).staleThresholdMs).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [-1, NaN, Infinity, '604800000', null]) {
      expect(normalizeRule({ staleThresholdMs: bad }).staleThresholdMs).toBe(DEFAULT_THRESHOLD_MS);
    }
  });
});

describe('nextLocalHour', () => {
  let tz;
  beforeAll(() => { tz = process.env.TZ; process.env.TZ = 'America/New_York'; });
  afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

  it('is the next whole local hour, strictly in the future', () => {
    const at = new Date(2026, 9, 6, 21, 59, 59, 999).getTime();
    expect(nextLocalHour(at)).toBe(new Date(2026, 9, 6, 22).getTime());
    expect(nextLocalHour(new Date(2026, 9, 6, 22).getTime())).toBe(new Date(2026, 9, 6, 23).getTime());
  });

  it('crosses midnight', () => {
    expect(nextLocalHour(new Date(2026, 9, 6, 23, 30).getTime())).toBe(new Date(2026, 9, 7, 0).getTime());
  });

  it('handles the spring-forward and repeated fall-back hours', () => {
    // 01:30 EST on 2026-03-08 -> 03:00 EDT (02:00 does not exist).
    expect(nextLocalHour(Date.UTC(2026, 2, 8, 6, 30))).toBe(Date.UTC(2026, 2, 8, 7));
    // Second 01:30 (EST) on 2026-11-01 -> 02:00 EST, not an earlier instant.
    expect(nextLocalHour(Date.UTC(2026, 10, 1, 6, 30))).toBe(Date.UTC(2026, 10, 1, 7));
    // First 01:30 (EDT) -> the second 01:00 (EST).
    expect(nextLocalHour(Date.UTC(2026, 10, 1, 5, 30))).toBe(Date.UTC(2026, 10, 1, 6));
  });

  it('treats a run more than an hour ahead as a clock change', () => {
    expect(isPlausibleRun(nextLocalHour(NOW), NOW)).toBe(true);
    expect(isPlausibleRun(NOW - DAY_MS, NOW)).toBe(true); // overdue: fires once
    expect(isPlausibleRun(NOW + 3 * HOUR_MS, NOW)).toBe(false);
    expect(isPlausibleRun(undefined, NOW)).toBe(false);
  });

  it('treats a run off the whole local hour as a time-zone change', () => {
    expect(isPlausibleRun(nextLocalHour(NOW) - 30 * 60_000, NOW)).toBe(false);
    expect(isPlausibleRun(nextLocalHour(NOW) + 1, NOW)).toBe(false);
  });
});

describe('nextLocalHour in other zones', () => {
  let tz;
  beforeAll(() => { tz = process.env.TZ; });
  afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const next = (zone, at) => { process.env.TZ = zone; return nextLocalHour(at); };

  it('handles fixed 30- and 45-minute offsets', () => {
    // 17:50 IST -> 18:00 IST; 18:05 NPT -> 19:00 NPT.
    expect(next('Asia/Kolkata', Date.UTC(2026, 9, 6, 12, 20))).toBe(Date.UTC(2026, 9, 6, 12, 30));
    expect(next('Asia/Kathmandu', Date.UTC(2026, 9, 6, 12, 20))).toBe(Date.UTC(2026, 9, 6, 13, 15));
  });

  it('handles Lord Howe\'s 30-minute DST in both directions', () => {
    // 4 Oct 2026, 01:30 LHST (+10:30) -> 03:00 LHDT (+11): 02:00-02:30 does not exist.
    expect(next('Australia/Lord_Howe', Date.UTC(2026, 9, 3, 15))).toBe(Date.UTC(2026, 9, 3, 16));
    // 5 Apr 2026, 01:45 LHDT -> 02:00 LHST: 01:30-02:00 repeats; 15:00Z shows 01:30.
    expect(next('Australia/Lord_Howe', Date.UTC(2026, 3, 4, 14, 45))).toBe(Date.UTC(2026, 3, 4, 15, 30));
    expect(isWholeLocalHour(Date.UTC(2026, 3, 4, 15))).toBe(false);
  });

  it('every result is a whole local hour, strictly later, with none skipped', () => {
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'UTC']) {
      process.env.TZ = zone;
      for (let t = Date.UTC(2026, 2, 1); t < Date.UTC(2026, 11, 1); t += 7 * HOUR_MS + 13 * 60_000) {
        const at = nextLocalHour(t);
        expect(at).toBeGreaterThan(t);
        expect(isWholeLocalHour(at)).toBe(true);
        for (let q = Math.ceil((t + 1) / (15 * 60_000)) * 15 * 60_000; q < at; q += 15 * 60_000) {
          expect(isWholeLocalHour(q)).toBe(false);
        }
      }
    }
  });
});

describe('bounded session records', () => {
  it('expires previews, rejects clock-inconsistent ones and caps the count', () => {
    const p = exp => ({ w: 1, r: '', exp, c: [] });
    const kept = prunePreviews({
      old: p(NOW), future: p(NOW + PREVIEW_TTL_MS + 1), bad: { exp: NOW + 5 },
      ...Object.fromEntries(Array.from({ length: MAX_PREVIEWS + 2 }, (_, i) => [`k${i}`, p(NOW + 1000 + i)])),
    }, NOW);
    expect(Object.keys(kept)).toHaveLength(MAX_PREVIEWS);
    expect(kept).not.toHaveProperty('old');
    expect(kept).not.toHaveProperty('future');
    expect(kept).toHaveProperty(`k${MAX_PREVIEWS + 1}`);
    expect(prunePreviews('junk', NOW)).toEqual({});
  });

  it('expires leases and intents', () => {
    expect(pruneLeases({ a: { w: 1, exp: NOW + 1 }, b: { w: 1, exp: NOW }, c: { w: 1, exp: NOW + LEASE_TTL_MS + 1 } }, NOW))
      .toEqual({ a: { w: 1, exp: NOW + 1 } });
    expect(isLiveIntent({ w: 1, exp: NOW + 1 }, NOW)).toBe(true);
    expect(isLiveIntent({ w: 1, exp: NOW }, NOW)).toBe(false);
    expect(isLiveIntent({ w: 1, exp: NOW + 60_000 }, NOW)).toBe(false);
  });

  it('hashes URLs stably and distinctly', () => {
    expect(urlHash('https://a.example/')).toBe(urlHash('https://a.example/'));
    expect(urlHash('https://a.example/')).not.toBe(urlHash('https://a.example/#x'));
    expect(Number.isSafeInteger(urlHash(undefined))).toBe(true);
  });
});

describe('messages', () => {
  it('report actual counts', () => {
    expect(manualCloseMessage({ closed: 1, skipped: 0, failed: 0 })).toBe('Closed 1 tab.');
    expect(manualCloseMessage({ closed: 2, skipped: 1, failed: 3 }))
      .toBe('Closed 2 tabs. Kept 1 tab that changed or is no longer stale. Could not close 3 tabs.');
    expect(manualCloseMessage({ closed: 0, skipped: 0, failed: 0 })).toBe('No stale tabs were closed.');
  });

  it('automatic sweeps are silent when nothing changed', () => {
    expect(autoCloseMessage({ closed: 0, failed: 0 })).toBe('');
    expect(autoCloseMessage({ closed: 6, failed: 1 })).toBe('Automatically closed 6 tabs. Could not close 1 tab automatically.');
  });
});
