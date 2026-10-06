// Exercises stale-service.js through a fake browser that delivers real
// listener callbacks, keeps normal and private state apart, and can restart
// the worker or the whole browser.
import { describe, it, expect, vi } from 'vitest';
import { createStaleService, STALE_ALARM, PREVIEW_EXPIRED, RULE_CHANGED, OPEN_FAILED } from '../src/stale-service.js';
import { DAY_MS, HOUR_MS, LEASE_TTL_MS, PREVIEW_TTL_MS, nextLocalHour } from '../src/stale-core.js';

const NOW = Date.UTC(2026, 9, 6, 12, 20, 0);
const WEEK = 7 * DAY_MS;
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

/**
 * firefox: native lastAccessed records deselection and is trusted; one
 * background sees normal and private tabs.
 * chromium: lastAccessed records selection only, onActivated has no
 * previousTabId, discard replaces the tab ID, restart changes every ID. The
 * manifest is "split": the normal and incognito workers each see and hear only
 * their own profile's tabs and windows, but share storage.session.
 * Both: a one-shot alarm is removed as it fires.
 */
function createWorld({ browser = 'firefox' } = {}) {
  const firefox = browser === 'firefox';
  const world = {
    now: NOW, tabs: [], windows: new Map(), local: {}, session: {}, alarms: new Map(),
    nextTabId: 1, workers: [], ids: 0,
  };
  const tabsIn = windowId => world.tabs.filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index);
  // Which tabs and windows a worker can see.
  const sees = (incognitoContext, incognito) => firefox || incognito === incognitoContext;

  world.addWindow = (id, { incognito = false, type = 'normal' } = {}) => {
    world.windows.set(id, { id, incognito, type, focused: false });
  };
  world.addTab = (windowId, extra = {}) => {
    const id = world.nextTabId++;
    const win = world.windows.get(windowId);
    const tab = {
      id, windowId, index: tabsIn(windowId).length, active: false, pinned: false, audible: false,
      incognito: win.incognito, status: 'complete', url: `https://site.example/${id}`, title: `Tab ${id}`,
      lastAccessed: world.now, ...extra,
    };
    world.tabs.push(tab);
    world.emitTab(tab, 'tabs.onCreated', clone(tab));
    return id;
  };
  world.tab = id => world.tabs.find(t => t.id === id);
  world.activate = tabId => {
    const tab = world.tab(tabId);
    const previous = tabsIn(tab.windowId).find(t => t.active);
    if (previous) {
      previous.active = false;
      if (firefox) previous.lastAccessed = world.now; // Firefox records deselection
    }
    tab.active = true;
    tab.lastAccessed = world.now;
    world.emitTab(tab, 'tabs.onActivated', firefox
      ? { tabId, windowId: tab.windowId, previousTabId: previous?.id }
      : { tabId, windowId: tab.windowId });
  };
  world.navigate = (tabId, url) => {
    const tab = world.tab(tabId);
    const change = url && url !== tab.url ? { status: 'loading', url } : { status: 'loading' };
    if (url) tab.url = url;
    world.emitTab(tab, 'tabs.onUpdated', tabId, change, clone(tab));
  };
  world.closeTab = tabId => {
    const tab = world.tab(tabId);
    world.tabs = world.tabs.filter(t => t.id !== tabId);
    world.emitTab(tab, 'tabs.onRemoved', tabId, {});
  };
  world.replace = tabId => { // Chromium discard
    const tab = world.tab(tabId);
    const added = world.nextTabId++;
    tab.id = added;
    world.emitTab(tab, 'tabs.onReplaced', added, tabId);
    return added;
  };
  world.emit = (name, ...args) => {
    for (const worker of world.workers) for (const fn of [...(worker.listeners[name] ?? [])]) fn(...args);
  };
  // Tab events reach only the workers that can see the tab.
  world.emitTab = (tab, name, ...args) => {
    for (const worker of world.workers) {
      if (!sees(worker.incognitoContext, tab?.incognito === true)) continue;
      for (const fn of [...(worker.listeners[name] ?? [])]) fn(...args);
    }
  };

  function makeApi({ incognitoContext = false } = {}) {
    const listeners = {};
    const event = name => ({
      addListener: fn => { (listeners[name] ??= new Set()).add(fn); },
      removeListener: fn => listeners[name]?.delete(fn),
    });
    const read = (store, keys) => {
      if (keys == null) return clone(store);
      if (typeof keys === 'string' || Array.isArray(keys)) {
        return Object.fromEntries([keys].flat().filter(k => k in store).map(k => [k, clone(store[k])]));
      }
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? clone(store[k]) : d]));
    };
    const visibleWindow = id => {
      const win = world.windows.get(id);
      return win && sees(incognitoContext, win.incognito) ? win : undefined;
    };
    const api = {
      runtime: {
        id: 'tabvacuum@adlio',
        getURL: path => `${firefox ? 'moz-extension' : 'chrome-extension'}://uuid/${path}`,
        getManifest: () => (firefox ? { manifest_version: 3 } : { manifest_version: 3, incognito: 'split' }),
        onStartup: event('runtime.onStartup'), onInstalled: event('runtime.onInstalled'),
      },
      extension: { inIncognitoContext: incognitoContext },
      tabs: {
        query: vi.fn(async () => clone(world.tabs.filter(t => sees(incognitoContext, t.incognito)))),
        get: vi.fn(async id => {
          const tab = world.tab(id);
          if (!tab || !sees(incognitoContext, tab.incognito)) throw new Error(`No tab with id: ${id}`);
          return clone(tab);
        }),
        remove: vi.fn(async id => {
          if (!world.tab(id)) throw new Error(`No tab with id: ${id}`);
          world.closeTab(id);
        }),
        onCreated: event('tabs.onCreated'), onActivated: event('tabs.onActivated'),
        onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved'), onReplaced: event('tabs.onReplaced'),
      },
      windows: {
        get: vi.fn(async (id, options) => {
          const win = visibleWindow(id);
          if (!win) throw new Error(`No window with id: ${id}`);
          return { ...clone(win), ...(options?.populate ? { tabs: clone(tabsIn(id)) } : {}) };
        }),
        getAll: vi.fn(async ({ windowTypes } = {}) => [...world.windows.values()]
          .filter(w => sees(incognitoContext, w.incognito) && (!windowTypes || windowTypes.includes(w.type))).map(clone)),
        getLastFocused: vi.fn(async () => clone([...world.windows.values()][0])),
      },
      storage: {
        local: {
          get: vi.fn(async keys => read(world.local, keys)),
          set: vi.fn(async items => {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: world.local[k], newValue: clone(v) };
              world.local[k] = clone(v);
            }
            world.emit('storage.onChanged', changes, 'local');
          }),
        },
        session: {
          get: vi.fn(async keys => read(world.session, keys)),
          set: vi.fn(async items => { for (const [k, v] of Object.entries(items)) world.session[k] = clone(v); }),
          remove: vi.fn(async keys => { for (const k of [keys].flat()) delete world.session[k]; }),
        },
        onChanged: event('storage.onChanged'),
      },
      alarms: {
        create: vi.fn(async (name, { when }) => { world.alarms.set(name, { name, scheduledTime: when }); }),
        get: vi.fn(async name => clone(world.alarms.get(name))),
        clear: vi.fn(async name => world.alarms.delete(name)),
        onAlarm: event('alarms.onAlarm'),
      },
      action: { openPopup: vi.fn(async () => {}) },
    };
    return { api, listeners };
  }

  /**
   * Starts a worker (the extension background). Earlier workers stop
   * receiving events; with keepOthers, only an earlier worker of the same
   * context is replaced (a Chromium split worker restarting on its own).
   */
  world.startWorker = ({ incognitoContext = false, keepOthers = false } = {}) => {
    const { api, listeners } = makeApi({ incognitoContext });
    const notify = vi.fn(async () => {});
    const service = createStaleService(api, {
      now: () => world.now, newId: () => `id-${++world.ids}`, notify, nativeTrusted: firefox,
    });
    const worker = { api, listeners, service, notify, incognitoContext };
    world.workers = keepOthers ? [...world.workers.filter(w => w.incognitoContext !== incognitoContext), worker] : [worker];
    service.install();
    return worker;
  };

  /** Full browser restart: session storage cleared; Chromium changes every tab ID. */
  world.restartBrowser = () => {
    world.session = {};
    if (firefox) world.alarms.clear(); // Firefox alarms do not survive a restart
    if (!firefox) for (const tab of world.tabs) tab.id = world.nextTabId++;
    return world.startWorker();
  };

  /** Fires the alarm as browsers do: the one-shot alarm is removed, then the callback runs. */
  world.fireAlarm = (worker = world.workers[0]) => {
    const alarm = world.alarms.get(STALE_ALARM);
    world.alarms.delete(STALE_ALARM);
    return worker.service.handleAlarm(clone(alarm));
  };

  return world;
}

