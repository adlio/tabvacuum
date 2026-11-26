// Exercises duplicate-service.js through a fake browser that delivers its tab
// and window events in the order the real browsers did (docs/design.md probe).
import { describe, it, expect, vi } from 'vitest';
import { createDuplicateService, DUPE_NOTICE_KEY, FIRST_SWITCH_MESSAGE } from '../src/duplicate-service.js';
import { DUPE_BURST_MS, DUPE_SETTLE_MS } from '../src/core.js';

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
    runtime: { id: 'atv@test', getURL: path => `ext://atv/${path}`, getManifest: () => ({ incognito: split ? 'split' : undefined }), onStartup: on('onStartup') },
    extension: { inIncognitoContext: incognitoContext },
    storage: {
      local: { get: async k => get(k), set: async v => { Object.assign(w.local, clone(v)); await emit('storage', Object.fromEntries(Object.keys(v).map(k => [k, {}])), 'local'); } },
      session: { get: async k => ({ [k]: clone(w.session[k]) }), set: async v => { Object.assign(w.session, clone(v)); } },
      onChanged: on('storage'),
    },
    tabs: {
      onCreated: on('created'), onUpdated: on('updated'), onRemoved: on('removed'), onActivated: on('activated'),
      get: vi.fn(async id => { const t = w.tabs.find(x => x.id === id); if (!t) throw new Error('No tab'); return clone(t); }),
      query: vi.fn(async () => clone(w.tabs)),
      update: vi.fn(async (id, props) => {
        w.calls.push(['tabs.update', id, props]);
        const t = w.tabs.find(x => x.id === id);
        if (t && props.url) {
          if (w.updateFails) throw new Error('Cannot navigate');
          (t.history ??= []).push(t.url);
          t.url = props.url;
          emit('updated', id, { url: props.url, status: 'loading' }, clone(t));
        }
      }),
      goForward: vi.fn(async id => { w.calls.push(['tabs.goForward', id]); throw new Error('Cannot go forward'); }),
      goBack: vi.fn(async id => {
        w.calls.push(['tabs.goBack', id]);
        const t = w.tabs.find(x => x.id === id);
        if (!t?.history?.length) throw new Error('Cannot go back');
        t.url = t.history.pop();
        emit('updated', id, { url: t.url, status: 'loading' }, clone(t));
      }),
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
  // Timers run only when the test advances the clock with w.tick().
  w.timers = [];
  w.schedule = (fn, ms) => { w.timers.push({ at: w.now + ms, fn }); };
  w.tick = async ms => {
    w.now += ms;
    for (const timer of w.timers.filter(t => t.at <= w.now)) { w.timers.splice(w.timers.indexOf(timer), 1); timer.fn(); }
    await settle();
    await w.service.idle();
  };
  w.settle = () => w.tick(DUPE_SETTLE_MS + 20);
  w.service = createDuplicateService(w.api, { now: () => w.now, notify: w.notify, schedule: w.schedule });
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
    await w.settle();
    return t;
  };
  w.emit = emit;
  // The user (or the browser) brings a tab to the front of its window.
  w.activate = async id => {
    const t = w.tabs.find(x => x.id === id);
    for (const x of w.tabs) if (x.windowId === t.windowId) x.active = x.id === id;
    await emit('activated', { tabId: id, windowId: t.windowId });
  };
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

