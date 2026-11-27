# Changelog

All notable changes to Aaron's Tab Vacuum are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before this file was introduced were reconstructed from the Git history
and the auto-generated GitHub release notes for each tag.

## [Unreleased]

## [0.10.0] - Unreleased

### Added
- **Bookmarks** in Search. Bookmarks are matched on title and URL, and each
  result shows its folder, such as "Bookmarks Bar › Work". The first time you
  turn Bookmarks on, the browser asks for bookmark access; you can remove that
  access again in Settings ([#24]).
- **Source buttons** under the search box: **Tabs · Bookmarks · History ·
  Contents**. They are always visible and show which sources are being searched.
  Click one to turn it on or off for this search. From the keyboard, press
  Shift+Tab from the query, move with the arrow keys and press Space. They
  replace the **Search in** menu.
- **Scope words.** Type `@tabs`, `@bookmarks`, `@history` or `@contents` (or
  `@t`, `@b`, `@h`, `@c`) to search only that source, or `@all` (`@a`) to search
  every source, page contents included. The word becomes a chip such as "Only
  bookmarks ×"; Backspace in an empty query removes it. Typing `@` lists the
  scope words.
- **A saved default.** Search still starts with Tabs only. When the sources on
  screen differ from your default, **Save as default** keeps them for next time,
  and Settings has a **Search by default** choice to view or reset it. Page
  contents can be searched on request but not saved as the default.
- **Counts for sources that are off.** A source button that's off shows how many
  more results it would add, such as "Bookmarks 3". When nothing matches, Search
  says what would ("No open tabs match. 3 bookmarks and 12 history pages do.")
  and Enter adds those sources for this search. Bookmarks are counted only after
  you've granted access, history is never counted in private windows, and page
  contents are never counted automatically.
- Results are grouped as Open tabs, Bookmarks, History, with a source label on
  every row. An open tab that is also bookmarked appears once, marked ★.
- Hints for the new controls: the placeholder reads "Search tabs · type @ for
  more", the key-hint footer shows `@` Sources, and each source button shows a
  one-time tip the first time you use it.

### Changed
- History stays on each time Search opens if you save it as part of your
  default; before, it turned off every time. After upgrading, Search starts with
  Tabs only, as before.

### Safety
- Bookmark access is an optional permission, so updating doesn't disable the
  extension or ask for anything up front. Search never edits or deletes
  bookmarks, and bookmark rows can't be closed or selected.
- Queries and counts stay on your device.

## [0.9.0] - 2026-11-26

### Added
- An **Ask first** mode for duplicate-tab prevention. With **Prevent duplicate
  tabs** on, Settings > Duplicate Detection now has a **When it happens** choice:
  **Switch to the open tab** (the default, so nothing changes if you already use
  it) or **Ask first** ([#20], [#22]).
- In Ask first mode, a new tab that would have been switched instead shows
  "Already open: <title>" with two buttons. **Switch** has focus, so Enter takes
  you to the open copy and closes the new tab. **Keep both** loads the page in
  the new tab and leaves both open.
- A duplicate that opens in the background gets its prompt there, and focus stays
  where it is. Everything Switch mode already keeps (tabs opened from their match,
  a reopen within a minute, bulk opens, restored tabs, pages opened by Search and
  the **Never on these sites** list) gets no prompt.

### Safety
- Ask first never closes a tab without asking. If the open copy closes or moves to
  another page while the prompt shows, or the prompt can't be shown, the new tab
  keeps its page.
- Duplicate-tab prevention is still off by default. No new permissions are
  requested.

## [0.8.0] - 2026-11-25

### Added
- Opt-in **Prevent duplicate tabs** in Settings > Duplicate Detection, off by
  default and off after upgrading. When a new tab opens a page that is already
  open in the same kind of window (and the same Firefox container), Tab Vacuum
  switches to the open tab and closes the new copy, about a quarter second after
  it opens. Only new tabs are checked; navigating inside an existing tab is never
  touched ([#20], [#21]).
- Copies you make on purpose are kept: Duplicate Tab, links on a page to the same
  page, pages that Tab Vacuum's Search opens, and a page you reopen within a minute
  of it being closed, so Reopen Closed Tab (Ctrl+Shift+T, or Cmd+Shift+T on a Mac)
  undoes a switch. The first switch shows one notification saying so.
- A **Never on these sites** list: one URL prefix, host name (such as
  `docs.example.com`) or `/regex/` per line.
- This release ships the Switch mode only. An "Ask first" mode is still to come.

### Safety
- Bulk opens are left alone: 3 or more tabs created in one window within 200 ms
  of each other, up to 1 s in total (for example Open All in Tabs), are all
  kept. Tabs opened 400 ms or more apart count as separate opens. Restored tabs,
  tabs that open with a new window or in the 10 s after browser startup, blank
  and browser pages, and the last tab in a window are never closed.
- If you move to another tab before a duplicate is handled, the duplicate is
  closed without changing focus. No new permissions are requested.

## [0.7.0] - 2026-11-02

### Added
- **Toggle Vertical Tabs** keyboard command (Firefox only), bound to `Alt+Shift+V`
  by default. Switches the tab bar between Firefox's horizontal strip and its
  native vertical sidebar in one keystroke, using the `browser.browserSettings`
  API available on Firefox 142+. The mechanism is adapted from
  [Vertical Tab Keyboard Toggle](https://github.com/AndreiMiculita/vertical-tab-keyboard-toggle)
  (MIT). The command is a no-op on browsers without the API, so Chrome is
  unaffected and keeps its four-shortcut set ([#17]).

## [0.6.0] - 2026-10-06

### Added
- Opt-in stale-tab cleanup. The Stale Tabs menu opens inline review controls
  showing an inactivity duration, the eligible tab count, and an explicit
  "Close N tabs now" action. Optional automatic cleanup runs hourly and shows
  its enabled state, count, and next local closing time on the main menu. It
  starts off after upgrading, preserves assigned shortcuts, and uses the
  `alarms` permission ([#16]).

### Changed
- Chrome measures stale age from a tab's last activation and preserves that age
  across clean restarts via a local timestamp-only correction journal.

### Safety
- Automatic cleanup excludes private windows and protects every window's active
  tab, plus pinned, audio-playing, and last-remaining tabs. Tabs with an unknown
  age are kept, not closed.

## [0.5.3] - 2026-10-03

### Changed
- Release-preparation and housekeeping for the 0.5.3 build; no user-facing
  behavior change ([#15]).

## [0.5.2] - 2026-10-02

### Fixed
- Keep the search panel open while closing tabs from it ([#14]).

## [0.5.1] - 2026-09-29

### Fixed
- Improve action feedback and unify the search keyboard shortcuts ([#12], [#13]).

## [0.5.0] - 2026-09-28

### Added
- History and page-content search, extending search beyond open tabs ([#11]).

## [0.4.0] - 2026-09-27

### Added
- Tab search and closing: find tabs fast and close them from the results ([#10]).

## [0.3.3] - 2026-07-12

### Fixed
- Chrome messaging, duplicate-close safety, and textarea whitespace handling ([#6]).
- Preserve pinned tabs when merging windows ([#7]).
- Limit suggested keyboard shortcuts to four to clear Chrome Web Store review ([#9]).

## [0.3.2] - 2026-03-10

### Fixed
- Correct the inverted sort direction for last-accessed, visit-count, and
  frecency sorts.

## [0.3.1] - 2026-03-07

### Added
- Inject the manifest version from `package.json` at build time, so the built
  extension version always matches the package ([#5]).

### Changed
- Add `chrome-webstore-upload-cli` for automated Chrome Web Store publishing ([#4]).
- Documentation: standardize AGENTS.md commands on npm scripts, and add Firefox
  and Chrome store links to the README ([#2], [#3]).

## [0.3.0] - 2026-03-07

### Added
- Close Blank Tabs action ([#1]).

## [0.2.0] - 2026-03-02

### Added
- First packaged release: popup menu with close-duplicates, merge-windows, and
  sort-tabs actions; frecency sort; ES-module background script; and the
  packaging scripts for Firefox and Chrome builds.

[Unreleased]: https://github.com/adlio/tabvacuum/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/adlio/tabvacuum/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/adlio/tabvacuum/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/adlio/tabvacuum/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/adlio/tabvacuum/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/adlio/tabvacuum/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/adlio/tabvacuum/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/adlio/tabvacuum/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/adlio/tabvacuum/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/adlio/tabvacuum/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/adlio/tabvacuum/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/adlio/tabvacuum/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/adlio/tabvacuum/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/adlio/tabvacuum/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/adlio/tabvacuum/releases/tag/v0.2.0
[#24]: https://github.com/adlio/tabvacuum/issues/24
[#22]: https://github.com/adlio/tabvacuum/pull/22
[#21]: https://github.com/adlio/tabvacuum/pull/21
[#20]: https://github.com/adlio/tabvacuum/issues/20
[#17]: https://github.com/adlio/tabvacuum/pull/17
[#16]: https://github.com/adlio/tabvacuum/pull/16
[#15]: https://github.com/adlio/tabvacuum/pull/15
[#14]: https://github.com/adlio/tabvacuum/pull/14
[#13]: https://github.com/adlio/tabvacuum/pull/13
[#12]: https://github.com/adlio/tabvacuum/pull/12
[#11]: https://github.com/adlio/tabvacuum/pull/11
[#10]: https://github.com/adlio/tabvacuum/pull/10
[#9]: https://github.com/adlio/tabvacuum/pull/9
[#7]: https://github.com/adlio/tabvacuum/pull/7
[#6]: https://github.com/adlio/tabvacuum/pull/6
[#5]: https://github.com/adlio/tabvacuum/pull/5
[#4]: https://github.com/adlio/tabvacuum/pull/4
[#3]: https://github.com/adlio/tabvacuum/pull/3
[#2]: https://github.com/adlio/tabvacuum/pull/2
[#1]: https://github.com/adlio/tabvacuum/pull/1
