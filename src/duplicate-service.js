// duplicate-service.js — Browser wiring for opt-in duplicate-tab prevention
// (R14). Rules live in core.js (judgeNewTab and friends); this module owns the
// tab events, session state and the switch itself.
//
// State lives in storage.session, one store per privacy context
// ('dupe.normal' / 'dupe.private'), so it survives a Chrome service-worker
// restart and the two Chrome split-incognito workers never prune each other's
// records. Firefox runs one background for both contexts and keys by
// tab.incognito. Nothing here is written while the feature is off.
import {
  DUPE_ALLOW_MS, DUPE_BURST_MS, DUPE_SETTLE_MS, DUPE_COMPLETE_GRACE_MS, DUPE_KEEP_MS, DUPE_NEW_TAB_CAP_MS, DUPE_STARTUP_QUIET_MS,
  dupeKey, isStillNew, judgeNewTab, newTabRecord, noteTabUrl,
} from './core.js';

export const DUPE_NOTICE_KEY = 'preventDuplicatesNoticeShown'; // storage.local: the first-switch notice was shown
export const FIRST_SWITCH_MESSAGE = 'Switched to the tab that was already open, and closed the new copy. '
  + 'To keep a second copy, use Reopen Closed Tab (Ctrl+Shift+T, or Cmd+Shift+T on a Mac). '
  + 'Change this in Settings > Duplicate Detection.';

const SETTING_KEYS = ['preventDuplicates', 'preventDuplicatesMode', 'preventDuplicatesNever', 'ignoreFragments', 'ignoreQueryParams'];
const SETTING_DEFAULTS = {
  preventDuplicates: false, preventDuplicatesMode: 'switch', preventDuplicatesNever: [],
  ignoreFragments: false, ignoreQueryParams: false,
};
const spaceOf = incognito => (incognito === true ? 'private' : 'normal');
const keyOf = space => `dupe.${space}`;
const emptyStore = () => ({ tabs: {}, windows: {}, closed: [], allowed: [], quietUntil: 0 });

// Runs async functions one at a time, in call order. A failure does not block later calls.
function serial() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function readStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  if (raw.tabs && typeof raw.tabs === 'object') store.tabs = raw.tabs;
  if (raw.windows && typeof raw.windows === 'object') store.windows = raw.windows;
  if (Array.isArray(raw.closed)) store.closed = raw.closed;
  if (Array.isArray(raw.allowed)) store.allowed = raw.allowed;
  if (Number.isFinite(raw.quietUntil)) store.quietUntil = raw.quietUntil;
  return store;
}

function prune(store, now) {
  for (const [id, r] of Object.entries(store.tabs)) {
    if (now - r.created > DUPE_NEW_TAB_CAP_MS + DUPE_COMPLETE_GRACE_MS) delete store.tabs[id];
  }
  for (const [id, at] of Object.entries(store.windows)) if (now - at > 5 * DUPE_BURST_MS) delete store.windows[id];
  store.closed = store.closed.filter(c => now - c.at <= DUPE_KEEP_MS);
  store.allowed = store.allowed.filter(a => now - a.at <= DUPE_ALLOW_MS);
}

