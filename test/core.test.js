import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  isProtected,
  findDuplicates,
  planMerge,
  planSort,
  findStaleTabs,
} from '../src/core.js';

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------
describe('normalizeUrl', () => {
  const defaultSettings = { ignoreFragments: false, ignoreQueryParams: false };

  it('passes through a basic URL unchanged', () => {
    const result = normalizeUrl('https://example.com/page', defaultSettings);
    expect(result).toBe('https://example.com/page');
  });

  it('strips trailing slash', () => {
    const result = normalizeUrl('https://example.com/page/', defaultSettings);
    expect(result).toBe('https://example.com/page');
  });

  it('strips fragment when ignoreFragments is true', () => {
    const result = normalizeUrl('https://example.com/page#section', {
      ...defaultSettings,
      ignoreFragments: true,
    });
    expect(result).toBe('https://example.com/page');
  });

  it('keeps fragment when ignoreFragments is false', () => {
    const result = normalizeUrl('https://example.com/page#section', {
      ...defaultSettings,
      ignoreFragments: false,
    });
    expect(result).toBe('https://example.com/page#section');
  });

  it('strips query params when ignoreQueryParams is true', () => {
    const result = normalizeUrl('https://example.com/page?foo=bar', {
      ...defaultSettings,
      ignoreQueryParams: true,
    });
    expect(result).toBe('https://example.com/page');
  });

  it('keeps query params when ignoreQueryParams is false', () => {
    const result = normalizeUrl('https://example.com/page?foo=bar', {
      ...defaultSettings,
      ignoreQueryParams: false,
    });
    expect(result).toBe('https://example.com/page?foo=bar');
  });

  it('handles invalid URLs gracefully', () => {
    const result = normalizeUrl('not-a-url', defaultSettings);
    expect(result).toBe('not-a-url');
  });

  it('normalizes root path trailing slash to /', () => {
    const result = normalizeUrl('https://example.com/', defaultSettings);
    expect(result).toBe('https://example.com/');
  });
});

// ---------------------------------------------------------------------------
// isProtected
// ---------------------------------------------------------------------------
describe('isProtected', () => {
  const defaultSettings = { skipPinned: true, skipAudible: true };

  it('active tab is protected', () => {
    const tab = { active: true, pinned: false, audible: false };
    expect(isProtected(tab, defaultSettings)).toBe(true);
  });

  it('pinned tab is protected when skipPinned is true', () => {
    const tab = { active: false, pinned: true, audible: false };
    expect(isProtected(tab, { ...defaultSettings, skipPinned: true })).toBe(true);
  });

  it('pinned tab is not protected when skipPinned is false', () => {
    const tab = { active: false, pinned: true, audible: false };
    expect(isProtected(tab, { ...defaultSettings, skipPinned: false })).toBe(false);
  });

  it('audible tab is protected when skipAudible is true', () => {
    const tab = { active: false, pinned: false, audible: true };
    expect(isProtected(tab, { ...defaultSettings, skipAudible: true })).toBe(true);
  });

  it('audible tab is not protected when skipAudible is false', () => {
    const tab = { active: false, pinned: false, audible: true };
    expect(isProtected(tab, { ...defaultSettings, skipAudible: false })).toBe(false);
  });

  it('normal tab is not protected', () => {
    const tab = { active: false, pinned: false, audible: false };
    expect(isProtected(tab, defaultSettings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findDuplicates
// ---------------------------------------------------------------------------
describe('findDuplicates', () => {
  const defaultSettings = {
    ignoreFragments: false,
    ignoreQueryParams: false,
    skipPinned: true,
    skipAudible: true,
  };

  it('closes newer duplicate', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/page', active: false, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, defaultSettings);
    expect(result.toClose).toEqual([2]);
    expect(result.message).toBe('Closed 1 duplicate tab');
  });

  it('keeps active tab and closes other duplicate', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/page', active: true, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, defaultSettings);
    // Active tab (id 2) is protected; close all unprotected (id 1)
    expect(result.toClose).toEqual([1]);
  });

  it('keeps pinned tab and closes unpinned duplicate', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page', active: false, pinned: true, audible: false },
      { id: 2, url: 'https://example.com/page', active: false, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, defaultSettings);
    // Pinned tab (id 1) is protected; close all unprotected (id 2)
    expect(result.toClose).toEqual([2]);
  });

  it('returns empty when no duplicates found', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page1', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/page2', active: false, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
    expect(result.message).toBe('No duplicate tabs found');
  });

  it('handles multiple groups of duplicates', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/a', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/a', active: false, pinned: false, audible: false },
      { id: 3, url: 'https://example.com/b', active: false, pinned: false, audible: false },
      { id: 4, url: 'https://example.com/b', active: false, pinned: false, audible: false },
      { id: 5, url: 'https://example.com/b', active: false, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, defaultSettings);
    expect(result.toClose).toEqual([2, 4, 5]);
    expect(result.message).toBe('Closed 3 duplicate tabs');
  });

  it('respects URL normalization settings', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page/', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/page', active: false, pinned: false, audible: false },
    ];
    // Trailing slash normalization always happens
    const result = findDuplicates(tabs, defaultSettings);
    expect(result.toClose).toEqual([2]);
  });

  it('with ignoreFragments, treats URLs with different fragments as duplicates', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/page#section1', active: false, pinned: false, audible: false },
      { id: 2, url: 'https://example.com/page#section2', active: false, pinned: false, audible: false },
    ];
    const result = findDuplicates(tabs, { ...defaultSettings, ignoreFragments: true });
    expect(result.toClose).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// planMerge
