// core.js — Pure functions for TabVacuum

export const BLANK_NEW_TAB_URLS = [
  'about:blank',
  'about:newtab',
  'about:home',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'edge://newtab/',
];

export const BLANK_WELCOME_URLS = [
  'about:welcome',
  'about:privatebrowsing',
  'chrome://welcome/',
];

// Matches search engine homepages but not search results or subpages.
// After the domain, allows only optional "/" then optional query/fragment params.
// Negative lookahead excludes URLs with search query params (q=, p=, wd=, etc.)
// so google.com/?gws_rd=ssl matches but google.com/?q=test does not.
export const SEARCH_ENGINE_HOMEPAGE_RE = new RegExp(
  '^https?://(' +
    'www\\.google\\.[a-z]{2,3}(?:\\.[a-z]{2})?' +
    '|www\\.bing\\.com' +
    '|duckduckgo\\.com' +
    '|search\\.yahoo\\.com' +
    '|www\\.baidu\\.com' +
    '|yandex\\.[a-z]{2,3}' +
    '|www\\.naver\\.com' +
    '|www\\.startpage\\.com' +
    '|www\\.ecosia\\.org' +
    '|search\\.brave\\.com' +
    '|www\\.qwant\\.com' +
  ')/?(?:[?#](?!(?:q|p|wd|text|query|search_query)=)(?!.*&(?:q|p|wd|text|query|search_query)=).*)?$'
);

// Parse custom URL lines into matchers: plain strings for exact match, RegExp for /pattern/ syntax.
export function parseCustomMatchers(lines) {
  if (!lines) return [];
  const matchers = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const regexMatch = trimmed.match(/^\/(.+)\/$/);
    if (regexMatch) {
      try {
        matchers.push(new RegExp(regexMatch[1]));
      } catch {
        // invalid regex, skip
      }
    } else {
      matchers.push(trimmed);
    }
  }
  return matchers;
}

export function isBlankTab(url, settings, customMatchers) {
  if (settings.blankNewTab && BLANK_NEW_TAB_URLS.includes(url)) return true;
  if (settings.blankWelcome && BLANK_WELCOME_URLS.includes(url)) return true;
  if (settings.blankSearchEngines && SEARCH_ENGINE_HOMEPAGE_RE.test(url)) return true;

  if (customMatchers) {
    for (const matcher of customMatchers) {
      if (typeof matcher === 'string') {
        if (url === matcher) return true;
      } else {
        if (matcher.test(url)) return true;
      }
    }
  }

  return false;
}

export function findBlankTabs(tabs, settings) {
  const customMatchers = parseCustomMatchers(settings.blankCustomUrls);
  const toClose = filterClosableTabs(tabs, settings, tab =>
    isBlankTab(tab.url, settings, customMatchers)
  );

  const count = toClose.length;
  const message = count > 0
    ? `Closed ${count} blank tab${count === 1 ? '' : 's'}`
    : 'No blank tabs found';

  return { toClose, message };
}

