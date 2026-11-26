// Duplicate-tab prevention rules (R14): judgeNewTab and its helpers in core.js.
// Tab shapes follow what the real browsers reported (docs/design.md probe table):
// Chromium gives pendingUrl at creation and url at commit; Firefox gives
// about:blank at creation and the page URL at commit.
import { describe, it, expect } from 'vitest';
import {
  DUPE_ALLOW_MS, DUPE_COMPLETE_GRACE_MS, DUPE_SETTLE_MS, DUPE_KEEP_MS, DUPE_NEW_TAB_CAP_MS, DUPE_STARTUP_QUIET_MS,
  dupeKey, isNeverUrl, isStillNew, judgeNewTab, newTabRecord, noteTabUrl, validateDuplicateSettings,
} from '../src/core.js';

const NOW = 1_800_000_000_000;
const DOC = 'https://docs.example.com/d/123/edit';
const ON = { preventDuplicates: true, preventDuplicatesMode: 'switch', preventDuplicatesNever: [], ignoreFragments: false, ignoreQueryParams: false };

const tab = (id, url, extra = {}) => ({ id, windowId: 1, index: id, url, incognito: false, active: false, status: 'complete', ...extra });
const doc = tab(1, DOC);
const other = tab(2, 'https://chat.example.com/room');

// A tab created at `created`, with the browser's first report `atCreate`, then committed to `url`.
function newTab(id, url, { created = NOW - 200 - DUPE_SETTLE_MS, atCreate = { url: 'about:blank' }, opener, extra = {}, recordExtra = {} } = {}) {
  const shape = { id, windowId: 1, index: id, incognito: false, openerTabId: opener, ...atCreate };
  const record = { ...newTabRecord(shape, { now: created }), ...recordExtra };
  noteTabUrl(record, url);
  return { tab: tab(id, url, { status: 'loading', openerTabId: opener, ...extra }), record };
}

function judge(fresh, { tabs = [doc, other], settings = ON, now = NOW, records = {}, closed = [], allowed = [] } = {}) {
  return judgeNewTab({ tab: fresh.tab, record: fresh.record, tabs: [...tabs, fresh.tab], records: { ...records, [fresh.tab.id]: fresh.record }, closed, allowed, settings, now });
}

describe('judgeNewTab: when it acts at all', () => {
  it('does nothing while the setting is off (the default, R4.5 precedent)', () => {
    expect(judge(newTab(9, DOC), { settings: { ...ON, preventDuplicates: false } })).toEqual({ action: 'ignore', reason: 'off' });
  });

  it('waits until a new tab is 200 ms old, so a burst is known before anything closes (F1)', () => {
    expect(judge(newTab(9, DOC, { created: NOW - DUPE_SETTLE_MS + 1 }))).toEqual({ action: 'wait', reason: 'settling' });
    expect(judge(newTab(9, DOC, { created: NOW - DUPE_SETTLE_MS })).action).toBe('switch');
  });

  it('switches a new tab whose committed URL is already open', () => {
    expect(judge(newTab(9, DOC))).toEqual({ action: 'switch', reason: 'duplicate', matchId: 1 });
  });

  it('never judges a tab it has no creation record for (an existing tab navigating, or one missed while asleep)', () => {
    const fresh = newTab(9, DOC);
    expect(judgeNewTab({ tab: fresh.tab, record: undefined, tabs: [doc, fresh.tab], settings: ON, now: NOW })).toEqual({ action: 'ignore', reason: 'unknown' });
  });

  it('stops judging 15 s after creation, and 3 s after its first web page finished loading', () => {
    expect(judge(newTab(9, DOC, { created: NOW - DUPE_NEW_TAB_CAP_MS - DUPE_SETTLE_MS - 1 })).reason).toBe('not-new');
    expect(judge(newTab(9, DOC, { recordExtra: { completedAt: NOW - DUPE_COMPLETE_GRACE_MS - 1 } })).reason).toBe('not-new');
    expect(judge(newTab(9, DOC, { recordExtra: { completedAt: NOW - DUPE_COMPLETE_GRACE_MS + 100 } })).action).toBe('switch');
  });

  it('waits on blank and browser pages instead of matching them (D1)', () => {
    for (const url of ['about:blank', 'about:newtab', 'chrome://newtab/', 'moz-extension://x/options.html', 'data:text/html,x', 'view-source:https://a.example/']) {
      const open = tab(1, url);
      expect(judge(newTab(9, url), { tabs: [open, other] })).toEqual({ action: 'wait', reason: 'not-web' });
    }
  });

  it('Ctrl+T next to an open empty New Tab is left alone (D1)', () => {
    const blank = tab(1, 'chrome://newtab/');
    const fresh = newTab(9, 'chrome://newtab/', { atCreate: { url: '', pendingUrl: 'chrome://newtab/' }, opener: 2 });
    expect(judge(fresh, { tabs: [blank, other] }).action).toBe('wait');
  });

  it('never closes the last tab in a window (R7.1)', () => {
    const fresh = newTab(9, DOC);
    fresh.tab.windowId = 5;
    expect(judge(fresh)).toEqual({ action: 'wait', reason: 'alone' });
  });

  it('judges only the committed URL, so Chrome can still restore the closed tab (D5)', () => {
    const fresh = newTab(9, DOC, { atCreate: { url: '', pendingUrl: DOC } });
    fresh.tab.url = '';
    fresh.tab.pendingUrl = DOC;
    expect(judge(fresh)).toEqual({ action: 'wait', reason: 'not-web' });
  });

  it('an active new tab is still switched: R7.2 is about bulk closing, not this (D8)', () => {
    const fresh = newTab(9, DOC, { extra: { active: true } });
    expect(judge(fresh).action).toBe('switch');
  });
});

