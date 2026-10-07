// Shared test-only DOM fixture.
//
// This is deliberately bounded: it parses the extension's real HTML into a
// small node tree so popup.js, options.js and search.js can be driven in unit
// tests without a full DOM. It is NOT a general-purpose DOM implementation and
// does not reproduce everything a browser does:
//   - events do not bubble or capture; dispatch() runs listeners on the node it
//     is called on only (stopPropagation/preventDefault are inert markers).
//   - there are no default browser actions (a dispatched click never toggles a
//     checkbox or submits a form) and no layout, geometry, or styling.
//
// What it does model, so semantic assertions stay meaningful:
//   - Attributes are parsed independent of source order and reflected onto both
//     attrs (getAttribute/hasAttribute) and their matching properties.
//   - Child order mirrors the markup nesting (incl. SVG shapes and HTML void
//     elements) and interleaves direct text, so contains()/closest()/
//     querySelector()/textContent see the real structure.
//   - Selectors are limited to tag, [attr] and tag[attr]. Anything else throws
//     rather than silently matching nothing (a faked pass).
//   - innerHTML is forbidden: the extension UI builds nodes, never raw HTML.
//     This keeps the XSS guard the search tests rely on.

// HTML void elements never hold children, with or without a trailing slash.
// SVG shapes (path, circle, rect, ...) are intentionally NOT listed: they may
// be written self-closing (`<circle .../>`) or with an explicit end tag
// (`<path ...></path>`), and self-closing detection at parse time handles both,
// so an explicit `</path>` no longer pops its parent <svg>.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const decodeEntities = text => text
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, '\u00a0');

const camel = name => name.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// Only tag, [attr] and tag[attr] are understood. Unsupported selectors throw
// so a test can never pass by matching nothing.
function parseSelector(selector) {
  const match = /^([a-z][\w-]*)?(?:\[([\w-]+)\])?$/i.exec(String(selector).trim());
  if (!match || (!match[1] && !match[2])) throw new Error(`unsupported selector: ${selector}`);
  return { tag: match[1] ?? null, attr: match[2] ?? null };
}

function selectorMatches(node, { tag, attr }) {
  if (tag && node.tag !== tag) return false;
  if (attr) {
    if (attr.startsWith('data-')) return node.dataset[camel(attr.slice(5))] !== undefined;
    return node.attrs.has(attr);
  }
  return true;
}

export class El {
  constructor(tag, owner = null) {
    this.tag = String(tag);
    this.tagName = this.tag.toUpperCase();
    this.owner = owner;
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.selected = false;
    this.parent = null;
    this.childNodes = [];
    this.dataset = {};
    this.listeners = {};
    this.attrs = new Map();
    // Legacy mirror of this element's direct text (seeded by the parser and by
    // the textContent setter). textContent itself walks childNodes; this field
    // exists only because popup.test.js backs an overridden textContent accessor
    // with it, so it must track the element's text.
    this.text = '';
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
    };
  }

  // Element children only (mirrors the real `children`); text segments live in
  // childNodes as plain strings and are skipped here.
  get children() {
    return this.childNodes.filter(node => node instanceof El);
  }

  // Walk childNodes in order so direct text and child elements interleave:
  // <p>a<b>b</b>c</p> is "abc", not "acb". Setting it replaces every child with
  // a single text segment.
  get textContent() {
    return this.childNodes.map(node => (node instanceof El ? node.textContent : node)).join('');
  }

  set textContent(value) {
    for (const node of this.childNodes) if (node instanceof El) node.parent = null;
    const text = value == null ? '' : String(value);
    this.text = text;
    this.childNodes = text === '' ? [] : [text];
  }

  // The extension never assigns innerHTML. Fail loudly to keep that guarantee.
  set innerHTML(_) {
    throw new Error('innerHTML is forbidden in extension UI');
  }

  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(listener => listener !== fn);
  }

  // Dual signature so every suite can share it:
  //   dispatch(type)                       -> target is this node
  //   dispatch(type, otherNode)            -> target is otherNode (El)
  //   dispatch(type, { ...eventInit })     -> plain init merged onto the event
  //   dispatch(type, otherNode, { init })  -> both
  dispatch(type, a, b) {
    let target = this;
    let init;
    if (a instanceof El) { target = a; init = b ?? {}; }
    else { init = a ?? {}; }
    const event = {
      type,
      target,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      stopImmediatePropagation() {},
      ...init,
    };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
    return event;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      // A fragment contributes its own content (text + elements) and empties.
      const incoming = node.tag === '#fragment' ? node.childNodes.splice(0) : [node];
      for (const child of incoming) {
        if (child instanceof El) {
          // Moving an already-parented node detaches it first, so append moves
          // rather than duplicates, and the flat registry stays unique.
          child.parent?.detach(child);
          child.parent = this;
          const all = this.owner?.all;
          if (all && !all.includes(child)) all.push(child);
        }
        this.childNodes.push(child);
      }
    }
  }

  // Remove a child node from this node without reparenting it.
  detach(child) {
    this.childNodes = this.childNodes.filter(node => node !== child);
  }

  replaceChildren(...nodes) {
    for (const node of this.childNodes) if (node instanceof El) node.parent = null;
    this.childNodes = [];
    this.text = '';
    this.append(...nodes);
  }

  closest(selector) {
    const parsed = parseSelector(selector);
    for (let node = this; node; node = node.parent) if (selectorMatches(node, parsed)) return node;
    return null;
  }

  querySelectorAll(selector) {
    const parsed = parseSelector(selector);
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (selectorMatches(child, parsed)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }

  focus() {
    if (!this.owner) return;
    const changed = this.owner.activeElement !== this;
    this.owner.activeElement = this;
    if (changed) this.dispatch('focus');
  }

  scrollIntoView() {}
}