export function normalizeUrl(url, settings) {
  try {
    const parsed = new URL(url);
    if (settings.ignoreFragments) parsed.hash = '';
    if (settings.ignoreQueryParams) parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isProtected(tab, settings) {
  return (
    tab.active ||
    (tab.pinned && settings.skipPinned) ||
    (tab.audible && settings.skipAudible)
  );
}

// Group tabs by window to prevent closing the last tab in any window
function filterClosableTabs(tabs, settings, shouldClose) {
  const tabsByWindow = new Map();
  for (const tab of tabs) {
    const windowTabs = tabsByWindow.get(tab.windowId) || [];
    windowTabs.push(tab);
    tabsByWindow.set(tab.windowId, windowTabs);
  }

  const toCloseSet = new Set();

  for (const tab of tabs) {
    if (isProtected(tab, settings)) continue;
    if (!shouldClose(tab)) continue;

    const windowTabs = tabsByWindow.get(tab.windowId);
    const remainingTabs = windowTabs.filter(
      t => !toCloseSet.has(t.id) && t.id !== tab.id
    );
    if (remainingTabs.length === 0) continue;

    toCloseSet.add(tab.id);
  }

  return [...toCloseSet];
}

export function findDuplicates(tabs, settings) {
  const groupedByUrl = new Map();

  for (const tab of tabs) {
    const key = normalizeUrl(tab.url, settings);
    const group = groupedByUrl.get(key) || [];
    group.push(tab);
    groupedByUrl.set(key, group);
  }

  // Build candidate set: tabs that are duplicates and should be closed
  const duplicateIds = new Set();

  for (const group of groupedByUrl.values()) {
    if (group.length < 2) continue;

    const protectedTabs = group.filter(tab => isProtected(tab, settings));
    const unprotectedTabs = group.filter(tab => !isProtected(tab, settings));

    if (unprotectedTabs.length === 0) continue;

    if (protectedTabs.length > 0) {
      // Close all unprotected duplicates when protected tabs exist
      for (const tab of unprotectedTabs) duplicateIds.add(tab.id);
    } else {
      // Keep first unprotected tab, close the rest
      for (const tab of unprotectedTabs.slice(1)) duplicateIds.add(tab.id);
    }
  }

  // Apply last-tab-in-window safety via filterClosableTabs (R7.1)
  const toClose = filterClosableTabs(tabs, settings, tab => duplicateIds.has(tab.id));

  const count = toClose.length;
  const message = count > 0
    ? `Closed ${count} duplicate tab${count === 1 ? '' : 's'}`
    : 'No duplicate tabs found';

  return { toClose, message };
}

// ---- Duplicate-tab prevention (R14) ----------------------------------------
// Pure rules for judging a brand-new tab. The service (duplicate-service.js)
// records what it saw and acts on the verdict. Timings are in docs/design.md.

export const DUPE_NEW_TAB_CAP_MS = 15 * 1000;      // a tab stops being "new" this long after creation
export const DUPE_COMPLETE_GRACE_MS = 3 * 1000;    // ...or this long after its first http(s) load completes
export const DUPE_DOUBLE_FIRE_MS = 1000;           // copies created this close together are one click
export const DUPE_KEEP_MS = 60 * 1000;             // a page TabVacuum closed may be reopened and kept
export const DUPE_STARTUP_QUIET_MS = 10 * 1000;    // ignore tabs created this long after browser start
export const DUPE_BURST_MS = 1000;                 // a new window's tabs, or a bulk open, within this window
export const DUPE_BULK_COUNT = 3;                  // this many tabs in one window within DUPE_BURST_MS is a bulk open
// A new tab is judged only once no other tab has been created in its window for
// this long (each creation re-arms the wait), and at most DUPE_BURST_MS after
// its own creation. A lone tab is judged after DUPE_SETTLE_MS.
export const DUPE_SETTLE_MS = 200;
export const DUPE_ALLOW_MS = 5 * 1000;             // TabVacuum Search's own opens are kept this long
export const DUPE_MODES = ['switch', 'ask'];
export const DUPE_ASK_MAX = 50; // prompts remembered at once; the oldest is dropped (and its tab simply kept)
const DUPE_NEVER_MAX = 200;

const isWebUrl = url => typeof url === 'string' && /^https?:\/\//i.test(url);
// The first URL a tab reports that is not the browser's placeholder.
const isPlaceholder = url => url === undefined || url === '' || url === 'about:blank';

/**
 * Never-list lines: a /regex/ is a regex; a plain line matches when the URL
 * starts with it or the URL's host equals it.
 */
export function isNeverUrl(url, lines) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* not a URL */ }
  for (const matcher of parseCustomMatchers(lines)) {
    if (typeof matcher === 'string') {
      if (url.startsWith(matcher) || host === matcher.toLowerCase()) return true;
    } else if (matcher.test(url)) return true;
  }
  return false;
}

/** Validates duplicate-prevention settings from a settings message. */
export function validateDuplicateSettings(patch) {
  if ('preventDuplicates' in patch && typeof patch.preventDuplicates !== 'boolean') return 'Prevent duplicate tabs must be on or off.';
  if ('preventDuplicatesMode' in patch && !DUPE_MODES.includes(patch.preventDuplicatesMode)) return 'Unknown duplicate-tab mode.';
  if ('preventDuplicatesNever' in patch) {
    const list = patch.preventDuplicatesNever;
    if (!Array.isArray(list) || list.length > DUPE_NEVER_MAX || !list.every(l => typeof l === 'string' && l.length <= 2000)) {
      return `The never list takes up to ${DUPE_NEVER_MAX} lines.`;
    }
  }
  return null;
}