describe('newTabRecord: tabs that are never judged (D6)', () => {
  const shape = extra => ({ id: 9, windowId: 1, url: 'about:blank', ...extra });
  it('ignores tabs created during the startup quiet period', () => {
    expect(newTabRecord(shape(), { now: NOW, quietUntil: NOW + DUPE_STARTUP_QUIET_MS }).ignored).toBe('startup');
    expect(newTabRecord(shape(), { now: NOW, quietUntil: NOW - 1 }).ignored).toBeUndefined();
  });
  it('ignores restored tabs: Firefox discarded, Chromium unloaded', () => {
    expect(newTabRecord(shape({ discarded: true, url: DOC }), { now: NOW }).ignored).toBe('restored');
    expect(newTabRecord(shape({ status: 'unloaded', url: DOC }), { now: NOW }).ignored).toBe('restored');
  });
  it("ignores a new window's first-second tabs (reopened window, restored session)", () => {
    expect(newTabRecord(shape(), { now: NOW, windowCreatedAt: NOW - 400 }).ignored).toBe('new-window');
    expect(newTabRecord(shape(), { now: NOW, windowCreatedAt: NOW - 5000 }).ignored).toBeUndefined();
  });
  it('treats a third tab in one window within a second as a bulk open', () => {
    const recent = [{ windowId: 1, created: NOW - 500 }, { windowId: 1, created: NOW - 100 }];
    expect(newTabRecord(shape(), { now: NOW, recent }).ignored).toBe('bulk');
    expect(newTabRecord(shape(), { now: NOW, recent: recent.slice(1) }).ignored).toBeUndefined();
    expect(newTabRecord(shape({ windowId: 2 }), { now: NOW, recent }).ignored).toBeUndefined();
  });
  it('records the first real URL: Chromium pendingUrl, or the first URL after Firefox about:blank', () => {
    expect(newTabRecord(shape({ url: '', pendingUrl: DOC }), { now: NOW }).first).toBe(DOC);
    const ff = newTabRecord(shape(), { now: NOW });
    expect(ff.first).toBeUndefined();
    noteTabUrl(ff, 'about:blank');
    noteTabUrl(ff, DOC);
    noteTabUrl(ff, 'https://later.example/');
    expect(ff.first).toBe(DOC);
  });
  it('a judged-done or ignored record is no longer new', () => {
    expect(isStillNew({ created: NOW, done: 'kept' }, NOW)).toBe(false);
    expect(isStillNew({ created: NOW, ignored: 'bulk' }, NOW)).toBe(false);
    expect(isStillNew(undefined, NOW)).toBe(false);
  });
});

