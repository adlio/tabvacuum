import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  convertDuration, createEditorLease, createLatest, createRuleWriter, describeAuto, describeMain, describeManual, domainOf,
  durationFromMs, formatRunTime, formatViewedAgo, isStaleState, parseDuration, scopeState,
} from '../src/stale-ui.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 6, 21, 15).getTime();
const at = (day, hours, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

const state = ({ settings, auto, preview } = {}) => ({
  settings: { staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: true, skipPinned: true, skipAudible: true, ...settings },
  auto: { enabled: true, available: true, nextRunAt: at(6, 22), count: 6, error: null, ...auto },
  preview: { id: 'p', tabs: [], count: 0, windowCount: 1, unknownCount: 0, ...preview },
});

describe('formatRunTime', () => {
  it.each([
    [at(6, 22), 'en-US', '10p'],
    [at(6, 22, 30), 'en-US', '10:30p'],
    [at(6, 21, 5), 'en-US', '9:05p'],
    [at(7, 0), 'en-US', '12a tomorrow'],
    [at(7, 12), 'en-US', '12p tomorrow'],
    [at(6, 22), 'en-GB', '22:00'],
    [at(6, 22, 30), 'de-DE', '22:30'],
  ])('formats %s in %s as %s', (time, locale, text) => {
    expect(formatRunTime(time, NOW, locale)).toBe(text);
  });

  it('adds a date beyond tomorrow and never a countdown or approximation', () => {
    const text = formatRunTime(at(9, 10), NOW, 'en-US');
    expect(text).toMatch(/^10a on Fri, Oct 9$/);
    expect(text).not.toMatch(/~|in \d|min/);
  });
});

describe('parseDuration and durationFromMs', () => {
  it.each([['7', 'days', 7 * DAY], ['1', 'hours', HOUR], [' 12 ', 'hours', 12 * HOUR], ['365', 'days', 365 * DAY], ['366', 'days', 366 * DAY], ['8761', 'hours', 8761 * HOUR], ['1000000', 'days', 1e6 * DAY]])('accepts %s %s', (value, unit, ms) => {
    expect(parseDuration(value, unit)).toEqual({ ms });
  });

  it.each([['0', 'days'], ['-2', 'days'], ['1.5', 'hours'], ['1e2', 'days'], ['', 'days'], ['abc', 'days'], ['9'.repeat(30), 'days'], ['104249992', 'days'], ['7', 'weeks'], [undefined, 'days']])('rejects %s %s', (value, unit) => {
    expect(parseDuration(value, unit).error).toMatch(/whole number/);
    expect(parseDuration(value, unit)).not.toHaveProperty('ms');
  });

  it('accepts the largest safe duration and rejects one hour more', () => {
    const hours = Math.floor(Number.MAX_SAFE_INTEGER / HOUR);
    expect(parseDuration(String(hours), 'hours')).toEqual({ ms: hours * HOUR });
    expect(parseDuration(String(hours + 1), 'hours').error).toMatch(/smaller/);
  });

  it('converts a duration between units without changing it', () => {
    expect(convertDuration('7', 'days', 'hours')).toBe('168');
    expect(convertDuration('48', 'hours', 'days')).toBe('2');
    // Not whole in the new unit: shown, and invalid until the user changes it.
    expect(convertDuration('36', 'hours', 'days')).toBe('1.5');
    expect(parseDuration('1.5', 'days').error).toBeTruthy();
    expect(convertDuration('abc', 'days', 'hours')).toBeNull();
  });

  it('splits saved thresholds into editor fields', () => {
    expect(durationFromMs(7 * DAY)).toEqual({ value: 7, unit: 'days' });
    expect(durationFromMs(36 * HOUR)).toEqual({ value: 36, unit: 'hours' });
    // Not whole hours: shown as-is so validation flags it rather than rounding.
    expect(durationFromMs(1.5 * HOUR)).toEqual({ value: 1.5, unit: 'hours' });
    expect(parseDuration(String(durationFromMs(1.5 * HOUR).value), 'hours').error).toBeTruthy();
  });
});

describe('isStaleState', () => {
  it('accepts a complete reply', () => {
    expect(isStaleState(state())).toBe(true);
    expect(isStaleState(state({ auto: { nextRunAt: null, count: null } }))).toBe(true);
  });

  it.each([
    ['an error reply', { ...state(), error: 'boom' }],
    ['missing preview', { ...state(), preview: undefined }],
    ['negative count', state({ preview: { count: -1 } })],
    ['more tabs than count', state({ preview: { count: 0, tabs: [{ id: 1 }] } })],
    ['non-integer tab id', state({ preview: { count: 1, tabs: [{ id: 'x' }] } })],
    ['empty preview id', state({ preview: { id: '' } })],
    ['zero threshold', state({ settings: { staleThresholdMs: 0 } })],
    ['string enabled flag', state({ settings: { autoCloseStaleEnabled: 'yes' } })],
    ['fractional auto count', state({ auto: { count: 1.5 } })],
    ['nothing', undefined],
  ])('rejects %s', (_, reply) => {
    expect(isStaleState(reply)).toBe(false);
  });
});

describe('describeMain', () => {
  it('uses the agreed title and caption', () => {
    expect(describeMain({ state: state(), now: NOW, locale: 'en-US' })).toEqual({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Closing 6 tabs automatically at 10p.', tone: '' });
    expect(describeMain({ state: state({ auto: { count: 1 } }), now: NOW, locale: 'en-US' }).caption).toBe('Closing 1 tab automatically at 10p.');
  });

  it('omits the caption at zero and when off', () => {
    expect(describeMain({ state: state({ auto: { count: 0 } }), now: NOW, locale: 'en-US' })).toEqual({ title: 'Stale Tabs (Auto-Close Enabled)', caption: '', tone: '' });
    expect(describeMain({ state: state({ settings: { autoCloseStaleEnabled: false } }), now: NOW, locale: 'en-US' })).toEqual({ title: 'Stale Tabs', caption: '', tone: '' });
  });

  it('never claims a time it does not have', () => {
    expect(describeMain({ state: state({ auto: { nextRunAt: null } }), now: NOW }).caption).toBe('Automatic cleanup is not scheduled.');
    expect(describeMain({ state: state({ auto: { error: 'Alarms unavailable' } }), now: NOW })).toMatchObject({ caption: 'Alarms unavailable', tone: 'error' });
    expect(describeMain({ state: state(), error: 'boom', now: NOW })).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Stale-tab status unavailable.', tone: 'error' });
    expect(describeMain({ state: null, now: NOW })).toMatchObject({ caption: 'Checking…' });
  });

  it('takes the enabled state from settings even without a valid stale state', () => {
    // getSettings answered, getStaleState failed or is still loading.
    expect(describeMain({ state: null, enabled: true, error: 'boom', now: NOW })).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Stale-tab status unavailable.', tone: 'error' });
    expect(describeMain({ state: null, enabled: true, now: NOW })).toMatchObject({ title: 'Stale Tabs (Auto-Close Enabled)', caption: 'Checking…' });
    expect(describeMain({ state: null, enabled: false, now: NOW })).toEqual({ title: 'Stale Tabs', caption: '', tone: '' });
    // The saved preference wins over an older state's copy of it.
    expect(describeMain({ state: state(), enabled: false, now: NOW })).toEqual({ title: 'Stale Tabs', caption: '', tone: '' });
  });

  it('never presents an unknown preference as off', () => {
    expect(describeMain({ state: null, enabled: null, now: NOW })).toMatchObject({ caption: 'Checking…', tone: 'muted' });
    expect(describeMain({ state: null, enabled: null, error: 'boom', now: NOW })).toMatchObject({ caption: 'Automatic cleanup status unavailable.', tone: 'error' });
  });
});

describe('describeAuto and describeManual', () => {
  it('explains the first run before enabling', () => {
    const off = state({ settings: { autoCloseStaleEnabled: false } });
    expect(describeAuto(off, NOW, 'en-US').text).toBe('If turned on, 6 tabs would close automatically at 10p. Nothing closes before then.');
    expect(describeAuto(state({ settings: { autoCloseStaleEnabled: false }, auto: { count: 0 } }), NOW, 'en-US').text).toBe('If turned on, the first automatic cleanup is at 10p. No tabs would close then.');
    expect(describeAuto(state({ auto: { count: 0 } }), NOW, 'en-US').text).toBe('No tabs would close automatically at 10p.');
  });

  it('keeps manual scope and protections distinct from automatic ones', () => {
    const manual = describeManual(state({ settings: { skipPinned: true, skipAudible: false }, preview: { count: 3, windowCount: 2, unknownCount: 2 } }), false);
    expect(manual.count).toBe('Close now: 3 tabs not viewed for 7 days, across 2 windows.');
    expect(manual.protections).toBe("Close now keeps pinned tabs. 2 tabs with an unknown last viewed time are kept. Automatic cleanup always keeps each window's active tab, pinned tabs, tabs playing audio and the last tab in a window.");
    expect(describeManual(state({ settings: { staleThresholdMs: HOUR }, preview: { count: 1, windowCount: 1 } }), true).count).toBe('Close now: 1 tab not viewed for 1 hour, across 1 private window.');
  });

  it('strips normal automation numbers from a private-window state', () => {
    const scoped = scopeState(state(), true);
    expect(scoped.auto).toMatchObject({ available: false, count: null });
    expect(describeMain({ state: scoped, now: NOW }).caption).toBe('');
    expect(scopeState(state(), false)).toEqual(state());
  });
});

describe('review helpers', () => {
  it('formats domain and time since last viewed', () => {
    expect(domainOf('https://docs.example.com/a?b')).toBe('docs.example.com');
    expect(domainOf('not a url')).toBe('');
    expect(formatViewedAgo(NOW - 3 * DAY, NOW, 'en-US')).toBe('Viewed 3 days ago');
    expect(formatViewedAgo(NOW - 5 * HOUR, NOW, 'en-US')).toBe('Viewed 5 hours ago');
    expect(formatViewedAgo(NOW - 20_000, NOW, 'en-US')).toBe('Viewed 1 minute ago');
    for (const bad of [0, NaN, undefined, NOW + 1000]) expect(formatViewedAgo(bad, NOW, 'en-US')).toBe('Last viewed time unknown');
  });
});

describe('createLatest', () => {
  it('lets only the newest request apply', () => {
    const latest = createLatest();
    const first = latest.next();
    const second = latest.next();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    latest.invalidate();
    expect(second()).toBe(false);
  });
});

describe('createRuleWriter', () => {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

  it('sends a disable at once, while an enable is unconfirmed, and the last write wins', async () => {
    const replies = [deferred(), deferred()];
    const send = vi.fn(() => replies[send.mock.calls.length - 1].promise);
    const rule = createRuleWriter(send);
    rule.learn({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: false });
    const enable = rule.save({ autoCloseStaleEnabled: true });
    expect(rule.value('autoCloseStaleEnabled')).toBe(true);
    const disable = rule.save({ autoCloseStaleEnabled: false });
    expect(send.mock.calls).toEqual([[{ autoCloseStaleEnabled: true }], [{ autoCloseStaleEnabled: false }]]);
    expect(rule.value('autoCloseStaleEnabled')).toBe(false);
    // The background answers in order. The confirmed enable does not show over the newer disable.
    replies[0].resolve({ message: 'Saved' });
    await enable;
    expect(rule.value('autoCloseStaleEnabled')).toBe(false);
    expect(rule.busy).toBe(true);
    replies[1].resolve({ message: 'Saved' });
    expect(await disable).toEqual({ ok: true });
    expect(rule.busy).toBe(false);
    expect(rule.value('autoCloseStaleEnabled')).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('falls back to the confirmed value when the latest write fails', async () => {
    const rule = createRuleWriter(async () => { throw new Error('gone'); });
    rule.learn({ staleThresholdMs: 7 * DAY, autoCloseStaleEnabled: true });
    expect(await rule.save({ staleThresholdMs: DAY })).toEqual({ ok: false, error: 'gone' });
    expect(rule.value('staleThresholdMs')).toBe(7 * DAY);
  });

  it('ignores reads while a write is unconfirmed, and fill never overwrites', async () => {
    const reply = deferred();
    const rule = createRuleWriter(() => reply.promise);
    expect(rule.value('autoCloseStaleEnabled')).toBeNull();
    rule.learn({ autoCloseStaleEnabled: 'yes', staleThresholdMs: 0 });
    expect(rule.value('autoCloseStaleEnabled')).toBeNull();
    expect(rule.value('staleThresholdMs')).toBeNull();
    const saving = rule.save({ autoCloseStaleEnabled: false });
    rule.learn({ autoCloseStaleEnabled: true });
    reply.resolve({ message: 'Saved' });
    await saving;
    expect(rule.saved('autoCloseStaleEnabled')).toBe(false);
    rule.learn({ autoCloseStaleEnabled: true }, { fill: true });
    expect(rule.value('autoCloseStaleEnabled')).toBe(false);
  });
});

describe('createEditorLease', () => {
  afterEach(() => vi.useRealTimers());

  it('acquires, renews every five seconds and releases', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async ({ open }) => (open ? { editorId: 'e1' } : {}));
    const lease = createEditorLease(send);
    lease.open();
    lease.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[{ open: true }]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenLastCalledWith({ open: true, editorId: 'e1' });
    lease.close();
    expect(send).toHaveBeenLastCalledWith({ open: false, editorId: 'e1' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('releases a lease granted after the view already closed', async () => {
    let grant;
    const send = vi.fn(({ open }) => (open ? new Promise(r => { grant = r; }) : Promise.resolve({})));
    const lease = createEditorLease(send);
    lease.open();
    lease.close();
    expect(send).toHaveBeenCalledTimes(1);
    grant({ editorId: 'late' });
    await new Promise(r => setImmediate(r));
    expect(send).toHaveBeenLastCalledWith({ open: false, editorId: 'late' });
  });

  it('re-acquires after a failed renewal instead of trusting a lost lease', async () => {
    vi.useFakeTimers();
    const replies = [() => ({ editorId: 'e1' }), () => { throw new Error('worker restarted'); }, () => ({ editorId: 'e2' })];
    const send = vi.fn(async () => replies.shift()());
    const lease = createEditorLease(send);
    lease.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls.map(([p]) => p)).toEqual([{ open: true }, { open: true, editorId: 'e1' }, { open: true }]);
    lease.close();
    expect(send).toHaveBeenLastCalledWith({ open: false, editorId: 'e2' });
  });
});
