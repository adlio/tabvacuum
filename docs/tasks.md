# TabVacuum - Task List

## Legend

- `[ ]` — Not started
- `[~]` — In progress (note agent/worker in parentheses)
- `[x]` — Complete

---

## Phase 1: Project Setup

- [x] **T1** — Initialize `package.json` with Vitest, web-ext, and chrome-webstore-upload-cli as dev dependencies (R8.5, R9)
- [x] **T2** — Create `vitest.config.js` (R9.1)
- [x] **T3** — Create `src/manifest.firefox.json` with all permissions, action, options_ui, commands (Design: Manifest)
- [x] **T4** — Create `src/manifest.chrome.json` mirroring Firefox manifest but with `service_worker` background (R8.4)
- [x] **T5** — Create `scripts/build.js` to assemble `dist/firefox/` and `dist/chrome/` from `src/` (R8.5, Design: Build Script)
- [x] **T6** — Create placeholder icon PNGs at `src/icons/icon-48.png` and `src/icons/icon-96.png`
- [x] **T7** — Add `webextension-polyfill` to the project and include in build output (R8.3)

### Checkpoint: Verify build produces loadable extensions
- [x] **T8** — Run `scripts/build.js`, load `dist/firefox/` in Firefox via `about:debugging`, load `dist/chrome/` in Chrome via `chrome://extensions` (developer mode). Confirm both load without errors and show the toolbar icon.

## Phase 2: Core Logic + Unit Tests

- [x] **T9** — Create `src/core.js` with `isProtected()` and `normalizeUrl()` helpers (R7.1-R7.2, R1.6, Design: core.js)
- [x] **T10** — Create `test/mocks/browser.js` with manual `vi.fn()` stubs for `browser.tabs`, `browser.windows`, `browser.storage`, `browser.notifications` (R9.2)
- [x] **T11** — Write unit tests for `isProtected()` and `normalizeUrl()` in `test/core.test.js` (R9.1)
- [x] **T12** — Implement `findDuplicates()` in `core.js` (R1.1-R1.6)
- [x] **T13** — Write unit tests for `findDuplicates()`: basic duplicates, active tab kept, pinned tab kept, URL normalization variants (R9.1)
- [x] **T14** — Implement `planMerge()` in `core.js` (R2.1-R2.5)
- [x] **T15** — Write unit tests for `planMerge()`: multiple windows, single window no-op, tab ordering (R9.1)
- [x] **T16** — Implement `planSort()` in `core.js` for URL, title, lastAccessed, visitCount, with direction (R3.1a-R3.1d, R3.2-R3.4)
- [x] **T17** — Write unit tests for `planSort()`: each criteria, ascending/descending, pinned tabs excluded (R9.1)
- [x] **T18** — Implement `findStaleTabs()` in `core.js` (R4.1-R4.4)
- [x] **T19** — Write unit tests for `findStaleTabs()`: threshold boundary, protected tabs skipped, active tab skipped (R9.1)

### Checkpoint: All unit tests pass
- [x] **T20** — Run `npx vitest run` and confirm all tests pass. Fix any failures.

## Phase 3: Background Wiring

- [x] **T21** — Create `src/background.js` with settings load/save using `browser.storage.local` (R5.3, Design: Settings)
- [x] **T22** — Wire `closeDuplicates()` in background.js: query tabs → call `findDuplicates()` → `tabs.remove()` (R1)
- [x] **T23** — Wire `mergeWindows()` in background.js: get windows → call `planMerge()` → execute moves → remove empty windows (R2)
- [x] **T24** — Wire `sortTabs()` in background.js: query tabs → enrich with visitCount if needed → call `planSort()` → execute moves (R3)
- [x] **T25** — Wire `closeStaleTabs()` in background.js: query tabs → call `findStaleTabs()` → `tabs.remove()` (R4)
- [x] **T26** — Implement `browser.runtime.onMessage` listener to route commands from popup/options (Design: Message listener)
- [x] **T27** — Register context menus with sort submenu and wire `contextMenus.onClicked` (R6.2, Design: Context menus)
- [x] **T28** — Wire `browser.commands.onCommand` to operations (R6.3)
- [x] **T29** — Implement `notify()` helper for feedback when popup is not open (R6.4)