/** Same page, same container, same private/normal context. */
export const dupeContextKey = tab => `${tab.incognito === true ? 'p' : 'n'}|${tab.cookieStoreId ?? ''}`;
export const dupeKey = (url, tab, settings) => `${dupeContextKey(tab)}|${normalizeUrl(url, settings)}`;

/**
 * What the service records when a tab is created. `ignored` names why the tab
 * is never judged: restored at startup or as a reopened window, part of a bulk
 * open, or created when no record could be trusted.
 */
export function newTabRecord(tab, { now, quietUntil = 0, windowCreatedAt, recent = [] }) {
  const record = { created: now, windowId: tab.windowId, opener: tab.openerTabId, ctx: dupeContextKey(tab) };
  const first = isPlaceholder(tab.pendingUrl) ? (isPlaceholder(tab.url) ? undefined : tab.url) : tab.pendingUrl;
  if (first !== undefined) record.first = first;
  if (now < quietUntil) record.ignored = 'startup';
  else if (tab.discarded === true || tab.status === 'unloaded') record.ignored = 'restored';
  else if (windowCreatedAt !== undefined && now - windowCreatedAt <= DUPE_BURST_MS) record.ignored = 'new-window';
  else if (recent.filter(r => r.windowId === tab.windowId && now - r.created <= DUPE_BURST_MS).length + 1 >= DUPE_BULK_COUNT) record.ignored = 'bulk';
  return record;
}

/** Records the first non-placeholder URL a tab reaches (the opener rule reads it). */
export function noteTabUrl(record, url) {
  if (record.first === undefined && !isPlaceholder(url)) record.first = url;
}

/**
 * When a new tab may first be judged: DUPE_SETTLE_MS after the latest tab
 * created in its window (a per-window debounce), capped at DUPE_BURST_MS after
 * its own creation.
 */
export function settleDeadline(record, records = {}) {
  let last = record.created;
  for (const r of Object.values(records)) {
    if (r && r.windowId === record.windowId && r.created > last && r.created - record.created <= DUPE_BURST_MS) last = r.created;
  }
  return Math.min(record.created + DUPE_BURST_MS, last + DUPE_SETTLE_MS);
}

/** Is a record still inside its new-tab window? */
export function isStillNew(record, now) {
  if (!record || record.ignored || record.done) return false;
  if (now - record.created > DUPE_NEW_TAB_CAP_MS) return false;
  if (record.completedAt !== undefined && now - record.completedAt > DUPE_COMPLETE_GRACE_MS) return false;
  return true;
}

/**
 * Judges one new tab. Returns { action, reason, matchId? } where action is:
 *   'switch' - focus matchId and close this tab
 *   'keep'   - keep this tab; stop judging it
 *   'ignore' - never judge this tab
 *   'wait'   - nothing yet; judge again on its next URL change
 *
 * tab:     the new tab as the browser reports it now (url = committed URL)
 * record:  what the service recorded at creation, or undefined if it missed it
 * tabs:    every tab this worker can see
 * records: id -> record, for tabs that are still new
 * closed:  [{ key, at, created }] pages TabVacuum closed
 * allowed: [{ url, at }] URLs TabVacuum Search is opening
 */
