import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchPageContent } from '../src/search-content.js';
import { CONTENT_LIMITS } from '../src/search-sources-core.js';

// A minimal linked light DOM (firstChild/nextSibling/parentNode), so the
// scanner's own traversal is what runs. Every node read is counted.
let reads = 0;
const link = (parent, children) => {
  parent.firstChild = children[0] ?? null;
  children.forEach((child, i) => { child.parentNode = parent; child.nextSibling = children[i + 1] ?? null; });
  return parent;
};
const text = nodeValue => ({ nodeType: 3, get nodeValue() { reads++; return nodeValue; } });
function el(tagName, children = [], { attrs = {}, hidden = false, editable = false, visible = true, style = {} } = {}) {
  const node = {
    nodeType: 1, tagName, hidden, isContentEditable: editable, style: { display: 'block', visibility: 'visible', ...style },
    getAttribute: name => attrs[name] ?? null,
    checkVisibility: visible === undefined ? undefined : () => visible,
  };
  return link(node, children.map(c => (typeof c === 'string' ? text(c) : c)));
}
const span = (...children) => el('SPAN', children, { style: { display: 'inline' } });
function page(body, { href = 'https://example.org/a?q=1#frag', styles = true } = {}) {
  reads = 0;
  vi.stubGlobal('document', { location: { href }, body, documentElement: body });
  if (styles) vi.stubGlobal('getComputedStyle', node => { reads++; return node.style; });
  else vi.stubGlobal('getComputedStyle', undefined);
}
const run = (query, limits = CONTENT_LIMITS) => searchPageContent(query, limits);

