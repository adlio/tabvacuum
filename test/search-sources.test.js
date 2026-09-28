import { describe, it, expect, vi } from 'vitest';
import {
  normalizeQuery, normalizeSources, isSafeWebUrl, selectHistory, contentSkipReason, readContentResult,
  mapLimit, withTimeout, MAX_QUERY_CHARS, HISTORY_LIMIT, composeSearchResults,
} from '../src/search-sources-core.js';
import { rankTabs } from '../src/search-core.js';

describe('search source rules', () => {
  it('trims queries and bounds their length', () => {
    expect(normalizeQuery('  a b  ')).toBe('a b');
    expect(normalizeQuery(' \t ')).toBe('');
    expect(normalizeQuery('x'.repeat(MAX_QUERY_CHARS))).toHaveLength(256);
    for (const bad of ['x'.repeat(257), undefined, null, 5, {}, ['a']]) expect(() => normalizeQuery(bad)).toThrow();
  });

  it('turns a source on only for an explicit true', () => {
    expect(normalizeSources({ history: true, content: 'yes' })).toEqual({ history: true, content: false });
    expect(normalizeSources(undefined)).toEqual({ history: false, content: false });
  });

  it.each([
    ['https://example.org/a?b=1#c', true], ['http://example.org', true],
    ['javascript:alert(1)', false], ['data:text/html,x', false], ['file:///etc/passwd', false],
    ['moz-extension://x/search.html', false], ['https://user:pw@example.org/', false], ['https://user@example.org/', false],
    ['//example.org', false], ['not a url', false], ['', false], [undefined, false], [`https://e.org/${'a'.repeat(9000)}`, false],
  ])('treats %s as safe web URL: %s', (url, ok) => {
    expect(isSafeWebUrl(url)).toBe(ok);
  });

  it('keeps the latest visit of each exact URL, newest first, dropping unsafe entries', () => {
    const { results, limited } = selectHistory([
      { url: 'https://a.test/?x=1', title: 'old', lastVisitTime: 1 },
      { url: 'https://a.test/?x=1', title: 'new', lastVisitTime: 5 },
      { url: 'https://a.test/?x=1#f', title: 'fragment', lastVisitTime: 3 }, // Distinct: no normalization.
      { url: 'javascript:void(0)', title: 'bad', lastVisitTime: 9 },
      { url: 'https://u:p@a.test/', title: 'creds', lastVisitTime: 9 },
      { url: 'https://b.test/', lastVisitTime: undefined },
    ]);
    expect(results).toEqual([
      { url: 'https://a.test/?x=1', title: 'new', lastVisitTime: 5 },
      { url: 'https://a.test/?x=1#f', title: 'fragment', lastVisitTime: 3 },
      { url: 'https://b.test/', title: '', lastVisitTime: 0 },
    ]);
    expect(limited).toBe(false);
  });

  it('caps at 100 and reports the limit', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ url: `https://a.test/${i}`, lastVisitTime: i }));
    const { results, limited } = selectHistory(items);
    expect(results).toHaveLength(100);
    expect(results[0].url).toBe('https://a.test/100');
    expect(limited).toBe(true);
    expect(selectHistory(items.slice(0, 100)).limited).toBe(false);
    expect(selectHistory(null)).toEqual({ results: [], limited: false });
  });

  it('skips discarded, loading, non-web, and search pages', () => {
    const isSearch = url => url.startsWith('moz-extension://x/search.html');
    expect(contentSkipReason({ url: 'https://a.test/', status: 'complete' }, isSearch)).toBeUndefined();
    expect(contentSkipReason({ url: 'https://a.test/', discarded: true }, isSearch)).toBe('discarded');
    expect(contentSkipReason({ url: 'https://a.test/', status: 'loading' }, isSearch)).toBe('loading');
    expect(contentSkipReason({ url: 'https://a.test/', pendingUrl: 'https://b.test/' }, isSearch)).toBe('loading');
    expect(contentSkipReason({ url: 'about:blank' }, isSearch)).toBe('unsupported');
    expect(contentSkipReason({ url: 'moz-extension://x/search.html' }, isSearch)).toBe('unsupported');
  });

  it('accepts only well-formed injected results and bounds the snippet', () => {
    expect(readContentResult({ url: 'https://a/', match: true, snippet: 'x'.repeat(500), truncated: true }))
      .toEqual({ url: 'https://a/', match: true, snippet: 'x'.repeat(240), truncated: true });
    expect(readContentResult({ url: 'https://a/', match: false, snippet: 'leak' }).snippet).toBe('');
    for (const bad of [undefined, null, 'mounted', { url: 1, match: true }, { url: 'https://a/' }, { url: 'https://a/', match: true }]) {
      expect(readContentResult(bad)).toBeUndefined();
    }
  });

  it('bounds concurrency and stops starting work after abort', async () => {
    let active = 0;
    let peak = 0;
    const controller = new AbortController();
    const seen = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 4, async item => {
      active++; peak = Math.max(peak, active); seen.push(item);
      await new Promise(resolve => setTimeout(resolve, 1));
      if (item === 2) controller.abort();
      active--;
    }, controller.signal);
    expect(peak).toBe(4);
    expect(seen.length).toBeLessThan(8);
  });

  it('times out and always clears its timer', async () => {
    const cancel = vi.fn();
    await expect(withTimeout(new Promise(() => {}), 1, setTimeout, cancel)).rejects.toThrow('Timed out.');
    await expect(withTimeout(Promise.resolve(7), 1000, setTimeout, cancel)).resolves.toBe(7);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe('composeSearchResults', () => {
  const tab = (id, title, url, lastAccessed = id) => ({ id, title, url, lastAccessed, windowId: 1 });
  const visit = (url, title, lastVisitTime) => ({ url, title, lastVisitTime });
  const shape = results => results.map(({ kind, key, matchType, snippet }) => ({ kind, key, matchType, ...(snippet ? { snippet } : {}) }));
  const tabs = [
    tab(1, 'Quarterly report', 'https://docs.test/q'),
    tab(2, 'Inbox', 'https://mail.test/u/0'),
    tab(3, 'Inbox', 'https://mail.test/u/0'), // An open duplicate.
    tab(4, 'Weather', 'https://weather.test/'),
    tab(5, 'Recipes', 'https://food.test/'),
  ];

  it('keeps rankTabs order and tab identity for tabs, with tab keys', () => {
    for (const query of ['inbox', 'test', 'qrtrly', 'nothing-matches']) {
      const expected = rankTabs(tabs, query, { currentTabId: 2 });
      const results = composeSearchResults({ tabs, query, currentTabId: 2 });
      expect(results.map(r => r.tab)).toEqual(expected.map(r => r.tab));
      results.forEach((r, i) => {
        expect(r.tab).toBe(expected[i].tab);
        expect(r).toEqual({ tab: expected[i].tab, matchType: expected[i].matchType, kind: 'tab', key: `tab:${r.tab.id}` });
      });
    }
  });

  it('ignores history and content for an empty query: recent ten, current last', () => {
    const many = Array.from({ length: 12 }, (_, i) => tab(i + 1, `T${i}`, `https://t.test/${i}`));
    const extras = { history: [visit('https://h.test/', 'History', 99)], content: [{ tabId: 1, url: 'https://t.test/0', snippet: 'x' }] };
    const small = composeSearchResults({ tabs: tabs.slice(0, 3), query: '  ', currentTabId: 3, ...extras });
    expect(small.map(r => r.key)).toEqual(['tab:2', 'tab:1', 'tab:3']);
    expect(small.every(r => r.kind === 'tab' && r.matchType === 'recent' && !('snippet' in r))).toBe(true);
    const big = composeSearchResults({ tabs: many, query: '', currentTabId: 12, ...extras });
    expect(big.map(r => r.tab.id)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(composeSearchResults({ tabs: [], query: '' })).toEqual([]);
  });

  it('merges a title match and a content match into one result with the snippet', () => {
    const results = composeSearchResults({ tabs, query: 'quarterly', content: [{ tabId: 1, url: 'https://docs.test/q', snippet: 'Quarterly numbers' }] });
    expect(shape(results)).toEqual([{ kind: 'tab', key: 'tab:1', matchType: 'title', snippet: 'Quarterly numbers' }]);
  });

  it('appends content-only tabs most recent first (id breaks ties), each once, ignoring stale or unknown entries', () => {
    const same = [tab(7, 'A', 'https://a.test/', 50), tab(6, 'B', 'https://b.test/', 50), tab(8, 'C', 'https://c.test/', 80), tab(9, 'D', 'https://d.test/', 90)];
    const results = composeSearchResults({
      tabs: same, query: 'budget',
      content: [
        { tabId: 7, url: 'https://a.test/', snippet: 'budget a' },
        { tabId: 6, url: 'https://b.test/', snippet: 'budget b' },
        { tabId: 8, url: 'https://c.test/', snippet: 'budget c' },
        { tabId: 8, url: 'https://c.test/', snippet: 'budget c again' },
        { tabId: 9, url: 'https://d.test/old', snippet: 'budget stale' }, // Tab navigated since it was read.
        { tabId: 99, url: 'https://gone.test/', snippet: 'budget closed' },
        { tabId: 7, url: 'https://a.test/', snippet: '' },
      ],
    });
    expect(shape(results)).toEqual([
      { kind: 'tab', key: 'tab:8', matchType: 'content', snippet: 'budget c' },
      { kind: 'tab', key: 'tab:6', matchType: 'content', snippet: 'budget b' },
      { kind: 'tab', key: 'tab:7', matchType: 'content', snippet: 'budget a' },
    ]);
  });

  it('adds matching history after tabs, deduplicated by exact URL keeping the newest visit', () => {
    const results = composeSearchResults({
      tabs, query: 'guide',
      history: [
        visit('https://wiki.test/guide', 'Guide (old title)', 1),
        visit('https://wiki.test/guide', 'Guide', 9),
        visit('https://wiki.test/guide?page=2', 'Guide', 5),
        visit('https://wiki.test/guide#setup', 'Guide', 4),
        visit('https://other.test/', 'Unrelated', 20), // The browser may return broad candidates.
      ],
    });
    expect(results.map(r => r.key)).toEqual(['history:https://wiki.test/guide', 'history:https://wiki.test/guide?page=2', 'history:https://wiki.test/guide#setup']);
    expect(results[0]).toEqual({
      tab: { id: 'history:https://wiki.test/guide', title: 'Guide', url: 'https://wiki.test/guide', lastAccessed: 9 },
      matchType: 'history', kind: 'history', key: 'history:https://wiki.test/guide',
    });
  });

  it('drops unsafe history URLs', () => {
    const results = composeSearchResults({
      tabs: [], query: 'page',
      history: [visit('javascript:page()', 'page', 9), visit('https://u:p@a.test/page', 'page', 9), visit('file:///page', 'page', 9), visit('https://a.test/page', 'page', 1)],
    });
    expect(results.map(r => r.key)).toEqual(['history:https://a.test/page']);
  });

  it('ranks history by the tab rules, with list order breaking exact ties', () => {
    const results = composeSearchResults({
      tabs: [], query: 'plan',
      history: [visit('https://x.test/1', 'Old plans', 5), visit('https://x.test/2', 'plan', 5), visit('https://x.test/3', 'Newer plans', 5)],
    });
    expect(results.map(r => r.tab.url)).toEqual(['https://x.test/2', 'https://x.test/1', 'https://x.test/3']);
  });

  it('handles one, two, and more than ten history results, capped by the history limit', () => {
    const pages = n => Array.from({ length: n }, (_, i) => visit(`https://h.test/${i}`, `Notes ${i}`, i));
    expect(composeSearchResults({ tabs: [], query: 'notes', history: pages(1) })).toHaveLength(1);
    expect(composeSearchResults({ tabs: [], query: 'notes', history: pages(2) }).map(r => r.tab.url)).toEqual(['https://h.test/1', 'https://h.test/0']);
    expect(composeSearchResults({ tabs: [], query: 'notes', history: pages(12) })).toHaveLength(12);
    const capped = composeSearchResults({ tabs: [], query: 'notes', history: pages(HISTORY_LIMIT + 5) });
    expect(capped).toHaveLength(HISTORY_LIMIT);
    expect(capped[0].tab.url).toBe(`https://h.test/${HISTORY_LIMIT + 4}`);
  });

  it('never shows history for an open URL; an already-listed tab appears once', () => {
    const results = composeSearchResults({ tabs, query: 'quarterly', history: [visit('https://docs.test/q', 'Quarterly report', 9)] });
    expect(shape(results)).toEqual([{ kind: 'tab', key: 'tab:1', matchType: 'title' }]);
  });

  it('promotes every open tab of a history-only match instead of losing the result', () => {
    const results = composeSearchResults({
      tabs, query: 'invoice',
      history: [visit('https://mail.test/u/0', 'Invoice from Acme - Inbox', 9), visit('https://billing.test/', 'Invoice archive', 3)],
    });
    expect(shape(results)).toEqual([
      { kind: 'tab', key: 'tab:2', matchType: 'history' },
      { kind: 'tab', key: 'tab:3', matchType: 'history' },
      { kind: 'history', key: 'history:https://billing.test/', matchType: 'history' },
    ]);
    expect(results[0].tab).toBe(tabs[1]);
    expect(results[1].tab).toBe(tabs[2]);
  });

  it('keeps a promoted tab once when content also found it', () => {
    const results = composeSearchResults({
      tabs, query: 'invoice',
      content: [{ tabId: 2, url: 'https://mail.test/u/0', snippet: 'Invoice #4' }],
      history: [visit('https://mail.test/u/0', 'Invoice', 9)],
    });
    expect(shape(results)).toEqual([
      { kind: 'tab', key: 'tab:2', matchType: 'content', snippet: 'Invoice #4' },
      { kind: 'tab', key: 'tab:3', matchType: 'history' },
    ]);
  });
});