/** One normal window: active tab 1, tabs 2..n background, all viewed `age` ago. */
async function setup({ browser = 'firefox', background = 3, age = 2 * WEEK } = {}) {
  const world = createWorld({ browser });
  world.addWindow(1);
  world.now = NOW - age;
  const front = world.addTab(1);
  const others = Array.from({ length: background }, () => world.addTab(1));
  world.now = NOW;
  world.tab(front).active = true;
  world.tab(front).lastAccessed = NOW;
  const worker = world.startWorker();
  await settle();
  return { world, worker, front, others, svc: worker.service };
}

const enable = (svc, windowId = 1) => svc.saveSettings({ autoCloseStaleEnabled: true }, { windowId, staleOnly: true });
const disable = (svc, windowId = 1) => svc.saveSettings({ autoCloseStaleEnabled: false }, { windowId, staleOnly: true });

describe('defaults and state shape', () => {
  it('starts with automation off, a prospective next run, and a preview id even at zero', async () => {
    const { world, svc } = await setup({ background: 0 });
    const state = await svc.getState(1);
    expect(state.settings).toEqual({ staleThresholdMs: WEEK, autoCloseStaleEnabled: false, skipPinned: true, skipAudible: true });
    expect(state.auto).toEqual({ enabled: false, available: true, nextRunAt: nextLocalHour(NOW), count: 0, error: null });
    expect(state.preview).toMatchObject({ count: 0, tabs: [], windowCount: 0, unknownCount: 0 });
    expect(state.preview.id).toMatch(/\S/);
    expect(world.alarms.size).toBe(0);
  });

  it('previews old Firefox tabs and projects the automatic count to the next run', async () => {
    const { svc, others } = await setup();
    const state = await svc.getState(1);
    expect(state.preview.count).toBe(3);
    expect(state.preview.tabs.map(t => t.id)).toEqual(others);
    expect(state.preview.tabs[0]).toEqual({ id: others[0], title: `Tab ${others[0]}`, url: `https://site.example/${others[0]}`, lastViewedAt: NOW - 2 * WEEK });
    expect(state.auto.count).toBe(3);
  });

  it('counts tabs that cross the threshold before the next run only in the automatic projection', async () => {
    const { svc } = await setup({ age: WEEK - 10 * 60_000 });
    const state = await svc.getState(1);
    expect(state.preview.count).toBe(0);
    expect(state.auto.count).toBe(3);
  });

  it('rejects an unknown window', async () => {
    const { svc } = await setup();
    await expect(svc.getState(42)).rejects.toThrow(/window/);
    await expect(svc.getState('1')).rejects.toThrow(/window/);
  });
});

