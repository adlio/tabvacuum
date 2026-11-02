# Changelog

All notable changes to Aaron's Tab Vacuum are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before this file was introduced were reconstructed from the Git history
and the auto-generated GitHub release notes for each tag.

## [Unreleased]

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

[Unreleased]: https://github.com/adlio/tabvacuum/compare/v0.7.0...HEAD
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