function applyAttributes(node, attrs, byId) {
  // Leading \s anchors each attribute, so the tag name is skipped and order is
  // irrelevant. Values may be double-quoted, single-quoted, unquoted, or absent.
  for (const [, name, dq, sq, uq] of attrs.matchAll(/\s([:\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s"'>]+))?/g)) {
    const raw = dq ?? sq ?? uq;
    const value = raw === undefined ? '' : decodeEntities(raw);
    // Every attribute is recorded, so hasAttribute/getAttribute work even for
    // the ones also mirrored onto properties below.
    node.attrs.set(name, value);
    switch (name) {
      case 'id': node.id = value; byId.set(value, node); break;
      case 'class':
        node.className = value;
        for (const token of value.split(/\s+/).filter(Boolean)) node.classes.add(token);
        break;
      case 'hidden': node.hidden = true; break;
      case 'checked': node.checked = true; break;
      case 'disabled': node.disabled = true; break;
      case 'selected': node.selected = true; break;
      case 'value': node.value = value; break;
      default:
        if (name.startsWith('data-')) node.dataset[camel(name.slice(5))] = value;
    }
  }
}

/**
 * Parse the extension markup into a node tree.
 *
 * @param {string} html The real HTML fixture read from src/.
 * @returns {{ document: El, byId: Map<string, El>, all: El[] }}
 *   `document` is the root El (getElementById/createElement/etc. wired on it),
 *   `byId` maps ids to nodes, and `all` is a flat list of every node.
 */
export function mountFixture(html) {
  const document = new El('#document');
  const byId = new Map();
  const all = [];
  document.all = all;
  document.activeElement = null;
  document.visibilityState = 'visible';

  // Comments and the doctype are not DOM text; drop them so they never leak
  // into a parent's textContent.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/gi, '');

  const stack = [];
  const tagRe = /<(\/?)([a-z][\w-]*)([^>]*)>/gi;
  let lastIndex = 0;
  let match;
  while ((match = tagRe.exec(markup)) !== null) {
    const parent = stack.at(-1) ?? document;
    const between = markup.slice(lastIndex, match.index);
    lastIndex = tagRe.lastIndex;
    // Keep text next to element children in document order so textContent
    // interleaves them. Whitespace-only gaps between tags are dropped so they
    // never surface as spurious text segments. parent.text mirrors the direct
    // text only (see the El.text note).
    if (parent !== document && between && between.trim()) {
      const text = decodeEntities(between);
      parent.childNodes.push(text);
      parent.text += text;
    }

    const [, close, tag, attrs] = match;
    if (close) { stack.pop(); continue; }

    const node = new El(tag, document);
    node.parent = parent;
    parent.childNodes.push(node);
    applyAttributes(node, attrs, byId);
    all.push(node);

    const selfClosing = VOID_TAGS.has(tag.toLowerCase()) || attrs.trimEnd().endsWith('/');
    if (!selfClosing) stack.push(node);
  }

  document.getElementById = id => byId.get(id) ?? null;
  document.createElement = tag => new El(tag, document);
  document.createDocumentFragment = () => new El('#fragment', document);
  document.body = all.find(node => node.tag === 'body') ?? null;

  return { document, byId, all };
}
