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
    "search-tabs": {
      "suggested_key": { "default": "Ctrl+Shift+Period", "mac": "Command+Shift+Period" },
      "description": "Search tabs"
    },
    "close-stale": { "description": "Close stale tabs" },
    "close-blank": { "description": "Close blank tabs" }
  }
}
```

### Permissions Rationale

| Permission | Why |
|---|---|
| `tabs` | Access `tab.url`, `tab.title`, `tab.lastAccessed` (R1-R4) |
| `history` | Access `visitCount` for sort-by-visit-count (R3.1d) |
| `contextMenus` | Tab context menu (R6.2). Chrome uses `contextMenus`; Firefox supports both `contextMenus` and `menus` |
| `notifications` | Outcome feedback for popup, context menu and shortcut actions (R6.4) |
| `storage` | Persist user settings (R5.3), the saved default sources and Search hint state (R15.3, R15.10) |
| `activeTab`, `scripting` | Inject the Search overlay into the page Search opens over (R11), and read loaded pages for Contents (R12.5) |
| `alarms` | Scheduled stale-tab cleanup (R4, 0.6.0) |
| `browserSettings` (Firefox only) | Toggle native vertical tabs (R13) |
| optional `http://*/*`, `https://*/*` | Contents: read text of already-loaded pages, requested from Settings only (R12.4) |
| optional `bookmarks` | Bookmarks source (R15). Optional, so an update shows no new warning and Chrome never disables the extension; requested on first use (R15.8). The browser's prompt says "Read and change your bookmarks" (Chrome) or "Read and modify bookmarks" (Firefox), since neither offers read-only access; Search only reads them |

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

// Stale cleanup uses stale-core.js planStale(tabs, records, context),
// with an explicit clock and manual/automatic policy. See the 0.6.0 section.

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
import { findDuplicates, planMerge, planSort } from './core.js';

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

**Message listener** — popup and options pages communicate via `browser.runtime.sendMessage`. This routing sketch is abbreviated: the implementation first checks the trusted extension-page sender and uses the Chrome-compatible asynchronous response wrapper. Embedded search frames cannot invoke these commands.

```js
browser.runtime.onMessage.addListener((msg) => {
  switch (msg.command) {
    case "closeDuplicates": return closeDuplicates();
    case "mergeWindows":    return mergeWindows();
    case "sortTabs":        return sortTabs(msg.criteria, msg.direction);
    case "getStaleState": return stale.getState(msg.windowId);
    case "closeStalePreview": return stale.closePreview(msg.windowId, msg.previewId);
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
menuApi.create({ id: "tv-stale",  title: "Review Stale Tabs…",   contexts: ["tab"] });
```

**Notifications** (R6.4):

```js
function notify(message) {
  browser.notifications.create({ type: "basic", title: "TabVacuum", message });
}
```

### popup.html / popup.js

Minimal HTML with action buttons and a sort-criteria dropdown with direction
toggle. JS sends messages to background. While Sort, Merge or a cleanup action is
pending, the status area shows an action label and spinner, and further action commands are ignored.
On success or a zero-match no-op the popup closes and the background posts the
outcome as a native notification (R6.4). A genuine failure stays inline in the status
area. If the notification cannot be delivered, the background still returns the
actual completion result, which an open popup shows inline rather than as a failure.
Search-palette closing is separate: it stays open and reports inline.

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
  → posts the outcome as a native notification (zero matches = informational)
  → returns { message } to caller (notification failure never rewrites the result)
  → popup closes on success/no-op, or shows a genuine failure inline
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

The toolbar menu and Ctrl+Shift+Period (Command+Shift+Period on macOS) both invoke `search-launcher.js` through the background worker. The menu remains a normal toolbar popup; the search itself is not anchored to the address bar. Both surfaces share light/dark tokens in `ui-theme.css`. The toolbar renders actual browser-assigned bindings with `shortcuts.js`, translating Mac modifier names to native keycaps without changing user assignments.

