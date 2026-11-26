// Exercises duplicate-service.js through a fake browser that delivers its tab
// and window events in the order the real browsers did (docs/design.md probe).
import { describe, it, expect, vi } from 'vitest';
import { createDuplicateService, DUPE_NOTICE_KEY, FIRST_SWITCH_MESSAGE } from '../src/duplicate-service.js';

const DOC = 'https://docs.example.com/d/1';
const settle = () => new Promise(resolve => setImmediate(resolve));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function world({ enabled = true, split = false, incognitoContext = false, local = {} } = {}) {
  const w = { now: 1_800_000_000_000, tabs: [], nextId: 1, calls: [], local: { preventDuplicates: enabled, ...local }, session: {} };
  const listeners = {};
  const on = name => ({ addListener: fn => { (listeners[name] ??= []).push(fn); } });
  const emit = async (name, ...args) => { for (const fn of listeners[name] ?? []) await fn(...args); await settle(); };
  const get = keys => {
    const out = {};
    if (typeof keys === 'string') { if (keys in w.local) out[keys] = clone(w.local[keys]); return out; }
    for (const [k, d] of Object.entries(keys)) out[k] = k in w.local ? clone(w.local[k]) : d;
    return out;
  };
  w.api = {
    runtime: { getManifest: () => ({ incognito: split ? 'split' : undefined }), onStartup: on('onStartup') },
    extension: { inIncognitoContext: incognitoContext },
    storage: {
      local: { get: async k => get(k), set: async v => { Object.assign(w.local, clone(v)); await emit('storage', Object.fromEntries(Object.keys(v).map(k => [k, {}])), 'local'); } },
      session: { get: async k => ({ [k]: clone(w.session[k]) }), set: async v => { Object.assign(w.session, clone(v)); } },
      onChanged: on('storage'),
    },
    tabs: {
      onCreated: on('created'), onUpdated: on('updated'), onRemoved: on('removed'),
      get: vi.fn(async id => { const t = w.tabs.find(x => x.id === id); if (!t) throw new Error('No tab'); return clone(t); }),
      query: vi.fn(async () => clone(w.tabs)),
      update: vi.fn(async (id, props) => { w.calls.push(['tabs.update', id, props]); }),
      remove: vi.fn(async id => {
        w.calls.push(['tabs.remove', id]);
        if (w.removeFails) throw new Error('No tab with id');
        w.tabs = w.tabs.filter(t => t.id !== id);
        // Like the browser, removal does not wait for extension listeners.
        emit('removed', id, {});
      }),
    },
    windows: { onCreated: on('windowCreated'), update: vi.fn(async (id, props) => { w.calls.push(['windows.update', id, props]); }) },
  };
  w.notify = vi.fn(async () => {});
  w.service = createDuplicateService(w.api, { now: () => w.now, notify: w.notify });
  w.service.install();
  w.existing = (url, extra = {}) => { const t = { id: w.nextId++, windowId: 1, index: w.tabs.length, url, status: 'complete', active: false, incognito: false, ...extra }; w.tabs.push(t); return t; };
  // Firefox shape: about:blank at creation, then the page URL at commit.
  w.open = async (url, { opener, extra = {}, atCreate = { url: 'about:blank' } } = {}) => {
    const t = { id: w.nextId++, windowId: 1, index: w.tabs.length, status: 'loading', active: true, incognito: false, openerTabId: opener, ...atCreate, ...extra };
    w.tabs.push(t);
    await emit('created', clone(t));
    w.now += 50;
    t.url = url;
    delete t.pendingUrl;
    await emit('updated', t.id, { status: 'loading', url }, clone(t));
    await w.service.idle();
    return t;
  };
  w.emit = emit;
  w.alive = id => w.tabs.some(t => t.id === id);
  return w;
}

describe('duplicate service: switching', () => {
  it('focuses the match and its window, then closes the new tab, in that order (D9)', async () => {
    const w = world();
    const doc = w.existing(DOC, { windowId: 2 });
    w.existing('https://other.example/');
    const fresh = await w.open(DOC);
    expect(w.calls).toEqual([
      ['tabs.update', doc.id, { active: true }],
      ['windows.update', 2, { focused: true }],
      ['tabs.remove', fresh.id],
    ]);
    expect(w.alive(fresh.id)).toBe(false);
  });

  it('does nothing and stores nothing while the setting is off (default)', async () => {
    const w = world({ enabled: false });
    w.existing(DOC);
    const fresh = await w.open(DOC);
    expect(w.alive(fresh.id)).toBe(true);
    expect(w.calls).toEqual([]);
    expect(w.session).toEqual({});
  });

  it('turning it on takes effect without a restart', async () => {
    const w = world({ enabled: false });
    w.existing(DOC);
    await w.open(DOC);
    await w.api.storage.local.set({ preventDuplicates: true });
    const fresh = await w.open(DOC);
    expect(w.alive(fresh.id)).toBe(false);
  });

  it('never touches an existing tab that navigates to an open page', async () => {
    const w = world();
    w.existing(DOC);
    const other = w.existing('https://other.example/');
    other.url = DOC;
    await w.emit('updated', other.id, { status: 'loading', url: DOC }, clone(other));
    await w.service.idle();
    expect(w.calls).toEqual([]);
  });

  it('shows the first-switch notice once, stored durably (D16)', async () => {
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    await w.open(DOC);
    await w.open(DOC);
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.notify).toHaveBeenCalledWith(FIRST_SWITCH_MESSAGE);
    expect(w.local[DUPE_NOTICE_KEY]).toBe(true);
  });

  it('a failed close is silent: no notice, no error', async () => {
    const w = world();
    w.existing(DOC);
    w.removeFails = true;
    await w.open(DOC);
    expect(w.notify).not.toHaveBeenCalled();
  });

  it('keeps the new tab when it changed page before the close (re-read)', async () => {
    const w = world();
    w.existing(DOC);
    const fresh = { id: 50 };
    w.api.tabs.update.mockImplementationOnce(async () => { const t = w.tabs.find(x => x.id === fresh.id); if (t) t.url = 'https://moved.example/'; });
    await w.open(DOC, { extra: { id: 50 } });
    expect(w.alive(50)).toBe(true);
    expect(w.calls.some(c => c[0] === 'tabs.remove')).toBe(false);
  });
});