describe('manual close from a preview', () => {
  it('closes exactly the previewed tabs, once', async () => {
    const { world, svc, others } = await setup();
    const { preview } = await svc.getState(1);
    // A tab that becomes eligible after the preview is not added.
    world.now = NOW - 3 * WEEK;
    const late = world.addTab(1);
    world.now = NOW;
    const result = await svc.closePreview(1, preview.id);
    expect(result).toEqual({ message: 'Closed 3 tabs not viewed recently.', closed: 3, skipped: 0, failed: 0 });
    expect(world.tab(late)).toBeTruthy();
    for (const id of others) expect(world.tab(id)).toBeUndefined();
    await expect(svc.closePreview(1, preview.id)).rejects.toThrow(PREVIEW_EXPIRED);
  });

  it('runs a duplicate close message only once', async () => {
    const { world, svc } = await setup();
    const { preview } = await svc.getState(1);
    const results = await Promise.allSettled([svc.closePreview(1, preview.id), svc.closePreview(1, preview.id)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(world.workers[0].api.tabs.remove).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['viewed', (world, id) => { world.activate(id); world.activate(1); }],
    ['navigated to the same URL', (world, id) => world.navigate(id)],
    ['navigated elsewhere', (world, id) => world.navigate(id, 'https://other.example/')],
    ['pinned', (world, id) => { world.tab(id).pinned = true; }],
    ['made audible', (world, id) => { world.tab(id).audible = true; }],
    ['moved to another window', (world, id) => { world.addWindow(2); world.tab(id).windowId = 2; }],
    ['closed', (world, id) => world.closeTab(id)],
  ])('keeps a candidate that was %s after the preview', async (_, change) => {
    const { world, svc, others } = await setup();
    const { preview } = await svc.getState(1);
    change(world, others[0]);
    await settle();
    const result = await svc.closePreview(1, preview.id);
    expect(result).toMatchObject({ closed: 2, skipped: 1, failed: 0 });
    expect(result.message).toBe('Closed 2 tabs not viewed recently. Kept 1 tab that changed or is no longer stale.');
  });

  it('a recycled same-URL tab with a new ID is not substituted', async () => {
    const { world, svc, others } = await setup({ background: 2 });
    const { preview } = await svc.getState(1);
    const url = world.tab(others[0]).url;
    world.closeTab(others[0]);
    world.now = NOW - 3 * WEEK;
    world.addTab(1, { url });
    world.now = NOW;
    expect(await svc.closePreview(1, preview.id)).toMatchObject({ closed: 1, skipped: 1 });
  });

  it('reports a removal failure without retrying it', async () => {
    const { world, svc, others } = await setup();
    const { preview } = await svc.getState(1);
    const { remove } = world.workers[0].api.tabs;
    remove.mockImplementationOnce(async () => { throw new Error('busy'); });
    const result = await svc.closePreview(1, preview.id);
    expect(result).toMatchObject({ closed: 2, skipped: 0, failed: 1 });
    expect(remove.mock.calls.filter(([id]) => id === others[0])).toHaveLength(1);
  });

  it('never closes the last tab of a window', async () => {
    const { world, svc, front, others } = await setup({ background: 1 });
    const { preview } = await svc.getState(1);
    world.closeTab(front);
    world.tab(others[0]).active = false; // window has no other active tab
    expect(await svc.closePreview(1, preview.id)).toMatchObject({ closed: 0, skipped: 1 });
  });

  it('rejects a preview from another window, an expired one and arbitrary ids', async () => {
    const { world, svc } = await setup();
    world.addWindow(2);
    world.addTab(2, { active: true });
    const { preview } = await svc.getState(1);
    await expect(svc.closePreview(2, preview.id)).rejects.toThrow(PREVIEW_EXPIRED);
    await expect(svc.closePreview(1, preview.id)).rejects.toThrow(PREVIEW_EXPIRED); // burned by the misuse
    const next = await svc.getState(1);
    world.now += PREVIEW_TTL_MS;
    await expect(svc.closePreview(1, next.preview.id)).rejects.toThrow(PREVIEW_EXPIRED);
    for (const bad of [undefined, '', 5, 'x'.repeat(500), '__proto__', 'toString']) {
      await expect(svc.closePreview(1, bad)).rejects.toThrow(PREVIEW_EXPIRED);
    }
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
  });

  it('a threshold change invalidates an earlier preview', async () => {
    const { world, svc } = await setup();
    const { preview } = await svc.getState(1);
    await svc.saveSettings({ staleThresholdMs: 3 * DAY_MS }, { windowId: 1, staleOnly: true });
    await expect(svc.closePreview(1, preview.id)).rejects.toThrow(PREVIEW_EXPIRED);
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
  });

  it('a rule change mid-batch stops before the next removal and returns actual counts with an error', async () => {
    const { world, svc } = await setup();
    const { preview } = await svc.getState(1);
    const { remove } = world.workers[0].api.tabs;
    const gate = deferred();
    remove.mockImplementationOnce(async id => { await gate.promise; world.closeTab(id); });
    const closing = svc.closePreview(1, preview.id);
    await settle();
    // The rule save is not queued behind the batch.
    await svc.saveSettings({ staleThresholdMs: 2 * WEEK }, { windowId: 1, staleOnly: true });
    gate.resolve();
    const result = await closing;
    expect(result).toMatchObject({ closed: 1, skipped: 2, failed: 0, error: RULE_CHANGED });
    expect(result.message).toMatch(/^Closed 1 tab/);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('manual cleanup can include pinned/audible tabs when those settings are off, never the active tab', async () => {
    const { world, svc, front, others } = await setup();
    world.tab(others[0]).pinned = true;
    world.tab(others[1]).audible = true;
    expect((await svc.getState(1)).preview.count).toBe(1);
    await svc.saveSettings({ skipPinned: false, skipAudible: false }, { windowId: 1 });
    const state = await svc.getState(1);
    expect(state.preview.count).toBe(3);
    expect(state.preview.tabs.map(t => t.id)).not.toContain(front);
    expect(state.auto.count).toBe(1); // automatic protections stay strict
  });
});

describe('age tracking', () => {
  it('Chromium never trusts restored native age: old tabs start a conservative baseline', async () => {
    const { world, svc } = await setup({ browser: 'chromium' });
    const state = await svc.getState(1);
    expect(state.preview.count).toBe(0);
    expect(state.preview.unknownCount).toBe(0);
    world.now = NOW + WEEK;
    expect((await svc.getState(1)).preview.count).toBe(3);
  });

  it('Chromium records leaving a tab without previousTabId, so a long view is not mistaken for old age', async () => {
    const { world, svc, front, others } = await setup({ browser: 'chromium', background: 2 });
    world.now = NOW + WEEK;
    world.activate(others[0]);   // selected at NOW + WEEK
    world.now += 3 * DAY_MS;
    world.activate(front);       // left 3 days later; native still says NOW + WEEK
    await settle();
    world.now += 4 * DAY_MS + HOUR_MS / 2;
    const ids = (await svc.getState(1)).preview.tabs.map(t => t.id);
    expect(ids).toEqual([others[1]]);
  });

  it('a background reload does not reset age, but invalidates the preview binding', async () => {
    const { world, svc, others } = await setup({ background: 1 });
    const first = await svc.getState(1);
    world.navigate(others[0]);
    await settle();
    const second = await svc.getState(1);
    expect(second.preview.count).toBe(1);
    expect(await svc.closePreview(1, first.preview.id)).toMatchObject({ closed: 0, skipped: 1 });
  });

  it('a replaced (discarded) Chromium tab starts its own baseline', async () => {
    const { world, svc, others } = await setup({ browser: 'chromium', background: 2 });
    world.now = NOW + WEEK;
    await svc.getState(1);
    const added = world.replace(others[0]);
    await settle();
    const ids = (await svc.getState(1)).preview.tabs.map(t => t.id);
    expect(ids).toEqual([others[1]]);
    expect(ids).not.toContain(added);
  });

  it('records survive a worker restart through storage.session', async () => {
    const { world, svc } = await setup({ browser: 'chromium' });
    await svc.getState(1);
    world.now = NOW + WEEK;
    const worker = world.startWorker();
    await settle();
    expect((await worker.service.getState(1)).preview.count).toBe(3);
  });

  it('a full Chromium restart resets age: new tab IDs never reuse old records', async () => {
    const { world, svc } = await setup({ browser: 'chromium' });
    await svc.getState(1);
    world.now = NOW + WEEK;
    const worker = world.restartBrowser();
    await settle();
    expect((await worker.service.getState(1)).preview.count).toBe(0);
  });

  it('Firefox native age continues across a full restart', async () => {
    const { world } = await setup();
    const worker = world.restartBrowser();
    await settle();
    expect((await worker.service.getState(1)).preview.count).toBe(3);
  });

  it('a corrupt session store is treated as no history, never as old age', async () => {
    const { world } = await setup({ browser: 'chromium' });
    world.session['stale.age.normal'] = { tabs: { 2: { s: -1, v: 0, g: 0 }, 3: 'old' }, active: 'x' };
    const worker = world.startWorker();
    expect((await worker.service.getState(1)).preview.count).toBe(0);
  });
});

describe('privacy contexts', () => {
  async function mixed() {
    const env = await setup();
    const { world } = env;
    world.addWindow(5, { incognito: true });
    world.now = NOW - 3 * WEEK;
    world.addTab(5, { active: true, lastAccessed: NOW });
    const priv = [world.addTab(5), world.addTab(5)];
    world.now = NOW;
    await settle();
    return { ...env, priv };
  }

  it('keeps private and normal previews apart and hides automation from private windows', async () => {
    const { svc, priv, others } = await mixed();
    const p = await svc.getState(5);
    expect(p.preview.tabs.map(t => t.id)).toEqual(priv);
    expect(p.auto).toEqual({ enabled: false, available: false, nextRunAt: null, count: null, error: null });
    const n = await svc.getState(1);
    expect(n.preview.tabs.map(t => t.id)).toEqual(others);
    expect(n.auto.count).toBe(3);
  });

  it('stores private records only in session storage, under their own keys', async () => {
    const { world, svc, priv } = await mixed();
    await svc.getState(5);
    await svc.editor(5, undefined, true);
    expect(Object.keys(world.session['stale.age.private'].tabs)).toEqual(
      expect.arrayContaining(priv.map(String)));
    expect(Object.keys(world.session['stale.age.normal'].tabs)).not.toEqual(expect.arrayContaining(priv.map(String)));
    expect(JSON.stringify(world.local)).not.toMatch(/site\.example|"\d+":/);
  });

  it('a private preview cannot close normal tabs and vice versa', async () => {
    const { world, svc } = await mixed();
    const p = await svc.getState(5);
    await expect(svc.closePreview(1, p.preview.id)).rejects.toThrow(PREVIEW_EXPIRED);
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
  });

  it('automation cannot be enabled from a private window or the incognito worker', async () => {
    const { world, svc } = await mixed();
    await expect(enable(svc, 5)).rejects.toThrow(/normal/);
    await expect(svc.saveSettings({ autoCloseStaleEnabled: true }, {})).rejects.toThrow(/normal/);
    expect(world.local.autoCloseStaleEnabled).toBeUndefined();
    const incognito = world.startWorker({ incognitoContext: true, keepOthers: true });
    await expect(enable(incognito.service, 5)).rejects.toThrow(/normal/);
  });

  it('the incognito worker never schedules or sweeps', async () => {
    const { world, svc } = await mixed();
    await enable(svc);
    const incognito = world.startWorker({ incognitoContext: true, keepOthers: true });
    await settle();
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm(incognito);
    expect(incognito.api.alarms.create).not.toHaveBeenCalled();
    expect(incognito.api.tabs.remove).not.toHaveBeenCalled();
  });

  it('automatic sweeps never touch private tabs', async () => {
    const { world, svc, priv } = await mixed();
    await enable(svc);
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm();
    for (const id of priv) expect(world.tab(id)).toBeTruthy();
  });
});

describe('opt-in and scheduling', () => {
  it('enabling schedules the next whole hour and closes nothing immediately', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    await settle();
    expect(world.alarms.get(STALE_ALARM)).toEqual({ name: STALE_ALARM, scheduledTime: nextLocalHour(NOW) });
    expect(world.local.staleNextRunAt).toBe(nextLocalHour(NOW));
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
    const state = await svc.getState(1);
    expect(state.auto).toEqual({ enabled: true, available: true, nextRunAt: nextLocalHour(NOW), count: 3, error: null });
  });

  it('a scheduled run closes eligible tabs under strict protections and notifies once', async () => {
    const { world, worker, svc, others, front } = await setup({ background: 5 });
    world.tab(others[0]).pinned = true;
    world.tab(others[1]).audible = true;
    world.tab(others[2]).url = 'about:config';
    await svc.saveSettings({ skipPinned: false, skipAudible: false }, { windowId: 1 });
    await enable(svc);
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm();
    expect(world.tabs.map(t => t.id).sort()).toEqual([front, others[0], others[1], others[2]].sort());
    expect(worker.notify).toHaveBeenCalledTimes(1);
    expect(worker.notify.mock.calls[0][0]).toBe('Automatically closed 2 tabs not viewed recently.');
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(world.now));
  });

  it('is silent when nothing changes', async () => {
    const { world, worker, svc } = await setup({ age: HOUR_MS });
    await enable(svc);
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm();
    expect(worker.notify).not.toHaveBeenCalled();
  });

  it('disabling clears the alarm, and a leftover alarm does nothing', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const alarm = { ...world.alarms.get(STALE_ALARM) };
    await disable(svc);
    expect(world.alarms.has(STALE_ALARM)).toBe(false);
    world.now = alarm.scheduledTime;
    await svc.handleAlarm(alarm);
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
    expect(world.alarms.has(STALE_ALARM)).toBe(false);
  });

  it('disabling works when scheduling is failing and no preview exists', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    world.workers[0].api.alarms.clear.mockRejectedValue(new Error('alarms broken'));
    await expect(svc.saveSettings({ autoCloseStaleEnabled: false }, { windowId: 1, staleOnly: true }))
      .resolves.toEqual({ message: 'Settings saved' });
    expect(world.local.autoCloseStaleEnabled).toBe(false);
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm();
    expect(world.workers[0].api.tabs.remove).not.toHaveBeenCalled();
  });

  it('disabling during a batch stops further removals and is not queued behind it', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const { remove } = world.workers[0].api.tabs;
    const gate = deferred();
    remove.mockImplementationOnce(async id => { await gate.promise; world.closeTab(id); });
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    const sweeping = world.fireAlarm();
    await settle();
    expect(remove).toHaveBeenCalledTimes(1);
    await disable(svc); // resolves while the first removal is still pending
    gate.resolve();
    await sweeping;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(world.tabs).toHaveLength(3);
  });

  it('fails closed when alarms are unavailable', async () => {
    const { world, svc } = await setup();
    delete world.workers[0].api.alarms;
    await expect(enable(svc)).rejects.toThrow(/could not be scheduled/);
    expect(world.local.autoCloseStaleEnabled).toBe(false);
  });

  it('reports a lost schedule instead of a count when the alarm cannot be restored', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    world.alarms.clear();
    world.workers[0].api.alarms.create.mockRejectedValue(new Error('quota'));
    const state = await svc.getState(1);
    expect(state.auto).toMatchObject({ enabled: true, nextRunAt: null, count: null });
    expect(state.auto.error).toMatch(/not scheduled: quota/);
  });

  it('a threshold change keeps the existing next run', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const at = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now += 10 * 60_000;
    await svc.saveSettings({ staleThresholdMs: DAY_MS }, { windowId: 1, staleOnly: true });
    expect((await svc.getState(1)).auto.nextRunAt).toBe(at);
  });

  it('re-enabling schedules a new future run', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    await disable(svc);
    world.now += 2 * HOUR_MS;
    await enable(svc);
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(world.now));
  });

  it('a worker restart restores one schedule from storage when the alarm is gone', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const at = world.alarms.get(STALE_ALARM).scheduledTime;
    world.alarms.clear();
    const worker = world.startWorker();
    await settle();
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(at);
    expect(worker.api.alarms.create).toHaveBeenCalledTimes(1);
  });

  it('an idle-restarted worker still sweeps from the persisted preference', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const worker = world.startWorker();
    await settle();
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm(worker);
    expect(world.tabs).toHaveLength(1);
  });

  it('a pre-restart alarm firing at startup does not bulk-close (Chromium keeps alarms)', async () => {
    const { world, svc } = await setup({ browser: 'chromium' });
    await enable(svc);
    world.now = NOW + 2 * WEEK; // browser was closed past the run
    const worker = world.restartBrowser();
    await settle();
    await worker.service.handleAlarm({ name: STALE_ALARM, scheduledTime: nextLocalHour(NOW) });
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(world.now));
  });

  it('after sleep, a delayed alarm runs one fresh sweep and plans the next future hour', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    world.now = world.alarms.get(STALE_ALARM).scheduledTime + 10 * HOUR_MS + 5 * 60_000;
    await world.fireAlarm();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(world.now));
    // The replaced alarm cannot fire again for the missed hours.
    await worker.service.handleAlarm({ name: STALE_ALARM, scheduledTime: nextLocalHour(NOW) + HOUR_MS });
    expect(worker.api.alarms.create.mock.calls.at(-1)[1].when).toBe(nextLocalHour(world.now));
  });

  it('a clock moved back replaces a run that is now more than an hour away', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    world.now -= DAY_MS;
    expect((await svc.getState(1)).auto.nextRunAt).toBe(nextLocalHour(world.now));
  });

  it('overlapping alarms run one sweep', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const alarm = { ...world.alarms.get(STALE_ALARM) };
    world.now = alarm.scheduledTime;
    await Promise.all([svc.handleAlarm(alarm), svc.handleAlarm(alarm)]);
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
    expect(worker.notify).toHaveBeenCalledTimes(1);
  });
});