### Checkpoint: Manual test core operations in Firefox
- [ ] **T30** — Build and load in Firefox. Open 5+ duplicate tabs, run Close Duplicates via keyboard shortcut. Verify correct tabs closed and notification shown.
- [ ] **T31** — Open tabs across 3+ windows. Run Merge Windows. Verify all tabs consolidated and extra windows closed.
- [ ] **T32** — Run each sort variant (URL, title, last accessed, visit count) via context menu. Verify tab order changes.
- [ ] **T33** — Wait or manually set old `lastAccessed`, run Close Stale. Verify only stale tabs closed.

### Checkpoint: Manual test core operations in Chrome
- [ ] **T34** — Build and load in Chrome. Repeat T30-T33 in Chrome. Note any behavioral differences.

## Phase 4: UI Surfaces

- [x] **T35** — Create `src/popup.html` + `src/popup.js` + `src/popup.css` with action buttons and sort dropdown with direction toggle (R6.1)
- [x] **T36** — Wire popup buttons to send messages to background and display result messages (R6.1, R6.4)
- [x] **T37** — Create `src/options.html` + `src/options.js` + `src/options.css` with settings form (R5.1-R5.2)
- [x] **T38** — Wire options page to load/save settings via messages (R5.1-R5.2)

### Checkpoint: Manual test all UI surfaces
- [ ] **T39** — In Firefox: test each operation via popup, context menu, and keyboard shortcut. Verify notifications, popup status text, and options persistence across restart.
- [ ] **T40** — In Chrome: repeat T39.

## Phase 5: CI/CD Pipeline

- [x] **T41** — Create `.github/workflows/ci.yml`: install deps, run vitest, run build, run `web-ext lint` on PR (R9.3-R9.4)
- [x] **T42** — Create `.github/workflows/release.yml`: trigger on `v*` tags, build, zip, create GitHub Release with artifacts (R10.3)
- [x] **T43** — Add Firefox Add-ons publishing step to `release.yml` using `web-ext sign` (R10.1, R10.4)
- [x] **T44** — Add Chrome Web Store publishing step to `release.yml` using `chrome-webstore-upload-cli` (R10.2, R10.4)

### Checkpoint: Verify CI pipeline
- [ ] **T45** — Push a branch with a failing test. Confirm CI blocks the PR. Fix the test, confirm CI passes.
- [ ] **T46** — Create a `v0.1.0` tag and push. Confirm release.yml creates a GitHub Release with Firefox and Chrome zips attached.

## Phase 6: Polish + Release

- [ ] **T47** — Design and export final icon set (48px and 96px) (R6.1)
- [ ] **T48** — Update README.md: badges (CI status, Firefox Add-ons, Chrome Web Store), install links for both stores, development setup with `npm install` / `npm test` / `npm run build` (R10.5)
- [ ] **T49** — Test edge cases in both browsers: single tab window, all tabs pinned, no duplicates found, zero stale tabs, window with only active tab (R7)
- [ ] **T50** — Set up Firefox Add-ons developer account and create initial listing (R10.1)
- [ ] **T51** — Set up Chrome Web Store developer account, Google Cloud project, OAuth credentials (R10.2)
- [ ] **T52** — Configure GitHub Secrets for both store environments (Design: Required GitHub Secrets)
- [ ] **T53** — End-to-end release test: tag `v0.1.0`, confirm GitHub Release created, confirm published to both stores.

## Tab Search — R11 (2026-09-27, Kiro)

