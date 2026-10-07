import { describe, it, expect } from 'vitest';
import {
  JOURNAL_VERSION, ANCHOR_DRIFT_MS, MAX_JOURNAL_ENTRIES,
  emptyJournal, readJournal, correctAnchor, buildCorrector, recordSupersededAnchor, compactJournal,
} from '../src/stale-age.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('readJournal', () => {
  it('treats absent data as an empty, non-rejected journal', () => {
    expect(readJournal(undefined)).toEqual({ journal: emptyJournal(), rejected: false });
    expect(readJournal(null).rejected).toBe(false);
  });

  it('accepts a well-formed store and parses a JSON string form', () => {
    const store = { v: JOURNAL_VERSION, floor: NOW - DAY, j: [[NOW - 2 * DAY, NOW - DAY]] };
    expect(readJournal(store)).toEqual({ journal: store, rejected: false });
    expect(readJournal(JSON.stringify(store))).toEqual({ journal: store, rejected: false });
  });

  it.each([
    ['wrong version', { v: 2, floor: 0, j: [] }],
    ['floor not a time', { v: 1, floor: -1, j: [] }],
    ['j not an array', { v: 1, floor: 0, j: {} }],
    ['entry wrong shape', { v: 1, floor: 0, j: [[NOW]] }],
    ['floor older than anchor', { v: 1, floor: 0, j: [[NOW, NOW - DAY]] }],
    ['non-finite entry', { v: 1, floor: 0, j: [[NOW, Infinity]] }],
    ['too many entries', { v: 1, floor: 0, j: Array.from({ length: MAX_JOURNAL_ENTRIES + 1 }, (_, i) => [i + 1, i + 2]) }],
    ['garbage string', 'not json'],
  ])('rejects %s and returns an empty journal', (_, raw) => {
    const { journal, rejected } = readJournal(raw);
    expect(rejected).toBe(true);
    expect(journal).toEqual(emptyJournal());
  });
});

describe('correctAnchor', () => {
  it('returns the raw native value when nothing matches', () => {
    expect(correctAnchor(emptyJournal(), NOW - DAY)).toBe(NOW - DAY);
  });

  it('passes through invalid native values unchanged', () => {
    expect(correctAnchor(emptyJournal(), 0)).toBe(0);
    expect(correctAnchor(emptyJournal(), NaN)).toBeNaN();
  });

  it('raises a matching anchor to its younger floor, never older', () => {
    const journal = { v: 1, floor: 0, j: [[NOW - 10 * DAY, NOW - 2 * DAY]] };
    expect(correctAnchor(journal, NOW - 10 * DAY)).toBe(NOW - 2 * DAY);
    // A value that does not match any anchor is untouched.
    expect(correctAnchor(journal, NOW - 5 * DAY)).toBe(NOW - 5 * DAY);
  });

  it('matches within drift but only ever makes younger', () => {
    const journal = { v: 1, floor: 0, j: [[NOW - 10 * DAY, NOW - DAY]] };
    expect(correctAnchor(journal, NOW - 10 * DAY + ANCHOR_DRIFT_MS)).toBe(NOW - DAY);
    expect(correctAnchor(journal, NOW - 10 * DAY - ANCHOR_DRIFT_MS)).toBe(NOW - DAY);
    // Outside drift: no correction.
    expect(correctAnchor(journal, NOW - 10 * DAY - ANCHOR_DRIFT_MS - 1)).toBe(NOW - 10 * DAY - ANCHOR_DRIFT_MS - 1);
  });

  it('a global floor raises older values; a younger value is untouched', () => {
    const journal = { v: 1, floor: NOW - DAY, j: [] };
    expect(correctAnchor(journal, NOW - 10 * DAY)).toBe(NOW - DAY); // global floor
    expect(correctAnchor(journal, NOW - DAY / 2)).toBe(NOW - DAY / 2); // younger than floor: untouched
  });

  it('surfaces a floor from before a backward clock step instead of discarding it', () => {
    // A floor recorded before the clock stepped back is now in the future
    // relative to a now that moved backward. It must be surfaced (not clamped
    // away): the caller treats a future result as inconsistent and KEEPS the
    // tab, rather than reverting to the raw old native value and closing it.
    const future = { v: 1, floor: NOW + DAY, j: [[NOW - 10 * DAY, NOW + DAY]] };
    expect(correctAnchor(future, NOW - 10 * DAY)).toBe(NOW + DAY); // global floor surfaced
    const entryOnly = { v: 1, floor: 0, j: [[NOW - 10 * DAY, NOW + DAY]] };
    expect(correctAnchor(entryOnly, NOW - 10 * DAY)).toBe(NOW + DAY); // matching entry surfaced
  });

  it('uses the youngest matching floor among several entries', () => {
    const journal = { v: 1, floor: 0, j: [[NOW - 10 * DAY, NOW - 5 * DAY], [NOW - 10 * DAY + 2, NOW - DAY]] };
    expect(correctAnchor(journal, NOW - 10 * DAY)).toBe(NOW - DAY);
  });
});