describe('editor lease', () => {
  it('defers a sweep while the stale controls are open, and expires if not renewed', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const due = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now = due - 5000;
    const { editorId } = await svc.editor(1, undefined, true);
    expect(editorId).toMatch(/\S/);
    world.now = due;
    expect((await svc.editor(1, editorId, true)).editorId).toBe(editorId); // renewal keeps the id
    await world.fireAlarm();
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(due));
    expect((await svc.getState(1)).auto.nextRunAt).toBe(nextLocalHour(due));
    // A lost view stops deferring once the lease is not renewed.
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    expect(world.now - due).toBeGreaterThan(LEASE_TTL_MS);
    await world.fireAlarm();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
  });

  it('release ends the lease; another window cannot renew or release it', async () => {
    const { world, svc } = await setup();
    world.addWindow(2);
    world.addTab(2, { active: true });
    const { editorId } = await svc.editor(1, undefined, true);
    expect((await svc.editor(2, editorId, true)).editorId).not.toBe(editorId);
    await svc.editor(2, editorId, false);
    expect(Object.keys(world.session['stale.lease.normal'])).toContain(editorId);
    expect(await svc.editor(1, editorId, false)).toEqual({ editorId: null });
    expect(Object.keys(world.session['stale.lease.normal'])).not.toContain(editorId);
  });

  it('an editor opened mid-batch stops the remaining automatic removals', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const { remove } = world.workers[0].api.tabs;
    remove.mockImplementationOnce(async id => { await svc.editor(1, undefined, true); world.closeTab(id); });
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('one-shot open intent', () => {
  it('opens the popup at once and expands stale controls once, for that window only', async () => {
    const { world, worker, svc } = await setup();
    world.addWindow(2);
    world.addTab(2, { active: true });
    const opened = svc.openControls({ id: 1, windowId: 1, incognito: false });
    expect(worker.api.action.openPopup).toHaveBeenCalledWith({ windowId: 1 }); // synchronously
    expect(await opened).toEqual({ opened: true });
    expect(await svc.consumeIntent(2)).toEqual({ open: false });
    expect(await svc.consumeIntent(1)).toEqual({ open: true });
    expect(await svc.consumeIntent(1)).toEqual({ open: false });
  });

  it('a popup that asks before the intent is saved still gets it', async () => {
    const { svc } = await setup();
    svc.openControls({ id: 1, windowId: 1 });
    expect(await svc.consumeIntent(1)).toEqual({ open: true });
  });

  it('expires', async () => {
    const { world, svc } = await setup();
    await svc.openControls({ id: 1, windowId: 1 });
    world.now += 60_000;
    expect(await svc.consumeIntent(1)).toEqual({ open: false });
  });

  it('a refused popup removes nothing, leaves no intent and explains the toolbar path', async () => {
    const { world, worker, svc } = await setup();
    worker.api.action.openPopup.mockRejectedValue(new Error('requires a user gesture'));
    expect(await svc.openControls({ id: 1, windowId: 1 })).toEqual({ error: OPEN_FAILED });
    expect(await svc.consumeIntent(1)).toEqual({ open: false });
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    delete worker.api.action;
    expect(await svc.openControls({ id: 1, windowId: 1 })).toEqual({ error: OPEN_FAILED });
    expect(world.session['stale.intent.normal']).toBeUndefined();
  });

  it('without a tab, binds the intent to the last focused window', async () => {
    const { worker, svc } = await setup();
    await svc.openControls(undefined);
    expect(worker.api.action.openPopup).toHaveBeenCalledWith();
    expect(await svc.consumeIntent(1)).toEqual({ open: true });
  });
});

describe('settings gate', () => {
  it('rejects invalid thresholds, other keys on setStaleRule, and never writes scheduler bookkeeping', async () => {
    const { world, svc } = await setup();
    for (const ms of [0, -1, 1.5, HOUR_MS + 1, Number.MAX_SAFE_INTEGER, '604800000', null]) {
      await expect(svc.saveSettings({ staleThresholdMs: ms }, { windowId: 1, staleOnly: true })).rejects.toThrow(/whole number/);
    }
    await expect(svc.saveSettings({ staleThresholdMs: DAY_MS, skipPinned: false }, { windowId: 1, staleOnly: true }))
      .rejects.toThrow(/Only the stale-tab rule/);
    await svc.saveSettings({ staleThresholdMs: 400 * DAY_MS, staleNextRunAt: 1, staleRuleRevision: 'x', other: 1, searchScope: 'current' },
      { windowId: 1, generalKeys: ['searchScope', 'staleNextRunAt'] });
    expect(world.local.staleThresholdMs).toBe(400 * DAY_MS);
    expect(world.local.searchScope).toBe('current');
    expect(world.local).not.toHaveProperty('staleNextRunAt');
    expect(world.local.staleRuleRevision).not.toBe('x');
    expect(world.local).not.toHaveProperty('other');
  });

  it('preserves a legacy threshold the editor would not produce', async () => {
    const { world, svc } = await setup();
    world.local.staleThresholdMs = 90 * 60_000;
    expect((await svc.getState(1)).settings.staleThresholdMs).toBe(90 * 60_000);
  });

  it('rewriting unchanged values does not invalidate a preview', async () => {
    const { svc } = await setup();
    const { preview } = await svc.getState(1);
    await svc.saveSettings({ skipPinned: true, skipAudible: true }, { windowId: 1 });
    expect(await svc.closePreview(1, preview.id)).toMatchObject({ closed: 3 });
  });
});

// ---- Reviewed defects (0.6.0) ----

/** setup() plus a private window; Chromium also gets its split incognito worker and aged baselines. */
async function withPrivate(browser) {
  const env = await setup({ browser });
  const { world } = env;
  world.addWindow(5, { incognito: true });
  world.addTab(5, { active: true });
  const priv = [world.addTab(5), world.addTab(5)];
  const incognito = browser === 'chromium' ? world.startWorker({ incognitoContext: true, keepOthers: true }) : undefined;
  await settle();
  if (browser === 'chromium') world.now = NOW + 2 * WEEK; // past the conservative first-observed baselines
  return { ...env, priv, incognito, privateService: incognito?.service ?? env.svc };
}

/**
 * Holds the first candidate's fresh re-check at one await (tabs.get, the
 * populated windows.get, or currentAges queued behind a pending session
 * write). Returns { reached, release }.
 */
function holdRecheck(world, worker, stage, front) {
  const gate = deferred();
  const reached = deferred();
  const { api } = worker;
  const realTab = api.tabs.get.getMockImplementation();
  const realWindow = api.windows.get.getMockImplementation();
  const realSet = api.storage.session.set.getMockImplementation();
  let held = false;
  if (stage === 'tabs.get') {
    api.tabs.get.mockImplementationOnce(async id => { reached.resolve(); await gate.promise; return realTab(id); });
  } else {
    api.windows.get.mockImplementation(async (id, options) => {
      if (options?.populate && !held) {
        held = true;
        if (stage === 'windows.get') {
          reached.resolve();
          await gate.promise;
        } else {
          // An event's session write is pending, so currentAges waits behind it.
          api.storage.session.set.mockImplementationOnce(async items => { reached.resolve(); await gate.promise; return realSet(items); });
          world.navigate(front);
        }
      }
      return realWindow(id, options);
    });
  }
  return { reached: reached.promise, release: gate.resolve };
}

const STAGES = ['tabs.get', 'windows.get', 'currentAges'];
const BROWSERS = ['firefox', 'chromium'];
const each = (stages, browsers, cases) => stages.flatMap(stage => browsers.flatMap(browser =>
  cases.map(([name, change]) => [name, browser, stage, change])));

describe('a change while a candidate is re-checked issues no further removal', () => {
  it.each(each(STAGES, BROWSERS, [
    ['automation is turned off', ({ svc }) => disable(svc)],
    ['the threshold changes', ({ svc }) => svc.saveSettings({ staleThresholdMs: DAY_MS }, { windowId: 1, staleOnly: true })],
    ['stale controls open in a normal window', ({ svc }) => svc.editor(1, undefined, true)],
    ['stale controls open in a private window', ({ privateService }) => privateService.editor(5, undefined, true)],
    ['another context turns automation off (storage only)', ({ world }) => { world.local.autoCloseStaleEnabled = false; }],
    ['another context changes the rule (storage only)', ({ world }) => { world.local.staleRuleRevision = 'elsewhere'; }],
    ['settings cannot be read', ({ worker }) => { worker.api.storage.local.get.mockRejectedValueOnce(new Error('io')); }],
    ['editor leases cannot be read', ({ worker }) => { worker.api.storage.session.get.mockRejectedValueOnce(new Error('io')); }],
  ]))('automatic: %s (%s, during %s)', async (_, browser, stage, change) => {
    const env = await withPrivate(browser);
    const { world, worker, svc, front } = env;
    await enable(svc);
    const hold = holdRecheck(world, worker, stage, front);
    const running = svc.sweep();
    await hold.reached;
    const changed = change(env);
    await settle();
    hold.release();
    await changed;
    expect(await running).toBe(false);
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    expect(world.tabs.filter(t => !t.incognito)).toHaveLength(4);
    expect(worker.notify).not.toHaveBeenCalled();
  });

  it.each(each(STAGES, BROWSERS, [
    ['the threshold changes', ({ svc }) => svc.saveSettings({ staleThresholdMs: DAY_MS }, { windowId: 1, staleOnly: true })],
    ['a protection setting changes', ({ svc }) => svc.saveSettings({ skipPinned: false }, { windowId: 1 })],
    ['another context changes the rule (storage only)', ({ world }) => { world.local.staleRuleRevision = 'elsewhere'; }],
    ['settings cannot be read', ({ worker }) => { worker.api.storage.local.get.mockRejectedValueOnce(new Error('io')); }],
  ]))('manual: %s (%s, during %s)', async (_, browser, stage, change) => {
    const env = await withPrivate(browser);
    const { world, worker, svc, front } = env;
    const { preview } = await svc.getState(1);
    expect(preview.count).toBe(3);
    const hold = holdRecheck(world, worker, stage, front);
    const closing = svc.closePreview(1, preview.id);
    await hold.reached;
    const changed = change(env);
    await settle();
    hold.release();
    await changed;
    expect(await closing).toEqual({
      message: 'No stale tabs were closed. Kept 3 tabs that changed or are no longer stale.',
      closed: 0, skipped: 3, failed: 0, error: RULE_CHANGED,
    });
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
  });

  it('a stop after some removals reports the actual partial result', async () => {
    const { world, worker, svc } = await setup();
    const { preview } = await svc.getState(1);
    const realTab = worker.api.tabs.get.getMockImplementation();
    let calls = 0;
    worker.api.tabs.get.mockImplementation(async id => {
      if (++calls === 2) await svc.saveSettings({ staleThresholdMs: DAY_MS }, { windowId: 1, staleOnly: true });
      return realTab(id);
    });
    expect(await svc.closePreview(1, preview.id)).toMatchObject({ closed: 1, skipped: 2, failed: 0, error: RULE_CHANGED });
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(1);
    expect(world.tabs).toHaveLength(3);
  });
});

describe('editors in private windows', () => {
  it.each(BROWSERS)('%s: open stale controls in a private window defer the sweep, stored only in session', async browser => {
    const { world, worker, svc, privateService } = await withPrivate(browser);
    await enable(svc);
    const due = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now = due - 5000;
    await privateService.editor(5, undefined, true);
    world.now = due;
    await world.fireAlarm();
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(due));
    expect(Object.keys(world.session['stale.lease.private'])).toHaveLength(1);
    expect(world.session['stale.lease.normal']).toBeUndefined();
    expect(JSON.stringify(world.local)).not.toMatch(/lease|site\.example|"w":/);
  });
});