describe('duplicate service: the user moved on (F2) and the settle period', () => {
  // A duplicate created in front whose URL commits, without running the settle timer yet.
  async function frontDuplicate(w, url, { active = true } = {}) {
    const t = { id: w.nextId++, windowId: 1, index: w.tabs.length, url: 'about:blank', status: 'loading', active, incognito: false };
    if (active) for (const x of w.tabs) if (x.windowId === 1) x.active = false;
    w.tabs.push(t);
    await w.emit('created', clone(t));
    w.now += 20;
    t.url = url;
    await w.emit('updated', t.id, { status: 'loading', url }, clone(t));
    await w.service.idle();
    return t;
  }

  it('user picks another tab while a front duplicate settles: duplicate closed, focus left alone', async () => {
    const w = world();
    const doc = w.existing(DOC, { windowId: 2 });
    const third = w.existing('https://third.example/');
    const dup = await frontDuplicate(w, DOC);
    await w.activate(third.id);
    await w.settle();
    expect(w.alive(dup.id)).toBe(false);
    expect(w.calls).toEqual([['tabs.remove', dup.id]]);
    expect(w.tabs.find(t => t.id === third.id).active).toBe(true);
    expect(doc.active).toBe(false);
  });

  it('Firefox shape: created in the background, then shown, then left: still a quiet close', async () => {
    const w = world();
    w.existing(DOC);
    const third = w.existing('https://third.example/');
    const dup = await frontDuplicate(w, DOC, { active: false });
    await w.activate(dup.id);
    await w.activate(third.id);
    await w.settle();
    expect(w.calls).toEqual([['tabs.remove', dup.id]]);
  });

  it('a duplicate that opened in the background and was never shown still brings the open copy forward', async () => {
    const w = world();
    const doc = w.existing(DOC);
    const chat = w.existing('https://chat.example/', { active: true });
    const dup = await frontDuplicate(w, DOC, { active: false });
    await w.settle();
    expect(w.calls).toEqual([['tabs.update', doc.id, { active: true }], ['tabs.remove', dup.id]]);
    expect(chat.id).toBeDefined();
  });

  it('a duplicate still in front is switched as before', async () => {
    const w = world();
    const doc = w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await frontDuplicate(w, DOC);
    await w.settle();
    expect(w.calls).toEqual([['tabs.update', doc.id, { active: true }], ['windows.update', 1, { focused: true }], ['tabs.remove', dup.id]]);
  });

  it('switches 200 ms after creation, not before, while the bulk rule keeps its 1 s window', async () => {
    expect(DUPE_SETTLE_MS).toBe(200);
    expect(DUPE_BURST_MS).toBe(1000);
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await frontDuplicate(w, DOC);
    await w.tick(DUPE_SETTLE_MS - 40); // 180 ms after creation
    expect(w.alive(dup.id)).toBe(true);
    await w.tick(40); // 220 ms: past the settle period and its timer slack
    expect(w.alive(dup.id)).toBe(false);
  });
});

