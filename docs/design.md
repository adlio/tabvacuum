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

## Centered Tab Search (R11)

The toolbar menu and Alt+Shift+K (Command+Shift+Space on macOS) both invoke `search-launcher.js` through the background worker. The menu remains a normal toolbar popup; the search itself is not anchored to the address bar. Both surfaces share light/dark tokens in `ui-theme.css`. The toolbar renders actual browser-assigned bindings with `shortcuts.js`, translating Mac modifier names to native keycaps without changing user assignments.

- `search-core.js`: pure fuzzy title/URL ranking. Empty queries sort recent focus descending, put the current tab last, then limit to ten. Typed queries apply no current-tab exception.
- `search-service.js`: live tab scope, normal/private filtering, focus timestamps, and tab/window activation. Search's own fallback tabs are excluded from results and focus tracking.
- `search-launcher.js`: random per-launch capability, sender validation, session lifecycle, overlay injection, and separate-window fallback. Session state survives worker suspension in `storage.session`; Chrome normal/private workers own different keys because split mode does not separate this storage. Invalid public frames are rejected before entering the serialized operation queue.
- `search-overlay.js`: one self-contained, top-frame-only function injected after an activeTab gesture. It mounts a native modal dialog inside a closed shadow tree, containing an extension-origin iframe. It restores focus on dismissal and removes itself on navigation. The token goes directly from the isolated script to that frame, restricted to the extension origin; it never enters the host DOM or the iframe URL.
- `search.html/js/css`: shared 640px-wide, viewport-constrained palette with two-line tab results, optional content snippets, light/dark styling, combobox/grid semantics, keyboard navigation and focus containment. The iframe talks directly to the background with its token. A single data-free close signal can go to the parent, which checks both source window and extension origin. No query or tab metadata crosses that channel.

Only `search.html` is web-accessible. Every search-data, activation, or explicit-close message must match the token's tab, privacy mode and frame placement; the first authorized claim binds the frame/document. Unclaimed launches expire after one minute, claimed sessions after one hour. Normal dismissal, activation, replacement, navigation and tab closure revoke sooner. Popup and options commands additionally require their exact extension-page sender URL; an embedded search frame cannot invoke them.

On unsupported schemes or failed injection, a `windows.create({type: 'popup'})` window hosts the same search page. It is centered from the source window's bounds and stays in the source privacy mode. Its launch token is in its extension-owned URL and is authorized only for that exact created tab. Chrome requires `incognito: "split"` for this page to load in a private window. OS window chrome remains visible. No source tab is navigated or moved.

Firefox restricts embedded extension pages to a smaller API surface than top-level pages. Authorized, visible search frames without tab events therefore refresh once per second via validated runtime requests. Chromium uses tab events, subscribing only after authorization. Default tab-only queries never leave the frame. Expanded-source queries go through the authorized background handler; neither queries nor snippets are persisted or sent off-device. All tab titles/URLs/snippets are text, never HTML, and icons are local glyphs rather than fetched favicons.

On Firefox the single background worker replaces the prior search when another is opened, including across normal/private windows. Chrome's split workers can each retain one search independently; their storage keys are distinct, while all results still obey privacy filtering.

Residual risks: a website can observe, remove or imitate any in-page overlay. The closed shadow root is style/DOM isolation, not a defense against a compromised browser. The extension-origin iframe provides the same-origin boundary for data; the public HTML resource permits installation fingerprinting. The separate-window fallback cannot match in-page appearance exactly because window chrome is controlled by the OS.

Verification uses Vitest for ranking, UI behavior, launch/sender validation, lifecycle and split-worker storage; real Firefox/Chromium harnesses test shortcuts, menus, native focus, one/two/150-tab cases, cross-window selection, private overlay/fallback, navigation and worker restart. These Linux runs do not establish macOS shortcut/focus behavior or prove every supported browser version.

### Explicit closing from search

`closeSearchTabs` shares the search launch authorization and serialized handler queue. The service accepts a frozen, nonempty list of unique integer tab IDs, limited to 10,000 per request. It checks the live privacy/window scope, excludes search pages, honors pinned/audio preferences and leaves the last tab in each window. It deliberately does not apply the active-tab protection used by automatic cleanup. Generic cleanup and settings commands remain inaccessible to embedded search. The origin tab closes last; a completed origin closure revokes the token and removes any fallback window. Accepted closing work does not depend on the requesting UI surviving.

The response distinguishes `closedIds`, `skipped` IDs with reasons and `failedIds`; `ok` means processed, not all closed. The UI never retries a destructive request automatically. It removes confirmed closed rows, keeps Close disabled through its final refresh, and reports refresh failures instead of silently displaying stale results. A completed checked batch cannot fall through to closing an unchecked neighbour without further navigation or selection.

