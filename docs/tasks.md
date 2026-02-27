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
