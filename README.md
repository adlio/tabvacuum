# TabVacuum

<!-- badges will be added once CI and store listings are live (T48) -->

A browser extension for power-user tab management. Works in Firefox and Chrome.

## Features

- **Search Tabs** — live fuzzy title/URL search with exact matches first; arrow keys highlight, Enter focuses the tab and its window, Escape dismisses. Empty queries show the 10 most recently focused tabs, forcing the current tab last before applying the limit. Typed queries give the current tab no special treatment.
- **Close Duplicate Tabs** — deduplicate by URL across all windows
- **Merge All Windows** — consolidate every tab into the current window
- **Sort Tabs** — by URL, title, last accessed, or visit count (ascending/descending)
- **Close Stale Tabs** — prune tabs untouched for a configurable period
- **Close Blank Tabs** — remove new-tab pages, welcome pages, and search engine homepages

Accessible via toolbar popup, tab right-click menu, and keyboard shortcuts.

## Install

**Firefox**: Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tabvacuum/)

**Chrome**: Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/tabvacuum/hhhpnpjhdjfhdflffpgnknlmbfogachb)

### Install from Source

1. Clone this repository
2. `npm install`
3. `npm run build`

**Firefox**:
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `dist/firefox/manifest.json`

**Chrome**:
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/chrome/` directory

## Keyboard Shortcuts

| Action | Default Shortcut |
|---|---|
| Close Duplicates | `Alt+Shift+D` |
| Merge Windows | `Alt+Shift+M` |
| Sort Tabs | `Alt+Shift+S` |
| Search Tabs | `Alt+Shift+K` (`Cmd+Shift+Space` on macOS) |
| Close Stale Tabs | *(unassigned — set manually)* |
| Close Blank Tabs | *(unassigned — set manually)* |

Chrome allows at most four suggested shortcuts per extension. **Close Stale Tabs** and **Close Blank Tabs** ship without defaults. Existing user-assigned bindings remain managed by the browser; check the browser's shortcut settings after upgrading. Search uses Alt+Shift+K because Firefox on Linux intercepts Alt+Shift+F for its File menu and Chromium reserves Alt+Shift+X for tab-group navigation. You can assign shortcuts yourself:

**Firefox**: remap in `about:addons` → gear icon → "Manage Extension Shortcuts".
**Chrome**: remap in `chrome://extensions/shortcuts`.

## Settings

Access via the browser's extension settings page (TabVacuum → Preferences/Options).

- Stale tab threshold (default: 7 days)
- URL normalization for duplicate detection (ignore fragments, ignore query params)
- Protected tab behavior (skip pinned, skip audio-playing)

## Development

```bash
npm install           # Install dev dependencies
npm test              # Run unit tests (Vitest)
npm run build         # Build dist/firefox/ and dist/chrome/
npm start             # Build + launch Firefox with extension loaded
npm run start:chrome  # Build + launch Chromium with extension loaded
npm run package       # Build + create zip files in artifacts/
npm run lint          # Lint Firefox extension (web-ext lint)
```

`npm start` and `npm run start:chrome` use `web-ext run` to open a
temporary browser profile with the extension installed. The browser
auto-reloads when files in the dist directory change, so the workflow is:
edit source, run `npm run build` in another terminal, and the browser
picks up the changes.

The `npm run package` command produces upload-ready zip files in `artifacts/`.

See `docs/prd.md` for requirements, `docs/design.md` for architecture, and
`docs/tasks.md` for the implementation task list.

## Tab search and browser tests

Search opens a centered command palette over the current web page, from the TabVacuum toolbar menu or its keyboard command. The scope is **all windows** by default; change it to **current window only** on the Settings page. Normal and private-window results are kept separate. Typing only searches: it never hides, moves, closes, or selects browser tabs as a group. Arrow keys highlight; Enter selects the tab and focuses its window. Escape or a backdrop click dismisses and restores page focus. Tab and Shift+Tab stay inside the palette.

### Close tabs from search

Inline hints change with focus, so the controls are available without memorizing them:

- **Search field**: type to search, arrows to highlight, Enter to switch. Every row has an × button that closes only that row. Backspace/Delete and Cmd+A/Ctrl+A keep editing the query. Tab enters the tab menu, without selecting multiple tabs.
- **Tab menu**: arrows or j/k move the highlight; Enter switches tabs. x or Delete closes the highlighted tab (Backspace also supports the Mac Delete key). Closing keeps the tab menu and query open, with the next row at the same position highlighted. `j, x, j, x, j, x` closes alternating original rows. Fast navigation/close keystrokes are processed in order; mode/focus changes or a partial failure cancel pending keystrokes.
- **Select multiple**: press m in the tab menu or click Select multiple. Space (labelled Toggle Selection) or Enter toggles a checkbox; a selects every current result, including those below the scroll. Cmd+A on Mac or Ctrl+A elsewhere also works in this mode. With an empty query, select-all covers only the ten listed recent tabs. Tabs arriving later remain unchecked.
- **Close selected**: x, Delete/Backspace or Close N tabs closes only the checked tabs. With nothing checked, these batch actions do nothing. A row's × always closes that row alone, even while other tabs are checked. Closing stays in multi-select mode, including with zero matches; held close keys never repeatedly close neighbours.
- **Step back**: m, Done or Escape leaves multi-select and clears checks, returning to the tab menu. Another Escape returns to the query; another dismisses search. Focusing the query directly returns to search and clears checks. No browser-native tab multi-selection is changed.

To close every current match: type `amazon`, then Tab → m → a → x (or Delete).

