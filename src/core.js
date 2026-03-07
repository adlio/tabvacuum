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

  const toClose = [];

  for (const group of groupedByUrl.values()) {
    if (group.length < 2) continue;

    const protectedTabs = group.filter(tab => isProtected(tab, settings));
    const unprotectedTabs = group.filter(tab => !isProtected(tab, settings));

    if (unprotectedTabs.length === 0) continue;

    if (protectedTabs.length > 0) {
      // Close all unprotected duplicates when protected tabs exist
      toClose.push(...unprotectedTabs.map(tab => tab.id));
    } else {
      // Keep first unprotected tab, close the rest
      toClose.push(...unprotectedTabs.slice(1).map(tab => tab.id));
    }
  }

  const count = toClose.length;
  const message = count > 0
    ? `Closed ${count} duplicate tab${count === 1 ? '' : 's'}`
    : 'No duplicate tabs found';

  return { toClose, message };
}

export function planMerge(windows, targetWindowId) {
  const targetWindow = windows.find(w => w.id === targetWindowId);
  if (!targetWindow) {
    return { moves: [], emptyWindowIds: [], message: 'Target window not found' };
  }

  const sourceWindows = windows.filter(w => w.id !== targetWindowId);
  if (sourceWindows.length === 0) {
    return { moves: [], emptyWindowIds: [], message: 'Only one window open' };
  }

  let currentIndex = targetWindow.tabs.length;
  const moves = [];
  const emptyWindowIds = [];
  let totalMoved = 0;

  for (const sourceWindow of sourceWindows) {
    const tabIds = sourceWindow.tabs.map(tab => tab.id);
    if (tabIds.length > 0) {
      moves.push({ tabIds, windowId: targetWindowId, index: currentIndex });
      totalMoved += tabIds.length;
      currentIndex += tabIds.length;
    }
    emptyWindowIds.push(sourceWindow.id);
  }

  const totalWindows = sourceWindows.length + 1;
  const totalTabs = targetWindow.tabs.length + totalMoved;
  const message = `Merged ${totalWindows} windows (${totalTabs} tabs)`;

  return { moves, emptyWindowIds, message };
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
      // Most recent first for ascending
      comparison = (b.lastAccessed || 0) - (a.lastAccessed || 0);
    } else if (criteria === 'visitCount') {
      // Most visited first for ascending
      comparison = (b.visitCount || 0) - (a.visitCount || 0);
    } else if (criteria === 'frecency') {
      // Highest frecency first for ascending
      comparison = (b.frecency || 0) - (a.frecency || 0);
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

export function findStaleTabs(tabs, settings) {
  const now = Date.now();
  const threshold = settings.staleThresholdMs || 7 * 24 * 60 * 60 * 1000;

  const toClose = filterClosableTabs(tabs, settings, tab =>
    now - (tab.lastAccessed || 0) >= threshold
  );

  const days = Math.round(threshold / (24 * 60 * 60 * 1000));
  const count = toClose.length;

  const message = count > 0
    ? `Closed ${count} tab${count === 1 ? '' : 's'} not accessed in ${days} day${days === 1 ? '' : 's'}`
    : 'No stale tabs found';

  return { toClose, message };
}
