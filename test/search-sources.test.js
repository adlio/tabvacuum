import { describe, it, expect, vi } from 'vitest';
import {
  normalizeQuery, normalizeSources, isSafeWebUrl, selectHistory, contentSkipReason, readContentResult,
  mapLimit, withTimeout, MAX_QUERY_CHARS, HISTORY_LIMIT, composeSearchResults,
  buildBookmarkIndex, searchBookmarkIndex, sourceCounts, scopeWord, scopeSuggestions, scopeSources,
  normalizeDefaultSources, startingSources, differsFromDefault, BOOKMARK_LIMIT,
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
    expect(normalizeSources({ history: true, content: 'yes', bookmarks: 1 })).toEqual({ tabs: true, bookmarks: false, history: true, content: false });
    expect(normalizeSources(undefined)).toEqual({ tabs: true, bookmarks: false, history: false, content: false });
    // Tabs is on unless explicitly off, so a handoff from an older search keeps it.
    expect(normalizeSources({ tabs: false, bookmarks: true })).toEqual({ tabs: false, bookmarks: true, history: false, content: false });
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

describe('bookmark index (R15)', () => {
  // Chromium's shape: an unnamed root, then named roots with parentId.
  const tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', children: [
      { id: '10', parentId: '1', title: 'Work', children: [
        { id: '11', parentId: '10', title: 'Plan', url: 'https://docs.example/plan', dateAdded: 5 },
        { id: '12', parentId: '10', title: 'Deep', children: [{ id: '13', parentId: '12', title: 'Deep page', url: 'https://deep.example/', dateAdded: 6 }] },
      ] },
      { id: '14', parentId: '1', title: 'Bookmarklet', url: 'javascript:alert(1)' },
      { id: '15', parentId: '1', title: 'Creds', url: 'https://user:pw@example.org/' },
      { id: '16', parentId: '1', type: 'separator' },
      { id: '17', parentId: '1', title: 'Recent', url: 'place:sort=8' },
      { id: '18', parentId: '1', title: 'Empty folder', children: [] },
    ] },
    { id: '2', parentId: '0', title: 'Other bookmarks', children: [
      { id: '21', parentId: '2', title: 'Plan again', url: 'https://docs.example/plan', dateAdded: 9 },
      { id: '22', parentId: '2', title: 'File', url: 'file:///etc/hosts' },
    ] },
  ] }];

  it('keeps web bookmarks only, once per URL, with the browser folder path', () => {
    expect(buildBookmarkIndex(tree)).toEqual([
      { id: '11', title: 'Plan', url: 'https://docs.example/plan', path: 'Bookmarks bar › Work', folders: 1, dateAdded: 5 },
      { id: '13', title: 'Deep page', url: 'https://deep.example/', path: 'Bookmarks bar › Work › Deep', folders: 0, dateAdded: 6 },
    ]);
    expect(buildBookmarkIndex(undefined)).toEqual([]);
    expect(buildBookmarkIndex([{ id: 'root________', title: '', children: [{ id: 'x', parentId: 'root________', title: 'Bookmarks Toolbar', children: [{ id: 'y', parentId: 'x', title: 't', url: 'https://t.example/' }] }] }])[0].path).toBe('Bookmarks Toolbar');
  });

  it('ranks matches with the tab rules, newest first on ties, capped, listing every match URL', () => {
    const index = Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Alpha ${i}`, url: `https://a${i}.example/`, path: '', folders: 0, dateAdded: i }));
    const { results, urls } = searchBookmarkIndex(index, 'alpha');
    expect(results).toHaveLength(BOOKMARK_LIMIT);
    expect(results[0].id).toBe('59'); // Not the oldest, as native Firefox order would give.
    expect(urls).toHaveLength(60);
    // Fuzzy, like tab search: a typo still finds it.
    expect(searchBookmarkIndex(index, 'alpah 7').results.map(r => r.id)).toContain('7');
    expect(searchBookmarkIndex(index, '  ')).toEqual({ results: [], urls: [] });
  });
});

