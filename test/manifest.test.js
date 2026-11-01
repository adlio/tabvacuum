import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// One home for the cross-feature manifest contract. Feature suites exercise
// rendering and behavior rather than repeating these permission/command tables.
const load = name => JSON.parse(readFileSync(new URL(`../src/manifest.${name}.json`, import.meta.url), 'utf8'));
const ORIGINS = ['http://*/*', 'https://*/*'];
const PERMISSIONS = ['tabs', 'history', 'notifications', 'storage', 'contextMenus', 'activeTab', 'scripting', 'alarms'];
// Vertical-tab toggling is Firefox-only: browser.browserSettings.verticalTabs
// exists on Firefox 142+ and needs the browserSettings permission, which Chrome
// does not define. So Firefox carries the extra permission and its command.
const FIREFOX_PERMISSIONS = [...PERMISSIONS, 'browserSettings'];
const COMMANDS = {
  'close-duplicates': { suggested_key: { default: 'Alt+Shift+D' }, description: 'Close duplicate tabs' },
  'merge-windows': { suggested_key: { default: 'Alt+Shift+M' }, description: 'Merge all windows' },
  'sort-tabs': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Sort tabs' },
  // Ctrl+Shift+K opens Firefox's web console. Search uses the period chord.
  'search-tabs': { suggested_key: { default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period' }, description: 'Search tabs' },
  'close-stale': { description: 'Review stale tabs' },
  'close-blank': { description: 'Close blank tabs' },
};
// Firefox adds the vertical-tab toggle. Chrome keeps the shared four-default set:
// it has a hard limit of four suggested keys and lacks the verticalTabs API.
const FIREFOX_COMMANDS = {
  ...COMMANDS,
  'toggle-vertical-tabs': { suggested_key: { default: 'Alt+Shift+V' }, description: 'Toggle vertical tabs' },
};

for (const browser of ['firefox', 'chrome']) {
  const manifest = load(browser);
  const expectedPermissions = browser === 'firefox' ? FIREFOX_PERMISSIONS : PERMISSIONS;
  const expectedCommands = browser === 'firefox' ? FIREFOX_COMMANDS : COMMANDS;
  describe(`${browser} manifest`, () => {
    it('requires only the approved permissions, without always-on website access', () => {
      expect([...manifest.permissions].sort()).toEqual([...expectedPermissions].sort());
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.content_scripts).toBeUndefined();
    });

    it('keeps website access optional in the browser-appropriate field', () => {
      const field = browser === 'chrome' ? 'optional_host_permissions' : 'optional_permissions';
      const other = browser === 'chrome' ? 'optional_permissions' : 'optional_host_permissions';
      expect([...manifest[field]].sort()).toEqual([...ORIGINS].sort());
      expect(manifest[other]).toBeUndefined();
      expect(manifest.web_accessible_resources).toEqual([{ resources: ['search.html'], matches: ORIGINS }]);
    });

    it('preserves extension identity and private-context isolation', () => {
      expect(manifest.key).toBeUndefined(); // Store-assigned Chrome identity.
      expect(manifest.version).toBeUndefined(); // Stamped by the build.
      if (browser === 'firefox') {
        expect(manifest.browser_specific_settings.gecko.id).toBe('tabvacuum@adlio');
        expect(manifest.incognito).toBeUndefined();
      } else {
        expect(manifest.incognito).toBe('split');
        expect(manifest.browser_specific_settings).toBeUndefined();
      }
    });

    it('ships the agreed commands with stale/blank unbound', () => {
      // Exact equality covers bindings, descriptions, retained unbound commands
      // and the Firefox-only vertical-tab toggle without a second copy of the table.
      expect(manifest.commands).toEqual(expectedCommands);
      // Chrome caps suggested keys at four; Firefox adds a fifth for the toggle.
      const expectedDefaults = browser === 'firefox' ? 5 : 4;
      expect(Object.values(manifest.commands).filter(command => command.suggested_key)).toHaveLength(expectedDefaults);
    });
  });
}