describe('judgeNewTab: matching', () => {
  it('uses Duplicate Detection normalization: fragments differ by default, match when ignored', () => {
    const sheet = tab(1, `${DOC}#gid=1`);
    expect(judge(newTab(9, `${DOC}#gid=2`), { tabs: [sheet, other] }).action).toBe('wait');
    expect(judge(newTab(9, `${DOC}#gid=2`), { tabs: [sheet, other], settings: { ...ON, ignoreFragments: true } }).action).toBe('switch');
    expect(judge(newTab(9, `${DOC}/`)).action).toBe('switch'); // trailing slash, as Close Duplicates
  });

  it('never matches across Firefox containers or private and normal windows', () => {
    const work = tab(1, DOC, { cookieStoreId: 'firefox-container-1' });
    expect(judge(newTab(9, DOC, { atCreate: { url: 'about:blank', cookieStoreId: 'firefox-default' } }), { tabs: [work, other] }).action).toBe('wait');
    const priv = tab(1, DOC, { incognito: true });
    expect(judge(newTab(9, DOC), { tabs: [priv, other] }).action).toBe('wait');
  });

  it('treats an absent cookieStoreId (Chromium) as the same store (D15)', () => {
    expect(judge(newTab(9, DOC, { atCreate: { url: '', pendingUrl: DOC } }))).toMatchObject({ action: 'switch', matchId: 1 });
    const ff = tab(1, DOC, { cookieStoreId: 'firefox-default' });
    const store = { cookieStoreId: 'firefox-default' };
    expect(judge(newTab(9, DOC, { atCreate: { url: 'about:blank', ...store }, extra: store }), { tabs: [ff, other] }).action).toBe('switch');
  });

  it('matches a pinned, sleeping or other-window copy', () => {
    for (const extra of [{ pinned: true }, { discarded: true }, { windowId: 7 }]) {
      expect(judge(newTab(9, DOC), { tabs: [tab(1, DOC, extra), other] })).toMatchObject({ action: 'switch', matchId: 1 });
    }
  });

  it('prefers an established copy in the same window over others', () => {
    const far = tab(1, DOC, { windowId: 7 });
    const near = tab(3, DOC);
    expect(judge(newTab(9, DOC), { tabs: [far, near, other] }).matchId).toBe(3);
  });

  it('does not match an established tab that is navigating away to another page', () => {
    const leaving = tab(1, DOC, { pendingUrl: 'https://elsewhere.example/', status: 'loading' });
    expect(judge(newTab(9, DOC), { tabs: [leaving, other] }).action).toBe('wait');
  });
});

describe('judgeNewTab: never list (D14)', () => {
  it('a plain line matches by URL prefix or host; /regex/ is a regex; bad regexes are skipped', () => {
    expect(isNeverUrl(DOC, ['docs.example.com'])).toBe(true);
    expect(isNeverUrl(DOC, ['https://docs.example.com/d/'])).toBe(true);
    expect(isNeverUrl(DOC, ['example.com'])).toBe(false);
    expect(isNeverUrl(DOC, ['/\\/edit$/'])).toBe(true);
    expect(isNeverUrl(DOC, ['/(/', 'other.example'])).toBe(false);
    expect(isNeverUrl(DOC, [])).toBe(false);
  });
  it('a page on the never list is kept', () => {
    expect(judge(newTab(9, DOC), { settings: { ...ON, preventDuplicatesNever: ['docs.example.com'] } })).toEqual({ action: 'wait', reason: 'never' });
  });
});

