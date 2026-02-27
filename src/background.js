// background.js — Wiring layer for TabVacuum
import './polyfill.js';
import { findDuplicates, planMerge, planSort, findStaleTabs, computeFrecency } from './core.js';

const DEFAULTS = {
  staleThresholdMs: 7 * 24 * 60 * 60 * 1000,
  ignoreFragments: false,
  ignoreQueryParams: false,
  skipPinned: true,
  skipAudible: true,
  lastSortCriteria: 'url',
  lastSortDirection: 'asc',
};

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(settings) {
  await browser.storage.local.set(settings);
  return { message: 'Settings saved' };
}

function notify(message) {
  browser.notifications.create({
    type: 'basic',
    title: 'TabVacuum',
    message,
    iconUrl: 'icons/icon-96.png',
  });
}

async function closeDuplicates() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const { toClose, message } = findDuplicates(tabs, settings);
  if (toClose.length) await browser.tabs.remove(toClose);
  return { message };
}

async function mergeWindows() {
  const windows = await browser.windows.getAll({ populate: true });
  const focused = await browser.windows.getCurrent();
  const { moves, emptyWindowIds, message } = planMerge(windows, focused.id);

  for (const move of moves) {
    await browser.tabs.move(move.tabIds, {
      windowId: move.windowId,
      index: move.index
    });
  }

  for (const windowId of emptyWindowIds) {
    // Windows may already be closed if they had no tabs
    try {
      await browser.windows.remove(windowId);
    } catch {
      // Ignore errors from already-closed windows
    }
  }

  return { message };
}

async function sortTabs(criteria, direction) {
  const settings = await getSettings();
  criteria = criteria || settings.lastSortCriteria;
  direction = direction || settings.lastSortDirection;

  await saveSettings({
    lastSortCriteria: criteria,
    lastSortDirection: direction
  });

  const tabs = await browser.tabs.query({ currentWindow: true });

  // Enrich tabs with history data when needed
  if (criteria === 'visitCount' || criteria === 'frecency') {
    const now = Date.now();
    for (const tab of tabs) {
      try {
        const results = await browser.history.search({
          text: tab.url,
          maxResults: 1
        });
        const item = results[0];
        tab.visitCount = item?.visitCount || 0;
        if (criteria === 'frecency') {
          tab.frecency = computeFrecency(item?.visitCount || 0, item?.lastVisitTime || 0, now);
        }
      } catch {
        tab.visitCount = 0;
        tab.frecency = 0;
      }
    }
  }

  const { moves, message } = planSort(tabs, criteria, direction);

  for (const move of moves) {
    await browser.tabs.move(move.tabId, { index: move.index });
  }

  return { message };
}

async function closeStaleTabs() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const { toClose, message } = findStaleTabs(tabs, settings);
  if (toClose.length) await browser.tabs.remove(toClose);
  return { message };
}

// Message handler for popup and options pages
browser.runtime.onMessage.addListener((message) => {
  const handlers = {
    closeDuplicates,
    mergeWindows,
    closeStaleTabs,
    getSettings,
    sortTabs: () => sortTabs(message.criteria, message.direction),
    saveSettings: () => saveSettings(message.settings)
  };

  const handler = handlers[message.command];
  return handler ? handler() : undefined;
});

// Register context menus on install
browser.runtime.onInstalled.addListener(() => {
  const menus = browser.contextMenus;
  const tabContext = ['tab'];

  menus.create({ id: 'tv-dupes', title: 'Close Duplicate Tabs', contexts: tabContext });
  menus.create({ id: 'tv-merge', title: 'Merge All Windows', contexts: tabContext });
  menus.create({ id: 'tv-sort', title: 'Sort Tabs', contexts: tabContext });
  menus.create({ id: 'tv-sort-url', parentId: 'tv-sort', title: 'by URL', contexts: tabContext });
  menus.create({ id: 'tv-sort-title', parentId: 'tv-sort', title: 'by Title', contexts: tabContext });
  menus.create({ id: 'tv-sort-last', parentId: 'tv-sort', title: 'by Last Accessed', contexts: tabContext });
  menus.create({ id: 'tv-sort-visit', parentId: 'tv-sort', title: 'by Visit Count', contexts: tabContext });
  menus.create({ id: 'tv-sort-frecency', parentId: 'tv-sort', title: 'by Frecency', contexts: tabContext });
  menus.create({ id: 'tv-stale', title: 'Close Stale Tabs', contexts: tabContext });
});

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info) => {
  const menuActions = {
    'tv-dupes': closeDuplicates,
    'tv-merge': mergeWindows,
    'tv-sort-url': () => sortTabs('url', 'asc'),
    'tv-sort-title': () => sortTabs('title', 'asc'),
    'tv-sort-last': () => sortTabs('lastAccessed', 'asc'),
    'tv-sort-visit': () => sortTabs('visitCount', 'asc'),
    'tv-sort-frecency': () => sortTabs('frecency', 'asc'),
    'tv-stale': closeStaleTabs
  };

  const action = menuActions[info.menuItemId];
  if (action) {
    const result = await action();
    notify(result.message);
  }
});

// Handle keyboard shortcuts
browser.commands.onCommand.addListener(async (command) => {
  const commandActions = {
    'close-duplicates': closeDuplicates,
    'merge-windows': mergeWindows,
    'sort-tabs': sortTabs,
    'close-stale': closeStaleTabs
  };

  const action = commandActions[command];
  if (action) {
    const result = await action();
    notify(result.message);
  }
});
