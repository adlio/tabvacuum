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
  addAskEntry, askOutcome, authorizeAskMessage, dupeAction, dupeContextKey, dupeKey, isAskPageUrl, isStillNew, judgeNewTab, newTabRecord, noteTabUrl, settleDeadline,
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
// asking: tab id -> the Ask first prompt showing in that tab (not pruned by age; bounded by DUPE_ASK_MAX).
const emptyStore = () => ({ tabs: {}, windows: {}, closed: [], allowed: [], quietUntil: 0, asking: {} });

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
  if (raw.asking && typeof raw.asking === 'object') store.asking = raw.asking;
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
    // A tab created in this window has arrived but is still queued: it may be
    // the rest of a burst, so judge again after it is recorded (F3).
    if (queuedCreates.get(record.windowId)) { settleLater(tabId, space === 'private', record, store.tabs); return; }
    let tab, tabs;
    try { [tab, tabs] = await Promise.all([api.tabs.get(tabId), api.tabs.query({})]); } catch { return; }
    // Records of other new tabs in the same context, so an older copy wins.
    const records = store.tabs;
    const verdict = judgeNewTab({ tab, record, tabs, records, closed: store.closed, allowed: store.allowed, settings: s, now: now() });
    if (verdict.action === 'wait') {
      if (verdict.reason === 'settling') settleLater(tabId, tab.incognito, record, records);
      return;
    }
    if (verdict.action !== 'switch') { record.done = verdict.reason; return; }
    const match = tabs.find(t => t.id === verdict.matchId);
    if (dupeAction(s) === 'ask') {
      record.done = 'asking';
      await askAbout(tab, match, record, store, s, space);
      return;
    }
    record.done = 'switched';
    await switchTo(tab, match, record, store, s, space);
  }

  // Judges a settling tab again once its window has been quiet (F1, F3). A
  // later tab in the window moves the deadline, and the re-judge then simply
  // schedules again. A timer lost to a worker restart only means the tab is
  // judged on its next URL change or not at all, so it fails toward keeping it.
  const settling = new Set();
  // Tab creations per window that have arrived but not yet been recorded.
  const queuedCreates = new Map();
  const bumpQueued = (windowId, by) => {
    const n = (queuedCreates.get(windowId) ?? 0) + by;
    if (n > 0) queuedCreates.set(windowId, n); else queuedCreates.delete(windowId);
  };
  function settleLater(tabId, incognito, record, records) {
    if (settling.has(tabId)) return;
    settling.add(tabId);
    schedule(() => {
      settling.delete(tabId);
      withStore(incognito, async (store, s, space) => {
        if (store.tabs[tabId] !== undefined) await judge(tabId, store, s, space);
      }).catch(() => {});
    }, Math.max(0, settleDeadline(record, records) - now()) + 10);
  }

  // D9 order: bring the match forward first, so the browser does not activate
  // (and stale tracking does not record) a neighbour; then close the new tab
  // only if it is still the same new page.
  async function switchTo(tab, match, record, store, s, space) {
    // Right before each step: a tab created meanwhile in this window may make
    // this one part of a burst, so wait for it to be recorded and judge again.
    const deferred = () => {
      if (!queuedCreates.get(tab.windowId)) return false;
      delete record.done;
      settleLater(tab.id, space === 'private', record, store.tabs);
      return true;
    };
    const read = async () => {
      try {
        const current = await api.tabs.get(tab.id);
        return current.url === tab.url && isStillNew({ ...record, done: undefined }, now()) ? current : null;
      } catch { return null; }
    };
    const current = await read();
    if (!current || deferred()) return;
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
    if (!(await read()) || deferred()) return;
    try { await api.tabs.remove(tab.id); } catch { return; } // already gone, or another extension closed it
    store.closed.push({ key: dupeKey(tab.url, tab, s), at: now(), created: record.created });
    await firstSwitchNotice();
  }

  // ---- Ask first (R14.11) ----
  const askUrl = api.runtime.getURL('ask.html');

  // Shows the prompt in the new tab instead of switching. Never closes the tab:
  // if the prompt cannot be shown, the tab is kept.
  async function askAbout(tab, match, record, store, s, space) {
    let current;
    try { current = await api.tabs.get(tab.id); } catch { return; }
    if (current.url !== tab.url) { record.done = 'changed'; return; }
    if (queuedCreates.get(tab.windowId)) { delete record.done; settleLater(tab.id, space === 'private', record, store.tabs); return; }
    addAskEntry(store.asking, tab.id, {
      matchId: match.id, url: tab.url, key: dupeKey(tab.url, tab, s), ctx: dupeContextKey(tab),
      title: match.title || '', created: record.created, at: now(),
    });
    try {
      await api.tabs.update(tab.id, { url: askUrl });
    } catch {
      delete store.asking[tab.id];
      record.done = 'kept';
    }
  }

  // Gives a prompt tab its page back: Back to the original entry, or loading
  // the URL again when there is no entry to go back to.
  // Chromium skips the original entry (a page left without a user gesture), so
  // Back can fail there; Forward covers a prompt reached by pressing Back on a
  // kept page.
  async function restorePage(tabId, url) {
    try { await api.tabs.goBack(tabId); return true; } catch { /* no usable back entry */ }
    try { await api.tabs.goForward(tabId); return true; } catch { /* no forward entry */ }
    if (!url) return false;
    return api.tabs.update(tabId, { url }).then(() => true, () => false);
  }

  function keepFor(store, tabId) {
    const record = store.tabs[tabId];
    if (record) record.done = 'kept';
    const entry = store.asking[tabId];
    delete store.asking[tabId];
    return entry;
  }

  /**
   * Messages from the prompt page: dupeAskInfo (what to show) and dupeAskChoice
   * ({ choice: 'switch' | 'keep' }). Returns undefined for any other message.
   * Works even if the feature was turned off while a prompt was showing.
   */
  function handleAskMessage(message, sender) {
    if (message?.command !== 'dupeAskInfo' && message?.command !== 'dupeAskChoice') return undefined;
    return queue(async () => {
      const space = spaceOf(sender?.tab?.incognito);
      const store = await load(space);
      const auth = authorizeAskMessage({ sender, extensionId: api.runtime.id, askUrl, entries: store.asking });
      if (!auth.ok) throw new Error(auth.error);
      const { tabId, entry } = auth;
      let match = null;
      if (entry) { try { match = await api.tabs.get(entry.matchId); } catch { match = null; } }
      const s = await settings();
      if (!entry || (message.command === 'dupeAskInfo' && askOutcome({ choice: 'switch', entry, match, settings: s }) === 'back')) {
        // No prompt for this tab (it was restored with Reopen Closed Tab, or
        // the prompt expired), or the open copy is gone: keep the tab's page.
        keepFor(store, tabId);
        await save(space);
        return { state: (await restorePage(tabId, entry?.url)) ? 'restored' : 'lost' };
      }
      if (message.command === 'dupeAskInfo') {
        let host = '';
        try { host = new URL(entry.url).host; } catch { /* keep empty */ }
        return { state: 'ask', title: match.title || entry.title || host, host, otherWindow: match.windowId !== sender.tab.windowId };
      }
      if (askOutcome({ choice: message.choice, entry, match, settings: s }) === 'switch') {
        delete store.asking[tabId];
        await save(space);
        try {
          await api.tabs.update(match.id, { active: true });
          await api.windows.update(match.windowId, { focused: true });
          await api.tabs.remove(tabId);
          store.closed.push({ key: entry.key, at: now(), created: entry.created });
          await save(space);
        } catch { /* the tab or its match went away meanwhile */ }
        return { state: 'switched' };
      }
      // Keep both: the page itself loads the original URL with
      // location.replace, so the prompt does not stay in the tab's history.
      keepFor(store, tabId);
      await save(space);
      return { state: 'kept', url: entry.url };
    });
  }

  async function firstSwitchNotice() {
    try {
      if ((await local.get(DUPE_NOTICE_KEY))[DUPE_NOTICE_KEY]) return;
      await local.set({ [DUPE_NOTICE_KEY]: true });
      await notify(FIRST_SWITCH_MESSAGE);
    } catch { /* a missing notice never undoes the switch */ }
  }

  // F3: stamped when the event arrives, not when the queue reaches it. A busy
  // queue (Chromium creating a dozen tabs while each handler awaits the tabs
  // API) otherwise spreads a 40 ms burst over more than a second.
  function onCreated(tab) {
    const at = now();
    bumpQueued(tab.windowId, 1);
    let queued = true;
    const arrived = () => { if (queued) { queued = false; bumpQueued(tab.windowId, -1); } };
    return withStore(tab.incognito, async (store, s, space) => {
      arrived();
      // Judged tabs count too: a burst is a burst whichever of its tabs was seen first.
      const recent = Object.values(store.tabs).filter(r => r.windowId === tab.windowId && at - r.created <= DUPE_BURST_MS);
      const record = newTabRecord(tab, { now: at, quietUntil: store.quietUntil, windowCreatedAt: store.windows[tab.windowId], recent });
      // A bulk open (Open All in Tabs, restore) ignores the whole burst, earlier tabs included.
      if (record.ignored === 'bulk') for (const r of recent) r.ignored = 'bulk';
      if (tab.active === true) record.seenActive = true;
      store.tabs[tab.id] = record;
      await judge(tab.id, store, s, space);
    }).finally(arrived);
  }

  function onUpdated(tabId, change, tab) {
    if (!('url' in change) && change.status !== 'complete') return undefined;
    return withStore(tab.incognito, async (store, s, space) => {
      // A prompt tab that leaves the prompt (the user pressed Back or typed an
      // address) keeps whatever it now shows, for good.
      if (store.asking[tabId] && change.url !== undefined && !isAskPageUrl(change.url, askUrl)) { keepFor(store, tabId); return; }
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
        let changed = false;
        if (store.tabs[tabId]) { delete store.tabs[tabId]; changed = true; }
        if (store.asking[tabId]) { delete store.asking[tabId]; changed = true; }
        // The open copy closed while its prompt was showing: nothing to switch
        // to, so the prompt tab gets its page back.
        const orphaned = Object.entries(store.asking).filter(([, e]) => e.matchId === tabId);
        for (const [id] of orphaned) keepFor(store, Number(id));
        if (changed || orphaned.length) await save(space);
        for (const [id, e] of orphaned) await restorePage(Number(id), e.url);
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
    const at = now();
    return withStore(win.incognito, store => {
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

  return { install, allow, handleAskMessage, askUrl, onCreated, onUpdated, onRemoved, onActivated, onWindowCreated, onStartup, idle: () => queue(() => {}) };
}
