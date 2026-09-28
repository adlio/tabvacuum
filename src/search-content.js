// Injected on demand into a page's top frame by scripting.executeScript.
// It must stay self-contained: the browser serializes only this function.
// Reads rendered text only and returns one bounded snippet plus the page URL,
// never the page text. Nothing is stored, logged, or sent anywhere else.

/**
 * @param {string} query literal text; whitespace-separated terms all must appear (case-insensitive)
 * @param {{maxChars:number,maxNodes:number,maxMs:number,snippetChars:number}} limits
 * @returns {{url:string, match:boolean, snippet:string, truncated:boolean}}
 */
export function searchPageContent(query, limits) {
  const { maxChars, maxNodes, maxMs, snippetChars } = limits;
  const url = String(document.location.href);
  const terms = [...new Set(String(query).trim().toLowerCase().split(/\s+/).filter(Boolean))];
  const root = document.body || document.documentElement;
  if (!terms.length || !root) return { url, match: false, snippet: '', truncated: false };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON',
    'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH', 'TABVACUUM-SEARCH']);
  // Used only when computed styles are unavailable: these never start a new line.
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK', 'Q',
    'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR']);
  const styleOf = element => {
    try { return typeof getComputedStyle === 'function' ? getComputedStyle(element) : null; } catch { return null; }
  };
  const skipped = (element, tag, style) => SKIP.has(tag) || element.hidden === true || element.isContentEditable === true ||
    element.getAttribute?.('aria-hidden') === 'true' ||
    (style !== null && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden')) ||
    // display:contents has no box, so checkVisibility is false even though its children render.
    (style?.display !== 'contents' && typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ visibilityProperty: true }));
  const breaks = (tag, style) => tag === 'BR' ||
    (style ? !/^(inline|contents|ruby)/.test(style.display || 'inline') : !INLINE.has(tag));

  let text = '';
  // Whitespace collapses as rendered text does; adjacent inline text stays joined.
  const add = raw => {
    const chunk = raw.replace(/\s+/g, ' ');
    text += text === '' || text.endsWith(' ') ? chunk.replace(/^ /, '') : chunk;
  };
  const separate = () => { if (text && !text.endsWith(' ')) text += ' '; };

  // A manual walk, so every node visited (element or text) counts against the
  // budget and the walk can stop at once. Only the light tree is followed:
  // shadow roots and frame documents are never entered.
  const started = performance.now();
  const open = []; // Whether each entered ancestor breaks the line when left.
  let visited = 0;
  let truncated = false;
  let node = root;
  while (node) {
    if (++visited > maxNodes || performance.now() - started > maxMs) { truncated = true; break; }
    if (node.nodeType === 3) {
      const value = String(node.nodeValue ?? '');
      const room = maxChars - text.length + 1;
      add(value.length > room ? value.slice(0, room) : value);
      if (value.length > room || text.length >= maxChars) { truncated = true; break; }
    } else if (node.nodeType === 1) {
      const tag = String(node.tagName).toUpperCase();
      const style = styleOf(node);
      if (!skipped(node, tag, style)) {
        const line = breaks(tag, style);
        if (line) separate();
        if (node.firstChild) { open.push(line); node = node.firstChild; continue; }
      }
    }
    while (node && node !== root && !node.nextSibling) {
      node = node.parentNode;
      if (open.pop()) separate();
    }
    node = node && node !== root ? node.nextSibling : null;
  }
  text = text.slice(0, maxChars).trim();

  // Literal matching by substring search: no query text becomes a pattern or code.
  const lower = text.toLowerCase();
  const positions = terms.map(term => lower.indexOf(term));
  if (positions.some(index => index < 0)) return { url, match: false, snippet: '', truncated };

  const at = positions[0];
  const start = Math.max(0, Math.min(at - Math.floor(snippetChars / 3), text.length - snippetChars));
  return { url, match: true, snippet: text.slice(start, start + snippetChars), truncated };
}