Closures are immediate after the explicit Close action. The current/active tab may be closed, including as part of a batch. If it hosts the palette, the background closes it last and finishes the accepted batch; the palette then disappears. Otherwise search and the query stay open. Configured pinned/audio protections and the last-tab-in-window safeguard still apply, with skips and failures explained inline. Existing automatic cleanup actions retain their active-tab protections. Use the browser's Reopen Closed Tab command to recover closed tabs; unsaved page state is not guaranteed to recover.

### Expand the search (0.5.0)

Open tabs are always searched. Use **Search in** beside the query to independently add **History** or **Page contents**, or both. Extras start off each time the palette opens; the query is preserved when sources change. Shift+Tab from the query reaches Search in. Escape closes the source menu before stepping back through the palette modes.

- **History** searches visited page titles and URLs using the browser's native matching across its full stored history, not just the last day. It retrieves up to the latest 100 matching unique pages, then ranks them below open tabs. Exact URLs are deduplicated without stripping query parameters or fragments. An already-open exact URL appears as the open tab rather than another history row; multiple real open tabs remain separate. History entries have no × or checkbox and can never be closed/deleted by search. Enter opens the page in a new tab, or focuses an eligible exact-URL tab if one is now open. History is unavailable in private search.
- **Page contents** searches rendered text in loaded website tabs only. First choose **Enable in Settings**, then **Allow website access** and approve the browser prompt. Reopen Search in and check Page contents; granting access alone does not start a scan. Settings also provides Remove website access. The browser retains this optional permission, while the two source toggles reset every launch.
- **Matching and coverage:** ordinary tab title/URL search keeps its fuzzy ranking. Contents requires all query terms to match literally, ignoring case, and adds a snippet without duplicating a tab already matched by title/URL. It reads main-document text only—not form controls, editable regions, hidden content, iframes or shadow roots. Sleeping/loading/protected tabs are skipped, not loaded. The status line reports searched/skipped counts and partially searched long pages. Each request examines at most 100 eligible tabs, with four scans at a time; each page is bounded to 100,000 text characters, 10,000 visited nodes and a 75ms traversal budget (1.5s request timeout). Expanded queries have a 256-character limit, explained inline; normal tab search remains available for longer queries.
- **Responsive and local:** open-tab results appear immediately while extras load. Late results preserve the highlighted target; if it disappears, another tab is not silently armed for closing. Typing a new query, turning extras off, or ending search cancels pending scans. Scripts already running finish within their bounds and their cancelled results are discarded. Queries and snippets are not saved or sent off the device. There is no background content index.

The shadcn-inspired UI uses native CSS and JavaScript, with no framework or remote assets. Default tab-only queries stay in the search frame. When an extra source is enabled, its query goes to the authorized background handler; content matching runs in the isolated world of the selected loaded pages and returns only matching snippets. Focus timestamps and short-lived launch metadata live in session storage, not persistent browsing history.

### Permissions and privacy

- `activeTab` grants temporary access to the current page after you invoke search. `scripting` mounts the palette there. There are no required broad host permissions or always-running content scripts. Page-content search separately requests optional HTTP/HTTPS website access through Settings, and runs only when explicitly selected in the palette.
- The palette lives in an extension-origin iframe inside a closed shadow tree. The page cannot read its query, titles, or URLs. The launch token is not in the page DOM or iframe URL. Each privileged search request is checked against its token, tab, frame, and privacy context. The only message sent back to the page is a data-free dismissal signal.
- On browser-internal pages, local files, and pages where injection fails, search opens in a separate extension-owned window, centered over the browser. That fallback has OS-managed window chrome. It closes after selection or Escape; it never navigates the source tab. Its short-lived token appears only in the extension-owned window URL, not a website URL, and is bound to that exact tab/frame.
- Private access must be enabled in the browser's extension settings. Chrome uses split incognito execution to support the protected-page fallback. Chrome still shares extension session storage between its workers; distinct session keys prevent normal/private launches overwriting each other. Private results never appear in normal search.
- Websites can notice that an overlay opened, remove it, or draw their own imitation; in-page UI cannot prevent a hostile site from interfering with its own page. The public frame resource also makes extension-installation fingerprinting possible. This does not grant access to tab data. Only the search HTML is web-accessible; unauthorized frames cannot obtain results or invoke cleanup/settings commands.

Firefox 115+ and Chrome 127+ are supported by the manifests. Firefox's embedded frame has a restricted API surface, so an authorized visible search refreshes once per second there; Chromium refreshes on tab events. Persistent filtering and deep content indexing remain deferred.


Run `npm run test:browsers` on Linux with Python 3, Xvfb, X11/XTest libraries, ffmpeg, Firefox, geckodriver, and Chromium installed. The tests use real built extensions, in-page palettes, protected-page fallback windows, native toolbar menus, and local fixture tabs in fresh profiles, with no mocked browser APIs. Test pages bind only to loopback. Set `KIROCREW_SCRATCH` (or `TMPDIR`) to a disposable test directory. Optional paths are `FIREFOX_BINARY`, `GECKODRIVER`, `CHROMIUM_BINARY`, and `XVFB_BINARY`. Firefox/geckodriver/Xvfb default to the session's `browsers/` install; Chromium defaults to Playwright's browser. On hosts with locally extracted Xvfb libraries, the harness also searches `browsers/usr/lib64` under scratch.

Screenshots go under `tabvacuum-firefox/` and `tabvacuum-chromium/` in scratch. `RECORD_BROWSER=1 npm run test:chromium` additionally records the actual desktop flow to MP4. Firefox uses its native Marionette actor for popup content because ordinary WebDriver frame APIs exclude these remote extension views. Physical shortcut keys are sent through XTest on the isolated X display. This verifies Linux browser behavior; it does not claim OS-level macOS shortcut testing.