export function judgeNewTab({ tab, record, tabs, records = {}, closed = [], allowed = [], settings, now }) {
  if (!settings.preventDuplicates) return { action: 'ignore', reason: 'off' };
  // A tab with no creation record already existed (or was created while the
  // worker could not see it): it may have back history, so it is never closed.
  if (!record) return { action: 'ignore', reason: 'unknown' };
  if (record.ignored) return { action: 'ignore', reason: record.ignored };
  if (!isStillNew(record, now)) return { action: 'ignore', reason: 'not-new' };
  // Chromium can commit the first tab of a bulk open before the rest of the
  // burst exists, so no tab is judged until its window has been quiet for
  // DUPE_SETTLE_MS (or DUPE_BURST_MS has passed); the service judges it again then.
  if (now < settleDeadline(record, records)) return { action: 'wait', reason: 'settling' };
  // Judge only the committed URL. Chrome does not offer an uncommitted tab to
  // Reopen Closed Tab, so closing before commit would leave no undo.
  if (!isWebUrl(tab.url)) return { action: 'wait', reason: 'not-web' };
  if (isNeverUrl(tab.url, settings.preventDuplicatesNever)) return { action: 'wait', reason: 'never' };
  // R7.1: the last tab in a window is never closed.
  if (!tabs.some(t => t.windowId === tab.windowId && t.id !== tab.id)) return { action: 'wait', reason: 'alone' };

  const key = dupeKey(tab.url, tab, settings);
  if (allowed.some(a => now - a.at <= DUPE_ALLOW_MS && dupeKey(a.url, tab, settings) === key)) return { action: 'keep', reason: 'search' };

  const matches = tabs.filter(t => {
    if (t.id === tab.id || dupeContextKey(t) !== record.ctx) return false;
    const other = records[t.id];
    const otherNew = isStillNew(other, now);
    // A younger new copy never closes an older one: the older copy wins.
    if (otherNew && (other.created > record.created || (other.created === record.created && t.id > tab.id))) return false;
    // An older copy that is still loading counts by where it is going (Chrome
    // pendingUrl); an established tab navigating away does not count.
    let url = t.url;
    if (t.pendingUrl && t.pendingUrl !== t.url) {
      if (!otherNew) return false;
      url = t.pendingUrl;
    }
    return isWebUrl(url) && dupeKey(url, t, settings) === key;
  });
  if (!matches.length) return { action: 'wait', reason: 'no-match' };
  // Prefer an established tab, then the one in this window, then the oldest.
  const match = matches.sort((a, b) =>
    (isStillNew(records[a.id], now) - isStillNew(records[b.id], now)) ||
    ((b.windowId === tab.windowId) - (a.windowId === tab.windowId)) ||
    (a.id - b.id))[0];

  // Opened from its match on purpose: Duplicate Tab, or a link on the page to
  // the same page. The first URL must already be the match's page, so a tab
  // opened blank from the match (Chrome Ctrl+T) and then typed into still switches.
  if (record.opener !== undefined && matches.some(m => m.id === record.opener) &&
      record.first !== undefined && isWebUrl(record.first) && dupeKey(record.first, tab, settings) === key) {
    return { action: 'keep', reason: 'from-match' };
  }
  // The user brought back a page TabVacuum just closed (Reopen Closed Tab or
  // opening it again), with no lower bound on how soon. Only a tab that already
  // existed when the copy was closed, and was created within a second of it,
  // is excluded: that is one click fired twice, and cannot be a reopen.
  const sameClick = c => record.created < c.at && Math.abs(record.created - c.created) <= DUPE_DOUBLE_FIRE_MS;
  if (closed.some(c => c.key === key && now - c.at <= DUPE_KEEP_MS && !sameClick(c))) {
    return { action: 'keep', reason: 'repeated' };
  }
  return { action: 'switch', reason: 'duplicate', matchId: match.id };
}

// ---- Ask first (R14.11) -------------------------------------------------------

/** What to do with a 'switch' verdict in the user's mode: 'switch' or 'ask'. */
export const dupeAction = settings => (settings.preventDuplicatesMode === 'ask' ? 'ask' : 'switch');

/** Is this URL TabVacuum's own Ask first prompt page? */
export function isAskPageUrl(url, askUrl) {
  if (typeof url !== 'string' || !url.startsWith(askUrl)) return false;
  const next = url[askUrl.length];
  return next === undefined || next === '?' || next === '#';
}

/**
 * Accepts a prompt-page message only from the prompt itself: sent by this
 * extension, from a tab showing the prompt page, about a prompt that exists
 * for that tab. The page names no URL or tab; both come from the stored entry.
 */
export function authorizeAskMessage({ sender, extensionId, askUrl, entries }) {
  const tabId = sender?.tab?.id;
  if (sender?.id !== extensionId || !Number.isSafeInteger(tabId)) return { ok: false, error: 'Not a prompt page.' };
  if (!isAskPageUrl(sender.url, askUrl)) return { ok: false, error: 'Not a prompt page.' };
  const entry = entries?.[tabId];
  return entry ? { ok: true, tabId, entry } : { ok: true, tabId, entry: null };
}

/**
 * Outcome of the user's choice on the prompt. Switch goes ahead only while the
 * open copy still shows the same page in the same context; otherwise the
 * prompt tab gets its page back (there is nothing to switch to).
 *   'switch' - focus entry.matchId and its window, close the prompt tab
 *   'back'   - load the original page in the prompt tab and keep it for good
 */
