// Native XTest keysyms for the default search binding, Ctrl+Shift+Period on Linux.
export const SEARCH_KEYS = ['Control_L', 'Shift_L', 'period'];

// Serialized into the native extension popup by both browser harnesses.
export function inspectPopup() {
  const $ = id => document.getElementById(id);
  const visible = el => el.getClientRects().length > 0;
  const shortcut = $('search-shortcut');
  const expectedButtons = ['btn-search', 'btn-merge', 'btn-sort', 'btn-dupes', 'btn-stale', 'btn-blank'];
  const luminance = color => {
    const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const ratios = [];
  for (const el of document.querySelectorAll('.logo, h2, button span, .action-detail, kbd')) {
    if (!visible(el) || !el.textContent.trim() || el.children.length) continue;
    let surface = el;
    while (surface && ['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
    if (!surface) continue;
    const a = luminance(getComputedStyle(el).color);
    const b = luminance(getComputedStyle(surface).backgroundColor);
    ratios.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
  }
  $('btn-sort').click();
  const expanded = !$('sort-options').hidden && $('btn-sort').getAttribute('aria-expanded') === 'true';
  const sortCount = document.querySelectorAll('[data-criteria]').length;
  $('btn-sort').click();
  $('btn-search').focus();
  return {
    visible: expectedButtons.every(id => visible($(id))),
    shortcut: [...shortcut.querySelectorAll('kbd')].map(cap => cap.textContent),
    shortcutLabel: shortcut.getAttribute('aria-label'),
    noOverflow: document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('button')].filter(visible).every(el => el.scrollWidth <= el.clientWidth),
    sort: expanded && $('sort-options').hidden && $('btn-sort').getAttribute('aria-expanded') === 'false' && sortCount === 7,
    // The live region is the status copy; the spinner and Close button sit outside it.
    status: (() => {
      const live = $('status').querySelector('.status-copy');
      return live?.getAttribute('role') === 'status' && live.getAttribute('aria-live') === 'polite' &&
        !$('status').hasAttribute('role') && !live.contains($('status-close')) && !live.contains($('status-spinner'));
    })(),
    contrast: Math.min(...ratios),
    scheme: getComputedStyle(document.body).backgroundColor,
  };
}