- `search-core.js`: pure fuzzy title/URL ranking. Empty queries sort recent focus descending, put the current tab last, then limit to ten. Typed queries apply no current-tab exception.
- `search-service.js`: live tab scope, normal/private filtering, focus timestamps, and tab/window activation. Search's own fallback tabs are excluded from results and focus tracking.
- `search-launcher.js`: random per-launch capability, sender validation, session lifecycle, overlay injection, and separate-window fallback. Session state survives worker suspension in `storage.session`; Chrome normal/private workers own different keys because split mode does not separate this storage. Invalid public frames are rejected before entering the serialized operation queue.
- `search-overlay.js`: one self-contained, top-frame-only function injected after an activeTab gesture. It mounts a native modal dialog inside a closed shadow tree, containing an extension-origin iframe. It restores focus on dismissal and removes itself on navigation. The token goes directly from the isolated script to that frame, restricted to the extension origin; it never enters the host DOM or the iframe URL.
- `search.html/js/css`: shared 640px-wide, viewport-constrained palette with two-line tab results, optional content snippets, light/dark styling, combobox/grid semantics, keyboard navigation and focus containment. The iframe talks directly to the background with its token. A single data-free close signal can go to the parent, which checks both source window and extension origin. No query or tab metadata crosses that channel.

Only `search.html` is web-accessible. Every search-data, activation, or explicit-close message must match the token's tab, privacy mode and frame placement; the first authorized claim binds the frame/document. Unclaimed launches expire after one minute, claimed sessions after one hour. Normal dismissal, activation, replacement, navigation and tab closure revoke sooner. Popup and options commands additionally require their exact extension-page sender URL; an embedded search frame cannot invoke them.

On unsupported schemes or failed injection, a `windows.create({type: 'popup'})` window hosts the same search page. It is centered from the source window's bounds and stays in the source privacy mode. Its launch token is in its extension-owned URL and is authorized only for that exact created tab. Chrome requires `incognito: "split"` for this page to load in a private window. OS window chrome remains visible. No source tab is navigated or moved.

Firefox restricts embedded extension pages to a smaller API surface than top-level pages. Authorized, visible search frames without tab events therefore refresh once per second via validated runtime requests. Chromium uses tab events, subscribing only after authorization. Default tab-only queries remain in the frame during ordinary search. A host-close handoff temporarily stores the query and UI state in `storage.session` and delivers them only to the authenticated replacement frame. Expanded-source queries go through the authorized background handler; neither queries nor snippets are persistently stored or sent off-device. All tab titles/URLs/snippets are text, never HTML, and icons are local glyphs rather than fetched favicons.

On Firefox the single background worker replaces the prior search when another is opened, including across normal/private windows. Chrome's split workers can each retain one search independently; their storage keys are distinct, while all results still obey privacy filtering.

Residual risks: a website can observe, remove or imitate any in-page overlay. The closed shadow root is style/DOM isolation, not a defense against a compromised browser. The extension-origin iframe provides the same-origin boundary for data; the public HTML resource permits installation fingerprinting. The separate-window fallback cannot match in-page appearance exactly because window chrome is controlled by the OS.

Verification uses Vitest for ranking, UI behavior, launch/sender validation, lifecycle and split-worker storage; real Firefox/Chromium harnesses test shortcuts, menus, native focus, one/two/150-tab cases, cross-window selection, private overlay/fallback, navigation and worker restart. These Linux runs do not establish macOS shortcut/focus behavior or prove every supported browser version.

### Explicit closing from search

`closeSearchTabs` shares the search launch authorization and serialized handler queue. The service accepts a frozen, nonempty list of unique integer tab IDs, limited to 10,000 per request. It checks the live privacy/window scope, excludes search pages, honors pinned/audio preferences and leaves the last tab in each window. It deliberately does not apply the active-tab protection used by automatic cleanup. Generic cleanup and settings commands remain inaccessible to embedded search. The origin tab closes last. A standalone search that closes its origin retains the origin's window as its scope.

