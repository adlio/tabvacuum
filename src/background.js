// background.js — Wiring layer for TabVacuum
import './polyfill.js';
import { findDuplicates, planMerge, planSort, findBlankTabs, computeFrecency } from './core.js';

import { createSearchService } from './search-service.js';
import { createSearchLauncher } from './search-launcher.js';
import { createStaleService, OPEN_FAILED } from './stale-service.js';

const search = createSearchService(browser);
search.installFocusTracking();
const launcher = createSearchLauncher(browser, search);
launcher.installCleanup();

function openSearch(tab) {
  return launcher.launch(tab).catch(() => {
    const message = "Could not open Search tabs. Try again from the Aaron's Tab Vacuum menu. For private windows, check that ATV is allowed to run there.";
    notify(message).catch(() => {});
    return { error: message };
  });
}

const DEFAULTS = {
  searchScope: 'all',
  staleThresholdMs: 7 * 24 * 60 * 60 * 1000,
  autoCloseStaleEnabled: false,
  ignoreFragments: false,
  ignoreQueryParams: false,
  skipPinned: true,
  skipAudible: true,
  lastSortCriteria: 'url',
  lastSortDirection: 'asc',
  blankNewTab: true,
  blankWelcome: true,
  blankSearchEngines: true,
  blankCustomUrls: [],
};

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// Every settings write, Settings page included, goes through the stale
// service's gate, which validates stale-rule fields and reconciles the schedule.
function saveSettings(settings, windowId) {
  return stale.saveSettings(settings, { windowId, generalKeys: Object.keys(DEFAULTS) });
}

async function notify(message) {
  await browser.notifications.create({
    type: 'basic',
    title: "Aaron's Tab Vacuum",
    message,
    iconUrl: 'icons/icon-96.png',
  });
}

const errorText = err => String(err?.message ?? err ?? 'Unknown error');

const stale = createStaleService(browser, { notify });
stale.install();

// Keyboard and context-menu entry: open the toolbar menu with Stale Tabs
// expanded. Called synchronously from the listener so the user gesture is
// still valid. Never closes tabs or opens another window.
function openStaleControls(tab) {
  return stale.openControls(tab).then(result => {
    if (result.error) return notify(OPEN_FAILED).catch(() => {});
  });
}

// Runs a tab action and reports its outcome in exactly one system
// notification, whichever surface started it (R6.4). Never rejects: an action
// failure stays `error`; a notification failure after completed work is
// reported separately so the completed tab change is not presented as failed.
async function runAction(action) {
  let result;
  try {
    result = await action();
  } catch (err) {
    const error = errorText(err);
    result = { error, message: `Error: ${error}` };
  }
  try {
    await notify(result.message);
  } catch (err) {
    return { ...result, notificationError: errorText(err) };
  }
  return result;
}

async function closeMatchingTabs(findFn) {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const { toClose, message } = findFn(tabs, settings);
  if (toClose.length) await browser.tabs.remove(toClose);
  return { message };
}

const closeDuplicates = () => closeMatchingTabs(findDuplicates);

