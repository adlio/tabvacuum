# TabVacuum - Product Requirements Document

## Overview

TabVacuum is a cross-browser WebExtension (Firefox + Chrome) for power-user tab
management. It provides bulk operations for cleaning up, organizing, and pruning
browser tabs across all windows.

## Target User

Power users with 50+ tabs across multiple windows who want fast, keyboard-accessible
tools to tame tab sprawl without leaving the browser.

## Terminology

- **Stale tab**: A tab whose `lastAccessed` timestamp is older than a user-configured threshold.
- **Duplicate tab**: Two or more tabs sharing the same URL (after normalization).
- **Active tab**: The currently focused tab in a window. Never auto-closed or moved destructively.
- **Protected tab**: A pinned tab or a tab playing audio. Excluded from bulk-close operations by default.

---

## Requirements

### R1 - Close Duplicate Tabs

- **R1.1**: Identify duplicate tabs by URL across all open windows.
- **R1.2**: When duplicates exist, keep the oldest (first-opened) instance and close the rest.
- **R1.3**: Never close the active tab. If the active tab is a duplicate, close the other instances instead.
- **R1.4**: Never close pinned tabs. If a pinned tab is a duplicate of an unpinned tab, close the unpinned one.
- **R1.5**: Display a count of closed duplicates after the operation completes (e.g., "Closed 7 duplicate tabs").
- **R1.6**: URL comparison should normalize trailing slashes and optionally ignore URL fragments (`#...`) and query parameters (`?...`), configurable via settings (R5).

### R2 - Consolidate All Tabs to One Window

