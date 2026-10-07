// stale-age.js — Chromium rollback-safety journal for stale-tab age (R4, R7).
// Pure: no browser API calls. Persisted in storage.local, normal context only.
//
// Chromium's tab.lastAccessed is the last-ACTIVATION time (when the tab was
// last selected) and it survives a clean browser restart, so it is the
// cross-restart source of a tab's age. A browser crash can roll it BACK to an
// older value, which would overstate age and risk closing a tab that was used
// more recently. This journal records, for each native anchor we observed get
// SUPERSEDED by a later activation, a younger "floor": a time the tab was known
// active after that anchor. correctAnchor() raises a native value to the floor
// of any journal entry it matches, so a match can only make a tab YOUNGER (or
// leave its age unknown) — it can never make a tab look older than its raw
// native value. Over-matching (restore drift, timestamp collisions) is
// therefore safe: it only keeps tabs. Only timestamps and a version live here —
// never URLs, hashes, titles, tab/window IDs or private-window activity.

export const JOURNAL_VERSION = 1;
// Observed native restore shifts were up to ~8 ms, and two live timestamps were
// ~3.7 ms apart, so a tolerant match can absorb drift but can also match a
// neighbour. That is acceptable here because a match only makes a tab younger.
export const ANCHOR_DRIFT_MS = 10;
export const MAX_JOURNAL_ENTRIES = 10_000;

const isTime = t => Number.isFinite(t) && t > 0;
const near = (a, b, drift) => Math.abs(a - b) <= drift;

export function emptyJournal() {
  return { v: JOURNAL_VERSION, floor: 0, j: [] };
}

/**
 * Validates a stored journal. A single malformed part discards the whole store,
 * so a garbled entry can never be read as a confident correction. Returns
 * { journal, rejected }; a rejected read tells the caller to establish a
 * younger baseline, because without the journal a rolled-back native value
 * could not be corrected.
 */
export function readJournal(raw) {
  if (raw == null) return { journal: emptyJournal(), rejected: false };
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return { journal: emptyJournal(), rejected: true }; }
  }
  const ok = data && typeof data === 'object' && data.v === JOURNAL_VERSION &&
    (data.floor === 0 || isTime(data.floor)) && Array.isArray(data.j) && data.j.length <= MAX_JOURNAL_ENTRIES &&
    data.j.every(e => Array.isArray(e) && e.length === 2 && isTime(e[0]) && isTime(e[1]) && e[1] > e[0]);
  if (!ok) return { journal: emptyJournal(), rejected: true };
  return { journal: { v: JOURNAL_VERSION, floor: data.floor, j: data.j.map(([a, f]) => [a, f]) }, rejected: false };
}

/**
 * Conservative last-view time for one Chromium native anchor. The global floor
 * and any matching journal entry can only raise the result (make the tab
 * younger), never lower it (never grant older eligibility).
 *
 * The result is deliberately not capped at `now`. A floor recorded before the
 * system clock stepped backward (NTP correction, VM resume, dual-boot RTC, DST)
 * can exceed the current clock; clamping it to `now` would silently discard the
 * younger evidence and let the raw old native value read as proof of age. A
 * corrected value above `now` is instead surfaced to the caller, which treats
 * any future signal as inconsistent and keeps the tab (lastViewedAt -> null ->
 * unknown). Over-matching (restore drift, timestamp collisions) stays safe: it
 * only keeps tabs.
 */
export function correctAnchor(journal, native, driftMs = ANCHOR_DRIFT_MS) {
  if (!isTime(native)) return native;
  let corrected = native;
  if (journal && isTime(journal.floor) && journal.floor > corrected) corrected = journal.floor;
  if (journal && Array.isArray(journal.j)) {
    for (const [anchor, floorTime] of journal.j) {
      if (near(anchor, native, driftMs) && floorTime > corrected) corrected = floorTime;
    }
  }
  return corrected;
}