describe('judgeNewTab: opened from its match (D7, rule 4)', () => {
  it('keeps Duplicate Tab: opener is the match and the first URL is its page (Chromium shape)', () => {
    expect(judge(newTab(9, DOC, { atCreate: { url: DOC, pendingUrl: DOC }, opener: 1 }))).toEqual({ action: 'keep', reason: 'from-match' });
  });
  it('keeps Duplicate Tab or a same-page link in Firefox (about:blank first, then the page)', () => {
    expect(judge(newTab(9, DOC, { opener: 1 })).action).toBe('keep');
  });
  it('switches Chromium Ctrl+T from the doc then typing its URL: opener is set but the first URL was the New Tab page', () => {
    const fresh = newTab(9, DOC, { atCreate: { url: '', pendingUrl: 'chrome://newtab/' }, opener: 1 });
    expect(judge(fresh)).toMatchObject({ action: 'switch', matchId: 1 });
  });
  it('switches a link from a chat page: the opener is the chat tab, not the doc', () => {
    expect(judge(newTab(9, DOC, { opener: 2 }))).toMatchObject({ action: 'switch', matchId: 1 });
  });
  it('has no tab-index fallback: an external link appended right of a rightmost doc still switches', () => {
    const rightmost = tab(1, DOC, { index: 1 });
    const fresh = newTab(9, DOC);
    fresh.tab.index = 2;
    expect(judge(fresh, { tabs: [tab(2, 'https://a.example/', { index: 0 }), rightmost] })).toMatchObject({ action: 'switch', matchId: 1 });
  });
});

describe('judgeNewTab: repeated and double-fired opens (D3, D4)', () => {
  const key = dupeKey(DOC, { incognito: false }, ON);
  it('keeps a page TabVacuum closed in the last 60 s, however soon it comes back', () => {
    // gap = reopen created this long after the close; judged once it has settled.
    for (const gap of [0, 300, 5000]) {
      const at = NOW - DUPE_SETTLE_MS - gap;
      const closed = [{ key, at, created: at - 100 }];
      expect(judge(newTab(9, DOC, { created: at + gap }), { closed })).toEqual({ action: 'keep', reason: 'repeated' });
    }
    const closed = [{ key, at: NOW - DUPE_KEEP_MS, created: NOW - DUPE_KEEP_MS - 100 }];
    expect(judge(newTab(9, DOC, { created: NOW - DUPE_SETTLE_MS }), { closed }).action).toBe('keep');
  });
  it('switches again after 60 s', () => {
    const closed = [{ key, at: NOW - DUPE_KEEP_MS - 1, created: NOW - DUPE_KEEP_MS - DUPE_SETTLE_MS - 100 }];
    expect(judge(newTab(9, DOC, { created: NOW - 50 - DUPE_SETTLE_MS }), { closed }).action).toBe('switch');
  });
  it('keys the keep record by context: a private reopen does not unlock a normal one', () => {
    const closed = [{ key: dupeKey(DOC, { incognito: true }, ON), at: NOW - 500, created: NOW - 700 - DUPE_SETTLE_MS }];
    expect(judge(newTab(9, DOC, { created: NOW - 50 - DUPE_SETTLE_MS }), { closed }).action).toBe('switch');
  });
  it('a copy that already existed when its twin was closed, created within 1 s of it, is the same click', () => {
    const closed = [{ key, at: NOW - 100, created: NOW - 400 - DUPE_SETTLE_MS }];
    expect(judge(newTab(9, DOC, { created: NOW - 200 - DUPE_SETTLE_MS }), { closed }).action).toBe('switch');
  });
  it('double-fire: the younger copy switches to the older one, even while the older is still loading (Chromium)', () => {
    const older = { tab: tab(5, '', { pendingUrl: DOC, status: 'loading' }), record: { created: NOW - 900 - DUPE_SETTLE_MS, windowId: 1, ctx: 'n|', first: DOC } };
    const younger = newTab(6, DOC, { created: NOW - 700 - DUPE_SETTLE_MS });
    expect(judge(younger, { tabs: [other, older.tab], records: { 5: older.record } })).toMatchObject({ action: 'switch', matchId: 5 });
  });
  it('double-fire: the older copy never closes for the younger one', () => {
    const younger = { tab: tab(6, DOC, { status: 'loading' }), record: { created: NOW - 700 - DUPE_SETTLE_MS, windowId: 1, ctx: 'n|', first: DOC } };
    const older = newTab(5, DOC, { created: NOW - 900 - DUPE_SETTLE_MS });
    expect(judge(older, { tabs: [other, younger.tab], records: { 6: younger.record } }).action).toBe('wait');
  });
});