- [x] **T54** — Implement live fuzzy title/URL ranking and empty-query recency/current-last behavior; cover one/two/many tabs and no typed-query current-tab penalty.
- [x] **T55** — Add search popup, toolbar-menu entry, Alt+Shift+K default, arrow/Enter/Escape behavior, and cross-window activation. Retain Close Stale Tabs unbound.
- [x] **T56** — Add Settings-only search scope, session-only focus tracking, and normal/private search separation without new permissions.
- [x] **T57** — Verify both real extension builds on kirodesk: 142 unit tests, Firefox lint clean, 24 Firefox and 26 Chromium browser assertions. Includes physical shortcut delivery, native popup layout, 150-tab scrolling, settings persistence, safe title rendering, and cross-window selection. Capture real screenshots and a Chromium-flow recording. No macOS execution claimed.
- [ ] **T58 (P1)** — Design persistent filtering and its clear/active UI; validate browser API feasibility before implementation.
- [x] **T59 (P2 → 0.5.0)** — Implemented opt-in search of loaded main-page contents under Search in, with an optional website-access grant in Settings. Sleeping tabs, embedded frames and persistent indexing remain excluded; see T65/R12.
- [x] **T60** — Human review accepted on 2026-09-27; user requested a PR and release for both stores. Release candidate is 0.4.0; publication remains pending the merged release tag and store review.
- [x] **T61 (Kiro)** — Replaced toolbar-anchored search with a centered shadcn-inspired in-page palette in vanilla CSS/JS (R11.2, R11.4, R11.6, R11.8-R11.10). Added approved activeTab/scripting permissions, extension-frame capability/sender isolation, protected-page fallback, and Chrome split-private session keys. Verified 256 unit tests, 86 Firefox 148 checks, 93 Chromium 145 checks, clean Firefox extension lint, native focus/shortcuts, contrast, narrow layout, normal/private overlay and fallback, navigation and worker restart. Source security review passed; light/narrow UX review passed and Kiro inspected dark rendering. Packaged unsigned development archives; no commit, push, signing or store submission. macOS and minimum-version execution remain for release validation.
- [x] **T62 (Kiro)** — Polished the centered palette and toolbar menu with shared light/dark tokens, grouped actions, outline icons, stronger selection, local fallback page icons, and accessible native keycaps for actual browser-assigned shortcuts (R6.1, R6.3, R11.2, R11.4). Set the user-approved macOS default to Command+Shift+Space; retain Alt+Shift+K elsewhere and never overwrite user assignments. Verified 275 unit tests, 93 Firefox 148 checks, 101 Chromium 145 checks, build/package byte equality and clean extension lint. Native menu tests cover both themes, keycaps, sort expansion, overflow and 4.5:1 text contrast. Cold-user visual review found no blockers; applied presentation findings and rejected its typed-query current-tab demotion. Ranking, permissions and extension-frame isolation unchanged. macOS physical shortcut execution still needs user verification; no commit/push/release.
- [x] **T63 (Kiro)** — Added explicit single/selected tab closing, Tab-to-selection, platform select-all of the current result snapshot, count-labelled Close button, and inline hints that follow focus (R11.11–R11.13). Current/active tabs can close; background closes the origin last and finishes accepted batches. Pinned/audio preferences and last-tab safeguards retained; generic cleanup/settings admission unchanged. Fixed review findings: repeat deletion after a checked batch cannot silently close an unchecked neighbour, Close stays locked through final refresh, confirmed closed rows are removed even if refresh fails, and refresh failures remain visible. Verified 369 unit tests, 174 Firefox 148 checks, 192 Chromium 145 checks, clean extension lint/build/package, dark/light/narrow/low-height hints, real keyboard/pointer close, query editing, native selection unchanged, new arrivals unchecked, protected-page fallback, and cross-window origin-last completion. Independent source review found no security blockers; correctness findings fixed and tested; final cold-user screenshot review found no blockers. No macOS physical-key verification, commit, push or marketplace release.
- [x] **T64 (Kiro)** — Refined closing per Mac feedback: row × controls; separate search/tab-menu/multi-select modes; Tab enters navigation, m enters multi-select, a selects the current snapshot, x/Delete closes highlighted or checked targets by mode. Space caption is Toggle Selection. All close paths retain mode/focus even with zero results; no checked-to-highlight fallback. Fixed review findings: queued rapid navigation/close keys in order; cancelled pending keys on focus/mode changes or partial failure; retained focused row-X identity across refresh; corrected button semantics to grid/row/gridcell and prevented IME Tab interception. Retained Backspace for the Mac Delete key. Verified 383 unit tests, 252 Firefox148 full checks, 272 Chromium145 full checks, plus Chromium119 closing-only rerun of shared observer fix. Native j/x burst (six presses in ~120ms) closes alternating original rows; row X keyboard/pointer closes only its own row; scope, protections, original ranking and auth regression tests pass. Screenshot UX review found no blockers; build/package/lint pass. Mac physical-key execution remains unverified; nothing committed/pushed/released.

## Expanded Search — 0.5.0 (R12, Kiro)

- [x] **T65 (Kiro)** — Implemented 0.5.0 opt-in History and loaded Page contents under one compact Search in disclosure. Open tabs remain first; exact-URL history dedup keeps query/fragment distinctions and never deletes history. Extras reset each palette launch. Content access is granted/revoked explicitly in Settings through browser prompts; reads are bounded and skip sleeping/loading/protected pages, form/editable/hidden text, frames and shadow roots. Late source replies preserve target identity; vanished targets disarm closing. Session ending, source changes and permission revocation cancel scans/discard results without blocking the close queue. Verified 540 unit tests, 324 Firefox148 checks, 348 Chromium145 checks, clean build/package/lint and 26-file archive/source equality per browser. Native tests cover real history visits/dedup/activation, permission denial/grant/revoke, content-only snippets, loaded-only coverage, private separation, narrow layouts and existing0.4 closing. Focused security review and cold-user screenshot review passed. Permission persistence across browser restart, minimum browser versions and physical macOS keys not separately tested. No commit, push or store release.

