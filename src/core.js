// core.js — Pure functions for TabVacuum

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
  };

  const count = unpinned.length;
  const label = criteriaLabels[criteria] || criteria;
  const message = `Sorted ${count} tab${count === 1 ? '' : 's'} by ${label}`;

  return { moves, message };
}

export function findStaleTabs(tabs, settings) {
  const now = Date.now();
  const threshold = settings.staleThresholdMs || 7 * 24 * 60 * 60 * 1000;

  // Group tabs by window to prevent closing the last tab
  const tabsByWindow = new Map();
  for (const tab of tabs) {
    const windowTabs = tabsByWindow.get(tab.windowId) || [];
    windowTabs.push(tab);
    tabsByWindow.set(tab.windowId, windowTabs);
  }

  const toClose = [];

  for (const tab of tabs) {
    if (isProtected(tab, settings)) continue;
    if (now - (tab.lastAccessed || 0) < threshold) continue;

    // Ensure at least one tab remains in the window
    const windowTabs = tabsByWindow.get(tab.windowId);
    const remainingTabs = windowTabs.filter(
      t => !toClose.includes(t.id) && t.id !== tab.id
    );
    if (remainingTabs.length === 0) continue;

    toClose.push(tab.id);
  }

  const days = Math.round(threshold / (24 * 60 * 60 * 1000));
  const count = toClose.length;

  const message = count > 0
    ? `Closed ${count} tab${count === 1 ? '' : 's'} not accessed in ${days} day${days === 1 ? '' : 's'}`
    : 'No stale tabs found';

  return { toClose, message };
}
