# Aaron's Tab Vacuum

[![CI](https://github.com/adlio/tabvacuum/actions/workflows/ci.yml/badge.svg)](https://github.com/adlio/tabvacuum/actions/workflows/ci.yml)
[![Firefox Add-on](https://img.shields.io/amo/v/tabvacuum.svg)](https://addons.mozilla.org/en-US/firefox/addon/tabvacuum/)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hhhpnpjhdjfhdflffpgnknlmbfogachb.svg)](https://chromewebstore.google.com/detail/tabvacuum/hhhpnpjhdjfhdflffpgnknlmbfogachb)

Aaron's Tab Vacuum (ATV) is a browser extension for power-user tab management. Find tabs fast, sort them your way, and clear duplicates, stale tabs and blank pages, with keyboard control throughout. Works in Firefox and Chrome.

## Features

- **Search tabs** — fuzzy search across all your open tabs by title or URL, with exact matches ranked first. Arrow keys to highlight, Enter to switch, Escape to dismiss. An empty query shows your 10 most recently used tabs.
- **Close duplicate tabs** — find tabs that share a URL and close the extras, across every window.
- **Merge all windows** — pull every tab into your current window.
- **Sort tabs** — by URL, title, last accessed, or visit count, in either direction.
- **Close stale tabs** — review tabs you haven't touched in a while and close them, or opt in to automatic hourly cleanup.
- **Close blank tabs** — clear out new-tab pages, welcome pages, and search engine homepages.
- **Toggle vertical tabs** (Firefox only) — flip Firefox's tab bar between the horizontal strip and the native vertical sidebar with one keystroke.

Every action is available from the toolbar popup, the tab right-click menu, and keyboard shortcuts. Actions report what happened through a system notification, or inline in the popup if it's still open.

## Install

**Firefox**: [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tabvacuum/)

**Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/tabvacuum/hhhpnpjhdjfhdflffpgnknlmbfogachb)

### Install from source

```bash
git clone https://github.com/adlio/tabvacuum.git
cd tabvacuum
npm install
npm run build
```

**Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...**, and select `dist/firefox/manifest.json`.

**Chrome**: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/chrome/` directory.

## Keyboard shortcuts

| Action | Default shortcut |
|---|---|
| Search tabs | `Ctrl+Shift+.` (`Cmd+Shift+.` on macOS) |
| Close duplicates | `Alt+Shift+D` |
| Merge windows | `Alt+Shift+M` |
| Sort tabs | `Alt+Shift+S` |
| Toggle vertical tabs (Firefox only) | `Alt+Shift+V` |
| Close stale tabs | *(unassigned — set manually)* |
| Close blank tabs | *(unassigned — set manually)* |

Chrome only allows four suggested shortcuts per extension, so **Close stale tabs** and **Close blank tabs** ship without defaults. You can set or change any shortcut yourself:

- **Firefox**: `about:addons` → gear icon → **Manage Extension Shortcuts**.
- **Chrome**: `chrome://extensions/shortcuts`.

ATV never overwrites a shortcut your browser already has assigned, so after upgrading, check your browser's shortcut settings if a binding looks different than expected.

## Tab search

Open search from the toolbar menu or its keyboard shortcut. It opens a centered search box over the current page — type to filter your open tabs by title or URL, use arrow keys (or j/k) to move the highlight, and press Enter to switch to a tab. Press **x** or click a row's **×** to close it without leaving search; press **m** to select several tabs and close them together.

By default search covers every window; switch to the current window only from Settings. Click **Search in** to also search your browsing history or the text of pages you already have open — both are off by default and reset each time you open search.

## Stale tabs

Choose **Stale Tabs** from the toolbar menu to expand a review panel: set how long a tab can sit untouched (7 days by default), see how many qualify, and close them with **Close N tabs now**. Nothing closes until you confirm.

Turn on **Automatically close stale tabs** in the panel or in Settings to have ATV close qualifying tabs once an hour, with no further confirmation. It's off by default, including after an upgrade, and the toolbar tells you when it's on and roughly when the next automatic close will happen. Either mode always protects the active tab in every window, the last tab in a window, and (optionally) pinned or audio-playing tabs.

Closing is not archiving — your browser's native "Reopen Closed Tab" command may bring a page back, but unsaved page state isn't guaranteed to survive. See [`docs/design.md`](docs/design.md#stale-tab-review-and-opt-in-scheduling-060-candidate-r4r7) for how age is tracked across restarts and the scheduling mechanics.

## Settings

Open from your browser's extension settings page (Aaron's Tab Vacuum → Preferences/Options).

- Stale tab threshold (default: 7 days)
- Whether duplicate detection ignores URL fragments and query parameters
- Whether pinned or audio-playing tabs are protected from manual cleanup

## Permissions and privacy

ATV only accesses the current page after you explicitly invoke search on it, and runs no content scripts that are always on. Tab search and history results are isolated inside the extension — the web page you're viewing can't read your query, your other tab titles, or your URLs. Letting ATV search the text of your open pages requires a separate, optional permission you grant from Settings; nothing is sent off your device, and there's no background index of anything you've browsed. Private-window results are always kept separate from normal-window results and are never mixed together.

For the full permission-by-permission breakdown and the isolation mechanics, see [`docs/design.md`](docs/design.md#centered-tab-search-r11).

## Credits

The **Toggle Vertical Tabs** feature adapts the flip-the-setting mechanism from the
[Vertical Tab Keyboard Toggle](https://github.com/AndreiMiculita/vertical-tab-keyboard-toggle)
add-on by Andrei-Lucian Miculita, used under the MIT License. See `LICENSE` for the
upstream copyright notice.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow, the full browser test suite, and CI details. Architecture and design decisions live in [`docs/design.md`](docs/design.md); requirements in [`docs/prd.md`](docs/prd.md).

## License

Aaron's Tab Vacuum is released under the MIT License. See `LICENSE`.
