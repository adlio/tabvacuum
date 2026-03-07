import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  isProtected,
  findDuplicates,
  planMerge,
  planSort,
  findStaleTabs,
  findBlankTabs,
  isBlankTab,
  parseCustomMatchers,
  computeFrecency,
  BLANK_NEW_TAB_URLS,
  BLANK_WELCOME_URLS,
  SEARCH_ENGINE_HOMEPAGE_RE,
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

  it('sorts by frecency (highest first for asc)', () => {
    const tabs = [
      { id: 1, frecency: 5, pinned: false },
      { id: 2, frecency: 70, pinned: false },
      { id: 3, frecency: 28, pinned: false },
    ];
    const result = planSort(tabs, 'frecency', 'asc');
    expect(result.moves.map((m) => m.tabId)).toEqual([2, 3, 1]);
    expect(result.message).toBe('Sorted 3 tabs by frecency');
  });
});

// ---------------------------------------------------------------------------
// computeFrecency
// ---------------------------------------------------------------------------
describe('computeFrecency', () => {
  const ONE_HOUR = 1000 * 60 * 60;

  it('returns 0 when visitCount is 0', () => {
    const now = Date.now();
    expect(computeFrecency(0, now, now)).toBe(0);
  });

  it('returns 0 when lastVisitTime is 0', () => {
    expect(computeFrecency(10, 0, Date.now())).toBe(0);
  });

  it('uses 1.0 multiplier for visits within 24 hours', () => {
    const now = Date.now();
    const lastVisit = now - 12 * ONE_HOUR;
    expect(computeFrecency(10, lastVisit, now)).toBe(10);
  });

  it('uses 0.7 multiplier for visits within past week', () => {
    const now = Date.now();
    const lastVisit = now - 3 * 24 * ONE_HOUR;
    expect(computeFrecency(10, lastVisit, now)).toBeCloseTo(7);
  });

  it('uses 0.4 multiplier for visits within past month', () => {
    const now = Date.now();
    const lastVisit = now - 14 * 24 * ONE_HOUR;
    expect(computeFrecency(10, lastVisit, now)).toBeCloseTo(4);
  });

  it('uses 0.1 multiplier for visits older than a month', () => {
    const now = Date.now();
    const lastVisit = now - 60 * 24 * ONE_HOUR;
    expect(computeFrecency(10, lastVisit, now)).toBeCloseTo(1);
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

// ---------------------------------------------------------------------------
// isBlankTab
// ---------------------------------------------------------------------------
describe('isBlankTab', () => {
  const allEnabled = {
    blankNewTab: true,
    blankWelcome: true,
    blankSearchEngines: true,
    blankCustomUrls: [],
  };

  // New tab URLs
  it.each(BLANK_NEW_TAB_URLS)('matches new tab URL: %s', (url) => {
    expect(isBlankTab(url, allEnabled)).toBe(true);
  });

  it('does not match new tab URLs when blankNewTab is false', () => {
    const settings = { ...allEnabled, blankNewTab: false };
    expect(isBlankTab('about:blank', settings)).toBe(false);
    expect(isBlankTab('about:newtab', settings)).toBe(false);
  });

  // Welcome URLs
  it.each(BLANK_WELCOME_URLS)('matches welcome URL: %s', (url) => {
    expect(isBlankTab(url, allEnabled)).toBe(true);
  });

  it('does not match welcome URLs when blankWelcome is false', () => {
    const settings = { ...allEnabled, blankWelcome: false };
    expect(isBlankTab('about:welcome', settings)).toBe(false);
    expect(isBlankTab('about:privatebrowsing', settings)).toBe(false);
  });

  // Search engine homepages — positive matches
  it.each([
    'https://www.google.com/',
    'https://www.google.com',
    'https://www.google.co.uk/',
    'https://www.google.com.br/',
    'https://www.google.de/',
    'https://www.google.com/?gws_rd=ssl',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://search.yahoo.com/',
    'https://www.baidu.com/',
    'https://yandex.ru/',
    'https://yandex.com/',
    'https://www.naver.com/',
    'https://www.startpage.com/',
    'https://www.ecosia.org/',
    'https://search.brave.com/',
    'https://www.qwant.com/',
  ])('matches search engine homepage: %s', (url) => {
    expect(isBlankTab(url, allEnabled)).toBe(true);
  });

  // Search engine — negative matches (search results)
  it.each([
    'https://www.google.com/search?q=test',
    'https://duckduckgo.com/?q=test',
    'https://www.bing.com/?q=test',
    'https://search.yahoo.com/?p=test',
    'https://www.baidu.com/?wd=test',
    'https://yandex.ru/?text=test',
    'https://www.qwant.com/?q=test',
  ])('does not match search results page: %s', (url) => {
    expect(isBlankTab(url, allEnabled)).toBe(false);
  });

  // Search engine — negative matches (subpages)
  it.each([
    'https://www.google.com/maps',
    'https://www.google.com/mail',
    'https://duckduckgo.com/about',
    'https://www.bing.com/images',
  ])('does not match search engine subpage: %s', (url) => {
    expect(isBlankTab(url, allEnabled)).toBe(false);
  });

  it('does not match search engines when blankSearchEngines is false', () => {
    const settings = { ...allEnabled, blankSearchEngines: false };
    expect(isBlankTab('https://www.google.com/', settings)).toBe(false);
    expect(isBlankTab('https://duckduckgo.com/', settings)).toBe(false);
  });

  // Custom URLs
  it('matches custom exact URL', () => {
    const matchers = parseCustomMatchers(['https://example.com/start']);
    expect(isBlankTab('https://example.com/start', allEnabled, matchers)).toBe(true);
  });

  it('does not match non-matching custom URL', () => {
    const matchers = parseCustomMatchers(['https://example.com/start']);
    expect(isBlankTab('https://example.com/other', allEnabled, matchers)).toBe(false);
  });

  it('matches custom regex pattern', () => {
    const matchers = parseCustomMatchers(['/^https:\\/\\/intranet\\.corp\\.com\\/?$/']);
    expect(isBlankTab('https://intranet.corp.com/', allEnabled, matchers)).toBe(true);
    expect(isBlankTab('https://intranet.corp.com', allEnabled, matchers)).toBe(true);
  });

  it('skips invalid regex gracefully', () => {
    const matchers = parseCustomMatchers(['/[invalid/']);
    expect(isBlankTab('https://example.com', allEnabled, matchers)).toBe(false);
  });

  it('skips empty lines in custom URLs', () => {
    const matchers = parseCustomMatchers(['', '  ', 'https://example.com']);
    expect(isBlankTab('https://example.com', allEnabled, matchers)).toBe(true);
  });

  it('returns false when all categories disabled', () => {
    const settings = {
      blankNewTab: false,
      blankWelcome: false,
      blankSearchEngines: false,
    };
    expect(isBlankTab('about:blank', settings)).toBe(false);
    expect(isBlankTab('https://www.google.com/', settings)).toBe(false);
  });

  it('does not match a regular website', () => {
    expect(isBlankTab('https://example.com/page', allEnabled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findBlankTabs
// ---------------------------------------------------------------------------
describe('findBlankTabs', () => {
  const defaultSettings = {
    blankNewTab: true,
    blankWelcome: true,
    blankSearchEngines: true,
    blankCustomUrls: [],
    skipPinned: true,
    skipAudible: true,
  };

  const tab = (overrides) => ({
    active: false, pinned: false, audible: false, windowId: 1,
    ...overrides,
  });

  it('closes blank tabs and keeps non-blank', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank' }),
      tab({ id: 2, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([1]);
  });

  it('closes ALL matching blank tabs (not keeping one)', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank' }),
      tab({ id: 2, url: 'about:newtab' }),
      tab({ id: 3, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([1, 2]);
  });

  it('skips active tab', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank', active: true }),
      tab({ id: 2, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('skips pinned tab', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank', pinned: true }),
      tab({ id: 2, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('skips audible tab', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank', audible: true }),
      tab({ id: 2, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('never closes last tab in window', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank', windowId: 1 }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.toClose).toEqual([]);
  });

  it('message for 0 tabs', () => {
    const tabs = [
      tab({ id: 1, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.message).toBe('No blank tabs found');
  });

  it('message for 1 tab', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank' }),
      tab({ id: 2, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.message).toBe('Closed 1 blank tab');
  });

  it('message for multiple tabs', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank' }),
      tab({ id: 2, url: 'about:newtab' }),
      tab({ id: 3, url: 'https://example.com/page' }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    expect(result.message).toBe('Closed 2 blank tabs');
  });

  it('respects last-tab-in-window across multiple windows', () => {
    const tabs = [
      tab({ id: 1, url: 'about:blank', windowId: 1 }),
      tab({ id: 2, url: 'about:blank', windowId: 2 }),
      tab({ id: 3, url: 'https://example.com', windowId: 2 }),
    ];
    const result = findBlankTabs(tabs, defaultSettings);
    // Window 1 has only one tab (blank) — must keep it
    // Window 2 has two tabs — can close the blank one
    expect(result.toClose).toEqual([2]);
  });
});