export function createDuplicateService(api, { now = () => Date.now(), notify = async () => {}, schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const local = api.storage.local;
  const session = api.storage.session;
  const split = api.runtime.getManifest?.()?.incognito === 'split';
  const incognitoContext = api.extension?.inIncognitoContext === true;
  const owned = split ? [incognitoContext ? 'private' : 'normal'] : ['normal', 'private'];
  const queue = serial();

  let settingsCache;
  const settings = () => (settingsCache ??= local.get(SETTING_DEFAULTS).then(s => ({ ...SETTING_DEFAULTS, ...s }), () => SETTING_DEFAULTS));

  const stores = new Map();
  async function load(space) {
    if (!stores.has(space)) {
      let raw;
      try { raw = (await session.get(keyOf(space)))[keyOf(space)]; } catch { raw = undefined; }
      if (!stores.has(space)) stores.set(space, readStore(raw));
    }
    return stores.get(space);
  }
  async function save(space) {
    const store = stores.get(space);
    if (!store || !owned.includes(space)) return;
    prune(store, now());
    try { await session.set({ [keyOf(space)]: store }); } catch { /* best effort: memory still holds it */ }
  }

  // Runs fn(store) for a tab's context, on the shared queue, only while the feature is on.
  const withStore = (incognito, fn) => queue(async () => {
    const s = await settings();
    if (!s.preventDuplicates) return;
    const space = spaceOf(incognito);
    const store = await load(space);
    const changed = await fn(store, s, space);
    if (changed !== false) await save(space);
  });

  async function judge(tabId, store, s, space) {
    const record = store.tabs[tabId];
    if (!isStillNew(record, now())) return;
    let tab, tabs;
    try { [tab, tabs] = await Promise.all([api.tabs.get(tabId), api.tabs.query({})]); } catch { return; }
    // Records of other new tabs in the same context, so an older copy wins.
    const records = store.tabs;
    const verdict = judgeNewTab({ tab, record, tabs, records, closed: store.closed, allowed: store.allowed, settings: s, now: now() });
    if (verdict.action === 'wait') {
      if (verdict.reason === 'settling') settleLater(tabId, tab.incognito, record);
      return;
    }
    if (verdict.action !== 'switch') { record.done = verdict.reason; return; }
    const match = tabs.find(t => t.id === verdict.matchId);
    record.done = 'switched';
    await switchTo(tab, match, record, store, s);
  }

  // Judges a settling tab again once its burst window has passed (F1). A timer
  // lost to a worker restart only means the tab is judged on its next URL
  // change or not at all, so it fails toward keeping the tab.
  const settling = new Set();
  function settleLater(tabId, incognito, record) {
    if (settling.has(tabId)) return;
    settling.add(tabId);
    schedule(() => {
      settling.delete(tabId);
      withStore(incognito, async (store, s, space) => {
        if (store.tabs[tabId] !== undefined) await judge(tabId, store, s, space);
      }).catch(() => {});
    }, Math.max(0, record.created + DUPE_SETTLE_MS - now()) + 10);
  }

  // D9 order: bring the match forward first, so the browser does not activate
  // (and stale tracking does not record) a neighbour; then close the new tab
  // only if it is still the same new page.
  async function switchTo(tab, match, record, store, s) {
    const read = async () => {
      try {
        const current = await api.tabs.get(tab.id);
        return current.url === tab.url && isStillNew({ ...record, done: undefined }, now()) ? current : null;
      } catch { return null; }
    };
    const current = await read();
    if (!current) return;
    // F2: the duplicate was in front and the user has since picked another
    // tab. Close it quietly and leave focus where the user put it. A
    // duplicate that opened in the background (never in front) still brings
    // the open copy forward.
    const userLeft = record.seenActive === true && !current.active;
    if (!userLeft) {
      try {
        await api.tabs.update(match.id, { active: true });
        if (match.windowId !== tab.windowId || current.active) await api.windows.update(match.windowId, { focused: true });
      } catch { return; } // the match went away: keep the new tab
    }
    if (!(await read())) return;
    try { await api.tabs.remove(tab.id); } catch { return; } // already gone, or another extension closed it
    store.closed.push({ key: dupeKey(tab.url, tab, s), at: now(), created: record.created });
    await firstSwitchNotice();
  }

  async function firstSwitchNotice() {
    try {
      if ((await local.get(DUPE_NOTICE_KEY))[DUPE_NOTICE_KEY]) return;
      await local.set({ [DUPE_NOTICE_KEY]: true });
      await notify(FIRST_SWITCH_MESSAGE);
    } catch { /* a missing notice never undoes the switch */ }
  }

  function onCreated(tab) {
    return withStore(tab.incognito, async (store, s, space) => {
      const at = now();
      // Judged tabs count too: a burst is a burst whichever of its tabs was seen first.
      const recent = Object.values(store.tabs).filter(r => r.windowId === tab.windowId && at - r.created <= DUPE_BURST_MS);
      const record = newTabRecord(tab, { now: at, quietUntil: store.quietUntil, windowCreatedAt: store.windows[tab.windowId], recent });
      // A bulk open (Open All in Tabs, restore) ignores the whole burst, earlier tabs included.
      if (record.ignored === 'bulk') for (const r of recent) r.ignored = 'bulk';
      if (tab.active === true) record.seenActive = true;
      store.tabs[tab.id] = record;
      await judge(tab.id, store, s, space);
    });
  }

  function onUpdated(tabId, change, tab) {
    if (!('url' in change) && change.status !== 'complete') return undefined;
    return withStore(tab.incognito, async (store, s, space) => {
      const record = store.tabs[tabId];
      if (!record || record.done || record.ignored) return false; // unknown tabs are existing tabs
      if (change.url !== undefined) noteTabUrl(record, change.url);
      if (change.status === 'complete' && record.completedAt === undefined && /^https?:/i.test(tab.url ?? '')) record.completedAt = now();
      await judge(tabId, store, s, space);
    });
  }

  function onRemoved(tabId) {
    return queue(async () => {
      for (const [space, store] of stores) {
        if (store.tabs[tabId]) { delete store.tabs[tabId]; await save(space); }
      }
    });
  }

  // Chromium reports a new window before its tabs; Firefox reports the first
  // tab first, so tabs already recorded for this window in the burst are
  // marked too (a reopened window, a restored session).
  // Remembers that a new tab has been in front, so a later switch can tell a
  // background open from a tab the user has already left (F2).
  function onActivated({ tabId }) {
    return queue(async () => {
      if (!(await settings()).preventDuplicates) return;
      for (const space of owned) {
        const record = (await load(space)).tabs[tabId];
        if (record && !record.seenActive) { record.seenActive = true; await save(space); }
      }
    });
  }

  function onWindowCreated(win) {
    return withStore(win.incognito, store => {
      const at = now();
      store.windows[win.id] = at;
      for (const r of Object.values(store.tabs)) {
        if (r.windowId === win.id && at - r.created <= DUPE_BURST_MS && !r.done) r.ignored ??= 'new-window';
      }
    });
  }

  function onStartup() {
    return queue(async () => {
      if (!(await settings()).preventDuplicates) return;
      for (const space of owned) {
        const store = await load(space);
        store.quietUntil = now() + DUPE_STARTUP_QUIET_MS;
        await save(space);
      }
    });
  }

  /** TabVacuum Search is about to open this URL itself: keep it (D13). */
  function allow(url, incognito = false) {
    return withStore(incognito, store => { store.allowed.push({ url, at: now() }); });
  }

  function install() {
    const on = (event, listener) => event?.addListener?.(listener);
    on(api.tabs.onCreated, onCreated);
    on(api.tabs.onUpdated, onUpdated);
    on(api.tabs.onRemoved, onRemoved);
    on(api.tabs.onActivated, onActivated);
    on(api.windows?.onCreated, onWindowCreated);
    on(api.runtime.onStartup, onStartup);
    on(api.storage.onChanged, (changes, area) => {
      if (area === 'local' && SETTING_KEYS.some(k => k in changes)) settingsCache = undefined;
    });
  }

  return { install, allow, onCreated, onUpdated, onRemoved, onActivated, onWindowCreated, onStartup, idle: () => queue(() => {}) };
}
