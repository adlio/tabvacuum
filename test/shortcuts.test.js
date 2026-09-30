import { describe, it, expect, vi } from 'vitest';
import { formatShortcut, renderShortcuts } from '../src/shortcuts.js';

const cases = [
  ['MacCtrl+Shift+K', 'mac', ['⌃', '⇧', 'K'], 'Control + Shift + K'],
  ['Ctrl+Shift+F', 'mac', ['⌘', '⇧', 'F'], 'Command + Shift + F'],
  ['Command+Shift+K', 'mac', ['⌘', '⇧', 'K'], 'Command + Shift + K'],
  ['Command+Shift+Space', 'mac', ['⌘', '⇧', 'Space'], 'Command + Shift + Space'],
  ['Alt+Shift+K', 'mac', ['⌥', '⇧', 'K'], 'Option + Shift + K'],
  ['Option+K', 'mac', ['⌥', 'K'], 'Option + K'],
  ['⌃⇧K', 'mac', ['⌃', '⇧', 'K'], 'Control + Shift + K'],
  ['⌘+⇧+K', 'mac', ['⌘', '⇧', 'K'], 'Command + Shift + K'],
  ['Ctrl+Shift+F', 'win', ['Ctrl', 'Shift', 'F'], 'Control + Shift + F'],
  ['Alt+Shift+K', 'linux', ['Alt', 'Shift', 'K'], 'Alt + Shift + K'],
  ['Ctrl+Comma', 'win', ['Ctrl', ','], 'Control + ,'],
  ['MacCtrl+Shift+Up', 'mac', ['⌃', '⇧', '↑'], 'Control + Shift + ↑'],
  // Default search binding as each browser reports it on each platform.
  ['Command+Shift+Period', 'mac', ['⌘', '⇧', '.'], 'Command + Shift + .'],
  ['⌘⇧Period', 'mac', ['⌘', '⇧', '.'], 'Command + Shift + .'],
  ['Ctrl+Shift+Period', 'win', ['Ctrl', 'Shift', '.'], 'Control + Shift + .'],
  ['Ctrl+Shift+Period', 'linux', ['Ctrl', 'Shift', '.'], 'Control + Shift + .'],
  ['', 'mac', [], ''],
  [undefined, 'linux', [], ''],
];

describe('shortcut labels', () => {
  it.each(cases)('formats %s on %s', (binding, os, keys, label) => {
    expect(formatShortcut(binding, os)).toEqual({ keys, label });
  });

  function target(command) {
    return {
      dataset: { shortcut: command }, children: [], hidden: true,
      replaceChildren() { this.children = []; },
      append(cap) { this.children.push(cap); },
      setAttribute: vi.fn(), removeAttribute: vi.fn(),
    };
  }
  function setup(commands, os = 'mac') {
    const search = target('search-tabs');
    const stale = target('close-stale');
    const document = {
      querySelectorAll: () => [search, stale],
      createElement: () => ({ setAttribute: vi.fn(), set innerHTML(_) { throw new Error('Use text only'); } }),
    };
    const browser = {
      commands: { getAll: vi.fn().mockResolvedValue(commands) },
      runtime: { getPlatformInfo: vi.fn().mockResolvedValue({ os }) },
    };
    return { document, browser, search, stale };
  }

  it('shows actual user remappings as keycaps with a spoken label', async () => {
    const { document, browser, search, stale } = setup([
      { name: 'search-tabs', shortcut: 'MacCtrl+Shift+F' },
      { name: 'close-stale', shortcut: '' },
    ]);
    await renderShortcuts(document, browser);
    expect(search.children.map(cap => cap.textContent)).toEqual(['⌃', '⇧', 'F']);
    expect(search.setAttribute).toHaveBeenCalledWith('aria-label', 'Control + Shift + F');
    expect(search.hidden).toBe(false);
    expect(stale.hidden).toBe(true);
    expect(stale.children).toEqual([]);
  });

  it('clears a label when the user removes a binding', async () => {
    const ui = setup([{ name: 'search-tabs', shortcut: 'Alt+Shift+K' }]);
    await renderShortcuts(ui.document, ui.browser);
    ui.browser.commands.getAll.mockResolvedValue([]);
    await renderShortcuts(ui.document, ui.browser);
    expect(ui.search.children).toEqual([]);
    expect(ui.search.hidden).toBe(true);
    expect(ui.search.removeAttribute).toHaveBeenCalledWith('aria-label');
  });

  it('leaves labels hidden when browser metadata is unavailable', async () => {
    const ui = setup([]);
    ui.browser.runtime.getPlatformInfo.mockRejectedValue(new Error('unavailable'));
    await expect(renderShortcuts(ui.document, ui.browser)).resolves.toBeUndefined();
    expect(ui.search.hidden).toBe(true);
  });
});

// Suggested defaults differ by platform, never by browser, and stay within
// Chromium's four-default command limit. User-assigned bindings remain untouched.
describe('manifest shortcut defaults', () => {
  async function load(name) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(new URL(`../src/manifest.${name}.json`, import.meta.url), 'utf8'));
  }

  // Ctrl+Shift+K opens Firefox's web console, so search uses the period chord.
  it.each(['firefox', 'chrome'])('uses the period-chord search binding in %s', async name => {
    const manifest = await load(name);
    expect(manifest.commands['search-tabs'].suggested_key).toEqual({
      default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period',
    });
  });

  it.each(['firefox', 'chrome'])('keeps exactly four suggested defaults in %s', async name => {
    const { commands } = await load(name);
    const defaults = Object.fromEntries(Object.entries(commands)
      .filter(([, command]) => command.suggested_key)
      .map(([id, command]) => [id, command.suggested_key]));
    expect(defaults).toEqual({
      'close-duplicates': { default: 'Alt+Shift+D' },
      'merge-windows': { default: 'Alt+Shift+M' },
      'sort-tabs': { default: 'Alt+Shift+S' },
      'search-tabs': { default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period' },
    });
    expect(commands['close-stale'].suggested_key).toBeUndefined();
    expect(commands['close-blank'].suggested_key).toBeUndefined();
  });

  it('ships identical command definitions to both browsers', async () => {
    expect((await load('firefox')).commands).toEqual((await load('chrome')).commands);
  });
});