/**
 * Builds a reusable corrector over `journal` that returns the same younger-only
 * result as correctAnchor for each native value, but in O(1) per call instead
 * of scanning the whole journal. One pass indexes the youngest floor near each
 * anchor into drift-sized buckets; a lookup reads at most three buckets, so a
 * plan over N tabs with an M-entry journal costs O(N + M) rather than O(N x M).
 *
 * Neighbouring buckets are always read, so any anchor within driftMs of a native
 * value is matched; a value up to ~2x driftMs away may also match. That slight
 * over-match is safe because a match can only make a tab younger. A corrected
 * value may exceed `now`, which the caller treats as inconsistent (keep).
 */
export function buildCorrector(journal, driftMs = ANCHOR_DRIFT_MS) {
  const floor = journal && isTime(journal.floor) ? journal.floor : 0;
  const buckets = new Map();
  if (journal && Array.isArray(journal.j)) {
    for (const [anchor, floorTime] of journal.j) {
      if (!isTime(anchor) || !isTime(floorTime)) continue;
      const bucket = Math.floor(anchor / driftMs);
      const current = buckets.get(bucket);
      if (current === undefined || floorTime > current) buckets.set(bucket, floorTime);
    }
  }
  return native => {
    if (!isTime(native)) return native;
    let corrected = native;
    if (floor > corrected) corrected = floor;
    const bucket = Math.floor(native / driftMs);
    for (let i = bucket - 1; i <= bucket + 1; i++) {
      const floorTime = buckets.get(i);
      if (floorTime !== undefined && floorTime > corrected) corrected = floorTime;
    }
    return corrected;
  };
}

/**
 * Records that `oldAnchor` was superseded by a later activation at `floorTime`
 * (floorTime must be younger than oldAnchor). Propagates the new floor to
 * entries whose floor points at `oldAnchor` (within drift), so a chain of
 * reactivations clamps to the latest known activation. Distinct anchors are
 * kept separate — only an exactly-equal anchor merges — so two anchors within
 * drift each keep their own correction window and no band of rolled-back values
 * between them is left uncovered. Stays bounded: on overflow the oldest-floor
 * entries fold into the global floor rather than being dropped, so no safety
 * evidence is lost. Returns true if the store changed.
 */
export function recordSupersededAnchor(journal, oldAnchor, floorTime,
  { driftMs = ANCHOR_DRIFT_MS, max = MAX_JOURNAL_ENTRIES } = {}) {
  if (!isTime(oldAnchor) || !isTime(floorTime) || floorTime <= oldAnchor) return false;
  if (!Array.isArray(journal.j)) journal.j = [];
  let changed = false;
  for (const entry of journal.j) {
    if (near(entry[1], oldAnchor, driftMs) && floorTime > entry[1]) { entry[1] = floorTime; changed = true; }
  }
  const existing = journal.j.find(entry => entry[0] === oldAnchor);
  if (existing) {
    if (floorTime > existing[1]) { existing[1] = floorTime; changed = true; }
  } else {
    journal.j.push([oldAnchor, floorTime]);
    changed = true;
  }
  if (journal.j.length > max) compactJournal(journal, max);
  return changed;
}

/**
 * Keeps the journal within `max` entries. The entries with the oldest floors
 * are the least useful (their anchors are long past), so their floors fold into
 * the global floor — a future value near them is still corrected up to at least
 * that floor — and entries the floor already covers are then dropped. Returns
 * true if the store changed.
 */
export function compactJournal(journal, max = MAX_JOURNAL_ENTRIES) {
  if (!Array.isArray(journal.j)) { journal.j = []; return false; }
  if (!isTime(journal.floor) && journal.floor !== 0) journal.floor = 0;
  if (journal.j.length <= max) return false;
  journal.j.sort((p, q) => p[1] - q[1]);
  while (journal.j.length > max) {
    const [, floorTime] = journal.j.shift();
    if (floorTime > journal.floor) journal.floor = floorTime;
  }
  journal.j = journal.j.filter(([, floorTime]) => floorTime > journal.floor);
  return true;
}