export function askOutcome({ choice, entry, match, settings }) {
  if (choice !== 'switch' || !entry || !match) return 'back';
  if (dupeContextKey(match) !== entry.ctx || !isWebUrl(match.url)) return 'back';
  return dupeKey(match.url, match, settings) === entry.key ? 'switch' : 'back';
}

/** Adds a prompt entry, dropping the oldest past DUPE_ASK_MAX. Returns the dropped tab IDs. */
export function addAskEntry(entries, tabId, entry) {
  entries[tabId] = entry;
  const ids = Object.keys(entries).sort((a, b) => entries[a].at - entries[b].at);
  const dropped = ids.slice(0, Math.max(0, ids.length - DUPE_ASK_MAX));
  for (const id of dropped) delete entries[id];
  return dropped.map(Number);
}

export function planMerge(windows, targetWindowId) {
  const targetWindow = windows.find(w => w.id === targetWindowId);
  if (!targetWindow) {
    return { moves: [], emptyWindowIds: [], pinnedTabIds: [], message: 'Target window not found' };
  }

  const sourceWindows = windows.filter(w => w.id !== targetWindowId);
  if (sourceWindows.length === 0) {
    return { moves: [], emptyWindowIds: [], pinnedTabIds: [], message: 'Only one window open' };
  }

  const moves = [];
  const emptyWindowIds = [];
  const pinnedTabIds = [];
  let totalMoved = 0;

  // Collect pinned and unpinned tabs separately from source windows
  for (const sourceWindow of sourceWindows) {
    const pinned = sourceWindow.tabs.filter(tab => tab.pinned);
    const unpinned = sourceWindow.tabs.filter(tab => !tab.pinned);

    if (pinned.length > 0) {
      const ids = pinned.map(tab => tab.id);
      moves.push({ tabIds: ids, windowId: targetWindowId, index: 0 });
      pinnedTabIds.push(...ids);
      totalMoved += ids.length;
    }

    if (unpinned.length > 0) {
      const ids = unpinned.map(tab => tab.id);
      moves.push({ tabIds: ids, windowId: targetWindowId, index: -1 });
      totalMoved += ids.length;
    }

    emptyWindowIds.push(sourceWindow.id);
  }

  const totalWindows = sourceWindows.length + 1;
  const totalTabs = targetWindow.tabs.length + totalMoved;
  const message = `Merged ${totalWindows} windows (${totalTabs} tabs)`;

  return { moves, emptyWindowIds, pinnedTabIds, message };
}

export function computeFrecency(visitCount, lastVisitTime, now) {
  if (!visitCount || !lastVisitTime) return 0;
  const ageMs = now - lastVisitTime;
  const ageHours = ageMs / (1000 * 60 * 60);

  let recency;
  if (ageHours < 24) recency = 1.0;
  else if (ageHours < 24 * 7) recency = 0.7;
  else if (ageHours < 24 * 30) recency = 0.4;
  else recency = 0.1;

  return visitCount * recency;
}

export function planSort(tabs, criteria, direction) {
  const pinned = tabs.filter(tab => tab.pinned);
  const unpinned = tabs.filter(tab => !tab.pinned);

  const sorted = [...unpinned].sort((a, b) => {
    let comparison = 0;

    if (criteria === 'url') {
      comparison = (a.url || '').localeCompare(b.url || '');
    } else if (criteria === 'title') {
      comparison = (a.title || '').localeCompare(b.title || '');
    } else if (criteria === 'lastAccessed') {
      comparison = (a.lastAccessed || 0) - (b.lastAccessed || 0);
    } else if (criteria === 'visitCount') {
      comparison = (a.visitCount || 0) - (b.visitCount || 0);
    } else if (criteria === 'frecency') {
      comparison = (a.frecency || 0) - (b.frecency || 0);
    }

    return direction === 'desc' ? -comparison : comparison;
  });

  const startIndex = pinned.length;
  const moves = sorted.map((tab, index) => ({
    tabId: tab.id,
    index: startIndex + index
  }));

  const criteriaLabels = {
    url: 'URL',
    title: 'title',
    lastAccessed: 'last accessed',
    visitCount: 'visit count',
    frecency: 'frecency',
  };

  const count = unpinned.length;
  const label = criteriaLabels[criteria] || criteria;
  const message = `Sorted ${count} tab${count === 1 ? '' : 's'} by ${label}`;

  return { moves, message };
}