## macOS search shortcut (R6.3, R11.1)

- [x] **T67 (Kiro)** — Set the macOS Search tabs default to Command+Shift+K in Firefox and Chrome, replacing the Slack mute conflict. Alt+Shift+K elsewhere, four suggested commands, and browser-owned user assignments remain unchanged. Updated README, requirements and design; added K keycap coverage and retained legacy Space rendering coverage. The shortcut-only branch passes 541 unit tests, both builds and extension lint. Physical macOS shortcut execution remains unverified. No version bump or store release.

## Consistent shortcut and action feedback (R6.1, R6.3, R6.4, R11.1)

- [x] **T68 (Kiro)** — Implemented approved option B: Command+Shift+Period on macOS and Ctrl+Shift+Period elsewhere, preserving browser-owned assignments and the four-command limit. Sort/Merge/cleanup show an immediate busy label and spinner, prevent repeat actions, collapse the sort submenu so progress fits, close on success/no-op, and report through background system notifications from all three entry points. Failures stay visible; notification-only failures preserve the completed result. Search-palette closing remains unchanged. Verified 619 unit tests, both builds, clean extension lint, focused native Firefox/Chromium popup and shortcut checks, plus 172 Firefox and 189 Chromium closing/expanded-search checks. Source and cold-user visual review completed; fixed submenu overflow and pointer-focus recovery, clarified Escape, and asserted the recorded sort result. Physical macOS/Windows keys, native screen-reader announcements and OS notification-banner visibility remain unverified. Combined changes target PR #12; no branding, version bump, merge or release.

## 0.5.1 release preparation (R10)

- [x] **T69 (Kiro)** — Prepared the version-only 0.5.1 candidate from merged main, aligned package and lockfile root versions without dependency changes, and verified both browser ZIPs contain version 0.5.1 with 26 files matching each build. All 619 unit tests, both builds/packages and extension lint pass. No code, permission, branding, tag or store-publication changes.

## 0.5.2 search closing fixes and release preparation (R10, R11.11–R11.13)

- [x] **T70 (Kiro)** — Restored bundled post-close context, parallel independent reads and unchanged-row reuse for repeated search closing. Display order survives browser activation and handoff until the query changes; queued keys keep their order for ordinary closes. Prepared 0.5.2 package/lockfile metadata without dependency, branding or keyboard-semantic changes. All 679 unit tests, both builds/packages and extension lint pass. Earlier scratch-build speed measurements were not reused as evidence for this reconstruction.
- [x] **T71 (Kiro)** — Search survives host closing using an authenticated loaded, already-permitted same-window replacement, with a standalone fallback. State, checks, source choices, order and focus transfer; dismissal cancels, invalid replacements cannot start removal, and a replacement lost mid-batch leaves the host and reports the partial result. Pending sessions are bounded and reconciled after worker restart. Fallback selects an already-loaded survivor when available to avoid Firefox waking a sleeping neighbor. Native verification on fbbd498 passed 222 Firefox 157 and 239 Chromium 145 closing/expanded-search checks, including the exact Tab/x/j/j/x flow, repeated host closes, private separation, permissions, and sleeping tabs. Independent source review passed; a final activation-failure focus rollback has regression-unit coverage after that native run. Physical Mac/Windows behavior and minimum supported versions remain unverified. No merge, tag or store publication.

## 0.5.3 Aaron's Tab Vacuum branding (R6.1, R10)

- [x] **T72 (Kiro)** — Prepared the branding-only 0.5.3 candidate: display name Aaron's Tab Vacuum, short name ATV, approved Little Vacuum silhouette, store copy and public UI strings. Package name, gecko ID, storage keys, permissions, commands and shortcuts remain unchanged; only package/lockfile root versions changed to 0.5.3, with no dependency changes. All 716 unit tests (37 branding), both builds/packages and extension lint pass; each 55-file ZIP matches its build. Native Linux verification: Firefox 157 full suite 374/0 and action feedback 48/0; Chromium 145 full suite 398/0 and action feedback 48/0. Ten real 1280×800 store screenshots captured. A confirmed Chrome dark-toolbar contrast defect was corrected with six Chrome-only exports using the same silhouette; final native recapture measured 3.22:1 on #3c3c3c and 3.42:1 on white. Existing 24 PNGs and popup SVG remain byte-identical to the approved originals. Independent source review passed; exported PNG pixels now have a regression assertion, capture input methods are documented accurately, and an early setup-failure probe confirms no owned Xvfb process remains. Physical Mac/Windows behavior, arbitrary custom themes and OS notification banners remain unverified. Publication authorized for 0.5.3: commit, PR, merge after CI, and release-tag push. Signed-in store listing copy and image edits remain separate from package submission.