Selection uses local ID checks, not browser-native tab multi-selection. Three modes separate typing, tab-menu navigation and multi-select. Tab enters the tab menu, arrows/j/k navigate, Enter activates, and x/Delete closes the highlight; m enters multi-select. Space/Enter toggles checks, a (or platform Select All) snapshots only current results, and x/Delete closes only checked IDs. Zero checks never fall back to the highlight. Each row's × always closes that row alone. Keyboard-accessible row controls use grid/row/gridcell semantics rather than buttons nested inside listbox options.

Escape steps multi-select → tab menu → search → dismissal; m/Done returns to the tab menu, while direct query focus clears checks and returns to typing. Closures retain mode and focus even when there are no matches, and preserve the next highlight at the same index. A bounded queue keeps fast navigation/close keys in order across asynchronous removal and refresh, cancelling them on mode/focus changes, partial failure or overflow. Each executed close still sends a frozen set of explicit IDs. Buttons keep native Enter/Space behavior; repeated close keys are ignored. A focused row × retains its tab identity during external refresh; when that tab vanishes externally, focus returns to the tab menu rather than another ×. Inline hints and accessible descriptions change by mode, with Toggle Selection, Select All and Close visible at narrow sizes. Unit tests cover authorization, frozen sets, partial failures, repeat hazards, IME, external focus drift and refresh races; native tests cover all three modes, real rapid j/x bursts, cross-window host-last batches and protected-page fallback.

## Expanded Search Sources (R12, 0.5.0)

The Search in disclosure exposes two independent optional sources; open tabs remain unconditional. Source choices are launch-local, not stored preferences. UI generations discard stale replies and cancel an in-flight query with an empty, sources-off `querySearchSources` request. Normal tab-only queries use the same pure ranking locally and never make a source request. Source changes preserve the text; the 256-character expanded-query limit is reported inline rather than truncating the query. The source menu owns its focus cycle and first Escape; the ordinary query→tab-menu→multi-select workflow remains intact.

`search-sources-core.js` composes stable `tab:<id>` and `history:<exact URL>` entries. It applies unchanged `rankTabs` first, appends content-only open tabs, then history matches. The newest history entry for each exact URL wins; query and fragment components are preserved. History matches with an eligible open URL become open-tab results rather than duplicates. Content snippets attach only when both tab ID and URL still match. History entries have no closing controls; entering multi-select hides history rather than treating it as selectable tabs. Automatic recomposition preserves the highlighted key; a vanished target disarms closing and cancels queued navigation/close actions. A close's own adjacent-row behavior remains unchanged.

`search-service.js` reads matching browser history using `startTime: 0` and 101 candidates to report the latest-100 limit. It never reads history in a private context. `activateHistoryResult` validates the normal context and HTTP/HTTPS URL, rechecks exact history membership, then focuses an eligible open tab or creates a tab in the origin window. It never edits browser history. Host permissions use HTTP/HTTPS origins in Chrome's `optional_host_permissions` and Firefox's `optional_permissions` for the declared Firefox 115 floor. `content-permissions.js` requests access synchronously inside the Settings click handler, reports denial and errors, and provides revocation. The browser retains the grant; the palette never auto-enables contents after a grant.

Content traversal uses the self-contained `searchPageContent` function in the top frame's isolated world. It excludes hidden/editable/form/script/frame/shadow-tree content, checks every visited node against time/node budgets and returns only a bounded matching snippet plus the exact document URL. The service checks live scope/privacy/URL and optional permission before each injection and drops results after navigation, cancellation or permission loss. At most 100 eligible tabs and four concurrent page tasks are attempted. Coverage distinguishes searched, skipped and partially searched pages; there is no background index or persisted text. Browser execution, not a regex or downloaded code string, runs the bundled function.

`querySearchSources` enters the launch queue only to authorize and snapshot the origin, then leaves the queue while history/content work runs. It re-authorizes before returning. One abort controller is registered per active source query; new queries supersede older ones. Central session saving cancels scans for removed sessions (dismissal, activation, replacement and origin lifecycle events); expiry is checked by authorization, so expired results are never returned. Per-task checks stop future injections after cancellation, while already-running synchronous scripts finish within their budgets and their results are discarded. Website permission is checked again before delivering snippets. Query/content data is transient memory only; the page receives only the existing data-free dismissal signal.

Native acceptance extends the existing harnesses with real visited-and-closed history pages, exact-URL variants, source menu keyboard interactions, browser-native permission denial/grant/revocation, content-only fixtures, hidden/form/frame/shadow exclusions, discarded tabs, window privacy separation and source reset. Firefox and Chromium use fresh profiles and loopback fixtures, without mocked browser APIs. Grant persistence is checked from another extension page, not across a browser restart; OS-level macOS behavior and minimum-browser versions still require separate validation.