// ---------------------------------------------------------------------------
describe('planMerge', () => {
  it('merges tabs from multiple windows', () => {
    const windows = [
      { id: 1, tabs: [{ id: 10 }, { id: 11 }] },
      { id: 2, tabs: [{ id: 20 }, { id: 21 }] },
      { id: 3, tabs: [{ id: 30 }] },
    ];
    const result = planMerge(windows, 1);
    expect(result.moves).toHaveLength(2);
    expect(result.moves[0]).toEqual({ tabIds: [20, 21], windowId: 1, index: 2 });
    expect(result.moves[1]).toEqual({ tabIds: [30], windowId: 1, index: 4 });
    expect(result.emptyWindowIds).toEqual([2, 3]);
    expect(result.message).toContain('Merged 3 windows');
    expect(result.message).toContain('5 tabs');
  });

  it('single window returns no-op', () => {
    const windows = [{ id: 1, tabs: [{ id: 10 }] }];
    const result = planMerge(windows, 1);
    expect(result.moves).toEqual([]);
    expect(result.emptyWindowIds).toEqual([]);
    expect(result.message).toBe('Only one window open');
  });

  it('preserves tab order from source windows', () => {
    const windows = [
      { id: 1, tabs: [{ id: 10 }] },
      { id: 2, tabs: [{ id: 20 }, { id: 21 }, { id: 22 }] },
    ];
    const result = planMerge(windows, 1);
    expect(result.moves[0].tabIds).toEqual([20, 21, 22]);
  });

  it('returns correct emptyWindowIds', () => {
    const windows = [
      { id: 1, tabs: [{ id: 10 }] },
      { id: 2, tabs: [{ id: 20 }] },
      { id: 3, tabs: [{ id: 30 }] },
    ];
    const result = planMerge(windows, 1);
    expect(result.emptyWindowIds).toEqual([2, 3]);
  });

  it('handles target window not found', () => {
    const windows = [{ id: 1, tabs: [{ id: 10 }] }];
    const result = planMerge(windows, 999);
    expect(result.moves).toEqual([]);
    expect(result.message).toBe('Target window not found');
  });
});

