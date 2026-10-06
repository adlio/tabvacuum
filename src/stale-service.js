// stale-service.js — Browser wiring for stale-tab review and opt-in automatic
// cleanup (R4, R5, R7). Rules live in stale-core.js; this module owns events,
// storage, the alarm and tab removal.
//
// Durable state:
//   storage.local   — the rule (threshold, opt-in, protections), a revision
//                     token and the next planned run. Never tab metadata.
//   storage.session — per-privacy-context age records, previews, editor leases
//                     and one-shot open intents. Cleared when the browser or
//                     extension restarts, so tab IDs never cross sessions.
// In-memory state (queues, a cache of the session age store, an epoch counter)
// only coordinates work inside one worker lifetime.
import {
  DEFAULT_THRESHOLD_MS, INTENT_TTL_MS, LEASE_TTL_MS, MAX_PREVIEW_TABS, MAX_TRACKED_TABS,
  PREVIEW_LIST_LIMIT, PREVIEW_TTL_MS, autoCloseMessage, classifyTab, isLiveIntent, isPlausibleRun,
  manualCloseMessage, nextLocalHour, normalizeRule, observeTabs, planStale, pruneLeases, prunePreviews,
  readAgeStore, recordActivation, urlHash, validateRulePatch,
} from './stale-core.js';

export const STALE_ALARM = 'atv-stale-sweep';
export const PREVIEW_EXPIRED = 'This list of stale tabs is out of date. Review the tabs again before closing them.';
export const OPEN_FAILED = "Could not open Stale Tabs. Click the Aaron's Tab Vacuum toolbar button, then choose Stale Tabs.";
export const RULE_CHANGED = 'The stale-tab rule changed, so the remaining tabs were kept. Review the tabs again.';
const ENABLE_NORMAL_ONLY = 'Turn on automatic cleanup from the Stale Tabs controls in a normal (not private) window.';

const RULE_DEFAULTS = {
  staleThresholdMs: DEFAULT_THRESHOLD_MS, autoCloseStaleEnabled: false,
  skipPinned: true, skipAudible: true, staleRuleRevision: '',
};
const RULE_KEYS = ['staleThresholdMs', 'autoCloseStaleEnabled', 'skipPinned', 'skipAudible'];
const STALE_RULE_KEYS = ['staleThresholdMs', 'autoCloseStaleEnabled'];
// Scheduler bookkeeping never accepted from a settings message.
const INTERNAL_KEYS = ['staleRuleRevision', 'staleNextRunAt'];
const SCHEDULE_DEFAULTS = { autoCloseStaleEnabled: false, staleNextRunAt: null };
// How far an alarm's scheduledTime may differ from the recorded plan.
const ALARM_MATCH_MS = 60 * 1000;
const NAMESPACES = ['normal', 'private'];
const SESSION_KEY = 'stale.session';

const ns = incognito => (incognito === true ? 'private' : 'normal');
const keyOf = (kind, space) => `stale.${kind}.${space}`;
const isId = id => Number.isSafeInteger(id) && id >= 0;
const errorText = err => String(err?.message ?? err ?? 'Unknown error');
const pick = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));