describe('composing bookmarks with other sources (R15)', () => {
  const tabs = [
    { id: 1, title: 'Docs plan', url: 'https://docs.example/plan', lastAccessed: 9 },
    { id: 2, title: 'Mail', url: 'https://mail.example/', lastAccessed: 8 },
  ];
  const bookmarks = [
    { id: 'b1', title: 'Plan bookmark', url: 'https://docs.example/plan', path: 'Work' },
    { id: 'b2', title: 'Plan wiki', url: 'https://wiki.example/plan', path: 'Work', folders: 2 },
    { id: 'b3', title: 'Mail plan', url: 'https://mail.example/', path: 'Work' },
  ];
  const history = [{ url: 'https://wiki.example/plan', title: 'Plan wiki', lastVisitTime: 3 }, { url: 'https://old.example/plan', title: 'Old plan', lastVisitTime: 2 }];
  const shape = list => list.map(r => [r.kind, r.key, r.openTabId]);

  it('orders tabs, then bookmarks, then history, each URL once', () => {
    expect(shape(composeSearchResults({ tabs, query: 'plan', sources: { tabs: true }, bookmarks, history }))).toEqual([
      ['tab', 'tab:1', undefined],
      ['tab', 'tab:2', undefined], // Open, found only through its bookmark.
      ['bookmark', 'bookmark:https://wiki.example/plan', undefined],
      ['history', 'history:https://old.example/plan', undefined], // wiki.example is listed as a bookmark.
    ]);
  });

  it('with Tabs off, shows open pages as bookmark or history rows that carry the open tab', () => {
    const list = composeSearchResults({ tabs, query: 'plan', sources: { tabs: false }, bookmarks, history });
    expect(shape(list)).toEqual([
      ['bookmark', 'bookmark:https://docs.example/plan', 1],
      ['bookmark', 'bookmark:https://wiki.example/plan', undefined],
      ['bookmark', 'bookmark:https://mail.example/', 2],
      ['history', 'history:https://old.example/plan', undefined],
    ]);
    expect(list[1]).toMatchObject({ bookmarkId: 'b2', path: 'Work', folders: 2 });
  });

  it('shows recent tabs for an empty query whatever sources are on', () => {
    expect(shape(composeSearchResults({ tabs, query: ' ', sources: { tabs: false, bookmarks: true }, bookmarks, history }))).toEqual([
      ['tab', 'tab:1', undefined], ['tab', 'tab:2', undefined],
    ]);
  });

  it('drops unsafe bookmark URLs from a reply', () => {
    expect(composeSearchResults({ tabs: [], query: 'x', bookmarks: [{ id: 'z', title: 'x', url: 'javascript:x' }] })).toEqual([]);
  });
});

describe('off-source counts (R15)', () => {
  it('counts what each source would add on its own after removing repeats', () => {
    const counts = sourceCounts({
      tabsOn: true, openUrls: ['https://a/'],
      bookmarkUrls: ['https://a/', 'https://b/', 'https://b/'],
      historyUrls: ['https://a/', 'https://b/', 'https://c/'],
    });
    // Bookmarks is off, so History alone adds b and c; with Bookmarks included too it adds only c.
    expect(counts).toEqual({ bookmarks: { count: 1, limited: false }, history: { count: 2, limited: false, withBookmarks: 1 } });
  });

  it('subtracts bookmarked pages from History only while Bookmarks is on', () => {
    const base = { openUrls: [], bookmarkUrls: ['https://u1/', 'https://u2/'], historyUrls: ['https://u1/', 'https://u2/', 'https://u3/'] };
    expect(sourceCounts(base).history).toEqual({ count: 3, limited: false, withBookmarks: 1 });
    expect(sourceCounts({ ...base, bookmarksOn: true }).history).toEqual({ count: 1, limited: false, withBookmarks: 1 });
  });

  it('caps Bookmarks at 50 and marks it limited when more match', () => {
    const urls = n => Array.from({ length: n }, (_, i) => `https://b${i}/`);
    expect(sourceCounts({ bookmarkUrls: urls(60) }).bookmarks).toEqual({ count: 50, limited: true });
    expect(sourceCounts({ bookmarkUrls: urls(50) }).bookmarks).toEqual({ count: 50, limited: false });
  });

  it('keeps open pages in the count when Tabs is off, since they then show as those rows', () => {
    expect(sourceCounts({ tabsOn: false, openUrls: ['https://a/'], bookmarkUrls: ['https://a/'], historyUrls: [] }))
      .toEqual({ bookmarks: { count: 1, limited: false }, history: { count: 0, limited: false, withBookmarks: 0 } });
  });

  it('reports uncounted sources as null and a limited history as limited', () => {
    expect(sourceCounts({ historyUrls: ['https://x/'], historyLimited: true })).toEqual({ bookmarks: null, history: { count: 1, limited: true, withBookmarks: 1 } });
    expect(sourceCounts()).toEqual({ bookmarks: null, history: null });
  });
});