describe('duplicate service: keeps', () => {
  it('keeps Duplicate Tab (opener is the match)', async () => {
    const w = world();
    const doc = w.existing(DOC);
    const dup = await w.open(DOC, { opener: doc.id });
    expect(w.alive(dup.id)).toBe(true);
  });

  it('Reopen Closed Tab right after a switch keeps the copy (D4, no lower bound)', async () => {
    const w = world();
    w.existing(DOC);
    const first = await w.open(DOC);
    expect(w.alive(first.id)).toBe(false);
    w.now += 300;
    const reopened = await w.open(DOC);
    expect(w.alive(reopened.id)).toBe(true);
  });

  it('a page TabVacuum Search is opening is kept (D13)', async () => {
    const w = world({ local: { ignoreFragments: true } });
    w.existing(`${DOC}#b`);
    await w.service.allow(`${DOC}#a`);
    const opened = await w.open(`${DOC}#a`);
    expect(w.alive(opened.id)).toBe(true);
  });

  it('ignores a bulk open: three tabs in one window within a second, the first two included', async () => {
    const w = world();
    w.existing(DOC);
    const created = [];
    for (let i = 0; i < 3; i++) {
      const t = { id: w.nextId++, windowId: 1, index: w.tabs.length, url: 'about:blank', status: 'loading', incognito: false };
      w.tabs.push(t); created.push(t);
      await w.emit('created', clone(t));
      w.now += 100;
    }
    for (const t of created) { t.url = DOC; await w.emit('updated', t.id, { url: DOC, status: 'loading' }, clone(t)); }
    await w.service.idle();
    expect(created.every(t => w.alive(t.id))).toBe(true);
  });

  it("ignores a reopened window's tabs, including Firefox's first tab reported before its window (D6)", async () => {
    const w = world();
    w.existing(DOC);
    const a = { id: 40, windowId: 9, index: 0, url: 'about:blank', status: 'loading', incognito: false };
    const b = { id: 41, windowId: 9, index: 1, url: DOC, status: 'complete', discarded: true, incognito: false };
    w.tabs.push(a, b);
    await w.emit('created', clone(a));
    await w.emit('windowCreated', { id: 9, incognito: false });
    await w.emit('created', clone(b));
    a.url = DOC;
    await w.emit('updated', a.id, { url: DOC, status: 'loading' }, clone(a));
    await w.service.idle();
    expect(w.alive(40) && w.alive(41)).toBe(true);
  });

  it('ignores tabs for 10 s after browser startup', async () => {
    const w = world();
    w.existing(DOC);
    await w.emit('onStartup');
    await w.service.idle();
    const restored = await w.open(DOC);
    expect(w.alive(restored.id)).toBe(true);
    w.now += 10_000;
    const later = await w.open(DOC);
    expect(w.alive(later.id)).toBe(false);
  });
});

describe('duplicate service: worker lifetime and contexts (D10, D11)', () => {
  it('a restarted worker continues from storage.session', async () => {
    const w = world();
    w.existing(DOC);
    const t = { id: 70, windowId: 1, index: 1, url: 'about:blank', status: 'loading', incognito: false };
    w.tabs.push(t);
    await w.emit('created', clone(t));
    await w.service.idle();
    const second = createDuplicateService(w.api, { now: () => w.now, notify: w.notify });
    t.url = DOC;
    await second.onUpdated(t.id, { url: DOC, status: 'loading' }, clone(t));
    expect(w.alive(70)).toBe(false);
  });

  it('split incognito workers write only their own key', async () => {
    const w = world({ split: true, incognitoContext: true });
    w.existing(DOC, { incognito: true });
    await w.open(DOC, { extra: { incognito: true } });
    expect(Object.keys(w.session)).toEqual(['dupe.private']);
  });

  it('Firefox keeps normal and private records apart in one background', async () => {
    const w = world();
    w.existing(DOC, { incognito: true });
    const normal = await w.open(DOC);
    expect(w.alive(normal.id)).toBe(true);
    expect(Object.keys(w.session).sort()).toEqual(['dupe.normal']);
  });
});