// Runs async functions one at a time, in call order. A failure does not block later calls.
function serial() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function createStaleService(api, {
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
  notify = async () => {},
  nativeTrusted = String(api.runtime.getURL('')).startsWith('moz-extension:'),
} = {}) {
  const local = api.storage.local;
  const session = api.storage.session;
  // Chromium "split" incognito runs a second worker. It serves private
  // windows only and never schedules or runs automatic cleanup.
  const incognitoContext = api.extension?.inIncognitoContext === true;

  const sessionWrite = serial(); // every read-modify-write of storage.session
  const scheduling = serial();   // alarm reconciliation
  const settingsWrite = serial();
  const closing = serial();      // tab removal: one batch at a time, manual or automatic
  // Bumped synchronously by any rule change this worker sees, so a running
  // batch stops before its next removal without waiting for storage.
  let ruleEpoch = 0;
  let sweeping = false;
  let pendingIntent = Promise.resolve();
  let sessionStarted;

  // ---- Session storage ----

  async function readSession(key) {
    return (await session.get(key))[key];
  }

  // Age store cache: loaded once per worker from storage.session (the source
  // of truth across suspension) and written through on every change.
  const ages = new Map();
  async function loadAges(space) {
    if (!ages.has(space)) {
      let raw;
      try { raw = await readSession(keyOf('age', space)); } catch { raw = undefined; }
      // Unreadable data starts a fresh, younger baseline: never older ages.
      if (!ages.has(space)) ages.set(space, readAgeStore(raw));
    }
    return ages.get(space);
  }

  function updateAges(space, change) {
    return sessionWrite(async () => {
      const store = await loadAges(space);
      if (change(store)) await session.set({ [keyOf('age', space)]: store });
      return store;
    });
  }

  // Waits for queued event updates, then returns the current records.
  const currentAges = space => sessionWrite(() => loadAges(space));

  const fresh = t => ({ s: t, v: 0, g: 0 });
  const roomFor = store => Object.keys(store.tabs).length < MAX_TRACKED_TABS;

  /** When this browser session started, from storage.session (set once). */
  function sessionStart() {
    sessionStarted ??= sessionWrite(async () => {
      const t = now();
      const stored = await readSession(SESSION_KEY);
      if (Number.isFinite(stored?.startedAt) && stored.startedAt <= t) return stored.startedAt;
      await session.set({ [SESSION_KEY]: { startedAt: t } });
      return t;
    }).catch(() => now()); // Unknown: treat every earlier alarm as a backlog.
    return sessionStarted;
  }

  // ---- Settings ----

  const readRule = async () => normalizeRule(await local.get(RULE_DEFAULTS));

  async function callerWindow(windowId) {
    if (!isId(windowId)) throw new Error('The current window is unavailable.');
    const window = await api.windows.get(windowId);
    if (!window || window.id !== windowId) throw new Error('The current window is unavailable.');
    if (incognitoContext && window.incognito !== true) throw new Error('The current window is unavailable.');
    return window;
  }

  async function assertCanEnable(windowId) {
    if (incognitoContext || !isId(windowId)) throw new Error(ENABLE_NORMAL_ONLY);
    const window = await callerWindow(windowId);
    if (window.incognito === true) throw new Error(ENABLE_NORMAL_ONLY);
  }

  /**
   * The one gate for every settings write. Stale fields are validated and
   * reconciled with the schedule; generalKeys lists other accepted keys.
   * staleOnly (setStaleRule) accepts the threshold and opt-in only.
   * Scheduler bookkeeping is never accepted.
   */
  function saveSettings(patch, { windowId, generalKeys = [], staleOnly = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return Promise.reject(new Error('No settings to save.'));
    }
    const allowed = staleOnly ? STALE_RULE_KEYS : [...RULE_KEYS, ...generalKeys.filter(k => !INTERNAL_KEYS.includes(k))];
    const extra = Object.keys(patch).filter(key => !allowed.includes(key));
    if (staleOnly && extra.length) return Promise.reject(new Error('Only the stale-tab rule can be saved here.'));
    const { fields, error } = validateRulePatch(pick(patch, staleOnly ? STALE_RULE_KEYS : RULE_KEYS));
    if (error) return Promise.reject(new Error(error));
    const general = staleOnly ? {} : pick(patch, allowed.filter(key => !RULE_KEYS.includes(key)));
    // Disabling or a new threshold interrupts a running batch immediately.
    if (fields.autoCloseStaleEnabled === false || 'staleThresholdMs' in fields) ruleEpoch++;

    return settingsWrite(async () => {
      const before = normalizeRule(await local.get(RULE_DEFAULTS));
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => before[key] !== value));
      const enabling = changed.autoCloseStaleEnabled === true;
      if (enabling) await assertCanEnable(windowId);
      const write = { ...general, ...changed };
      if (Object.keys(changed).length) {
        ruleEpoch++;
        write.staleRuleRevision = newId(); // invalidates every earlier preview
      }
      if (Object.keys(write).length) await local.set(write);
      if ('autoCloseStaleEnabled' in changed) {
        try {
          // Enabling always plans a new future run, never an earlier leftover.
          await reconcile({ fresh: enabling });
        } catch (err) {
          // Disabled is saved and every alarm and removal re-checks it, so a
          // scheduling failure never blocks turning automation off.
          if (!enabling) return { message: 'Settings saved' };
          // Fail closed: automation stays off when it cannot be scheduled.
          await local.set({ autoCloseStaleEnabled: false, staleRuleRevision: newId() }).catch(() => {});
          await reconcile().catch(() => {});
          throw new Error(`Automatic cleanup could not be scheduled: ${errorText(err)}`);
        }
      }
      return { message: 'Settings saved' };
    });
  }

  // ---- Scheduling ----

  async function plan(at) {
    // Metadata first: an alarm that does not match it is ignored as stray.
    await local.set({ staleNextRunAt: at });
    await api.alarms.create(STALE_ALARM, { when: at });
    return at;
  }

  /**
   * Makes the alarm match the saved preference: none while disabled, exactly
   * one future-or-overdue run while enabled. Keeps a valid existing run.
   * Returns the planned time, or null when disabled.
   */
  function reconcile({ fresh: replace = false } = {}) {
    if (incognitoContext) return Promise.resolve(null);
    return scheduling(async () => {
      const stored = await local.get(SCHEDULE_DEFAULTS);
      if (stored.autoCloseStaleEnabled !== true) {
        await api.alarms?.clear?.(STALE_ALARM);
        if (stored.staleNextRunAt != null) await local.set({ staleNextRunAt: null });
        return null;
      }
      if (typeof api.alarms?.create !== 'function' || typeof api.alarms.get !== 'function') {
        throw new Error('Scheduling is unavailable in this browser.');
      }
      const t = now();
      const recorded = stored.staleNextRunAt;
      if (!replace) {
        const alarm = await api.alarms.get(STALE_ALARM);
        const at = alarm?.scheduledTime;
        if (isPlausibleRun(at, t) && Number.isFinite(recorded) && Math.abs(at - recorded) <= ALARM_MATCH_MS) return at;
        // Alarm lost (e.g. worker or browser restart): keep a still-future plan.
        if (!alarm && isPlausibleRun(recorded, t) && recorded > t) return plan(recorded);
      }
      return plan(nextLocalHour(t));
    });
  }

  async function handleAlarm(alarm) {
    if (alarm?.name !== STALE_ALARM || incognitoContext) return;
    const startedAt = await sessionStart();
    const stored = await local.get(SCHEDULE_DEFAULTS);
    if (stored.autoCloseStaleEnabled !== true) {
      await reconcile().catch(() => {}); // Disabled: never sweeps, whatever the alarm API does.
      return;
    }
    const due = alarm.scheduledTime;
    // Only the recorded plan from this browser session runs. An alarm due
    // before startup is a pre-restart backlog: no startup bulk-close.
    const genuine = Number.isFinite(due) && Number.isFinite(stored.staleNextRunAt) &&
      Math.abs(due - stored.staleNextRunAt) <= ALARM_MATCH_MS && due >= startedAt;
    // The next run is planned before sweeping, so a failed sweep cannot stop
    // the schedule, and a delayed (slept) alarm runs once, never per missed hour.
    await scheduling(() => plan(nextLocalHour(now())));
    if (!genuine || sweeping) return;
    // Someone is looking at the rule: defer to the next run.
    if (await hasEditor('normal')) return;
    await sweep();
  }

  // ---- Leases and intents ----

  async function hasEditor(space) {
    return Object.keys(pruneLeases(await readSession(keyOf('lease', space)), now())).length > 0;
  }

  async function editor(windowId, editorId, open) {
    const space = ns((await callerWindow(windowId)).incognito);
    return sessionWrite(async () => {
      const key = keyOf('lease', space);
      const t = now();
      const leases = pruneLeases(await readSession(key), t);
      const own = typeof editorId === 'string' && Object.hasOwn(leases, editorId) && leases[editorId].w === windowId
        ? editorId : undefined;
      if (open !== true) {
        if (own) delete leases[own];
        await session.set({ [key]: leases });
        return { editorId: null };
      }
      const id = own ?? newId();
      leases[id] = { w: windowId, exp: t + LEASE_TTL_MS };
      await session.set({ [key]: pruneLeases(leases, t) });
      return { editorId: id };
    });
  }

  /**
   * Keyboard/context-menu entry: opens the toolbar popup first, while the
   * user gesture is still valid, then records a short-lived intent for that
   * window. Never closes tabs and never opens another window.
   */
  function openControls(tab) {
    const windowId = isId(tab?.windowId) ? tab.windowId : undefined;
    let opening;
    try {
      opening = Promise.resolve(windowId === undefined ? api.action.openPopup() : api.action.openPopup({ windowId }));
    } catch (err) {
      opening = Promise.reject(err);
    }
    const t = now();
    const target = windowId === undefined
      ? Promise.resolve().then(() => api.windows.getLastFocused())
      : Promise.resolve({ id: windowId, incognito: tab.incognito === true });
    const recorded = target.then(window => {
      if (!isId(window?.id)) return undefined;
      const space = ns(window.incognito);
      return sessionWrite(() => session.set({ [keyOf('intent', space)]: { w: window.id, exp: t + INTENT_TTL_MS } }))
        .then(() => space);
    }).catch(() => undefined);
    pendingIntent = recorded;
    return opening.then(() => ({ opened: true }), async () => {
      const space = await recorded;
      if (space) await sessionWrite(() => session.remove(keyOf('intent', space))).catch(() => {});
      return { error: OPEN_FAILED };
    });
  }

  async function consumeIntent(windowId) {
    const space = ns((await callerWindow(windowId)).incognito);
    await pendingIntent;
    return sessionWrite(async () => {
      const key = keyOf('intent', space);
      const intent = await readSession(key);
      if (intent === undefined) return { open: false };
      const live = isLiveIntent(intent, now());
      if (live && intent.w !== windowId) return { open: false }; // another window's; it expires
      await session.remove(key);
      return { open: live };
    });
  }

  // ---- Planning ----

  const context = (rule, policy, at, t) => ({
    policy, at, now: t, thresholdMs: rule.staleThresholdMs,
    skipPinned: rule.skipPinned, skipAudible: rule.skipAudible, nativeTrusted,
  });

  /** All tabs of one privacy scope, with their records brought up to date. */
  async function loadScope(space) {
    const tabs = (await api.tabs.query({})).filter(tab => ns(tab.incognito) === space);
    const t = now();
    const store = await updateAges(space, s => observeTabs(s, tabs, t));
    return { tabs, records: store.tabs, now: t };
  }

  // Automatic scope: tabs of ordinary, non-private browser windows only.
  async function normalWindowTabs(tabs) {
    const windows = await api.windows.getAll({ windowTypes: ['normal'] });
    const ids = new Set(windows.filter(w => w.type === 'normal' && w.incognito === false).map(w => w.id));
    return tabs.filter(tab => ids.has(tab.windowId));
  }

  async function autoState(rule, tabs, records, t) {
    const enabled = rule.autoCloseStaleEnabled;
    let nextRunAt;
    try {
      nextRunAt = (enabled ? await reconcile() : null) ?? nextLocalHour(t);
    } catch (err) {
      return { enabled, available: true, nextRunAt: null, count: null, error: `Automatic cleanup is not scheduled: ${errorText(err)}` };
    }
    const scoped = await normalWindowTabs(tabs);
    // Counts tabs that will have crossed the threshold by the run.
    const { candidates } = planStale(scoped, records, context(rule, 'auto', Math.max(nextRunAt, t), t));
    return { enabled, available: true, nextRunAt, count: candidates.length, error: null };
  }

  async function savePreview(space, windowId, revision, candidates, t) {
    const id = newId();
    const entries = candidates.slice(0, MAX_PREVIEW_TABS).map(c => [c.id, c.windowId, c.gen, urlHash(c.url)]);
    await sessionWrite(async () => {
      const key = keyOf('preview', space);
      const previews = prunePreviews(await readSession(key), t);
      previews[id] = { w: windowId, r: revision, exp: t + PREVIEW_TTL_MS, c: entries };
      await session.set({ [key]: prunePreviews(previews, t) });
    });
    return id;
  }

  /** Removes the preview whatever happens next, so it can never be used twice. */
  function takePreview(space, windowId, previewId) {
    return sessionWrite(async () => {
      const key = keyOf('preview', space);
      const previews = prunePreviews(await readSession(key), now());
      const preview = Object.hasOwn(previews, previewId) ? previews[previewId] : undefined;
      delete previews[previewId];
      await session.set({ [key]: previews });
      return preview?.w === windowId ? preview : undefined;
    });
  }

  async function getState(windowId) {
    const window = await callerWindow(windowId);
    const space = ns(window.incognito);
    const rule = await readRule();
    const { tabs, records, now: t } = await loadScope(space);
    const manual = planStale(tabs, records, context(rule, 'manual', t, t));
    const authorized = manual.candidates.slice(0, MAX_PREVIEW_TABS);
    const id = await savePreview(space, windowId, rule.revision, authorized, t);
    const auto = space === 'normal' && !incognitoContext
      ? await autoState(rule, tabs, records, t)
      : { enabled: rule.autoCloseStaleEnabled, available: false, nextRunAt: null, count: null, error: null };
    return {
      settings: {
        staleThresholdMs: rule.staleThresholdMs, autoCloseStaleEnabled: rule.autoCloseStaleEnabled,
        skipPinned: rule.skipPinned, skipAudible: rule.skipAudible,
      },
      auto,
      preview: {
        id,
        tabs: authorized.slice(0, PREVIEW_LIST_LIMIT).map(({ id: tabId, title, url, lastViewedAt }) => ({ id: tabId, title, url, lastViewedAt })),
        count: authorized.length,
        windowCount: new Set(authorized.map(c => c.windowId)).size,
        unknownCount: manual.unknownCount,
      },
    };
  }

  // ---- Removal ----

  /** Re-reads the tab, its window and its record; true only if it may close now. */
  async function stillEligible(candidate, space, rule, policy) {
    try {
      const tab = await api.tabs.get(candidate.id);
      if (tab?.id !== candidate.id || tab.windowId !== candidate.windowId || ns(tab.incognito) !== space) return false;
      if (urlHash(tab.url) !== candidate.hash) return false;
      const window = await api.windows.get(tab.windowId, { populate: true });
      if (window?.id !== tab.windowId || ns(window.incognito) !== space) return false;
      if (policy === 'auto' && window.type !== 'normal') return false;
      // Another tab is active in this window, so this is not its last tab.
      if (!(window.tabs ?? []).some(other => other.id !== tab.id && other.active === true)) return false;
      const record = (await currentAges(space)).tabs[tab.id];
      if ((record?.g ?? 0) !== candidate.gen) return false; // navigated or reloaded
      const t = now();
      return classifyTab(tab, record, context(rule, policy, t, t)).status === 'stale';
    } catch {
      return false; // Unknown state keeps the tab.
    }
  }

  /** One tab at a time, each freshly checked; guard() runs before every removal. */
  async function removeCandidates(candidates, space, rule, policy, guard) {
    const result = { closed: 0, skipped: 0, failed: 0 };
    for (const [index, candidate] of candidates.entries()) {
      if (!await guard()) {
        result.skipped += candidates.length - index;
        result.stopped = true;
        break;
      }
      if (!await stillEligible(candidate, space, rule, policy)) {
        result.skipped++;
        continue;
      }
      try {
        await api.tabs.remove(candidate.id);
        result.closed++;
      } catch {
        result.failed++; // Never retried: the outcome may be uncertain.
      }
    }
    return result;
  }

  async function closePreview(windowId, previewId) {
    const epoch = ruleEpoch;
    if (typeof previewId !== 'string' || !previewId || previewId.length > 200) throw new Error(PREVIEW_EXPIRED);
    const space = ns((await callerWindow(windowId)).incognito);
    const preview = await takePreview(space, windowId, previewId);
    if (!preview) throw new Error(PREVIEW_EXPIRED);
    const candidates = preview.c
      .filter(entry => Array.isArray(entry) && entry.length === 4 && entry.every(Number.isSafeInteger))
      .map(([id, w, gen, hash]) => ({ id, windowId: w, gen, hash }));
    // An accepted close continues if the popup is dismissed.
    return closing(async () => {
      const guard = async () => {
        if (ruleEpoch !== epoch) return false;
        try { return (await readRule()).revision === preview.r; } catch { return false; }
      };
      if (!await guard()) throw new Error(PREVIEW_EXPIRED);
      const rule = await readRule();
      const { closed, skipped, failed, stopped } = await removeCandidates(candidates, space, rule, 'manual', guard);
      const result = { message: manualCloseMessage({ closed, skipped, failed }), closed, skipped, failed };
      // Actual counts stay in the reply even when the batch was cut short.
      if (stopped) result.error = RULE_CHANGED;
      return result;
    });
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      await closing(async () => {
        const epoch = ruleEpoch;
        const rule = await readRule();
        const guard = async () => {
          if (ruleEpoch !== epoch) return false;
          try {
            const current = await readRule();
            return current.autoCloseStaleEnabled && current.revision === rule.revision && !await hasEditor('normal');
          } catch {
            return false;
          }
        };
        if (!rule.autoCloseStaleEnabled || !await guard()) return;
        const { tabs, records, now: t } = await loadScope('normal');
        const scoped = await normalWindowTabs(tabs);
        const { candidates } = planStale(scoped, records, context(rule, 'auto', t, t));
        const result = await removeCandidates(
          candidates.map(c => ({ id: c.id, windowId: c.windowId, gen: c.gen, hash: urlHash(c.url) })),
          'normal', rule, 'auto', guard);
        const message = autoCloseMessage(result);
        if (message) await notify(message).catch(() => {});
      });
    } catch (err) {
      await notify(`Automatic stale-tab cleanup did not run: ${errorText(err)}`).catch(() => {});
    } finally {
      sweeping = false;
    }
  }

  // ---- Events ----

  function install() {
    const on = (event, listener) => event?.addListener?.(listener);
    const quiet = promise => { Promise.resolve(promise).catch(() => {}); };

    on(api.tabs.onCreated, tab => {
      if (!isId(tab?.id)) return;
      const t = now();
      quiet(updateAges(ns(tab.incognito), store => {
        if (store.tabs[tab.id] || !roomFor(store)) return false;
        store.tabs[tab.id] = fresh(t);
        return true;
      }));
    });

    // Window focus changes are not tracked separately: an active tab never
    // closes, and its leave is recorded when it stops being active, which is
    // never earlier than its last focus.
    on(api.tabs.onActivated, info => {
      const t = now();
      quiet(Promise.resolve(api.windows.get(info?.windowId))
        .then(window => window && updateAges(ns(window.incognito), store => recordActivation(store, info ?? {}, t))));
    });

    // A navigation or reload is a new document: it invalidates previews but
    // does not count as a view.
    on(api.tabs.onUpdated, (tabId, change, tab) => {
      if (!isId(tabId) || !change || (!('url' in change) && change.status !== 'loading')) return;
      const t = now();
      quiet(updateAges(ns(tab?.incognito), store => {
        if (!store.tabs[tabId]) {
          if (!roomFor(store)) return false;
          store.tabs[tabId] = fresh(t);
        }
        store.tabs[tabId].g++;
        return true;
      }));
    });

    on(api.tabs.onRemoved, tabId => {
      for (const space of NAMESPACES) {
        quiet(updateAges(space, store => {
          if (!Object.hasOwn(store.tabs, tabId)) return false;
          delete store.tabs[tabId];
          return true;
        }));
      }
    });

    // A replacing tab (discard, prerender) starts its own baseline; it never
    // inherits the replaced tab's age or document.
    on(api.tabs.onReplaced, (addedTabId, removedTabId) => {
      const t = now();
      for (const space of NAMESPACES) {
        quiet(updateAges(space, store => {
          if (!Object.hasOwn(store.tabs, removedTabId)) return false;
          delete store.tabs[removedTabId];
          if (isId(addedTabId)) store.tabs[addedTabId] = fresh(t);
          // Keep the window's active-tab map on the live ID.
          for (const [windowId, tabId] of Object.entries(store.active)) {
            if (tabId === removedTabId) store.active[windowId] = addedTabId;
          }
          return true;
        }));
      }
    });

    on(api.alarms?.onAlarm, alarm => quiet(handleAlarm(alarm)));
    on(api.runtime.onStartup, () => quiet(reconcile()));
    on(api.runtime.onInstalled, () => quiet(reconcile()));
    on(api.storage.onChanged, (changes, area) => {
      if (area !== 'local' || !changes) return;
      if (RULE_KEYS.some(key => key in changes) || 'staleRuleRevision' in changes) ruleEpoch++;
      if ('autoCloseStaleEnabled' in changes) quiet(reconcile());
    });

    // Worker start: record the session start, start age baselines for tabs
    // already open, then restore one schedule.
    quiet(sessionStart().then(() => reconcile()));
    for (const space of incognitoContext ? ['private'] : NAMESPACES) quiet(loadScope(space));
  }

  return {
    install, getState, saveSettings, closePreview, editor, consumeIntent, openControls,
    reconcile, handleAlarm, sweep,
  };
}