describe('judgeNewTab: TabVacuum Search opens (D13)', () => {
  it('keeps a page Search is opening for 5 s, then the allowance lapses', () => {
    expect(judge(newTab(9, DOC), { allowed: [{ url: DOC, at: NOW - 1000 }] })).toEqual({ action: 'keep', reason: 'search' });
    expect(judge(newTab(9, DOC), { allowed: [{ url: DOC, at: NOW - DUPE_ALLOW_MS - 1 }] }).action).toBe('switch');
  });
  it('covers a Search history result with fragments ignored, which Search deliberately did not reuse', () => {
    const open = tab(1, `${DOC}#b`);
    const fragments = { ...ON, ignoreFragments: true };
    expect(judge(newTab(9, `${DOC}#a`), { tabs: [open, other], settings: fragments, allowed: [{ url: `${DOC}#a`, at: NOW - 50 }] }).action).toBe('keep');
  });
});

describe('judgeNewTab: redirectors (D2)', () => {
  it('waits on the wrapper URL, then switches when the final page commits', () => {
    const fresh = newTab(9, 'https://safelinks.example/?url=x', { atCreate: { url: '', pendingUrl: 'https://safelinks.example/?url=x' } });
    expect(judge(fresh).action).toBe('wait');
    fresh.tab.url = DOC;
    noteTabUrl(fresh.record, DOC);
    expect(judge(fresh, { now: NOW + 1500 })).toMatchObject({ action: 'switch', matchId: 1 });
  });
  it('a script redirect after the wrapper loaded still counts within the 3 s grace', () => {
    const fresh = newTab(9, DOC, { recordExtra: { completedAt: NOW - 400 } });
    expect(judge(fresh).action).toBe('switch');
  });
});

describe('issue #20 scenario table', () => {
  const rows = [
    ['Chat or email link to a doc already open', newTab(9, DOC), 'switch'],
    ['Link inside a webmail or chat tab to an open doc', newTab(9, DOC, { opener: 2 }), 'switch'],
    ['Typed URL, bookmark or history entry in a new tab (Firefox)', newTab(9, DOC, { atCreate: { url: 'about:newtab' } }), 'switch'],
    ['Duplicate Tab to view two parts of a large spreadsheet', newTab(9, DOC, { opener: 1 }), 'keep'],
    ['Cmd/Ctrl-click a link to the same page', newTab(9, DOC, { opener: 1, atCreate: { url: '', pendingUrl: DOC } }), 'keep'],
    ['Pasting the URL into a new tab: first try', newTab(9, DOC, { atCreate: { url: '', pendingUrl: 'chrome://newtab/' }, opener: 1 }), 'switch'],
  ];
  it.each(rows)('%s', (_name, fresh, action) => {
    expect(judge(fresh).action).toBe(action);
  });
  it('Pasting it again within a minute keeps the second copy', () => {
    const closed = [{ key: dupeKey(DOC, { incognito: false }, ON), at: NOW - 8000, created: NOW - 8200 - DUPE_SETTLE_MS }];
    expect(judge(newTab(9, DOC), { closed }).action).toBe('keep');
  });
});

describe('validateDuplicateSettings (D17)', () => {
  it('accepts the defaults and switch mode only', () => {
    expect(validateDuplicateSettings({ preventDuplicates: false, preventDuplicatesMode: 'switch', preventDuplicatesNever: [] })).toBeNull();
    expect(validateDuplicateSettings({ preventDuplicatesMode: 'ask' })).toMatch(/mode/);
    expect(validateDuplicateSettings({ preventDuplicates: 'yes' })).toMatch(/on or off/);
    expect(validateDuplicateSettings({ preventDuplicatesNever: 'docs.example.com' })).toMatch(/never list/);
    expect(validateDuplicateSettings({ preventDuplicatesNever: Array(201).fill('a') })).toMatch(/never list/);
    expect(validateDuplicateSettings({ searchScope: 'all' })).toBeNull();
  });
});