Closing an embedded host first prepares a replacement. The first choice is a complete, loaded HTTP(S) page in the same window and privacy mode, outside the closing set, using existing optional website access. A standalone extension window is the fallback. Before an active host closes on this path, an already-loaded, same-window survivor outside the closing set is selected when one exists; it may be a protected page, since no overlay is injected into it. This avoids Firefox selecting a sleeping neighbor. If there is no loaded survivor, the browser still chooses the tab to activate after the close. Pending replacements may only load context, report readiness or dismiss. The background rechecks destination and access before delivering launch-local state and again at the destructive boundaries after the close-policy reads. It brings the replacement forward before closing and retains original authority until the replacement takes over. Waiting for readiness happens outside the serialized queue so the replacement can authenticate. If both attempts fail before removal, no requested tabs close and the original search remains usable. Dismissing a pending replacement cancels the whole attempt rather than trying another destination. If the destination is lost after siblings close, the host is kept and the original reports the partial result. Query, mode, sources, checks, displayed tab order and focus transfer; queued keys do not. The UI retains the relative order of existing results until query input changes, preventing browser activation from changing the next close target; fresh queries use the existing ranking.

The response distinguishes `closedIds`, `skipped` IDs with reasons and `failedIds`; `ok` means processed, not all closed. A successful close normally includes fresh context in the same reply, avoiding another message round trip. If that read fails, the UI attempts one read-only refresh and never repeats the destructive request. It removes confirmed closed rows, keeps Close disabled until the list settles, and reports refresh failures instead of silently displaying stale results. Unchanged rows are reused with refreshed indices and accessibility attributes. A completed checked batch cannot fall through to closing an unchecked neighbour without further navigation or selection.

Selection uses local ID checks, not browser-native tab multi-selection. Three modes separate typing, tab-menu navigation and multi-select. Tab enters the tab menu, arrows/j/k navigate, Enter activates, and x/Delete closes the highlight; m enters multi-select. Space/Enter toggles checks, a (or platform Select All) snapshots only current results, and x/Delete closes only checked IDs. Zero checks never fall back to the highlight. Each row's × always closes that row alone. Keyboard-accessible row controls use grid/row/gridcell semantics rather than buttons nested inside listbox options.

Escape steps multi-select → tab menu → search → dismissal; m/Done returns to the tab menu, while direct query focus clears checks and returns to typing. Closures retain mode and focus even when there are no matches, and preserve the next highlight at the same index. A bounded queue keeps fast navigation/close keys in order across asynchronous removal and refresh, cancelling them on mode/focus changes, partial failure or overflow. Each executed close still sends a frozen set of explicit IDs. Buttons keep native Enter/Space behavior; repeated close keys are ignored. A focused row × retains its tab identity during external refresh; when that tab vanishes externally, focus returns to the tab menu rather than another ×. Inline hints and accessible descriptions change by mode, with Toggle Selection, Select All and Close visible at narrow sizes. Unit tests cover authorization, frozen sets, partial failures, repeat hazards, IME, external focus drift and refresh races; native tests cover all three modes, real rapid j/x bursts, cross-window host-last batches and protected-page fallback.

## Expanded Search Sources (R12, 0.5.0)

Superseded in part by Search sources (R15) below: the Search in disclosure became the source toolbar, Tabs became a source that can be off, the default sources are saved, and settled tab-only queries now ask the background for off-source counts. UI generations discard stale replies; an in-flight query is cancelled with its own `cancelSearchSources` command. Source changes preserve the text; the 256-character expanded-query limit is reported inline rather than truncating the query. The source menu owns its focus cycle and first Escape; the ordinary query→tab-menu→multi-select workflow remains intact.

`search-sources-core.js` composes stable `tab:<id>` and `history:<exact URL>` entries. It applies unchanged `rankTabs` first, appends content-only open tabs, then history matches. The newest history entry for each exact URL wins; query and fragment components are preserved. History matches with an eligible open URL become open-tab results rather than duplicates. Content snippets attach only when both tab ID and URL still match. History entries have no closing controls; entering multi-select hides history rather than treating it as selectable tabs. Automatic recomposition preserves the highlighted key; a vanished target disarms closing and cancels queued navigation/close actions. A close's own adjacent-row behavior remains unchanged.

`search-service.js` reads matching browser history using `startTime: 0` and 101 candidates to report the latest-100 limit. It never reads history in a private context. `activateHistoryResult` validates the normal context and HTTP/HTTPS URL, rechecks exact history membership, then focuses an eligible open tab or creates a tab in the origin window. It never edits browser history. Host permissions use HTTP/HTTPS origins in Chrome's `optional_host_permissions` and Firefox's `optional_permissions` for the declared Firefox 115 floor. `content-permissions.js` requests access synchronously inside the Settings click handler, reports denial and errors, and provides revocation. The browser retains the grant; the palette never auto-enables contents after a grant.