describe('scope words (R15)', () => {
  it.each([
    ['@b', 'bookmarks'], ['@bookmarks', 'bookmarks'], ['@T', 'tabs'], ['@history', 'history'], ['@c', 'content'],
    ['@contents', 'content'], ['@all', 'all'], ['@a', 'all'],
  ])('recognizes %s as the whole query', (text, scope) => {
    expect(scopeWord(text)?.scope).toBe(scope);
  });

  it.each(['@types', '@b x', ' @b', 'a@b.com', '@', '＠b', '@bookmark', '@angular/core', ''])('leaves %j as text', text => {
    expect(scopeWord(text)).toBeUndefined();
  });

  it('suggests words only for a bare @ prefix', () => {
    expect(scopeSuggestions('@').map(e => e.word)).toEqual(['tabs', 'bookmarks', 'history', 'contents', 'all']);
    expect(scopeSuggestions('@b').map(e => e.word)).toEqual(['bookmarks']);
    expect(scopeSuggestions('@a').map(e => e.word)).toEqual(['all']);
    for (const text of ['@types', '@x', 'b', '＠', '@b ']) expect(scopeSuggestions(text)).toEqual([]);
  });

  it('maps @all to every source, Contents included', () => {
    expect(scopeSources('all')).toEqual({ tabs: true, bookmarks: true, history: true, content: true });
    expect(scopeSources('bookmarks')).toEqual({ tabs: false, bookmarks: true, history: false, content: false });
  });
});

describe('default sources (R15)', () => {
  it('stores tabs, bookmarks and history only, with Tabs when nothing valid is set', () => {
    expect(normalizeDefaultSources(undefined)).toEqual({ tabs: true, bookmarks: false, history: false });
    expect(normalizeDefaultSources({ tabs: false })).toEqual({ tabs: true, bookmarks: false, history: false });
    expect(normalizeDefaultSources({ tabs: false, bookmarks: true, content: true })).toEqual({ tabs: false, bookmarks: true, history: false });
  });

  it('starts a search without sources this window cannot use, never with Contents', () => {
    expect(startingSources({ tabs: true, bookmarks: true, history: true }, { incognito: true, bookmarkPermission: false }))
      .toEqual({ tabs: true, bookmarks: false, history: false, content: false });
    expect(startingSources({ tabs: false, history: true }, { incognito: true })).toEqual({ tabs: true, bookmarks: false, history: false, content: false });
    expect(startingSources({ tabs: false, bookmarks: true }, { bookmarkPermission: true })).toEqual({ tabs: false, bookmarks: true, history: false, content: false });
  });

  it('ignores Contents when deciding whether Save as default changes anything', () => {
    expect(differsFromDefault({ tabs: true, content: true }, { tabs: true })).toBe(false);
    expect(differsFromDefault({ tabs: true, bookmarks: true, history: true, content: true }, undefined)).toBe(true);
  });
});