describe('searchPageContent (injected)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds literal, case-insensitive terms and returns only a bounded snippet with the exact URL', () => {
    const long = 'filler '.repeat(200);
    page(el('BODY', [el('P', [long]), el('P', ['The Quarterly Report is ready']), el('P', [long])]));
    const result = run('quarterly REPORT');
    expect(result).toMatchObject({ url: 'https://example.org/a?q=1#frag', match: true, truncated: false });
    expect(result.snippet).toContain('Quarterly Report');
    expect(result.snippet.length).toBeLessThanOrEqual(240);
    expect(Object.keys(result).sort()).toEqual(['match', 'snippet', 'truncated', 'url']);
  });

  it('requires every term and treats pattern characters literally', () => {
    page(el('BODY', ['price is 5 dollars']));
    expect(run('price euros').match).toBe(false);
    expect(run('5.*').match).toBe(false);
    expect(run('(').match).toBe(false);
    page(el('BODY', ['a+b (c) [d] $1 \\d']));
    expect(run('a+b (c) [d] $1 \\d').match).toBe(true);
  });

  it.each([
    ['script', el('SCRIPT', ['secret'])], ['style', el('STYLE', ['secret'])], ['noscript', el('NOSCRIPT', ['secret'])],
    ['template', el('TEMPLATE', ['secret'])], ['textarea', el('TEXTAREA', ['secret'])], ['select', el('SELECT', [el('OPTION', ['secret'])])],
    ['button', el('BUTTON', ['secret'])], ['input', el('INPUT', ['secret'])], ['iframe', el('IFRAME', ['secret'])],
    ['frame', el('FRAME', ['secret'])], ['object', el('OBJECT', ['secret'])],
    ['hidden attribute', el('DIV', ['secret'], { hidden: true })], ['aria-hidden', el('DIV', ['secret'], { attrs: { 'aria-hidden': 'true' } })],
    ['contenteditable', el('DIV', ['secret'], { editable: true })], ['checkVisibility false', el('DIV', ['secret'], { visible: false })],
    ['display:none', el('DIV', ['secret'], { style: { display: 'none' } })],
    ['visibility:hidden', el('DIV', ['secret'], { style: { visibility: 'hidden' } })],
    ['content-visibility:hidden', el('DIV', ['secret'], { style: { contentVisibility: 'hidden' } })],
    ['search overlay', el('TABVACUUM-SEARCH', ['secret'])], ['lowercase svg', el('svg', ['secret'])],
  ])('ignores text inside %s', (_name, node) => {
    page(el('BODY', [el('P', ['visible']), el('DIV', [node])]));
    expect(run('secret')).toMatchObject({ match: false, snippet: '' });
    expect(run('visible').match).toBe(true);
  });

  it.each([
    ['hidden', { hidden: true }], ['contenteditable', { editable: true }], ['aria-hidden', { attrs: { 'aria-hidden': 'true' } }],
    ['display:none', { style: { display: 'none' } }],
  ])('reads nothing when the root itself is %s', (_name, options) => {
    page(el('BODY', [el('P', ['secret'])], options));
    expect(run('secret')).toMatchObject({ match: false, snippet: '' });
  });

  it('keeps visible children of a display:contents element even though checkVisibility is false', () => {
    page(el('BODY', [el('DIV', [el('P', ['wrapped text'])], { visible: false, style: { display: 'contents' } })]));
    expect(run('wrapped').match).toBe(true);
    // A display:contents element that is hidden another way is still skipped.
    page(el('BODY', [el('DIV', ['secret'], { visible: false, style: { display: 'contents', visibility: 'hidden' } })]));
    expect(run('secret').match).toBe(false);
  });

  it('falls back to computed style when checkVisibility is absent', () => {
    page(el('BODY', [
      el('P', ['shown'], { visible: undefined }),
      el('DIV', ['secret'], { visible: undefined, style: { display: 'none' } }),
    ]));
    expect(run('shown').match).toBe(true);
    expect(run('secret').match).toBe(false);
  });

  it('falls back to attributes and tag names when computed styles are unavailable', () => {
    page(el('BODY', [el('P', ['road']), el('P', ['map']), el('SPAN', ['sun']), el('SPAN', ['set']), el('DIV', ['secret'], { hidden: true })]),
      { styles: false });
    expect(run('roadmap').match).toBe(false);
    expect(run('sunset').match).toBe(true);
    expect(run('secret').match).toBe(false);
  });

  it('joins adjacent inline text and separates block text, collapsing whitespace', () => {
    page(el('BODY', [el('P', [span('road'), span('map')]), el('P', ['next  \n line']), el('DIV', ['a']), 'b', el('BR'), 'c']));
    expect(run('roadmap').match).toBe(true);
    expect(run('roadmap next').match).toBe(true);
    expect(run('mapnext').match).toBe(false);
    expect(run('next line').snippet).toBe('roadmap next line a b c');
  });

  it('reports truncation at the character bound, even for one enormous text node', () => {
    page(el('BODY', ['x'.repeat(50), 'needle']));
    expect(run('needle', { ...CONTENT_LIMITS, maxChars: 20 })).toMatchObject({ match: false, truncated: true });
    page(el('BODY', [`${'x '.repeat(500_000)}needle`]));
    const result = run('x', { ...CONTENT_LIMITS, maxChars: 1000 });
    expect(result).toMatchObject({ match: true, truncated: true });
    expect(run('needle', { ...CONTENT_LIMITS, maxChars: 1000 }).match).toBe(false);
  });

  it('counts every element, not just text, against the node bound and stops without scanning ahead', () => {
    const empties = Array.from({ length: 50_000 }, () => el('DIV'));
    page(el('BODY', [...empties, el('P', ['needle'])]));
    expect(run('needle', { ...CONTENT_LIMITS, maxNodes: 100 })).toMatchObject({ match: false, truncated: true });
    expect(reads).toBeLessThanOrEqual(101);
    // Rejected (hidden) subtrees still count once each at their root.
    const hiddenRoots = Array.from({ length: 50_000 }, () => el('DIV', ['secret'], { hidden: true }));
    page(el('BODY', [...hiddenRoots, el('P', ['needle'])]));
    expect(run('needle', { ...CONTENT_LIMITS, maxNodes: 100 })).toMatchObject({ match: false, truncated: true });
    expect(reads).toBeLessThanOrEqual(101);
  });

  it('checks the time bound on every node, including element-only nodes', () => {
    page(el('BODY', [el('DIV', [el('DIV', [el('DIV')])]), 'needle']));
    let t = 0;
    vi.stubGlobal('performance', { now: () => (t += 30) });
    expect(run('needle', { ...CONTENT_LIMITS, maxMs: 75 })).toMatchObject({ match: false, truncated: true });
  });

  it('distinguishes a searched empty page (no match) from unavailable', () => {
    page(el('BODY', []));
    expect(run('anything')).toEqual({ url: 'https://example.org/a?q=1#frag', match: false, snippet: '', truncated: false });
    expect(run('   ')).toMatchObject({ match: false });
  });

  it('is self-contained, so the serialized copy behaves the same', () => {
    page(el('BODY', [el('P', ['hello world']), el('P', [span('road'), span('map')])]));
    const copy = new Function(`return ${searchPageContent.toString().replace(/^export /, '')}`)();
    expect(copy('WORLD roadmap', CONTENT_LIMITS)).toEqual(run('WORLD roadmap'));
    expect(copy('WORLD roadmap', CONTENT_LIMITS).match).toBe(true);
  });
});
