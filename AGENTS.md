# TabVacuum - Agent Instructions

## Project Summary

TabVacuum is a cross-browser WebExtension (Manifest V3) for power-user tab management.
Targets Firefox and Chrome. Minimal build step. No UI frameworks. Vitest for unit tests.

## Key Files

| File | Purpose |
|---|---|
| `docs/prd.md` | Numbered requirements (R1-R10). All work traces to a requirement. |
| `docs/design.md` | Architecture, module design, cross-browser strategy, testing, CI/CD. |
| `docs/tasks.md` | Task list with status tracking. Update status when starting/finishing work. |
| `src/manifest.firefox.json` | Firefox MV3 manifest (background scripts). |
| `src/manifest.chrome.json` | Chrome MV3 manifest (service worker). |
| `src/core.js` | Pure functions: all tab operation logic. No browser API calls. |
| `src/background.js` | Wiring: calls browser APIs, delegates to core.js, handles messages/menus/commands. |
| `src/popup.html/js/css` | Toolbar popup UI. Sends messages to background.js. |
| `src/options.html/js/css` | Settings page. Sends messages to background.js. |
| `test/core.test.js` | Vitest unit tests for core.js. |
| `test/mocks/browser.js` | Manual browser API mock with `vi.fn()` stubs. |
| `scripts/build.js` | Assembles `dist/firefox/` and `dist/chrome/` from `src/`. |

## Working Conventions

1. **Before starting a task**: mark it `[~]` in `docs/tasks.md` with your agent ID.
2. **After completing a task**: mark it `[x]` in `docs/tasks.md`.
3. **Reference requirements**: use R-numbers (e.g., R1.3) in code comments only where the logic is non-obvious.
4. **No UI frameworks**: vanilla JS for all UI code.
5. **Browser API namespace**: always use `browser.*`. The `webextension-polyfill` handles Chrome compatibility.
6. **Async pattern**: all browser API calls use `async/await`.
7. **Message protocol**: popup/options communicate with background via `browser.runtime.sendMessage({ command, ...params })`. Background returns `{ message: string }`.
8. **Core vs wiring**: business logic goes in `core.js` as pure functions. Browser API calls go in `background.js`. This separation exists for testability.
9. **Testing**: run `npx vitest run`. Load extensions manually via `about:debugging` (Firefox) or `chrome://extensions` (Chrome) for integration testing.
10. **Building**: run `node scripts/build.js`. Output goes to `dist/firefox/` and `dist/chrome/`.

## Common Pitfalls

- `tabs.query({})` returns tabs from all windows. Filter by `currentWindow: true` when appropriate.
- `tabs.move()` with a `windowId` different from the tab's current window moves it across windows.
- Pinned tabs cannot be moved to a position after unpinned tabs. Always filter them out of sort/move operations.
- `history.search({ text: url })` may return multiple results. Match on exact URL or take the first result.
- The last tab in a window cannot be closed (browser will error). Always check before removing.
- Firefox uses `browser.menus`; Chrome uses `browser.contextMenus`. With the polyfill, use `browser.contextMenus` for cross-browser compatibility.
- Chrome MV3 service workers can be terminated by the browser. Do not store state in global variables in `background.js`; use `browser.storage.local`.
- The `"contextMenus"` permission string is required in the manifest (not `"menus"`).