Content traversal uses the self-contained `searchPageContent` function in the top frame's isolated world. It excludes hidden/editable/form/script/frame/shadow-tree content, checks every visited node against time/node budgets and returns only a bounded matching snippet plus the exact document URL. The service checks live scope/privacy/URL and optional permission before each injection and drops results after navigation, cancellation or permission loss. At most 100 eligible tabs and four concurrent page tasks are attempted. Coverage distinguishes searched, skipped and partially searched pages; there is no background index or persisted text. Browser execution, not a regex or downloaded code string, runs the bundled function.

`querySearchSources` enters the launch queue only to authorize and snapshot the origin, then leaves the queue while history/content work runs. It re-authorizes before returning. One abort controller is registered per active source query; new queries supersede older ones. Central session saving cancels scans for removed sessions (dismissal, activation, replacement and origin lifecycle events); expiry is checked by authorization, so expired results are never returned. Per-task checks stop future injections after cancellation, while already-running synchronous scripts finish within their budgets and their results are discarded. Website permission is checked again before delivering snippets. Query/content data is transient memory only; the page receives only the existing data-free dismissal signal.

Native acceptance extends the existing harnesses with real visited-and-closed history pages, exact-URL variants, source menu keyboard interactions, browser-native permission denial/grant/revocation, content-only fixtures, hidden/form/frame/shadow exclusions, discarded tabs, window privacy separation and source reset. Firefox and Chromium use fresh profiles and loopback fixtures, without mocked browser APIs. Grant persistence is checked from another extension page, not across a browser restart; OS-level macOS behavior and minimum-browser versions still require separate validation.

## Search sources (R15, issue #24)

**UI (`search.js`, `search.html`).** The toolbar under the query holds four `aria-pressed` buttons and a hidden-until-needed **Save as default**. It is one entry at the end of `focusOrder()` with a roving `tabindex`, so Shift+Tab from the query reaches it and Tab from the query still opens the tab menu. Source state is `{ tabs, bookmarks, history, content }`, set once from `startingSources(defaultSources, context)` on the first context, replaced by a handoff's carried state, and otherwise changed only by the user. A source that needs access adds itself to `needsAccess`, which shows its enable row in `#source-access`; when a later context reports the access, the source turns on (or the pending scope word applies in full). `lockedScope()` is true while every source the chip names still needs access: all sources are off (the one exception to "at least one stays on"), `render()` lists nothing, counts are neither requested nor shown, the list heading and Save as default hide, and the enable row is the content; the same context check turns the chip's sources on and schedules a source search for the current query. The scope chip is a sibling before the `<input>` with its own remove button; the `@` list is a `role="listbox"` that the combobox points at only while open. Scope words convert in the `input` handler only for `inputType === 'insertText'` with a space, and composition is already skipped by the existing `composing` guard. `searchText()` returns '' for a bare `@` prefix, so nothing is ranked or counted on it.

**Pure rules (`search-sources-core.js`).** `buildBookmarkIndex(tree)` flattens `getTree()` into unique web bookmarks with folder paths; `searchBookmarkIndex` ranks them with `rankTabs` (lastAccessed = `dateAdded`) and caps at 50 while returning every matched URL. `composeSearchResults` takes `sources` and `bookmarks`: tab rows only while Tabs is on, then promoted open tabs, bookmarks, history, each URL once; with Tabs off an open page found another way keeps its bookmark/history row with `openTabId`. `sourceCounts` removes repeats as R15.5 describes. History's `count` subtracts bookmarked URLs only while Bookmarks is on, so each button matches what it alone adds; `withBookmarks` is the count with both included, which the empty-list sentence uses. Bookmarks returns `{ count, limited }` capped at 50. `scopeWord`, `scopeSuggestions`, `scopeSources`, `normalizeDefaultSources`, `startingSources` and `differsFromDefault` hold the grammar and default rules.