## Stale-tab preview and automatic cleanup specification (R4, R5, R6, R7, R10)

- [x] **T73 (Kiro)** — Prepared docs/automatic-stale-tab-cleanup.code-task.md: exact approved main-menu wording, inline disclosure/review, safe age handling and preview-bound removal, opt-in alarm lifecycle, normal/private isolation, real-browser acceptance criteria, and the proposed 0.6.0 PR/store release plan. Checked the existing code and release workflow; native timestamp semantics remain an explicit implementation verification gate. Documentation only; implementation, commits and publication have not started.

## 0.6.0 stale-tab controls and optional automation (R4, R5, R6, R7)

- [x] **T74 (Kiro)** — Chrome last-activated age and timestamp-only younger-correction journal implemented after user approval on 2026-10-06; Firefox retains last-viewed age. Each window's active tab is protected regardless of age, with a synchronous activation guard before close dispatch. Journal validation, future-time protection, bounded compaction, indexed lookup, failed-write recovery and journal-before-session write ordering have regression tests. Native checks cover three clean restarts without age reset, durable journal survival through an owned Chromium crash, injected write failure and real split-incognito activity without journal changes. Independent review found no remaining blockers; simultaneous loss of recent browser and journal writes remains a disclosed premature-eligibility risk, not a solved guarantee. No real seven-day soak claimed.
- [x] **T75 (Kiro)** — Inline disclosure/review, exact enabled title and local-time caption, shared Settings, safe unit/Escape editing, unconditional disable access, and non-destructive shortcut/context opening implemented. Added future-count explanation and read-only Review remaining tabs recovery. Fixed native footer occlusion and a polling/recovery race; both browsers now show and focus the refreshed list above the footer. UI unit and actual browser checks pass.
- [x] **T76 (Kiro)** — Prepared the 0.6.0 review candidate and opened [PR #16](https://github.com/adlio/tabvacuum/pull/16). Final parent verification after Chrome hardening and test cleanup: 1,137 unit tests across 19 files, both builds/packages and lint pass (zero errors, notices or warnings); all 59 files per ZIP match the build. All 111 final-evidence hashes matched the candidate before commit. The full seven-suite local browser gate passed: search Firefox/Chromium 374/398, stale cleanup 88/94, Chromium restart/journal 36, and feedback 47/47. Tests label accelerated clocks, synthetic younger corrections and injected faults; no failed assertions were waived. Evidence: artifacts/test-cleanup/ and artifacts/age-hardening-final/. Live CI/review status is tracked on the PR; CI runs unit/build/lint only. Nothing merged, tagged or submitted; no new permission beyond the approved alarms addition. Simultaneous browser/journal write loss remains a crash risk. Physical macOS/Windows, minimum versions, signed Firefox full restart, native editor deferral exactly at a whole-hour alarm and an actual week-long soak remain unverified.

## Test maintainability (R9, Kiro)

- [x] **T77 (Kiro)** — Completed test-only cleanup: one manifest contract suite, shared bounded DOM fixtures with 15 helper tests, semantic accessibility assertions instead of attribute-order checks, shipped-pixel contrast checks independent of generator variable names, and one event-loop boundary instead of repeated service timers. All 165 stale-service cases and UI safety regressions retained. Added focused browser commands and a single-build full browser gate; CI remains unit/build/lint-only. Parent verification: 1,137 tests across 19 files (5.09s observed versus 9.37s before cleanup), both builds and lint pass; seven native suites report 1,084 passing checks. Both baseline and cleaned suites catch the same four injected faults in isolated copies; three harmless HTML/CSS/generator edits now pass. Five normal and two shuffled service runs pass. All 81 protected production/harness/dependency/workflow files match the pre-cleanup hashes; independent review found no blockers. Evidence: artifacts/test-cleanup/SUMMARY.txt. Existing native timing/platform/restart/soak limits remain documented. Included in PR #16; nothing merged, tagged or published.
