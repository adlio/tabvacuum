import { describe, it, expect } from 'vitest';
import { rankTabs } from '../src/search-core.js';

const tab = (id, title, lastAccessed = id, url = `https://example.org/${id}`) => ({ id, title, url, lastAccessed });
const ids = (tabs, query = '', options = {}) => rankTabs(tabs, query, options).map(result => result.tab.id);

describe('recent tabs', () => {
  it('sorts by focus time with only the current tab forced last', () => {
    expect(ids([tab(1, 'Current', 99), tab(2, 'Older', 1), tab(3, 'Previous', 10)], '', { currentTabId: 1 })).toEqual([3, 2, 1]);
  });
  it('supports two tabs, one tab, and an empty scope', () => {
    expect(ids([tab(1, 'Current'), tab(2, 'Other')], '', { currentTabId: 1 })).toEqual([2, 1]);
    expect(ids([tab(1, 'Current')], '', { currentTabId: 1 })).toEqual([1]);
    expect(ids([])).toEqual([]);
  });
  it('treats whitespace as empty and applies the recent limit after sorting', () => {
    const tabs = Array.from({ length: 20 }, (_, id) => tab(id, 'Tab'));
    expect(ids(tabs, '  ', { currentTabId: 19 })).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 10, 9]);
  });
  it('does not mutate the source array and handles missing timestamps', () => {
    const tabs = [tab(1, 'First'), { id: 2 }];
    ids(tabs);
    expect(tabs.map(t => t.id)).toEqual([1, 2]);
  });
});

describe('typed search', () => {
  it('never penalizes the current tab for any nonempty search', () => {
    const tabs = [tab(1, 'Project roadmap', 1), tab(2, 'Project discussion', 100)];
    for (const query of ['project roadmap', 'roadmap', 'prjct', 'raodmap']) {
      expect(ids(tabs, query, { currentTabId: 1 })).toEqual(ids(tabs, query, { currentTabId: 2 }));
      expect(ids(tabs, query, { currentTabId: 1 })).toContain(1);
    }
    expect(ids(tabs, 'roadmap', { currentTabId: 1 })[0]).toBe(1);
  });
  it('ranks literal matches ahead of fuzzy matches regardless of recency', () => {
    expect(ids([tab(1, 'Roadmap', 1), tab(2, 'Readmap', 999)], 'roadmap')).toEqual([1, 2]);
  });
  it('matches title, URL, and terms split across fields', () => {
    const tabs = [tab(1, 'Release plan', 1, 'https://docs.example.org/quarter')];
    expect(ids(tabs, 'release docs')).toEqual([1]);
    expect(rankTabs(tabs, 'docs')[0].matchType).toBe('url');
    expect(rankTabs(tabs, 'release')[0].matchType).toBe('title');
    expect(rankTabs(tabs, 'release docs')[0].matchType).toBe('title+url');
  });
  it('supports case folding, accents, subsequences and transposed typos', () => {
    const tabs = [tab(1, 'Café Project roadmap')];
    for (const query of ['CAFÉ', 'cafe', 'prjct', 'raodmap']) expect(ids(tabs, query)).toEqual([1]);
  });
  it('requires every term and returns no results for unrelated queries', () => {
    expect(ids([tab(1, 'Roadmap')], 'roadmap nonexistent')).toEqual([]);
    expect(ids([tab(1, 'Roadmap')], 'zzzz')).toEqual([]);
  });
  it('keeps all typed results searchable and uses recency to break ties', () => {
    const tabs = Array.from({ length: 2500 }, (_, id) => tab(id, 'Matching tab'));
    const before = performance.now();
    expect(ids(tabs, 'matching')).toHaveLength(2500);
    expect(ids(tabs, 'matching')[0]).toBe(2499);
    expect(performance.now() - before).toBeLessThan(1000);
  });
});