**Background (`search-service.js`, `search-launcher.js`).** The bookmark index is a module-level promise per worker, built lazily, invalidated by a version counter on every bookmark event and on `permissions.onRemoved`, and never written to storage. Listeners attach to whichever `bookmarks` namespace object currently exists, so a revoke and re-grant that hands the worker a new object still invalidates the index. `getContext` adds `bookmarkPermission`, `bookmarked` (open tab IDs whose exact URL is bookmarked, for ★), `defaultSources` and hint state. `querySearchSources` accepts `count: { bookmarks, history }`, lists on sources, and computes off-source counts in the same reply; history counting is one `history.search` with 101 candidates and never runs in private windows. `beforeOpen(url, incognito)` records duplicate prevention's Search exemption in the store for the search window's privacy mode, so a bookmark opened in a private window is kept there (and, in Chrome split mode, by the private worker). New token-checked commands: `activateBookmarkResult` (re-reads the bookmark by id; works in private windows), `saveSearchDefault`, `noteSearchHints`, `cancelSearchSources`. `background.js` adds `searchSources` to the settings defaults and normalizes it on save, and on update removes the `searchBookmarksNew` counter that 0.10.0 stored for its retired "New" mark.

**Permission prompt (probed 2026-11-27, `scripts/probe-bookmark-permission.mjs`).**

| Context | Firefox 161 | Chromium 145 headful |
|---|---|---|
| Framed overlay | `browser.permissions` is undefined in the frame | Real dialog "Read and change your bookmarks" |
| Standalone Search window | Real doorhanger "Read and modify bookmarks" | Real dialog |
| Private overlay | `browser.permissions` undefined | Covered by the harness through the normal-window grant |

So Search calls `permissions.request` synchronously in the click handler whenever `browser.permissions.request` exists, and otherwise offers **Enable in Settings**. `runtime.openOptionsPage()` opens Settings in a new tab; the overlay stays in its own tab, and the `visibilitychange`/focus re-check turns Bookmarks on when the user comes back. Chromium re-grants a previously granted optional permission without showing the dialog again.

**Native acceptance (`scripts/test-search-sources.mjs`, `--sources-only`).** Both harnesses seed bookmarks and history only in the throwaway profile and cover: the prompt or Settings path from the overlay and the window, a grant arriving while Search is open, folder/separator/bookmarklet/`file:` filtering, a URL in two folders, ★, Tabs off with an open bookmark, opening a bookmark, Save as default and its reset, the `@` list, `@b`/`@all`/`@types`, Backspace restore, paste, counts that keep the highlight, 105 history matches reading 100+, double Enter on the include action, one-time tips, handoff with Bookmarks on and Tabs off, private windows, revoke while open, `getTree()` on 10,000 bookmarks, and whether a Ctrl+K remap reaches the extension. Input-method composition is covered by unit tests only.

## Stale-tab review and opt-in scheduling (0.6.0 candidate, R4–R7)

The main menu's Stale Tabs row is a disclosure, not a destructive action. Popup and Settings share the threshold and opt-in through the trusted background messages in `docs/automatic-stale-tab-cleanup.code-task.md`. The enabled title and scheduled caption use the user's approved wording. The manual count plans for now; the caption plans for the scheduler's next run. A higher projected count is explained inside the disclosure. Settings and popup failures do not remove access to disabling automation.

`stale-core.js` owns deterministic threshold validation, conservative age evaluation, manual/automatic protection policies, whole-local-hour arithmetic, bounded record validation, preview/lease expiry and actual-result messages. `stale-service.js` owns browser calls, event ordering, previews, leases, one-shot opening intent, preference updates and alarms. The former zero-fallback `findStaleTabs` export and immediate `closeStaleTabs` message are removed. Existing command IDs and assigned shortcuts remain; stale keyboard/context actions open the same toolbar controls through `action.openPopup`, or report a non-destructive opening error.

`storage.local` contains the saved rule, revision and next planned run, not per-tab activity. `storage.session` contains bounded, separate normal/private age records, previews and editor leases. Firefox's single worker owns both contexts; Chrome split workers own only the context they can see, because session storage is shared. Either context's active editor defers automatic sweeps, since the rule itself is shared. Unknown metadata fails toward keeping tabs. Private activity never becomes persistent browsing metadata.

