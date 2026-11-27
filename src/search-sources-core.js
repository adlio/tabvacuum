// Pure helpers for expanded search sources (history and open-page content).
// No browser APIs here, so every rule is unit-testable.
import { rankTabs } from './search-core.js';

export const MAX_QUERY_CHARS = 256;
export const HISTORY_LIMIT = 100;
export const CONTENT_TAB_LIMIT = 100;
export const CONTENT_CONCURRENCY = 4;
export const CONTENT_TIMEOUT_MS = 1500;
export const CONTENT_LIMITS = Object.freeze({ maxChars: 100_000, maxNodes: 10_000, maxMs: 75, snippetChars: 240 });

/** The trimmed query; throws for a non-string or over-long query. */
export function normalizeQuery(query) {
  if (typeof query !== 'string' || query.length > MAX_QUERY_CHARS) {
    throw new Error(`Search text must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  return query.trim();
}

export const BOOKMARK_LIMIT = 50;
export const SOURCE_NAMES = Object.freeze(['tabs', 'bookmarks', 'history', 'content']);

/** Open tabs stay on unless explicitly `false`; every other source needs an explicit `true`. */
export function normalizeSources(sources) {
  return {
    tabs: sources?.tabs !== false, bookmarks: sources?.bookmarks === true,
    history: sources?.history === true, content: sources?.content === true,
  };
}

// --- Saved default sources (R15) ---------------------------------------------
// Stored as tabs/bookmarks/history only: Contents is never a saved default.

/** The stored default, with Tabs alone when nothing valid is stored. */
export function normalizeDefaultSources(saved) {
  const value = saved && typeof saved === 'object' ? saved : {};
  const out = { tabs: value.tabs === true, bookmarks: value.bookmarks === true, history: value.history === true };
  if (!out.tabs && !out.bookmarks && !out.history) out.tabs = true;
  return out;
}

/** The sources a new search starts with: the default minus what this window can't use. */
export function startingSources(saved, { incognito = false, bookmarkPermission = false } = {}) {
  const out = { ...normalizeDefaultSources(saved), content: false };
  if (!bookmarkPermission) out.bookmarks = false;
  if (incognito) out.history = false;
  if (!out.tabs && !out.bookmarks && !out.history) out.tabs = true;
  return out;
}

/** Whether Save as default would change anything. Contents never counts. */
export function differsFromDefault(current, saved) {
  const base = normalizeDefaultSources(saved);
  return ['tabs', 'bookmarks', 'history'].some(name => Boolean(current?.[name]) !== base[name]);
}

// --- Scope words (R15) ---------------------------------------------------------

export const SCOPE_WORDS = Object.freeze([
  { word: 'tabs', short: 't', scope: 'tabs', label: 'Only open tabs' },
  { word: 'bookmarks', short: 'b', scope: 'bookmarks', label: 'Only bookmarks' },
  { word: 'history', short: 'h', scope: 'history', label: 'Only history' },
  { word: 'contents', short: 'c', scope: 'content', label: 'Only page contents' },
  { word: 'all', short: 'a', scope: 'all', label: 'All sources' },
]);

/**
 * The scope word that the whole query is, or undefined. ASCII `@` only: a
 * full-width ＠ stays literal text. The caller converts only on a typed space.
 */
export function scopeWord(text) {
  const match = /^@([a-z]+)$/i.exec(String(text ?? ''));
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return SCOPE_WORDS.find(entry => entry.word === name || entry.short === name);
}

/** Scope words the query could still become while it is a bare `@` prefix; else []. */
export function scopeSuggestions(text) {
  const match = /^@([a-z]*)$/i.exec(String(text ?? ''));
  if (!match) return [];
  const typed = match[1].toLowerCase();
  return SCOPE_WORDS.filter(entry => entry.word.startsWith(typed) || entry.short === typed);
}

/** The sources a scope word selects. `all` includes Contents. */
export function scopeSources(scope) {
  if (scope === 'all') return { tabs: true, bookmarks: true, history: true, content: true };
  return { tabs: scope === 'tabs', bookmarks: scope === 'bookmarks', history: scope === 'history', content: scope === 'content' };
}

// --- Bookmarks (R15) -------------------------------------------------------------

/**
 * A flat list of web bookmarks from bookmarks.getTree(): folders, separators,
 * bookmarklets, place: queries and non-web URLs are dropped. Each URL appears
 * once, with the first folder path found and how many other folders hold it.
 * Paths use the browser's own folder names; the unnamed root is skipped.
 */
export function buildBookmarkIndex(tree) {
  const byUrl = new Map();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.url === 'string') {
      if (!isSafeWebUrl(node.url)) return;
      const seen = byUrl.get(node.url);
      if (seen) { seen.folders++; return; }
      byUrl.set(node.url, {
        id: String(node.id), title: typeof node.title === 'string' ? node.title : '', url: node.url,
        path: path.join(' › '), folders: 0, dateAdded: Number.isFinite(node.dateAdded) ? node.dateAdded : 0,
      });
      return;
    }
    if (!Array.isArray(node.children)) return;
    const next = node.parentId !== undefined && node.title ? [...path, node.title] : path;
    for (const child of node.children) walk(child, next);
  };
  for (const root of Array.isArray(tree) ? tree : [tree]) walk(root, []);
  return [...byUrl.values()];
}

/**
 * Bookmarks matching the query with the tab ranking rules, newest first on
 * ties. `results` is capped; `urls` holds every match, for counts and dedup.
 */
export function searchBookmarkIndex(index, query, limit = BOOKMARK_LIMIT) {
  if (!String(query ?? '').trim() || !Array.isArray(index)) return { results: [], urls: [] };
  const matched = rankTabs(index.map((entry, id) => ({ id, title: entry.title, url: entry.url, lastAccessed: entry.dateAdded })), query);
  const entries = matched.map(({ tab }) => index[tab.id]);
  return { results: entries.slice(0, limit), urls: entries.map(entry => entry.url) };
}

/**
 * How many rows each off source would add on its own, after removing repeats:
 * open-tab URLs (only while Tabs is on, since an open page then shows as its
 * tab) and, for History, bookmark URLs only while Bookmarks is on. History's
 * `withBookmarks` is what it adds when Bookmarks is included with it, as
 * "Include them" does. Null means "not counted"; `limited` means more matched
 * than the source lists.
 */
export function sourceCounts({ tabsOn = true, bookmarksOn = false, openUrls = [], bookmarkUrls = null, historyUrls = null, historyLimited = false } = {}) {
  const open = new Set(tabsOn ? openUrls : []);
  const unique = urls => [...new Set(urls)];
  const bookmarks = Array.isArray(bookmarkUrls) ? unique(bookmarkUrls).filter(url => !open.has(url)) : null;
  const marked = new Set(Array.isArray(bookmarkUrls) ? bookmarkUrls : []);
  const visits = Array.isArray(historyUrls) ? unique(historyUrls).filter(url => !open.has(url)) : null;
  const history = visits && (bookmarksOn ? visits.filter(url => !marked.has(url)) : visits);
  const withBookmarks = visits && visits.filter(url => !marked.has(url));
  return {
    bookmarks: bookmarks ? { count: Math.min(bookmarks.length, BOOKMARK_LIMIT), limited: bookmarks.length > BOOKMARK_LIMIT } : null,
    history: history ? {
      count: Math.min(history.length, HISTORY_LIMIT), limited: historyLimited || history.length > HISTORY_LIMIT,
      withBookmarks: Math.min(withBookmarks.length, HISTORY_LIMIT),
    } : null,
  };
}

/** An absolute http(s) URL without embedded credentials, as given (not normalized). */
export function isSafeWebUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
}

/**
 * Most recent unique history entries. URLs are compared as exact strings, so
 * query strings and fragments are kept; `limited` reports a truncated result.
 */
export function selectHistory(items, limit = HISTORY_LIMIT) {
  const latest = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isSafeWebUrl(item?.url)) continue;
    const lastVisitTime = Number.isFinite(item.lastVisitTime) ? item.lastVisitTime : 0;
    const seen = latest.get(item.url);
    if (!seen || lastVisitTime > seen.lastVisitTime) {
      latest.set(item.url, { url: item.url, title: typeof item.title === 'string' ? item.title : '', lastVisitTime });
    }
  }
  const sorted = [...latest.values()].sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  const received = Array.isArray(items) ? items.length : 0;
  return { results: sorted.slice(0, limit), limited: sorted.length > limit || received > limit };
}

const accessed = tab => Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
const tabResult = (tab, matchType) => ({ tab, matchType, kind: 'tab', key: `tab:${tab.id}` });

/**
 * One result list: ranked open tabs first (in rankTabs order), then tabs found
 * only by their contents, then open tabs found only through a bookmark or a
 * history visit, then bookmarks that are not open, then history pages that are
 * neither open nor bookmarked. Each open tab appears once; a content snippet
 * attaches only when its tabId and URL both still match the tab. Bookmarks and
 * history are deduplicated by exact URL. With Tabs off, an open page found
 * through a bookmark or history stays that row, carrying `openTabId`. An empty
 * query returns the recent tabs alone, whatever sources are on (R11.3).
 */
export function composeSearchResults({ tabs = [], query = '', currentTabId, sources, bookmarks = [], history = [], content = [] } = {}) {
  const ranked = rankTabs(tabs, query, { currentTabId });
  if (!String(query).trim()) return ranked.map(r => tabResult(r.tab, r.matchType));
  const tabsOn = sources?.tabs !== false;

  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const snippets = new Map();
  for (const item of Array.isArray(content) ? content : []) {
    const tab = byId.get(item?.tabId);
    // A tab that navigated since the page was read keeps no stale snippet.
    if (!tab || tab.url !== item.url || typeof item.snippet !== 'string' || !item.snippet || snippets.has(tab.id)) continue;
    snippets.set(tab.id, item.snippet);
  }

  const out = tabsOn ? ranked.map(r => tabResult(r.tab, r.matchType)) : [];
  const listed = new Set(out.map(r => r.tab.id));
  const contentOnly = [...snippets.keys()].filter(id => !listed.has(id)).map(id => byId.get(id))
    .sort((a, b) => accessed(b) - accessed(a) || a.id - b.id);
  for (const tab of contentOnly) { listed.add(tab.id); out.push(tabResult(tab, 'content')); }
  for (const result of out) if (snippets.has(result.tab.id)) result.snippet = snippets.get(result.tab.id);

  const openByUrl = new Map();
  for (const tab of tabs) openByUrl.set(tab.url, [...(openByUrl.get(tab.url) ?? []), tab]);
  const promoted = [];
  const shownUrls = new Set();
  // An open page found through another source shows as its tab while Tabs is
  // on, or once some row already lists that tab. Every open duplicate stays
  // listed, so each remains closable. Returns true when the page is handled.
  const promote = (url, matchType) => {
    const open = openByUrl.get(url);
    if (!open || !(tabsOn || open.some(tab => listed.has(tab.id)))) return false;
    for (const tab of open) if (!listed.has(tab.id)) { listed.add(tab.id); promoted.push(tabResult(tab, matchType)); }
    shownUrls.add(url);
    return true;
  };
  const openTabId = url => openByUrl.get(url)?.[0]?.id;

  const marks = [];
  for (const mark of Array.isArray(bookmarks) ? bookmarks : []) {
    if (!isSafeWebUrl(mark?.url) || shownUrls.has(mark.url) || promote(mark.url, 'bookmark')) continue;
    shownUrls.add(mark.url);
    const key = `bookmark:${mark.url}`;
    marks.push({
      tab: { id: key, title: typeof mark.title === 'string' ? mark.title : '', url: mark.url, lastAccessed: 0 },
      matchType: 'bookmark', kind: 'bookmark', key, bookmarkId: String(mark.id),
      path: typeof mark.path === 'string' ? mark.path : '', folders: Number.isInteger(mark.folders) ? mark.folders : 0,
      openTabId: openTabId(mark.url),
    });
  }

  // Rank history with the tab rules; numeric stand-in ids keep ties stable.
  const visits = selectHistory(history).results;
  const matched = rankTabs(visits.map((visit, id) => ({ id, title: visit.title, url: visit.url, lastAccessed: visit.lastVisitTime })), query);
  const pages = [];
  for (const { tab: { id } } of matched) {
    const visit = visits[id];
    if (shownUrls.has(visit.url) || promote(visit.url, 'history')) continue;
    const key = `history:${visit.url}`;
    pages.push({ tab: { id: key, title: visit.title, url: visit.url, lastAccessed: visit.lastVisitTime }, matchType: 'history', kind: 'history', key, openTabId: openTabId(visit.url) });
  }
  return [...out, ...promoted, ...marks, ...pages];
}

/** Why a tab cannot be content-searched right now, or undefined if it can. */
export function contentSkipReason(tab, isSearchPage) {
  if (tab.discarded) return 'discarded';
  if (tab.status !== undefined && tab.status !== 'complete') return 'loading';
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) return 'loading';
  if (!/^https?:\/\//.test(tab.url ?? '') || isSearchPage(tab.url)) return 'unsupported';
  return undefined;
}

/** The injected function's result, or undefined if it is malformed. */
export function readContentResult(value, snippetChars = CONTENT_LIMITS.snippetChars) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || typeof value.match !== 'boolean') return undefined;
  const snippet = typeof value.snippet === 'string' ? value.snippet.slice(0, snippetChars) : '';
  if (value.match && !snippet) return undefined;
  return { url: value.url, match: value.match, snippet: value.match ? snippet : '', truncated: value.truncated === true };
}

/** Runs fn over items with at most `limit` in flight; stops starting work once `signal` aborts. */
export async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Rejects after ms; the timer is always cleared. */
export function withTimeout(promise, ms, schedule = setTimeout, cancel = clearTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = schedule(() => reject(new Error('Timed out.')), ms); });
  return Promise.race([promise, timeout]).finally(() => cancel(timer));
}
