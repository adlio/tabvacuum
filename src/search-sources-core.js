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

/** Only an explicit `true` turns a source on. */
export function normalizeSources(sources) {
  return { history: sources?.history === true, content: sources?.content === true };
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
 * only by their contents, then open tabs found only through a history visit,
 * then history pages that are not open. Each open tab appears once; a content
 * snippet attaches only when its tabId and URL both still match the tab.
 * History is deduplicated by exact URL and never shown for an open URL; hiding
 * it here is display-only. An empty query returns the recent tabs alone.
 */
export function composeSearchResults({ tabs = [], query = '', currentTabId, history = [], content = [] } = {}) {
  const ranked = rankTabs(tabs, query, { currentTabId });
  if (!String(query).trim()) return ranked.map(r => tabResult(r.tab, r.matchType));

  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const snippets = new Map();
  for (const item of Array.isArray(content) ? content : []) {
    const tab = byId.get(item?.tabId);
    // A tab that navigated since the page was read keeps no stale snippet.
    if (!tab || tab.url !== item.url || typeof item.snippet !== 'string' || !item.snippet || snippets.has(tab.id)) continue;
    snippets.set(tab.id, item.snippet);
  }

  const out = ranked.map(r => tabResult(r.tab, r.matchType));
  const listed = new Set(out.map(r => r.tab.id));
  const contentOnly = [...snippets.keys()].filter(id => !listed.has(id)).map(id => byId.get(id))
    .sort((a, b) => accessed(b) - accessed(a) || a.id - b.id);
  for (const tab of contentOnly) { listed.add(tab.id); out.push(tabResult(tab, 'content')); }
  for (const result of out) if (snippets.has(result.tab.id)) result.snippet = snippets.get(result.tab.id);

  // Rank history with the tab rules; numeric stand-in ids keep ties stable.
  const visits = selectHistory(history).results;
  const matched = rankTabs(visits.map((visit, id) => ({ id, title: visit.title, url: visit.url, lastAccessed: visit.lastVisitTime })), query);
  const openByUrl = new Map();
  for (const tab of tabs) openByUrl.set(tab.url, [...(openByUrl.get(tab.url) ?? []), tab]);
  const promoted = [];
  const pages = [];
  for (const { tab: { id } } of matched) {
    const visit = visits[id];
    const open = openByUrl.get(visit.url);
    if (open) {
      // Every open duplicate stays listed, so each remains closable.
      for (const tab of open) if (!listed.has(tab.id)) { listed.add(tab.id); promoted.push(tabResult(tab, 'history')); }
      continue;
    }
    const key = `history:${visit.url}`;
    pages.push({ tab: { id: key, title: visit.title, url: visit.url, lastAccessed: visit.lastVisitTime }, matchType: 'history', kind: 'history', key });
  }
  return [...out, ...promoted, ...pages];
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