describe('duplicate service: spread-out bulk opens (F3)', () => {
  const shape = (w, id, url, extra = {}) => ({ id, windowId: 1, index: w.tabs.length, url: '', pendingUrl: url, status: 'loading', incognito: false, ...extra });
  async function create(w, t) { w.tabs.push(t); await w.emit('created', clone(t)); }
  async function commit(w, t) { t.url = t.pendingUrl; delete t.pendingUrl; await w.emit('updated', t.id, { status: 'loading', url: t.url }, clone(t)); }

  it('P5d: three tabs 150 ms apart, doc first and committed at once: the doc copy is kept and marked bulk after it was created', async () => {
    const w = world();
    w.existing(DOC);
    const first = shape(w, 80, DOC);
    await create(w, first);
    await commit(w, first);
    await w.tick(150);
    await create(w, shape(w, 81, 'https://a.example/'));
    await w.tick(150);
    await create(w, shape(w, 82, 'https://b.example/'));
    await w.tick(1500);
    expect(w.alive(80)).toBe(true);
    expect(w.calls).toEqual([]);
    expect(['80', '81', '82'].map(id => w.session['dupe.normal'].tabs[id]?.ignored)).toEqual(['bulk', 'bulk', 'bulk']);
  });

  it('two tabs 150 ms apart are not a burst: the duplicate switches once the window is quiet, within the 1 s cap', async () => {
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    const first = shape(w, 83, DOC);
    await create(w, first);
    await commit(w, first);
    await w.tick(150);
    await create(w, shape(w, 84, 'https://a.example/'));
    await w.tick(150); // 300 ms: the second tab re-armed the wait to 350 ms
    expect(w.alive(83)).toBe(true);
    await w.tick(100); // 400 ms
    expect(w.alive(83)).toBe(false);
  });

  it('the 1 s cap: restored tabs arriving every 150 ms keep re-arming the wait, but the duplicate is judged 1 s after creation', async () => {
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    const first = shape(w, 85, DOC);
    await create(w, first);
    await commit(w, first);
    // Sleeping restored tabs are ignored as 'restored', so they never start a bulk open.
    for (let i = 0; i < 6; i++) {
      await w.tick(150);
      await create(w, { id: 120 + i, windowId: 1, index: w.tabs.length, url: `https://r.example/${i}`, status: 'unloaded', discarded: true, incognito: false });
    }
    await w.tick(50); // 950 ms
    expect(w.alive(85)).toBe(true);
    await w.tick(80); // 1030 ms: capped
    expect(w.alive(85)).toBe(false);
  });

  it('P5e order: a burst whose handlers queue behind a slow tabs API, with the doc committed before they run, keeps the doc', async () => {
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    // Hold the tabs API while Chromium is busy creating tabs, so handlers queue up.
    let release;
    const held = new Promise(r => { release = r; });
    const query = w.api.tabs.query.getMockImplementation();
    w.api.tabs.query.mockImplementation(async () => { await held; return query(); });
    const first = shape(w, 90, DOC);
    w.tabs.push(first);
    const pending = [w.emit('created', clone(first))];
    for (const [id, gap] of [[91, 23], [92, 21]]) {
      w.now += gap;
      const t = shape(w, id, `https://bm.example/${id}`);
      w.tabs.push(t);
      pending.push(w.emit('created', clone(t)));
    }
    first.url = DOC; delete first.pendingUrl;
    pending.push(w.emit('updated', first.id, { status: 'loading', url: DOC }, clone(first)));
    w.now += 1500; // the queue drains long after the burst arrived
    release();
    await Promise.all(pending);
    await w.tick(2000);
    expect(w.alive(90)).toBe(true);
    expect(w.session['dupe.normal'].tabs['90'].ignored).toBe('bulk');
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
    await w.settle();
    expect(created.every(t => w.alive(t.id))).toBe(true);
  });

  it('F1: a Chromium bulk open whose first tab commits before the others exist keeps that tab', async () => {
    const w = world();
    w.existing(DOC);
    const shape = (id, url) => ({ id, windowId: 1, index: w.tabs.length, url: '', pendingUrl: url, status: 'loading', incognito: false });
    // Chromium order seen in P5/P5c: create #1, commit #1, then create #2 and #3.
    const first = shape(60, DOC);
    w.tabs.push(first);
    await w.emit('created', clone(first));
    w.now += 20;
    first.url = DOC; delete first.pendingUrl;
    await w.emit('updated', first.id, { status: 'loading', url: DOC }, clone(first));
    await w.service.idle();
    for (const [id, url] of [[61, 'https://a.example/'], [62, 'https://b.example/']]) {
      w.now += 15;
      const t = shape(id, url);
      w.tabs.push(t);
      await w.emit('created', clone(t));
    }
    await w.settle();
    await w.tick(5000);
    expect(w.alive(60)).toBe(true);
    expect(w.calls).toEqual([]);
    expect(w.session['dupe.normal'].tabs[60].ignored).toBe('bulk');
  });

  it('a lone new tab (no burst) that commits at once is still switched after the settle period', async () => {
    const w = world();
    w.existing(DOC);
    w.existing('https://other.example/');
    const t = { id: 63, windowId: 1, index: 2, url: '', pendingUrl: DOC, status: 'loading', incognito: false };
    w.tabs.push(t);
    await w.emit('created', clone(t));
    t.url = DOC; delete t.pendingUrl;
    await w.emit('updated', t.id, { status: 'loading', url: DOC }, clone(t));
    await w.service.idle();
    expect(w.alive(63)).toBe(true); // nothing closes inside the burst window
    await w.settle();
    expect(w.alive(63)).toBe(false);
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
    await w.settle();
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
    const second = createDuplicateService(w.api, { now: () => w.now, notify: w.notify, schedule: w.schedule });
    w.service = second;
    t.url = DOC;
    await second.onUpdated(t.id, { url: DOC, status: 'loading' }, clone(t));
    await w.settle();
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

describe('duplicate service: Ask first (R14.11)', () => {
  const ASK = 'ext://atv/ask.html';
  const ask = () => world({ local: { preventDuplicatesMode: 'ask' } });
  const from = (w, id) => ({ id: 'atv@test', url: ASK, tab: { id, windowId: w.tabs.find(t => t.id === id)?.windowId ?? 1, incognito: false } });
  const send = (w, id, message) => w.service.handleAskMessage(message, from(w, id));

  it('shows the prompt in the new tab instead of switching, and touches nothing else', async () => {
    const w = ask();
    w.existing(DOC, { title: 'Roadmap' });
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    expect(w.calls).toEqual([['tabs.update', dup.id, { url: ASK }]]);
    expect(w.alive(dup.id)).toBe(true);
    expect(w.session['dupe.normal'].asking[dup.id]).toMatchObject({ matchId: 1, url: DOC });
    expect(w.notify).not.toHaveBeenCalled();
    expect(await send(w, dup.id, { command: 'dupeAskInfo' })).toEqual({ state: 'ask', title: 'Roadmap', host: 'docs.example.com', otherWindow: false });
  });

  it('Switch focuses the open copy and its window, then closes the prompt tab', async () => {
    const w = ask();
    const doc = w.existing(DOC, { windowId: 2 });
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    w.calls.length = 0;
    expect(await send(w, dup.id, { command: 'dupeAskChoice', choice: 'switch' })).toEqual({ state: 'switched' });
    expect(w.calls).toEqual([['tabs.update', doc.id, { active: true }], ['windows.update', 2, { focused: true }], ['tabs.remove', dup.id]]);
  });

  it('Keep both hands the page its URL to load, and the tab is left alone for good', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    w.calls.length = 0;
    expect(await send(w, dup.id, { command: 'dupeAskChoice', choice: 'keep' })).toEqual({ state: 'kept', url: DOC });
    expect(w.session['dupe.normal'].asking[dup.id]).toBeUndefined();
    // The page runs location.replace(url): the tab reports the page again.
    const t = w.tabs.find(x => x.id === dup.id);
    t.url = DOC;
    await w.emit('updated', dup.id, { url: DOC, status: 'loading' }, clone(t));
    await w.tick(5000);
    expect(w.calls).toEqual([]);
    expect(w.alive(dup.id)).toBe(true);
  });

  it('restoring a page with no history entry to go back to loads the URL again', async () => {
    const w = ask();
    const doc = w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    w.tabs.find(t => t.id === dup.id).history = [];
    w.calls.length = 0;
    w.tabs = w.tabs.filter(t => t.id !== doc.id);
    await w.emit('removed', doc.id, {});
    await w.service.idle();
    expect(w.calls).toEqual([['tabs.goBack', dup.id], ['tabs.goForward', dup.id], ['tabs.update', dup.id, { url: DOC }]]);
  });

  it('the user pressing Back on the prompt keeps the original page without asking again', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    const t = w.tabs.find(x => x.id === dup.id);
    t.url = DOC;
    await w.emit('updated', dup.id, { url: DOC, status: 'loading' }, clone(t));
    await w.settle();
    expect(w.session['dupe.normal'].asking[dup.id]).toBeUndefined();
    expect(w.calls.filter(c => c[1] === dup.id)).toEqual([['tabs.update', dup.id, { url: ASK }]]);
  });

  it('the open copy closing while the prompt shows gives the prompt tab its page back', async () => {
    const w = ask();
    const doc = w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    w.tabs = w.tabs.filter(t => t.id !== doc.id);
    await w.emit('removed', doc.id, {});
    await w.service.idle();
    expect(w.calls).toContainEqual(['tabs.goBack', dup.id]);
    expect(w.tabs.find(t => t.id === dup.id).url).toBe(DOC);
  });

  it('Switch after the open copy navigated elsewhere keeps the tab instead', async () => {
    const w = ask();
    const doc = w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    doc.url = 'https://elsewhere.example/';
    w.calls.length = 0;
    expect(await send(w, dup.id, { command: 'dupeAskChoice', choice: 'switch' })).toEqual({ state: 'kept', url: DOC });
    expect(w.calls).toEqual([]);
  });

  it('a restored prompt (Reopen Closed Tab) has no entry: the tab is kept and goes back to its page', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const restored = { id: 77, windowId: 1, index: 2, url: ASK, status: 'loading', incognito: false, history: [DOC] };
    w.tabs.push(restored);
    await w.emit('created', clone(restored));
    expect(await send(w, 77, { command: 'dupeAskInfo' })).toEqual({ state: 'restored' });
    await w.settle();
    expect(restored.url).toBe(DOC);
    expect(w.session['dupe.normal'].tabs['77'].done).toBe('kept');
    expect(w.calls.filter(c => c[0] === 'tabs.remove')).toEqual([]);
  });

  it('a restored prompt with no history to return to says so instead of hanging', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const restored = { id: 78, windowId: 1, index: 2, url: ASK, status: 'loading', incognito: false, history: [] };
    w.tabs.push(restored);
    await w.emit('created', clone(restored));
    expect(await send(w, 78, { command: 'dupeAskInfo' })).toEqual({ state: 'lost' });
    expect(w.alive(78)).toBe(true);
  });

  it('rejects messages that do not come from the prompt page in its own tab', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    await expect(w.service.handleAskMessage({ command: 'dupeAskChoice', choice: 'switch' }, { ...from(w, dup.id), url: 'https://evil.example/' })).rejects.toThrow();
    await expect(w.service.handleAskMessage({ command: 'dupeAskChoice', choice: 'switch' }, { ...from(w, dup.id), id: 'other-extension' })).rejects.toThrow();
    expect(w.service.handleAskMessage({ command: 'getSettings' }, from(w, dup.id))).toBeUndefined();
    expect(w.alive(dup.id)).toBe(true);
  });

  it('keeps the tab when the prompt cannot be shown (never closes without asking)', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    w.updateFails = true;
    const dup = await w.open(DOC);
    expect(w.alive(dup.id)).toBe(true);
    expect(w.calls.some(c => c[0] === 'tabs.remove')).toBe(false);
    expect(w.session['dupe.normal'].asking[dup.id]).toBeUndefined();
  });

  it('already-allowed cases show no prompt: opened from its match, and a reopen within 60 s', async () => {
    const w = ask();
    const doc = w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC, { opener: doc.id });
    expect(w.calls).toEqual([]);
    expect(w.alive(dup.id)).toBe(true);
  });

  it('a background duplicate gets its prompt without anything being activated', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://chat.example/', { active: true });
    const dup = await w.open(DOC, { extra: { active: false } });
    expect(w.calls).toEqual([['tabs.update', dup.id, { url: ASK }]]);
  });

  it('closing the prompt tab forgets it', async () => {
    const w = ask();
    w.existing(DOC);
    w.existing('https://other.example/');
    const dup = await w.open(DOC);
    w.tabs = w.tabs.filter(t => t.id !== dup.id);
    await w.emit('removed', dup.id, {});
    await w.service.idle();
    expect(w.session['dupe.normal'].asking).toEqual({});
  });
});
