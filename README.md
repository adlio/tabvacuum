# TabVacuum

<!-- badges will be added once CI and store listings are live (T48) -->

A browser extension for power-user tab management. Works in Firefox and Chrome.

## Features

- **Close Duplicate Tabs** — deduplicate by URL across all windows
- **Merge All Windows** — consolidate every tab into the current window
- **Sort Tabs** — by URL, title, last accessed, or visit count (ascending/descending)
- **Close Stale Tabs** — prune tabs untouched for a configurable period

Accessible via toolbar popup, tab right-click menu, and keyboard shortcuts.

## Install

**Firefox**: Install from [Firefox Add-ons](#) <!-- link updated at publish time -->

**Chrome**: Install from the [Chrome Web Store](#) <!-- link updated at publish time -->

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
| Close Stale Tabs | `Alt+Shift+X` |

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
npm run lint          # Lint Firefox extension (web-ext lint)
```

See `docs/prd.md` for requirements, `docs/design.md` for architecture, and
`docs/tasks.md` for the implementation task list.
