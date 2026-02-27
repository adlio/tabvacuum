// background.js — Wiring layer for TabVacuum
import { findDuplicates, planMerge, planSort, findStaleTabs } from './core.js';

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

  // Add visit count data when needed
  if (criteria === 'visitCount') {
    for (const tab of tabs) {
      try {
        const results = await browser.history.search({
          text: tab.url,
          maxResults: 1
        });
        tab.visitCount = results[0]?.visitCount || 0;
      } catch {
        tab.visitCount = 0;
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

// Message listener — popup and options pages communicate here
browser.runtime.onMessage.addListener((msg) => {
  switch (msg.command) {
    case 'closeDuplicates': return closeDuplicates();
    case 'mergeWindows': return mergeWindows();
    case 'sortTabs': return sortTabs(msg.criteria, msg.direction);
    case 'closeStaleTabs': return closeStaleTabs();
    case 'getSettings': return getSettings();
    case 'saveSettings': return saveSettings(msg.settings);
  }
});

// Context menus — registered on install
browser.runtime.onInstalled.addListener(() => {
  const menuApi = browser.contextMenus;
  menuApi.create({ id: 'tv-dupes', title: 'Close Duplicate Tabs', contexts: ['tab'] });
  menuApi.create({ id: 'tv-merge', title: 'Merge All Windows', contexts: ['tab'] });
  menuApi.create({ id: 'tv-sort', title: 'Sort Tabs', contexts: ['tab'] });
  menuApi.create({ id: 'tv-sort-url', parentId: 'tv-sort', title: 'by URL', contexts: ['tab'] });
  menuApi.create({ id: 'tv-sort-title', parentId: 'tv-sort', title: 'by Title', contexts: ['tab'] });
  menuApi.create({ id: 'tv-sort-last', parentId: 'tv-sort', title: 'by Last Accessed', contexts: ['tab'] });
  menuApi.create({ id: 'tv-sort-visit', parentId: 'tv-sort', title: 'by Visit Count', contexts: ['tab'] });
  menuApi.create({ id: 'tv-stale', title: 'Close Stale Tabs', contexts: ['tab'] });
});

// Context menu click handler
browser.contextMenus.onClicked.addListener(async (info) => {
  let result;
  switch (info.menuItemId) {
    case 'tv-dupes': result = await closeDuplicates(); break;
    case 'tv-merge': result = await mergeWindows(); break;
    case 'tv-sort-url': result = await sortTabs('url', 'asc'); break;
    case 'tv-sort-title': result = await sortTabs('title', 'asc'); break;
    case 'tv-sort-last': result = await sortTabs('lastAccessed', 'asc'); break;
    case 'tv-sort-visit': result = await sortTabs('visitCount', 'asc'); break;
    case 'tv-stale': result = await closeStaleTabs(); break;
  }
  if (result) notify(result.message);
});

// Keyboard shortcut handler
browser.commands.onCommand.addListener(async (command) => {
  let result;
  switch (command) {
    case 'close-duplicates': result = await closeDuplicates(); break;
    case 'merge-windows': result = await mergeWindows(); break;
    case 'sort-tabs': result = await sortTabs(); break; // uses last-selected criteria
    case 'close-stale': result = await closeStaleTabs(); break;
  }
  if (result) notify(result.message);
});