// ---------------------------------------------------------------------------
// planSort
// ---------------------------------------------------------------------------
describe('planSort', () => {
  it('sorts by URL ascending', () => {
    const tabs = [
      { id: 1, url: 'https://c.com', title: 'C', pinned: false },
      { id: 2, url: 'https://a.com', title: 'A', pinned: false },
      { id: 3, url: 'https://b.com', title: 'B', pinned: false },
    ];
    const result = planSort(tabs, 'url', 'asc');
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
  });

  it('sorts by URL descending', () => {
    const tabs = [
      { id: 1, url: 'https://a.com', title: 'A', pinned: false },
      { id: 2, url: 'https://c.com', title: 'C', pinned: false },
      { id: 3, url: 'https://b.com', title: 'B', pinned: false },
    ];
    const result = planSort(tabs, 'url', 'desc');
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
  });

  it('sorts by title', () => {
    const tabs = [
      { id: 1, url: 'https://x.com', title: 'Zebra', pinned: false },
      { id: 2, url: 'https://y.com', title: 'Apple', pinned: false },
      { id: 3, url: 'https://z.com', title: 'Mango', pinned: false },
    ];
    const result = planSort(tabs, 'title', 'asc');
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
  });

  it('sorts by lastAccessed (most recent first for asc)', () => {
    const tabs = [
      { id: 1, lastAccessed: 100, pinned: false },
      { id: 2, lastAccessed: 300, pinned: false },
      { id: 3, lastAccessed: 200, pinned: false },
    ];
    const result = planSort(tabs, 'lastAccessed', 'asc');
    // Most recent first: 300, 200, 100
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
  });

  it('sorts by visitCount (most visited first for asc)', () => {
    const tabs = [
      { id: 1, visitCount: 5, pinned: false },
      { id: 2, visitCount: 50, pinned: false },
      { id: 3, visitCount: 20, pinned: false },
    ];
    const result = planSort(tabs, 'visitCount', 'asc');
    // Most visited first: 50, 20, 5
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
  });

  it('pinned tabs are excluded from sort moves', () => {
    const tabs = [
      { id: 1, url: 'https://c.com', title: 'C', pinned: true },
      { id: 2, url: 'https://a.com', title: 'A', pinned: false },
      { id: 3, url: 'https://b.com', title: 'B', pinned: false },
    ];
    const result = planSort(tabs, 'url', 'asc');
    // Only unpinned tabs are sorted; pinned tab id 1 not in moves
    const movedIds = result.moves.map((m) => m.tabId);
    expect(movedIds).not.toContain(1);
    expect(movedIds).toEqual([2, 3]);
    // Indexes start after pinned tabs
    expect(result.moves[0].index).toBe(1);
    expect(result.moves[1].index).toBe(2);
  });

  it('returns correct message', () => {
    const tabs = [
      { id: 1, url: 'https://a.com', pinned: false },
      { id: 2, url: 'https://b.com', pinned: false },
    ];
    const result = planSort(tabs, 'url', 'asc');
    expect(result.message).toBe('Sorted 2 tabs by URL');
  });

  it('returns correct message for single tab', () => {
    const tabs = [{ id: 1, url: 'https://a.com', pinned: false }];
    const result = planSort(tabs, 'title', 'asc');
    expect(result.message).toBe('Sorted 1 tab by title');
  });
});

// ---------------------------------------------------------------------------
// findStaleTabs
// ---------------------------------------------------------------------------
describe('findStaleTabs', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * ONE_DAY;

  const defaultSettings = {
    staleThresholdMs: SEVEN_DAYS,
    skipPinned: true,
    skipAudible: true,
  };

  it('closes stale tabs', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS - 1000, active: false, pinned: false, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([1]);
    expect(result.message).toContain('Closed 1 tab');
    expect(result.message).toContain('7 days');
  });

  it('skips active tab', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS - 1000, active: true, pinned: false, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('skips pinned tab when skipPinned is true', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS - 1000, active: false, pinned: true, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('skips audible tab when skipAudible is true', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS - 1000, active: false, pinned: false, audible: true, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('will not close the last tab in a window', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('returns empty when no stale tabs', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 2000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
    expect(result.message).toBe('No stale tabs found');
  });

  it('tab exactly at threshold boundary is stale (>= threshold)', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS, active: false, pinned: false, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    // now - lastAccessed = SEVEN_DAYS, which is NOT < SEVEN_DAYS, so it doesn't skip
    // The tab is considered stale at exactly the threshold
    expect(result.toClose).toEqual([1]);
  });

  it('tab just under threshold is not stale', () => {
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'https://a.com', lastAccessed: now - SEVEN_DAYS + 1, active: false, pinned: false, audible: false, windowId: 1 },
      { id: 2, url: 'https://b.com', lastAccessed: now - 1000, active: false, pinned: false, audible: false, windowId: 1 },
    ];
    const result = findStaleTabs(tabs, defaultSettings);
    // now - lastAccessed = SEVEN_DAYS - 1, which IS < SEVEN_DAYS, so it skips
    expect(result.toClose).toEqual([]);
  });
});