- **R2.1**: Move all tabs from all open windows into a single target window.
- **R2.2**: The target window is the currently focused window.
- **R2.3**: Preserve tab order within each source window (append each window's tabs in the order they appeared).
- **R2.4**: Close empty windows after all tabs have been moved out.
- **R2.5**: Display a count of consolidated tabs/windows (e.g., "Merged 3 windows (42 tabs)").

### R3 - Sort Tabs

- **R3.1**: Sort tabs in the current window by one of the following criteria:
  - **R3.1a**: URL (alpha or reverse alpha)
  - **R3.1b**: Title (alpha or reverse alpha)
  - **R3.1c**: Last Accessed (most recent first)
  - **R3.1d**: Visit Count (most visited first, using `history.search()` visitCount)
- **R3.2**: Pinned tabs are never moved. Sorting applies only to unpinned tabs.
- **R3.3**: The sort applies to the current window only.
- **R3.4**: Display the sort criteria used after the operation (e.g., "Sorted 28 tabs by URL").

### R4 - Close Stale Tabs

- **R4.1**: Close all tabs whose `lastAccessed` timestamp is older than a user-configured threshold.
- **R4.2**: The default threshold is 7 days. Configurable via settings (R5).
- **R4.3**: Never close the active tab, pinned tabs, or tabs currently playing audio.
- **R4.4**: Display a count of closed tabs and the threshold used (e.g., "Closed 12 tabs not accessed in 7 days").

### R5 - User Settings

- **R5.1**: Provide an options page accessible from the browser's extension management UI.
- **R5.2**: Configurable settings:
  - **R5.2a**: Stale tab threshold (default: 7 days). Input as a number with a unit selector (hours/days).
  - **R5.2b**: URL normalization for duplicate detection: toggle to ignore fragments, toggle to ignore query parameters (both default off).
  - **R5.2c**: Protected tab behavior: toggle to skip pinned tabs (default on), toggle to skip tabs playing audio (default on).
- **R5.3**: Settings are persisted via `browser.storage.local`.

### R6 - User Interface

- **R6.1**: **Toolbar popup** — primary UI with a button for each action (R1-R4) and a sort-criteria dropdown for R3.
- **R6.2**: **Tab context menu** — right-click any tab to access all actions. Items appear at the top level of the tab context menu (not nested under a submenu). Note: both Firefox and Chrome automatically group an extension's context menu items into a submenu named after the extension when there are more than one. This is browser-enforced and cannot be overridden. The items should be well-organized within this automatic grouping, with a "Sort By" submenu for the four sort criteria.
- **R6.3**: **Keyboard shortcuts** — one shortcut per action, user-remappable via browser settings. Default bindings:
  - Close Duplicates: `Alt+Shift+D`
  - Merge Windows: `Alt+Shift+M`
  - Sort Tabs: `Alt+Shift+S` (uses last-selected sort criteria)
  - Search Tabs: `Alt+Shift+K` (`Command+Shift+Space` on macOS)
  - Close Stale and Close Blank: unassigned (manually assignable)
- **R6.4**: After every operation, display a brief notification (via the popup if open, or `browser.notifications` if triggered via keyboard/context menu).

### R7 - Safety

- **R7.1**: Never close the last remaining tab in a window (browsers require at least one tab per window).
- **R7.2**: Never close the active tab in any window via bulk operations.
- **R7.3**: All close operations should be undoable via the browser's built-in "Undo Close Tab" (`Ctrl+Shift+T`). The extension relies on the browser's native session restore for this; no custom undo stack is needed.

### R8 - Platform

- **R8.1**: Manifest V3 (current standard for both Firefox and Chrome).
- **R8.2**: Cross-browser: Firefox and Chrome (including Chromium-based browsers like Edge, Brave, etc).
- **R8.3**: Use `browser.*` API namespace with `webextension-polyfill` for Chrome compatibility.
- **R8.4**: Separate manifest files per browser where needed (Firefox uses background scripts; Chrome uses service workers).
- **R8.5**: Minimal build step: a script to assemble browser-specific `dist/` directories from shared source.

### R9 - Testing

- **R9.1**: Unit tests via Vitest for all core logic (pure functions extracted from browser API calls).
- **R9.2**: Browser API interactions are mocked in tests using manual mocks (no third-party mock libraries).
- **R9.3**: `web-ext lint` runs in CI to validate the extension structure.
- **R9.4**: All tests and linting must pass before merge (enforced by GitHub Actions on PRs).

### R10 - Distribution

- **R10.1**: Published to [Firefox Add-ons](https://addons.mozilla.org) (AMO).
- **R10.2**: Published to the [Chrome Web Store](https://chromewebstore.google.com).
- **R10.3**: GitHub Releases created automatically on version tags.
- **R10.4**: CI/CD pipeline automates building, testing, and publishing to both stores on tagged releases.
- **R10.5**: README includes badges for CI status, Firefox Add-ons, and Chrome Web Store.

### R11 - Tab Search

- **R11.1**: Open search from a TabVacuum toolbar-menu item or the default Alt+Shift+K shortcut (Command+Shift+Space on macOS). Remove the Close Stale Tabs default, retaining its command and all cleanup actions. Keep four suggested shortcuts. Show actual user-assigned shortcuts as platform-native keycaps; do not overwrite existing assignments.
- **R11.2**: Search tab titles and URLs while typing. Fuzzy matching is enabled by default; exact/literal matches outrank fuzzy matches. Results show titles, URLs, match source, and other-window context without runtime configuration controls.
- **R11.3**: For an empty/whitespace-only query, sort by most recent focus descending and force the current tab last, then take the first 10. With two tabs, the other tab is first; with one, the current tab remains selectable. For every nonempty query, apply no current-tab ranking exception.
- **R11.4**: Arrow keys move the highlighted result without activating tabs. Enter activates that tab and focuses its window without moving the tab. Escape dismisses without navigation. Clicking a result also selects it.
- **R11.5**: Search all windows by default. Offer current-window-only scope on the Settings page, not the search UI. Keep normal and private window results separate.
- **R11.6**: Use the same search UI across Firefox and Chrome and verify real built extensions in isolated browser profiles on kirodesk. Do not substitute mocked browser APIs for these acceptance tests.
- **R11.7**: Persistent filtering and deep content indexing remain deferred. R12 adds only explicit history and loaded-page content search. No Tree Style Tab integration, audio-tab search, runtime fuzzy slider, or automatic hiding/multi-selection.
- **R11.8**: Present a centered in-page command palette with shadcn-inspired neutral light/dark styling, compact two-line results, visible keyboard selection, and no settings controls. Use native CSS/JS, not a UI framework. Constrain the palette to the viewport and keep Tab/Shift+Tab focus inside it; Escape and backdrop dismissal restore the page's prior focus.
- **R11.9**: For default tab search use `activeTab` and `scripting` only after user invocation, without required broad host permissions or permanent content scripts. Optional page-content access follows R12's explicit permission flow. Isolate titles, URLs, queries, and launch authorization from website scripts. Bind privileged messages to the launch token, tab, frame, and private/normal context. Never expose generic cleanup/settings operations to the embedded search page; explicit closing uses the same validated search capability and scope.
- **R11.10**: When the current page cannot host search, use a separate centered extension-owned window without navigating the source tab. Support private-window fallback with Chrome split incognito execution; keep normal/private worker session keys distinct. Revoke sessions on dismissal, activation, replacement, navigation, and tab closure; reject expired or replayed authorization.
- **R11.11**: Provide explicit tab closing using an × button on each result row, closing only that row even when other rows are checked. Tab enters tab-menu mode without checkboxes. In that mode arrows/j/k navigate, Enter activates, x/Delete closes the highlight, and m enters multi-select. In multi-select use arrows/j/k, Space/Enter to Toggle Selection, and a (or platform Cmd/Ctrl+A) to select the current result snapshot including off-scroll results. x/Delete and Close N tabs close checked tabs only, never an unchecked fallback. Empty-query select-all is limited to ten recent results; later arriving tabs stay unchecked. Keep browser-native multi-selection unchanged.
- **R11.12**: Show mode-specific inline hints, a mode indicator, and a selected count. Show a header Close N tabs button only in multi-select; individual closing belongs on rows. x/Delete/Backspace closes only with result focus; text editing retains its normal keys. Escape steps multi-select → tab menu → search → dismissal; m or Done returns from multi-select to tab menu. Query focus clears checks and returns to search. Keep keyboard focus inside the palette; row × controls must be keyboard accessible, retain native button activation and survive refresh without moving to an unrelated external replacement.
- **R11.13**: Close only explicitly targeted IDs immediately after Close. Allow the current/active tab even in a batch; close the host last and finish accepted work in the background. Preserve pinned/audio settings and last-tab protection, reporting skips/failures inline. Do not change automatic cleanup safeguards. Preserve query, current mode and keyboard focus even with zero matches. Highlight the next row at the same index so j/x sequences close alternating original rows. Preserve fast navigation/close keystroke order during asynchronous closing; cancel pending keys on focus/mode change or partial failure. Ignore key autorepeat and never hide post-close refresh failures.

### R12 - Expanded Search (0.5.0)

- **R12.1**: Open tabs are always included. A single Search in disclosure beside the query independently enables History and Page contents, including both together. Extras start off on each palette launch, preserve the query when changed, and show the enabled sources. Do not introduce persistent runtime settings, automatic source expansion, or another global shortcut.
- **R12.2**: Show all open-tab matches before History. Deduplicate history by the exact URL, keeping its most recent visit; preserve query parameters and fragments. An eligible open tab replaces its exact-URL history row, even when the old history title matched better. Multiple real open tabs remain separate. One tab matching title/URL and contents appears once with its snippet.
- **R12.3**: History searches title/URL using the browser's native matching over all stored time, returning up to the latest 100 candidates with a limit indicator. Repeated visits produce one row. History results never expose ×, checkboxes or deletion; multi-select covers only tabs. Enter revalidates the history URL, reuses a same-context exact-URL tab if available, or opens a new tab without navigating the source page. Permit HTTP/HTTPS results only, without embedded credentials. History is unavailable in private search.
- **R12.4**: Content search is explicit and limited to already-loaded website tabs in the configured window/privacy scope. Request optional HTTP/HTTPS host access only from a Settings button and browser permission prompt. Opening Settings or granting permission alone does not enable a source. Provide permission revocation. Keep required permissions unchanged and install no permanent content scripts.
- **R12.5**: Read rendered main-document text only. Exclude form values, editable regions, hidden elements, scripts/styles, frames, shadow trees and the search overlay. Match all terms literally, case-insensitive, with snippets at most 240 characters. Do not activate, reload, fetch or wake tabs. Report skipped and truncated coverage; bound each request to 100 eligible tabs with four concurrent scans, 100,000 characters/10,000 nodes/75ms per page and a 1.5s injection timeout. Expanded queries over 256 characters are explained rather than silently truncated.
- **R12.6**: Render ordinary open-tab results immediately. Preserve highlighted result identity when extra results arrive; if it disappears, disarm closing and clear queued list actions until deliberate navigation/selection. Cancel superseded/disabled/dismissed scans, discard results from revoked sessions or changed page URLs, and retain existing authorization and private-window separation. Running page scripts may finish within their bounds but their cancelled results are discarded.
- **R12.7**: Search queries and snippets are never persisted or sent off-device. Only explicitly expanded queries cross the authorized background boundary. Keep content processing out of the serialized close/launch queue. Tab, Escape, row closing and multi-select remain compatible with R11; Escape closes the source menu before changing palette mode. Shift+Tab from the query reaches Search in. Verify source controls, history deduplication, permissions and old closing flows in real Firefox and Chromium.