describe('recordSupersededAnchor', () => {
  it('adds an entry and corrects a later rollback to the floor', () => {
    const journal = emptyJournal();
    expect(recordSupersededAnchor(journal, NOW - 10 * DAY, NOW - DAY)).toBe(true);
    expect(journal.j).toEqual([[NOW - 10 * DAY, NOW - DAY]]);
    expect(correctAnchor(journal, NOW - 10 * DAY, NOW)).toBe(NOW - DAY);
  });

  it('refuses a floor that is not younger than the anchor', () => {
    const journal = emptyJournal();
    expect(recordSupersededAnchor(journal, NOW, NOW)).toBe(false);
    expect(recordSupersededAnchor(journal, NOW, NOW - DAY)).toBe(false);
    expect(recordSupersededAnchor(journal, 0, NOW)).toBe(false);
    expect(journal.j).toEqual([]);
  });

  it('merges a repeat anchor, keeping the youngest floor', () => {
    const journal = emptyJournal();
    recordSupersededAnchor(journal, NOW - 10 * DAY, NOW - 5 * DAY);
    expect(recordSupersededAnchor(journal, NOW - 10 * DAY, NOW - DAY)).toBe(true);
    expect(recordSupersededAnchor(journal, NOW - 10 * DAY, NOW - 2 * DAY)).toBe(false); // not younger
    expect(journal.j).toEqual([[NOW - 10 * DAY, NOW - DAY]]);
  });

  it('propagates a chain of reactivations to the latest activation', () => {
    const journal = emptyJournal();
    recordSupersededAnchor(journal, NOW - 10 * DAY, NOW - 6 * DAY); // t1 -> t2
    recordSupersededAnchor(journal, NOW - 6 * DAY, NOW - DAY);      // t2 -> t3
    // A rollback to the earliest anchor still clamps to the latest activation.
    expect(correctAnchor(journal, NOW - 10 * DAY, NOW)).toBe(NOW - DAY);
  });

  it('stays within bounds by folding the oldest floors into the global floor', () => {
    const journal = emptyJournal();
    const max = 50;
    for (let i = 1; i <= max + 20; i++) recordSupersededAnchor(journal, i * 100, i * 100 + 1_000_000, { max });
    expect(journal.j.length).toBeLessThanOrEqual(max);
    expect(journal.floor).toBeGreaterThan(0);
    // The dropped evidence is absorbed: a value below the floor is still raised.
    expect(correctAnchor(journal, 100)).toBe(journal.floor);
  });

  it('keeps distinct near anchors separate, so a merged edge band is not left uncovered', () => {
    // Two activations whose native anchors are one drift apart. Collapsing them
    // onto one anchor would shrink coverage and leave a drift-wide band of
    // rolled-back values unclamped. Keeping both preserves the union window.
    const a1 = NOW - 10 * DAY;
    const a2 = a1 + ANCHOR_DRIFT_MS;
    const journal = emptyJournal();
    recordSupersededAnchor(journal, a1, NOW - 5 * DAY);
    recordSupersededAnchor(journal, a2, NOW - 3 * DAY);
    expect(journal.j).toHaveLength(2); // not merged onto a1
    // A value just past a1's window but still inside a2's window is clamped by
    // a2. With anchor-merging it would have fallen outside the lone a1 window.
    const edge = a2 + ANCHOR_DRIFT_MS; // = a1 + 2*drift: outside a1, inside a2
    expect(correctAnchor(journal, edge)).toBe(NOW - 3 * DAY);
    // a1 is within drift of a2, so both entries apply and the youngest wins.
    expect(correctAnchor(journal, a1)).toBe(NOW - 3 * DAY);
  });
});

describe('compactJournal', () => {
  it('is a no-op under the cap', () => {
    const journal = { v: 1, floor: 0, j: [[1, 2], [3, 4]] };
    expect(compactJournal(journal, 10)).toBe(false);
    expect(journal.j).toEqual([[1, 2], [3, 4]]);
  });

  it('raises the floor to the largest dropped floor and prunes covered entries', () => {
    const journal = { v: 1, floor: 0, j: [[1, 100], [2, 200], [3, 300], [4, 400]] };
    compactJournal(journal, 2);
    expect(journal.floor).toBe(200);
    expect(journal.j).toEqual([[3, 300], [4, 400]]);
  });
});

describe('buildCorrector', () => {
  it('matches correctAnchor for in-window, global-floor and no-match values', () => {
    const journal = { v: 1, floor: NOW - 2 * DAY, j: [[NOW - 10 * DAY, NOW - DAY], [NOW - 20 * DAY, NOW - 5 * DAY]] };
    const correct = buildCorrector(journal);
    expect(correct(NOW - 10 * DAY)).toBe(NOW - DAY);               // matching anchor -> younger floor
    expect(correct(NOW - 10 * DAY + ANCHOR_DRIFT_MS)).toBe(NOW - DAY); // within drift
    expect(correct(NOW - 30 * DAY)).toBe(NOW - 2 * DAY);           // only the global floor applies
    expect(correct(NOW - DAY / 2)).toBe(NOW - DAY / 2);            // younger than everything: untouched
    expect(correct(NaN)).toBeNaN();
  });

  it('only ever makes a tab younger, never older, and surfaces a future floor', () => {
    const journal = { v: 1, floor: 0, j: [[NOW - 10 * DAY, NOW + DAY]] };
    const correct = buildCorrector(journal);
    expect(correct(NOW - 10 * DAY)).toBe(NOW + DAY); // future floor surfaced (caller keeps the tab)
    expect(correct(NOW - 10 * DAY)).toBeGreaterThanOrEqual(NOW - 10 * DAY);
  });

  it('corrects 10,000 values against a 10,000-entry journal without O(n^2) blow-up', () => {
    // Spread anchors far enough apart to land in distinct drift buckets.
    const journal = emptyJournal();
    for (let i = 1; i <= 10_000; i++) journal.j.push([i * 1000, i * 1000 + 500]);
    const start = performance.now();
    const correct = buildCorrector(journal);
    let kept = 0;
    for (let i = 1; i <= 10_000; i++) if (correct(i * 1000) === i * 1000 + 500) kept++;
    const elapsed = performance.now() - start;
    expect(kept).toBe(10_000);              // every value matched its own anchor's floor
    expect(correct(5000)).toBe(5500);       // spot check one bucket
    // A per-value full scan would be ~1e8 ops; the bucket index keeps it linear.
    expect(elapsed).toBeLessThan(250);
  });
});