async function mergeWindows() {
  const windows = await browser.windows.getAll({ populate: true });
  const focused = await browser.windows.getCurrent();
  const { moves, emptyWindowIds, pinnedTabIds, message } = planMerge(windows, focused.id);

  for (const move of moves) {
    await browser.tabs.move(move.tabIds, {
      windowId: move.windowId,
      index: move.index
    });
  }

  // Restore pinned state for tabs that were pinned in their source window
  for (const tabId of pinnedTabIds) {
    await browser.tabs.update(tabId, { pinned: true });
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

const closeBlankTabs = () => closeMatchingTabs(findBlankTabs);

// Message handler for popup and options pages
// Uses sendResponse callback pattern for Chrome compatibility.
// Returning a Promise from onMessage only works in Chrome 144+ natively;
// older Chrome versions require sendResponse + return true for async responses.
//
// Search commands authorize themselves by launch token. Everything else is
// accepted only from the extension's own menu and settings pages, never from
// content scripts or the search page embedded in websites.
const trustedPages = new Set(['popup.html', 'options.html'].map(page => browser.runtime.getURL(page)));
const isTrustedPage = sender => sender.id === browser.runtime.id &&
  trustedPages.has(String(sender.url ?? '').split(/[?#]/, 1)[0]);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const searching = launcher.handleMessage(message, sender);
  if (searching) {
    searching
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message, message: `Error: ${err.message}` }));
    return true;
  }
  if (!isTrustedPage(sender)) return;

  const handlers = {
    launchSearch: () => openSearch(),
    closeDuplicates: () => runAction(closeDuplicates),
    mergeWindows: () => runAction(mergeWindows),
    closeBlankTabs: () => runAction(closeBlankTabs),
    getSettings,
    sortTabs: () => runAction(() => sortTabs(message.criteria, message.direction)),
    saveSettings: () => saveSettings(message.settings, message.windowId),
    getStaleState: () => stale.getState(message.windowId),
    setStaleRule: () => stale.saveSettings(message.settings, { windowId: message.windowId, staleOnly: true }),
    closeStalePreview: () => runAction(() => stale.closePreview(message.windowId, message.previewId)),
    staleEditor: () => stale.editor(message.windowId, message.editorId, message.open),
    consumeStaleIntent: () => stale.consumeIntent(message.windowId),
  };

  if (!Object.hasOwn(handlers, message?.command)) return;
  const handler = handlers[message.command];

  // The reply is sent only after the action and its notification settle. The
  // work itself does not depend on delivery: a dismissed popup just drops it.
  handler()
    .catch(err => ({ error: errorText(err), message: `Error: ${errorText(err)}` }))
    .then(result => {
      try { sendResponse(result); } catch { /* caller is gone */ }
    });
  return true; // keep message channel open for async sendResponse
});

// Register context menus on install
browser.runtime.onInstalled.addListener(() => {
  const menus = browser.contextMenus;
  const tabContext = browser.runtime.getURL('').startsWith('moz-extension:') ? ['tab'] : ['action'];

  menus.create({ id: 'tv-dupes', title: 'Close Duplicate Tabs', contexts: tabContext });
  menus.create({ id: 'tv-merge', title: 'Merge All Windows', contexts: tabContext });
  menus.create({ id: 'tv-sort', title: 'Sort Tabs', contexts: tabContext });
  menus.create({ id: 'tv-sort-url', parentId: 'tv-sort', title: 'by URL', contexts: tabContext });
  menus.create({ id: 'tv-sort-title', parentId: 'tv-sort', title: 'by Title', contexts: tabContext });
  menus.create({ id: 'tv-sort-last', parentId: 'tv-sort', title: 'by Last Accessed', contexts: tabContext });
  menus.create({ id: 'tv-sort-visit', parentId: 'tv-sort', title: 'by Visit Count', contexts: tabContext });
  menus.create({ id: 'tv-sort-frecency', parentId: 'tv-sort', title: 'by Frecency', contexts: tabContext });
  menus.create({ id: 'tv-stale', title: 'Review Stale Tabs…', contexts: tabContext });
  menus.create({ id: 'tv-blank', title: 'Close Blank Tabs', contexts: tabContext });
});

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tv-stale') {
    await openStaleControls(tab);
    return;
  }
  const menuActions = {
    'tv-dupes': closeDuplicates,
    'tv-merge': mergeWindows,
    'tv-sort-url': () => sortTabs('url', 'asc'),
    'tv-sort-title': () => sortTabs('title', 'asc'),
    'tv-sort-last': () => sortTabs('lastAccessed', 'desc'),
    'tv-sort-visit': () => sortTabs('visitCount', 'desc'),
    'tv-sort-frecency': () => sortTabs('frecency', 'desc'),
    'tv-blank': closeBlankTabs
  };

  const action = menuActions[info.menuItemId];
  if (action) await runAction(action);
});

// Handle keyboard shortcuts
browser.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'close-stale') {
    await openStaleControls(tab);
    return;
  }
  if (command === 'search-tabs') {
    // The command grants activeTab for the tab that was active when pressed.
    await openSearch(tab);
    return;
  }
  const commandActions = {
    'close-duplicates': closeDuplicates,
    'merge-windows': mergeWindows,
    'sort-tabs': sortTabs,
    'close-blank': closeBlankTabs
  };

  const action = commandActions[command];
  // Called with no arguments so the shortcut sort uses the saved criteria.
  if (action) await runAction(() => action());
});
