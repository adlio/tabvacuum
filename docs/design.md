# TabVacuum - Design Document

## Architecture

TabVacuum is a cross-browser Manifest V3 WebExtension (R8.1-R8.2). Core logic lives in
pure functions that are unit-testable without a browser. Thin wiring layers call browser
APIs and delegate to the core functions. A minimal build step assembles browser-specific
distributions.

## Cross-Browser Strategy (R8.2-R8.5)

### API Namespace

All source code uses the `browser.*` namespace. Chrome compatibility is provided by
[webextension-polyfill](https://github.com/nicedoc/webextension-polyfill), which maps
`browser.*` (with Promises) to Chrome's `chrome.*` API.

### Background Execution

Firefox MV3 supports background scripts (event pages). Chrome MV3 requires service
workers. The core logic is identical; only the manifest `background` key differs:

- **Firefox**: `"background": { "scripts": ["browser-polyfill.js", "background.js"] }`
- **Chrome**: `"background": { "service_worker": "background.js" }` (polyfill bundled)

### Manifest Files

Two manifest files share all fields except `background` and `browser_specific_settings`:

- `src/manifest.firefox.json` — includes `browser_specific_settings.gecko`
- `src/manifest.chrome.json` — includes `service_worker` background

The build script copies the appropriate manifest to `dist/<browser>/manifest.json`.

## File Tree

```
tabvacuum/
  src/
    manifest.firefox.json
    manifest.chrome.json
    background.js           ← Wiring: message listener, menus, commands, notifications
    core.js                 ← Pure functions: all tab operation logic
    popup.html
    popup.js
    popup.css
    options.html
    options.js
    options.css
    icons/
      icon-48.png
      icon-96.png
  test/
    core.test.js            ← Vitest unit tests for core.js
    mocks/
      browser.js            ← Manual browser API mock
  scripts/
    build.js                ← Assembles dist/firefox/ and dist/chrome/
  dist/                     ← Build output (gitignored)
    firefox/
    chrome/
  docs/
    prd.md
    design.md
    tasks.md
  .github/
    workflows/
      ci.yml                ← PR checks: lint + test
      release.yml           ← Tag-triggered: build, GitHub Release, publish to stores
  package.json              ← Vitest, web-ext, chrome-webstore-upload-cli
  vitest.config.js
  AGENTS.md
  README.md
```

## Manifest (R8.1)

Firefox example (Chrome is identical except `background` and no `browser_specific_settings`):

```json
{
  "manifest_version": 3,
  "name": "TabVacuum",
  "version": "0.1.0",
  "description": "Power-user tab cleanup: close duplicates, merge windows, sort tabs, prune stale tabs.",
  "permissions": ["tabs", "history", "notifications", "storage", "contextMenus"],
  "action": {
    "default_popup": "popup.html",
    "default_icon": { "48": "icons/icon-48.png", "96": "icons/icon-96.png" }
  },
  "options_ui": { "page": "options.html" },
  "background": { "scripts": ["browser-polyfill.js", "background.js"] },
  "browser_specific_settings": {
    "gecko": { "id": "tabvacuum@adlio" }
  },
  "commands": {
    "close-duplicates": {
      "suggested_key": { "default": "Alt+Shift+D" },
      "description": "Close duplicate tabs"
    },
    "merge-windows": {
      "suggested_key": { "default": "Alt+Shift+M" },
      "description": "Merge all windows"
    },
    "sort-tabs": {
      "suggested_key": { "default": "Alt+Shift+S" },
      "description": "Sort tabs"
    },
    "close-stale": {
      "suggested_key": { "default": "Alt+Shift+X" },
      "description": "Close stale tabs"
    }
  }
}
```

### Permissions Rationale

| Permission | Why |
|---|---|
| `tabs` | Access `tab.url`, `tab.title`, `tab.lastAccessed` (R1-R4) |
| `history` | Access `visitCount` for sort-by-visit-count (R3.1d) |
| `contextMenus` | Tab context menu (R6.2). Chrome uses `contextMenus`; Firefox supports both `contextMenus` and `menus` |
| `notifications` | Feedback when triggered via shortcut/context menu (R6.4) |
| `storage` | Persist user settings (R5.3) |

## Module Design

### core.js — Pure Functions (R9.1)

All business logic lives here. Functions accept data (arrays of tab objects, settings
objects) and return results. They never call `browser.*` directly. This makes them
trivially unit-testable.

```js
// core.js exports:

export function findDuplicates(tabs, settings)
// Input: array of tab objects, settings
// Returns: { toClose: number[], message: string }

export function planMerge(windows, targetWindowId)
// Input: array of window objects (with tabs), target window ID
// Returns: { moves: [{tabIds, windowId, index}], emptyWindowIds: number[], message: string }

export function planSort(tabs, criteria, direction)
// Input: array of tab objects, criteria string, direction string
// Returns: { moves: [{tabId, index}], message: string }
// For visitCount criteria, caller must enrich tabs with visitCount before calling

export function findStaleTabs(tabs, settings)
// Input: array of tab objects, settings (with staleThresholdMs)
// Returns: { toClose: number[], message: string }

export function isProtected(tab, settings)
// Input: single tab object, settings
// Returns: boolean

export function normalizeUrl(url, settings)
// Input: URL string, settings
// Returns: normalized URL string
```

### background.js — Wiring Layer

Calls browser APIs, passes data to core.js functions, executes the returned plans.

```js
import { findDuplicates, planMerge, planSort, findStaleTabs } from './core.js';

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
  for (const m of moves) await browser.tabs.move(m.tabIds, { windowId: m.windowId, index: m.index });
  for (const id of emptyWindowIds) await browser.windows.remove(id);
  return { message };
}
```

**Settings** — loads defaults, merges with `browser.storage.local`:

```js
const DEFAULTS = {
  staleThresholdMs: 7 * 24 * 60 * 60 * 1000,
  ignoreFragments: false,
  ignoreQueryParams: false,
  skipPinned: true,
  skipAudible: true,
  lastSortCriteria: "url",
  lastSortDirection: "asc",
};
```

**Message listener** — popup and options pages communicate via `browser.runtime.sendMessage`:

```js
browser.runtime.onMessage.addListener((msg) => {
  switch (msg.command) {
    case "closeDuplicates": return closeDuplicates();
    case "mergeWindows":    return mergeWindows();
    case "sortTabs":        return sortTabs(msg.criteria, msg.direction);
    case "closeStaleTabs":  return closeStaleTabs();
    case "getSettings":     return getSettings();
    case "saveSettings":    return saveSettings(msg.settings);
  }
});
```

**Context menus** (R6.2) — registered on install. Both browsers auto-group multiple
items under the extension name:

```js
const menuApi = browser.contextMenus || browser.menus;
menuApi.create({ id: "tv-dupes",  title: "Close Duplicate Tabs", contexts: ["tab"] });
menuApi.create({ id: "tv-merge",  title: "Merge All Windows",    contexts: ["tab"] });
menuApi.create({ id: "tv-sort",   title: "Sort Tabs",            contexts: ["tab"] });
menuApi.create({ id: "tv-sort-url",    parentId: "tv-sort", title: "by URL",           contexts: ["tab"] });
menuApi.create({ id: "tv-sort-title",  parentId: "tv-sort", title: "by Title",         contexts: ["tab"] });
menuApi.create({ id: "tv-sort-last",   parentId: "tv-sort", title: "by Last Accessed", contexts: ["tab"] });
menuApi.create({ id: "tv-sort-visit",  parentId: "tv-sort", title: "by Visit Count",   contexts: ["tab"] });
menuApi.create({ id: "tv-stale",  title: "Close Stale Tabs",     contexts: ["tab"] });
```

**Notifications** (R6.4):

```js
function notify(message) {
  browser.notifications.create({ type: "basic", title: "TabVacuum", message });
}
```

### popup.html / popup.js

Minimal HTML with four action buttons and a sort-criteria dropdown with direction
toggle. JS sends messages to background and displays the returned `message` string
in a status area. ~50 lines of HTML, ~50 lines of JS.

### options.html / options.js

Form fields bound to settings from R5.2. On change, sends `saveSettings` message to
background. On load, sends `getSettings` to populate form. ~40 lines of HTML, ~30 lines of JS.

## Data Flow

```
User action (popup button / context menu / keyboard shortcut)
  → background.js receives command
  → loads current settings from storage
  → queries tabs/windows via browser APIs
  → calls core.js pure function with data + settings
  → core.js returns plan (IDs to close, moves to make, message)
  → background.js executes plan via browser APIs
  → returns { message } to caller
  → UI displays message (popup status area or notification)
```

## Testing Strategy (R9)

### Unit Tests (Vitest)

All `core.js` functions are pure and testable without browser mocks:

```js
// test/core.test.js
import { findDuplicates, isProtected, normalizeUrl } from '../src/core.js';

test('findDuplicates closes newer duplicate', () => {
  const tabs = [
    { id: 1, url: 'https://example.com', active: false, pinned: false, audible: false },
    { id: 2, url: 'https://example.com', active: false, pinned: false, audible: false },
  ];
  const { toClose } = findDuplicates(tabs, { ignoreFragments: false, ignoreQueryParams: false, skipPinned: true, skipAudible: true });
  expect(toClose).toEqual([2]);
});
```

For `background.js` wiring (message listener, context menus), a manual mock of
`browser.*` is provided at `test/mocks/browser.js`. This is a lightweight object with
`vi.fn()` stubs for the APIs we use, following Google's recommended approach.

### Linting

`web-ext lint --source-dir dist/firefox/` validates manifest structure, permissions, and
common errors. Runs in CI (R9.3).

## Build Script (R8.5)

`scripts/build.js` (Node.js, no dependencies beyond `fs`):

1. Creates `dist/firefox/` and `dist/chrome/`
2. Copies all `src/` files (except manifests) into both directories
3. Copies `src/manifest.firefox.json` → `dist/firefox/manifest.json`
4. Copies `src/manifest.chrome.json` → `dist/chrome/manifest.json`
5. Downloads or copies `webextension-polyfill` into both dist directories

## CI/CD (R10)

### ci.yml — PR Checks

Triggers on pull requests. Runs:
1. `npm ci`
2. `npx vitest run` (unit tests)
3. `node scripts/build.js` (verify build succeeds)
4. `npx web-ext lint --source-dir dist/firefox/`

### release.yml — Tag-Triggered Release

Triggers on `v*` tags. Runs:
1. All CI checks
2. `node scripts/build.js`
3. Zips `dist/firefox/` and `dist/chrome/`
4. Creates GitHub Release with both zips attached
5. Publishes to Firefox Add-ons via `web-ext sign` (R10.1)
6. Publishes to Chrome Web Store via `chrome-webstore-upload-cli` (R10.2)

### Required GitHub Secrets

| Secret | Environment | Purpose |
|---|---|---|
| `WEB_EXT_API_KEY` | Firefox | AMO API key |
| `WEB_EXT_API_SECRET` | Firefox | AMO API secret |
| `CHROME_EXTENSION_ID` | Chrome | Chrome Web Store extension ID |
| `CHROME_CLIENT_ID` | Chrome | Google OAuth2 client ID |
| `CHROME_CLIENT_SECRET` | Chrome | Google OAuth2 client secret |
| `CHROME_REFRESH_TOKEN` | Chrome | Google OAuth2 refresh token |

## Sort-by-Visit-Count Performance Note (R3.1d)

Sorting by visit count requires one `history.search({ text: url, maxResults: 1 })`
call per tab. For 100 tabs this means 100 API calls. In practice this completes
in <500ms since it's a local SQLite lookup, but it is the slowest sort path.
All other sort criteria use data already present on the `Tab` object. The history
lookups happen in `background.js` before calling `core.planSort()`, which receives
tabs already enriched with `visitCount`.