A preview stores a bounded frozen set of tab/window IDs, document generations and URL hashes, tied to a rule revision, invoking window, privacy scope and short expiry. Its first use consumes it. Removal is serial, rechecks the live tab/window/document and protections, then rechecks rule/editor guards immediately before calling `tabs.remove`. Changing a setting or opening an editor during awaited checks stops subsequent automatic removals. Partial-result messages retain actual counts; lost replies never cause automatic removal retries. Review remaining tabs obtains a fresh preview, scrolls it above the sticky footer and focuses it without issuing another close. Passive polling cannot supersede that recovery read; failed refreshes cannot reopen an outdated review list.

The scheduler adds only `alarms`. Enabling schedules a future whole local hour; no immediate sweep runs. Schedule reconciliation and one-shot alarm claiming are serialized. A callback that wakes an idle worker can claim its already-fired alarm once even if initialization has planned the next run. Full browser restarts reject pre-start backlog; device wake can run one delayed sweep. Disabled state prevents removal even if alarm clearing fails. DST, half-hour transitions and time-zone changes replan to whole local hours. Distinct failures are reported once per failure episode rather than every hour.

Native age probes established Firefox's deselection-based timestamp and Chromium's selection-based timestamp in the tested versions.

**Age tracking and the correction journal (shipped, 0.6.0+).** Firefox uses the tab's native last-viewed time together with current-session observations. Chrome uses the tab's native last-activated time — the clock starts when you select a tab, not when you leave it — so a tab left active for more than the threshold is kept; once you switch away, it can qualify. Chrome's native timestamp carries age across clean restarts. ATV also keeps a bounded, timestamp-only journal in `storage.local` to correct known older restored timestamps; corrections can only make a tab *younger*, never older. The journal holds no tab IDs, URLs, hashes, titles, or private-window activity and needs no extra permission. An earlier implementation reset Chrome's age baseline on every full browser/extension restart; the journal replaced it, and three clean Chromium restarts preserved age correctly in the integrated tests. Crash immunity is not promised: if an abrupt crash loses recent activity in both the browser and the extension, a restored tab can appear older than it really is and qualify too early. Chrome private-window age records stay in session storage only. Tests use accelerated age fixtures, not a real seven-day soak.

Verification uses unit tests for boundaries, races and privacy, the original search/closing suites, and `scripts/test-stale-cleanup.mjs` for native popup controls, safe editing, previews, protection checks, private isolation, shortcuts/context menus, alarm events and visible error recovery. Browser fixtures use disposable profiles on loopback. Firefox age fixtures use privileged native timestamp setup; Chromium fixtures offset only the extension's test clock. Accelerated alarm plans and injected transport failures are labelled in result JSON. These runs do not establish a real week of unattended use, minimum-version execution, physical macOS behavior or full Firefox restart behavior with a signed installed add-on.

## Duplicate-tab prevention (R14, issue #20)

### Probe: what the browsers report

`scripts/probe-duplicate-tabs.mjs` loads a generated probe extension (`tabs` permission only, not the product build) into a disposable profile on an isolated Xvfb display, against a loopback fixture site, and logs `tabs.onCreated`/`onUpdated`/`onRemoved`, `windows.onCreated` and `onAttached`/`onDetached` with `url`, `pendingUrl`, `openerTabId`, `index`, `status` and `discarded`. Browser gestures are real XTest input (`scripts/test-native-key.py` plus pointer events). Run on 2026-11-25 with Firefox 161.0 and Chromium 145.0.7632.0 on Linux aarch64; two runs gave the same results. Values are what `onCreated` reported, then how the URL arrived.