describe('Chromium activation order', () => {
  it('applies tab switches in event order when a window lookup is slow', async () => {
    const { world, worker, svc, front, others: [a, b] } = await setup({ browser: 'chromium', background: 2 });
    await svc.saveSettings({ staleThresholdMs: HOUR_MS, autoCloseStaleEnabled: true }, { windowId: 1, staleOnly: true });
    world.now = NOW + WEEK;
    const gate = deferred();
    const realWindow = worker.api.windows.get.getMockImplementation();
    worker.api.windows.get.mockImplementationOnce(async (...args) => { await gate.promise; return realWindow(...args); });
    world.activate(a);         // this switch's window lookup is slow
    world.now += 1000;
    world.activate(front);     // and the user returns at once
    await settle();
    gate.resolve();
    await settle();
    world.now += 3 * HOUR_MS;  // front viewed for three hours
    world.activate(b);
    await settle();
    world.now += 60_000;
    expect(await svc.sweep()).toBe(true);
    expect(world.tab(front)).toBeTruthy(); // left a minute ago
    expect(world.tab(a)).toBeUndefined();  // left three hours ago
  });
});

describe('Chromium split workers share storage.session', () => {
  it('neither worker prunes or writes the other profile\'s age records', async () => {
    const { world, priv } = await withPrivate('chromium');
    const before = clone(world.session['stale.age.private']);
    expect(Object.keys(before.tabs)).toEqual(expect.arrayContaining(priv.map(String)));
    const normal = world.startWorker({ keepOthers: true }); // the normal worker restarts
    await settle();
    await normal.service.getState(1);
    expect(world.session['stale.age.private']).toEqual(before);
    await expect(normal.service.getState(5)).rejects.toThrow(/window/);
    const normalBefore = clone(world.session['stale.age.normal']);
    const incognito = world.startWorker({ incognitoContext: true, keepOthers: true });
    await settle();
    expect(world.session['stale.age.normal']).toEqual(normalBefore);
    expect((await incognito.service.getState(5)).preview.tabs.map(t => t.id)).toEqual(priv);
    await expect(incognito.service.getState(1)).rejects.toThrow(/window/);
  });
});

