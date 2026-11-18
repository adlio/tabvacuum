# Contributing to Aaron's Tab Vacuum

See [`docs/prd.md`](docs/prd.md) for requirements and [`docs/design.md`](docs/design.md) for architecture before making a change. `AGENTS.md` has conventions for AI coding agents working in this repo.

## Development

```bash
npm install           # Install dev dependencies
npm test               # Run unit tests (Vitest)
npm run build          # Build dist/firefox/ and dist/chrome/
npm start              # Build + launch Firefox with extension loaded
npm run start:chrome   # Build + launch Chromium with extension loaded
npm run package        # Build + create zip files in artifacts/
npm run lint           # Lint Firefox extension (web-ext lint)
```

`npm start` and `npm run start:chrome` use `web-ext run` to open a temporary browser profile with the extension installed. The browser auto-reloads when files in the `dist` directory change, so the workflow is: edit source, run `npm run build` in another terminal, and the browser picks up the changes.

`npm run package` produces upload-ready zip files in `artifacts/`.

## Browser test gate

`npm run test:browsers` is the full browser gate. It builds `dist/` once, then runs every real-browser suite in order: search (Firefox and Chromium), stale-tab cleanup (Firefox and Chromium), the Chromium last-activated age journal/restart check, and toolbar action feedback (Firefox and Chromium). The suites drive the actual built extensions — in-page palettes, protected-page fallback windows, native toolbar menus, and local fixture tabs — in fresh profiles. Success paths use real browser APIs; fault cases and accelerated age fixtures are labelled in the results. Test pages bind only to loopback.

**Prerequisites.** Linux with Python 3, Xvfb, X11/XTest libraries, ffmpeg, Firefox, geckodriver, and Chromium installed. Set `KIROCREW_SCRATCH` (or `TMPDIR`) to a disposable test directory. Optional binary paths are `FIREFOX_BINARY`, `GECKODRIVER`, `CHROMIUM_BINARY`, and `XVFB_BINARY`. Firefox/geckodriver/Xvfb default to the session's `browsers/` install; Chromium defaults to Playwright's browser. On hosts with locally extracted Xvfb libraries, the harness also searches `browsers/usr/lib64` under scratch.

**Focused reruns.** The gate builds once, and the focused scripts below do not rebuild — run `npm run build` first (or let the gate build), then rerun only what you need:

| Script | Covers |
|---|---|
| `npm run test:search:firefox` / `npm run test:search:chromium` | command palette: open, close-from-search, expanded History/Page-contents, and the privacy/lifecycle checks |
| `npm run test:stale:firefox` / `npm run test:stale:chromium` | stale-tab review and automatic cleanup |
| `npm run test:age:chromium` | Chromium last-activated age tracking and the restart-safety journal |
| `npm run test:feedback:firefox` / `npm run test:feedback:chromium` | toolbar action feedback and the period search shortcut |

`npm run test:firefox` and `npm run test:chromium` keep their previous meaning: build, then run that browser's search suite. Narrow a search suite further by passing a flag, e.g. `npm run test:search:firefox -- --acceptance-only` (also `--closing-only` and `--expanded-only`).

**Screenshots and recordings.** Screenshots go under `tabvacuum-firefox/` and `tabvacuum-chromium/` in scratch. `RECORD_BROWSER=1 npm run test:chromium` additionally records the actual desktop flow to MP4; for action feedback, `RECORD_BROWSER=1` records a real frecency sort and asserts its returned result. Firefox uses its native Marionette actor for popup content because ordinary WebDriver frame APIs exclude these remote extension views. Physical shortcut keys are sent through XTest on the isolated X display. The action-feedback suite's success/no-op checks use real browser APIs on disposable tabs; busy-state screenshots deliberately delay the test transport, and failure cases inject transport errors or a notification-only failure. These checks establish notification API acceptance, not OS-banner visibility. This verifies Linux browser behavior; it does not claim OS-level macOS shortcut testing. The Firefox harness selects the privileged-inspection opt-in supported by the installed geckodriver, only for its throwaway profile.

## Continuous integration

CI (`.github/workflows/ci.yml`) runs the unit tests (`vitest run`), the build (`node scripts/build.js`), and the Firefox `web-ext lint` only, on every PR against `main`. The browser gate above runs locally and is not part of CI.

`.github/workflows/release.yml` runs on `v*` tags: it re-runs CI, builds, zips `dist/firefox/` and `dist/chrome/`, creates a GitHub Release with both zips attached, and publishes to the Firefox Add-ons and Chrome Web Store listings.