| Case | Firefox 161 | Chromium 145 |
|---|---|---|
| `tabs.duplicate` (stands in for Duplicate Tab) | `about:blank`, opener = source, index = source + 1; page URL ~60 ms later | `url` and `pendingUrl` = page at creation, opener = source, index = source + 1 |
| Address bar Alt+Enter on the doc | `about:blank`, no opener, appended at the end | `pendingUrl` = doc, opener = doc, appended at the end |
| Middle-click or Ctrl-click a link to the same page | `about:blank`, opener = the page, index + 1 | `pendingUrl` = page, opener = the page, index + 1 |
| Ctrl-click / middle-click a link from another page (also `rel=noopener`) | opener = the linking page (kept with `noopener`) | opener = the linking page (kept with `noopener`) |
| `window.open`, with and without `noopener` | `about:blank`, opener = the opening page | `url` empty, no `pendingUrl`, status `complete`, opener = the opening page |
| Ctrl+T, then typing the doc's URL | `about:newtab`, **no opener**; typed URL arrives ~2 s later | `pendingUrl` = `chrome://newtab/`, **opener = current tab**; typed URL arrives later |
| Server redirect to an open page | `about:blank`, then the final URL only | `pendingUrl` = redirector, then `url` = final page at commit |
| Script redirect (300 ms) to an open page | redirector loads and completes, final URL ~300 ms later | same |
| Another app opens a URL (doc is the rightmost tab) | `about:blank`, no opener, index = doc + 1 | not measured: the second launch hit Chromium's profile lock in this harness |
| Same URL created twice 200 ms apart | two tabs, both `about:blank` at creation | two tabs, both with `pendingUrl` = the page |
| Close at `onCreated` (before commit), then Ctrl+Shift+T | URL unknown at `onCreated` (`about:blank`), so nothing to close yet | **not restorable**: Ctrl+Shift+T restored the older closed tab |
| Close when `url` first arrives (commit, status `loading`), then Ctrl+Shift+T | restored the closed page | restored the closed page |
| Close a two-tab window, then reopen it | first tab `about:blank`, **then** `windows.onCreated` in the same ms; second tab `discarded: true` | `windows.onCreated` first; tabs status `unloaded` with `url` set |
| `tabs.move` to another window | `onDetached`/`onAttached` only | same |
| Browser restart with session restore | not measured: the temporary probe add-on is installed after startup | the worker started after the restored tabs were created and saw only their `onUpdated` events |

What the design takes from it:

- **Opener rule (D7).** Both browsers set the opener on Duplicate Tab and same-page links, so the tab-index fallback is dropped: an app link next to a rightmost doc lands at doc + 1 with no opener, which the fallback would have kept. Chromium sets the opener on Ctrl+T, so the opener counts only when the tab's first real URL (Chromium `pendingUrl`, or the first URL after Firefox's `about:blank`) was already the match's page.
- **Close timing (D5).** Chromium does not restore a tab closed before commit, so both browsers judge only the committed `url`. In Chromium that is the `url` change at commit; Firefox reports nothing earlier.
- **Restore and bulk heuristics (D6).** Reopened windows are caught by `discarded` (Firefox), status `unloaded` (Chromium) and the new-window burst. Firefox reports a window's first tab before the window, so `windows.onCreated` also marks already-recorded tabs of that window. Tabs the worker never saw created are never judged, which covers Chromium's late-starting worker after a restart. Every new tab waits until its window has had no new tab for 200 ms (a per-window debounce, `settleDeadline`, capped at 1 s after the tab's creation), and the burst count includes tabs already judged: real-browser testing showed Chromium committing the first tab of a three-tab Open All within about 20 ms, before the other two existed, so without the wait that tab was switched before the burst was known. Across 34 harness runs the third tab of a burst arrived 19-41 ms after the first (Chromium `tabs.create` and Bookmark Manager Open all, Firefox `tabs.create`), so a lone tab's 200 ms wait leaves about five times that margin; the burst rule itself still counts 3 tabs within 1 s. Larger or slower bursts (a 12-bookmark Open all spread over 313-403 ms with gaps up to about 158 ms; three tabs 150 ms apart) are covered by the debounce. Creation times are stamped when the event reaches the worker, not when the serial queue processes it: during a 12-tab Open all the queue fell about 0.5 s behind (records stamped 536 ms apart for tabs that arrived 23 ms apart), and the doc was switched (`done: switched`) before the queue reached the later tabs, which then marked it `bulk` too late. A judge or switch also waits while a tab created in the same window has arrived but is not yet recorded. An earlier 1 s wait made every switch land about 1 s late and pulled users back from tabs they had picked meanwhile. Because the switch can now run after the user has left a duplicate that was in front (tracked through `tabs.onActivated`), it then only closes the duplicate and leaves focus alone.
- **Redirects (D2).** Both browsers deliver the final URL through `onUpdated`; script redirects arrive after the first page completed, hence the 3 s grace.

### Design

`core.js` holds the rules as pure functions: `newTabRecord` (what to remember at creation, and whether the tab is never judged), `noteTabUrl`, `isStillNew`, `isNeverUrl`, `validateDuplicateSettings`, and `judgeNewTab`, which returns `switch` (with the match), `keep`, `ignore` or `wait`. It never calls the bulk-closing filters; it applies R7.1 itself. `duplicate-service.js` owns the events, state and the switch. `background.js` installs its listeners synchronously at top level, like the stale service, so a sleeping Chromium worker still hears the event that wakes it.

State is in `storage.session` under `dupe.normal` and `dupe.private`: per-tab creation records, recent window creations, the 60 s keep records, Search's 5 s allowances and the startup quiet deadline. Chromium split-incognito workers each write only their own key; Firefox's one background keys by `tab.incognito`. All reads and writes run on one serial queue in event order, and the store is loaded once per worker. Settings are read from `storage.local` and cached until `storage.onChanged`. Nothing is written while the feature is off.

A switch activates the match, focuses its window when it is elsewhere or the new tab was in front, re-reads the new tab and closes it only if it still shows the same page inside its new-tab period. Activating first means the browser does not pick a neighbour to activate, so stale-age tracking does not record a spurious view. A failed removal is silent. The first switch sets `preventDuplicatesNoticeShown` in `storage.local` and sends one notification through the existing `notify()`.

TabVacuum's own Search (D13): `createSearchService` takes a `beforeOpen(url)` hook, which the background points at `dupes.allow(url)`. A history result Search opens is kept for 5 s, so Search's exact-URL reuse rule is unchanged even with "Ignore URL fragments" on. Tabs opened by other extensions cannot be identified; the never list covers them.

No permission is added: `tabs`, `storage` and `notifications` are already in both manifests.

Not covered by the probe and left to real-browser acceptance tests: native Duplicate Tab from the tab context menu (the probe used `tabs.duplicate`), Open All in Tabs, Chromium external-app links, and Firefox startup restore.

### Ask first (R14.11)

`core.js` adds `dupeAction` (mode to action), `isAskPageUrl`, `authorizeAskMessage`, `askOutcome` and `addAskEntry`. The service turns a `switch` verdict into a prompt in Ask first mode: it records `{matchId, url, key, ctx, title}` under the tab ID in the store's `asking` map (at most 50, oldest dropped and simply kept), marks the record `asking`, and navigates the tab to `ask.html` with `tabs.update`. A failed navigation keeps the tab.

`ask.html`/`ask.js` ask the background `dupeAskInfo` and send `dupeAskChoice` with only `switch` or `keep`. `background.js` routes those two commands to the service before the popup/options trust check; the service accepts them only from this extension's `ask.html` in a tab that has a prompt entry, and takes the URL and the open copy from the entry. Switch re-reads the open copy (`askOutcome`): same page, container and context, or the tab keeps its page instead. Keep both returns the URL to the page, which calls `location.replace(url)`, so the tab's history holds the page and not the prompt.

Real-browser findings: in both Firefox 161 and Chromium 145 the original page entry before the prompt is not reachable with Back (Firefox reports `canGoBack: false`; Chromium's `tabs.goBack` fails with "Cannot find a next page in history"), because both skip an entry the user never interacted with. Pressing Back on the prompt therefore does nothing; the prompt stays usable. `tabs.goBack` from the extension still worked in Firefox. The service therefore restores a page (open copy closed, or a prompt with no entry) with `tabs.goBack`, then `tabs.goForward`, then `tabs.update(url)` when the URL is known; a restored prompt with nothing to restore says so on the page.

Harness rows A1-A10 (`scripts/test-dupes.mjs`) cover the prompt, Enter to switch, Keep both and Back afterwards, Back on the prompt, the open copy closing, Ctrl+W then Ctrl+Shift+T on a prompt, opened-from-match, a bulk open, a private window, and Firefox containers.