describe('alarm delivery', () => {
  it.each([
    ['before the startup reconcile', false],
    ['after the startup reconcile replaced the plan', true],
  ])('a worker woken by its one-shot alarm sweeps once when the callback runs %s', async (_, reconcileFirst) => {
    const { world, svc } = await setup();
    await enable(svc);
    const due = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now = due + 1000;
    world.alarms.delete(STALE_ALARM); // fired: the browser removed it
    const worker = world.startWorker();
    if (reconcileFirst) await settle();
    await worker.service.handleAlarm({ name: STALE_ALARM, scheduledTime: due });
    await settle();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(due));
    expect(world.local.staleNextRunAt).toBe(nextLocalHour(due));
    // A duplicate delivery does not sweep again.
    world.now -= 4 * WEEK;
    const late = world.addTab(1);
    world.now = due + 2000;
    await worker.service.handleAlarm({ name: STALE_ALARM, scheduledTime: due });
    expect(world.tab(late)).toBeTruthy();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
  });

  it('an overdue run whose alarm never calls back moves to the next hour without a sweep', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const due = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now = due + 1000;
    world.alarms.delete(STALE_ALARM);
    const worker = world.startWorker();
    await settle();
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(world.now));
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    await world.fireAlarm(worker);
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
  });

  it('an alarm that fires a little early runs once and plans the following hour', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const due = world.alarms.get(STALE_ALARM).scheduledTime;
    world.now = due - 5;
    await world.fireAlarm();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(nextLocalHour(due));
    expect(nextLocalHour(due)).toBeGreaterThan(due);
  });

  it('a disable during the alarm\'s pending settings read leaves no alarm or plan', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const { get } = worker.api.storage.local;
    const real = get.getMockImplementation();
    const gate = deferred();
    get.mockImplementationOnce(async keys => {
      const snapshot = await real(keys); // read before the disable lands
      await gate.promise;
      return snapshot;
    });
    world.now = world.alarms.get(STALE_ALARM).scheduledTime;
    const fired = world.fireAlarm();
    const disabling = disable(svc);
    await settle();
    gate.resolve();
    await Promise.all([fired, disabling]);
    await settle();
    expect(world.alarms.has(STALE_ALARM)).toBe(false);
    expect(world.local.staleNextRunAt).toBeNull();
    expect(worker.api.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('time zones', () => {
  async function inZone(zone, fn) {
    const tz = process.env.TZ;
    process.env.TZ = zone;
    try {
      await fn();
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  }
  const wholeHour = at => new Date(at).getMinutes() === 0 && new Date(at).getSeconds() === 0;

  it('a time-zone change moves an off-hour plan to the next whole local hour', () => inZone('Asia/Kolkata', async () => {
    const { world, svc } = await setup();
    await enable(svc);
    const planned = world.alarms.get(STALE_ALARM).scheduledTime;
    expect(planned).toBe(Date.UTC(2026, 9, 6, 12, 30)); // 18:00 in Kolkata
    process.env.TZ = 'America/New_York';               // 08:30 here
    const { auto } = await svc.getState(1);
    expect(auto.nextRunAt).toBe(Date.UTC(2026, 9, 6, 13)); // 09:00 EDT
    expect(world.alarms.get(STALE_ALARM).scheduledTime).toBe(auto.nextRunAt);
    expect(world.local.staleNextRunAt).toBe(auto.nextRunAt);
  }));

  it('hourly runs stay on whole local hours across Lord Howe\'s 30-minute DST change', () => inZone('Australia/Lord_Howe', async () => {
    const world = createWorld();
    world.now = Date.UTC(2026, 9, 3, 14, 20); // 00:50 LHST, before 02:00 -> 02:30 on 4 October
    world.addWindow(1);
    world.addTab(1, { active: true });
    const { service } = world.startWorker();
    await settle();
    await enable(service);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const at = world.alarms.get(STALE_ALARM).scheduledTime;
      runs.push(at);
      world.now = at;
      await world.fireAlarm();
    }
    runs.push(world.alarms.get(STALE_ALARM).scheduledTime);
    expect(runs).toEqual([
      Date.UTC(2026, 9, 3, 14, 30), // 01:00 LHST
      Date.UTC(2026, 9, 3, 16, 0),  // 03:00 LHDT (02:00-02:30 does not exist)
      Date.UTC(2026, 9, 3, 17, 0),  // 04:00 LHDT
      Date.UTC(2026, 9, 3, 18, 0),
    ]);
    expect(runs.every(wholeHour)).toBe(true);
  }));
});

describe('failure notices', () => {
  const NOT_SCHEDULED = 'Automatic stale-tab cleanup is not scheduled: quota';
  const DID_NOT_RUN = msg => `Automatic stale-tab cleanup did not run: ${msg}`;
  const CLOSED = 'Automatically closed 3 tabs not viewed recently.';

  it('a failed next-run plan is reported once, never swallowed, and again after a run succeeds', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const { create } = worker.api.alarms;
    const real = create.getMockImplementation();
    const fireRecorded = async () => {
      world.now = world.local.staleNextRunAt;
      await svc.handleAlarm({ name: STALE_ALARM, scheduledTime: world.now });
    };
    create.mockRejectedValue(new Error('quota'));
    for (let i = 0; i < 3; i++) await fireRecorded();
    expect(worker.notify.mock.calls.map(([m]) => m)).toEqual([NOT_SCHEDULED]);
    expect(worker.api.tabs.remove).not.toHaveBeenCalled(); // unknown scheduler state: no sweep
    create.mockImplementation(real);
    await fireRecorded();
    expect(worker.api.tabs.remove).toHaveBeenCalledTimes(3);
    create.mockRejectedValue(new Error('quota'));
    await fireRecorded();
    expect(worker.notify.mock.calls.map(([m]) => m)).toEqual([NOT_SCHEDULED, CLOSED, NOT_SCHEDULED]);
  });

  it('a failing sweep is reported once per unchanged failure and reset by a successful run', async () => {
    const { world, worker, svc } = await setup();
    await enable(svc);
    const { query } = worker.api.tabs;
    const real = query.getMockImplementation();
    const fire = async () => {
      world.now = world.alarms.get(STALE_ALARM).scheduledTime;
      await world.fireAlarm();
    };
    query.mockRejectedValue(new Error('tabs unavailable'));
    for (let i = 0; i < 3; i++) await fire();
    query.mockRejectedValue(new Error('other'));
    await fire();
    query.mockImplementation(real);
    await fire();
    query.mockRejectedValue(new Error('tabs unavailable'));
    await fire();
    expect(worker.notify.mock.calls.map(([m]) => m)).toEqual([
      DID_NOT_RUN('tabs unavailable'), DID_NOT_RUN('other'), CLOSED, DID_NOT_RUN('tabs unavailable'),
    ]);
  });
});

describe('legacy thresholds', () => {
  it('keeps a fractional 0.5.3 threshold to the millisecond', async () => {
    const { world, svc } = await setup();
    world.local.staleThresholdMs = 1.1 * HOUR_MS; // 3960000.0000000005
    expect((await svc.getState(1)).settings.staleThresholdMs).toBe(3_960_000);
  });

  it('automation needs a whole-hour threshold; a legacy one still works for manual cleanup', async () => {
    const { world, svc } = await setup();
    world.local.staleThresholdMs = 90 * 60_000;
    await expect(enable(svc)).rejects.toThrow(/whole number of hours or days/);
    expect(world.local.autoCloseStaleEnabled).toBeUndefined();
    expect(world.alarms.size).toBe(0);
    expect((await svc.getState(1)).preview.count).toBe(3);
    await svc.saveSettings({ staleThresholdMs: 2 * HOUR_MS, autoCloseStaleEnabled: true }, { windowId: 1, staleOnly: true });
    expect(world.local).toMatchObject({ staleThresholdMs: 2 * HOUR_MS, autoCloseStaleEnabled: true });
  });
});
