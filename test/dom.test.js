import { describe, it, expect, vi } from 'vitest';
import { El, mountFixture } from './mocks/dom.js';

describe('mountFixture attribute parsing', () => {
  it('parses attributes independent of their source order', () => {
    const a = mountFixture('<button id="go" data-criteria="url" aria-expanded="false"></button>');
    const b = mountFixture('<button aria-expanded="false" id="go" data-criteria="url"></button>');
    for (const { byId } of [a, b]) {
      const node = byId.get('go');
      expect(node.tag).toBe('button');
      expect(node.getAttribute('aria-expanded')).toBe('false');
      expect(node.dataset.criteria).toBe('url');
    }
  });

  it('reflects boolean and reflected attributes onto properties', () => {
    const { byId } = mountFixture(
      '<input id="box" type="checkbox" checked disabled><select id="pick"><option value="days" selected>days</option></select>',
    );
    expect(byId.get('box').checked).toBe(true);
    expect(byId.get('box').disabled).toBe(true);
    expect(byId.get('box').getAttribute('type')).toBe('checkbox');
    const option = byId.get('pick').children[0];
    expect(option.value).toBe('days');
    expect(option.selected).toBe(true);
  });

  it('decodes entities in text and leaves missing attributes null', () => {
    const { byId } = mountFixture('<p id="p" class="note">Frequent &amp; recent</p>');
    expect(byId.get('p').textContent).toBe('Frequent & recent');
    expect(byId.get('p').getAttribute('max')).toBeNull();
    expect(byId.get('p').hasAttribute('max')).toBe(false);
    expect(byId.get('p').classes.has('note')).toBe(true);
  });

  it('keeps reflected attributes readable via getAttribute/hasAttribute', () => {
    const { byId } = mountFixture('<div id="panel" class="box lead" hidden data-role="main"></div>');
    const node = byId.get('panel');
    // Mirrored onto properties...
    expect(node.id).toBe('panel');
    expect(node.className).toBe('box lead');
    expect(node.hidden).toBe(true);
    expect(node.dataset.role).toBe('main');
    // ...and still present as attributes (regression: these used to be dropped,
    // so hasAttribute('hidden') read false even on hidden markup).
    expect(node.hasAttribute('hidden')).toBe(true);
    expect(node.getAttribute('id')).toBe('panel');
    expect(node.getAttribute('class')).toBe('box lead');
    expect(node.getAttribute('data-role')).toBe('main');
    expect(node.hasAttribute('missing')).toBe(false);
  });
});

describe('mountFixture nesting', () => {
  it('treats HTML void elements as leaves that never capture later siblings', () => {
    const { byId, document } = mountFixture(`
      <main>
        <button id="btn"><img src="x" alt=""><span class="label">Go</span></button>
        <input id="field" type="text">
        <br>
      </main>`);
    const btn = byId.get('btn');
    const main = document.querySelector('main');
    expect(btn.children.map(child => child.tag)).toEqual(['img', 'span']);
    expect(main.contains(btn)).toBe(true);
    expect(main.contains(byId.get('field'))).toBe(true);
    // The void img/input/br are leaves: none swallowed a following sibling.
    expect(byId.get('field').children).toHaveLength(0);
    expect(main.children.map(child => child.tag)).toEqual(['button', 'input', 'br']);
  });

  it('keeps SVG shapes inside <svg> whether self-closing or explicitly closed', () => {
    const { document } = mountFixture(
      '<svg><path d="M0 0"></path><circle cx="1" cy="1" r="1"/><rect x="0"></rect></svg><span id="after">x</span>',
    );
    const svg = document.querySelector('svg');
    // The explicit </path> must not pop <svg>; every shape stays its child.
    expect(svg.children.map(child => child.tag)).toEqual(['path', 'circle', 'rect']);
    expect(svg.children.every(child => child.children.length === 0)).toBe(true);
    // The element after </svg> is a sibling, not swallowed into the subtree.
    expect(svg.contains(document.getElementById('after'))).toBe(false);
  });

  it('interleaves direct text and child elements in document order', () => {
    const { document } = mountFixture('<p id="p">a<b>b</b>c</p>');
    const p = document.getElementById('p');
    expect(p.textContent).toBe('abc');
    expect(p.children.map(child => child.tag)).toEqual(['b']);
  });

  it('exposes scoped textContent and element children for semantic checks', () => {
    const { document } = mountFixture(
      '<ul id="list"><li><span>Design doc</span><span>docs.example.com</span></li></ul>',
    );
    const row = document.getElementById('list').children[0];
    expect(row.children.map(part => part.textContent)).toEqual(['Design doc', 'docs.example.com']);
    expect(row.textContent).toBe('Design docdocs.example.com');
  });
});

