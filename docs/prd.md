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
  - Close Stale: `Alt+Shift+X`
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
