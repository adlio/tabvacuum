// Format browser-owned bindings for display; never infer a binding from defaults.
const names = {
  MacCtrl: 'Control', Ctrl: 'Control', Command: 'Command', Alt: 'Alt',
  Option: 'Option', Shift: 'Shift', Space: 'Space', Comma: ',', Period: '.',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
};
const macKeys = { MacCtrl: '⌃', Ctrl: '⌘', Command: '⌘', Alt: '⌥', Option: '⌥', Shift: '⇧' };
const glyphNames = { '⌃': 'MacCtrl', '⌘': 'Command', '⌥': 'Alt', '⇧': 'Shift' };

export function formatShortcut(shortcut, os) {
  // Chromium can return Mac glyphs; Firefox returns names such as MacCtrl.
  const tokens = String(shortcut || '').replace(/[⌃⌘⌥⇧]/gu, glyph => `${glyphNames[glyph]}+`)
    .split('+').map(token => token.trim()).filter(Boolean);
  const mac = os === 'mac';
  return {
    keys: tokens.map(token => mac ? (macKeys[token] || names[token] || token) : (token === 'Ctrl' ? 'Ctrl' : names[token] || token)),
    label: tokens.map(token => mac && token === 'Ctrl' ? 'Command' : mac && token === 'Alt' ? 'Option' : names[token] || token).join(' + '),
  };
}

export async function renderShortcuts(document, browser) {
  try {
    const [commands, { os }] = await Promise.all([
      browser.commands.getAll(), browser.runtime.getPlatformInfo(),
    ]);
    for (const target of document.querySelectorAll('[data-shortcut]')) {
      const binding = commands.find(command => command.name === target.dataset.shortcut)?.shortcut;
      const { keys, label } = formatShortcut(binding, os);
      target.replaceChildren();
      target.hidden = !keys.length;
      if (!keys.length) { target.removeAttribute('aria-label'); continue; }
      target.setAttribute('aria-label', label);
      for (const key of keys) {
        const cap = document.createElement('kbd');
        cap.textContent = key;
        cap.setAttribute('aria-hidden', 'true');
        target.append(cap);
      }
    }
  } catch {
    // Missing command metadata must not prevent using the menu or invent a key.
  }
}