describe('El scoped querying', () => {
  it('matches tag, [attr] and tag[attr], and rejects unsupported selectors', () => {
    const { byId, document } = mountFixture(
      '<div id="opts"><button data-criteria="url"><span>A</span></button><button data-criteria="title"></button></div>',
    );
    const opts = byId.get('opts');
    expect(opts.querySelectorAll('button')).toHaveLength(2);
    expect(opts.querySelectorAll('[data-criteria]')).toHaveLength(2);
    const inner = opts.querySelector('span');
    expect(inner.closest('button[data-criteria]').dataset.criteria).toBe('url');
    expect(document.querySelector('div')).toBe(opts);
    expect(() => opts.querySelectorAll('.cls')).toThrow(/unsupported selector/);
    expect(() => inner.closest('button > span')).toThrow(/unsupported selector/);
  });
});

describe('El events and focus', () => {
  it('tracks focus on the owner and fires a focus event only on change', () => {
    const { byId } = mountFixture('<button id="a"></button><button id="b"></button>');
    const a = byId.get('a');
    const focuses = vi.fn();
    a.addEventListener('focus', focuses);
    a.focus();
    a.focus();
    expect(a.owner.activeElement).toBe(a);
    expect(focuses).toHaveBeenCalledTimes(1);
    byId.get('b').focus();
    expect(a.owner.activeElement).toBe(byId.get('b'));
  });

  it('dispatches with target/currentTarget and supports preventDefault', () => {
    const { byId } = mountFixture('<form id="f"><input id="i"></form>');
    const form = byId.get('f');
    const input = byId.get('i');
    let seen;
    form.addEventListener('click', event => { seen = event; event.preventDefault(); });
    // Positional El target (as the popup suite uses) plus returned event state.
    const event = form.dispatch('click', input);
    expect(seen.target).toBe(input);
    expect(seen.currentTarget).toBe(form);
    expect(event.defaultPrevented).toBe(true);
  });

  it('passes a plain init object through as event fields', () => {
    const { byId } = mountFixture('<input id="i">');
    const input = byId.get('i');
    let relatedTarget;
    input.addEventListener('focusout', event => { relatedTarget = event.relatedTarget; });
    input.dispatch('focusout', { relatedTarget: 'other' });
    expect(relatedTarget).toBe('other');
  });
});

describe('El guards', () => {
  it('forbids innerHTML and clears children when textContent is replaced', () => {
    const { byId } = mountFixture('<div id="d"><span>old</span></div>');
    const node = byId.get('d');
    expect(() => { node.innerHTML = '<b>x</b>'; }).toThrow(/innerHTML is forbidden/);
    node.textContent = 'fresh';
    expect(node.children).toHaveLength(0);
    expect(node.textContent).toBe('fresh');
  });
});

describe('El child mutation', () => {
  it('append moves an existing node instead of duplicating it', () => {
    const { document, all } = mountFixture('<div id="from"><span id="s">hi</span></div><div id="to"></div>');
    const from = document.getElementById('from');
    const to = document.getElementById('to');
    const span = document.getElementById('s');
    const before = all.length;
    to.append(span);
    expect(from.children).toHaveLength(0);
    expect(to.children).toEqual([span]);
    expect(span.parent).toBe(to);
    // The flat registry stays unique: a move does not re-register the node.
    expect(all.filter(node => node === span)).toHaveLength(1);
    expect(all.length).toBe(before);
  });

  it('drains a fragment on append and swaps the subtree on replaceChildren', () => {
    const { document } = mountFixture('<ul id="list"><li id="old">old</li></ul>');
    const list = document.getElementById('list');
    const fragment = document.createDocumentFragment();
    const a = document.createElement('li');
    const b = document.createElement('li');
    fragment.append(a, b);
    expect(fragment.children).toEqual([a, b]);
    list.replaceChildren(fragment);
    expect(fragment.children).toHaveLength(0);
    expect(list.children).toEqual([a, b]);
    expect(document.getElementById('old').parent).toBeNull();
  });
});
