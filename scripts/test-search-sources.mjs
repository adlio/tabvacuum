// Real-browser flows for Search sources (R15): Bookmarks, the source toolbar,
// scope words, off-source counts, hints, private windows and handoff. Shared by
// the Firefox and Chromium harnesses through the closing adapter (see
// test-search-closing.mjs) plus `a.sources`:
//
//   promptInOverlay             whether the framed overlay can show the browser's permission prompt
//   permitted()                 permissions.contains({ permissions: ['bookmarks'] }) from an extension page
//   answer('allow' | 'deny')    answers the browser's own permission prompt that Search just opened
//   settings(action)            'grant' | 'deny' | 'revoke' through Settings' bookmark access buttons
//   seed(items)                 creates bookmarks under one fresh folder per call: items are
//                               { title, url } | { folder, children } | { separator: true } -> cleanup id
//   unseed(id), seedHistory(urls), treeTiming(count)
//   remap(shortcut), restoreShortcut(), pressRemapped()   the Search command's shortcut
//   privateWindow(urls, title)  as in test-expanded-search.mjs
//
// Bookmarks and history exist only in the throwaway profile.
import { randomBytes } from 'node:crypto';
import { sleep, until, hits } from './test-browser-fixtures.mjs';
import { follow } from './test-search-closing.mjs';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const token = prefix => `${prefix}${[...randomBytes(6)].map(b => LETTERS[b % 26]).join('')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const STATE = `
  const $ = id => document.getElementById(id);
  const shown = el => Boolean(el) && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const rows = [...document.querySelectorAll('#results .result')].map(row => ({
    kind: row.classList.contains('result-bookmark') ? 'bookmark' : row.classList.contains('result-history') ? 'history' : 'tab',
    title: row.querySelector('.title')?.textContent, url: row.querySelector('.url')?.textContent,
    path: row.querySelector('.path')?.textContent || null, star: Boolean(row.querySelector('.star')),
    open: [...row.querySelectorAll('.badge')].some(b => b.textContent === 'Open'), active: row.dataset.active === 'true' }));
  const source = name => ({ on: $('source-' + name).getAttribute('aria-pressed') === 'true', locked: $('source-' + name).dataset.state === 'locked',
    count: $('source-' + name + '-badge').textContent, description: $('source-' + name + '-count').textContent });
  return { focus: document.activeElement?.id || null, mode: $('palette').dataset.mode, query: $('query').value, rows,
    tabs: source('tabs'), bookmarks: source('bookmarks'), history: source('history'), content: source('content'),
    chip: shown($('scope-chip')) ? $('scope-chip-label').textContent : null, list: shown($('scope-list')) ? [...$('scope-list').children].map(o => o.dataset.scope) : [],
    access: shown($('source-access')), enable: shown($('enable-bookmarks')) ? $('enable-bookmarks').textContent : null,
    note: $('bookmarks-access-note').textContent, message: shown($('message')) ? $('message').textContent : '',
    include: shown($('include-line')), save: shown($('save-default')), tip: shown($('tip')) ? $('tip').textContent : null,
    newMark: shown($('bookmarks-new')), select: shown($('select-toggle')), placeholder: $('query').placeholder,
    busy: $('results').getAttribute('aria-busy'), ariaControls: $('query').getAttribute('aria-controls') };`;

export const brief = s => (!s?.tabs ? s : { focus: s.focus, mode: s.mode, query: s.query, chip: s.chip, list: s.list,
  on: ['tabs', 'bookmarks', 'history', 'content'].filter(n => s[n].on), counts: { b: s.bookmarks.count, h: s.history.count },
  message: s.message, access: s.access, enable: s.enable,
  rows: s.rows.map(r => `${r.kind[0]} ${r.url?.replace(/^https?:\/\/[^/]+/, '')}${r.path ? ` [${r.path}]` : ''}${r.star ? ' ★' : ''}${r.open ? ' open' : ''}${r.active ? ' *' : ''}`) });

export function tools(a) {
  const state = () => a.ui(STATE);
  const press = async (keys, ms = 300) => { await a.keys(keys); await sleep(ms); return state(); };
  async function settle(ok, ms = 8000) {
    let last;
    await until(async () => ok(last = await state()), 'sources state', ms).catch(() => {});
    return last;
  }
  const visible = async () => { const c = await a.uiCount(); return c.overlays + c.windows; };
  async function open(url = a.originUrl) {
    await a.focus(url);
    const kind = await a.open();
    return { kind, s: kind ? await settle(s => s.busy === 'false') : null };
  }
  async function dismiss() {
    for (let i = 0; i < 5 && await visible(); i++) { await a.keys(['Escape']); await sleep(300); }
    await until(async () => !(await visible()), 'search dismissed', 4000).catch(() => {});
  }
  async function toQuery() {
    let s = await state();
    for (let i = 0; i < 8 && s.focus !== 'query'; i++) s = await press(['Tab']);
    return s;
  }
  async function toSource(name) {
    let s = await toQuery();
    s = await press(['Shift_L', 'Tab']);
    for (let i = 0; i < 6 && s.focus !== `source-${name}`; i++) s = await press(['Right']);
    return s;
  }
  async function setSource(name, on) {
    let s = await toSource(name);
    if (s.focus === `source-${name}` && s[name].on !== on) s = await press(['space']);
    await toQuery();
    return state();
  }
  // Typed one key at a time, like a person, so a trailing space is a real insertText.
  async function typeKeys(text) {
    await toQuery();
    await a.type(text);
    return state();
  }
  return { state, press, settle, open, dismiss, toQuery, toSource, setSource, typeKeys, visible };
}

export async function runSourceSearch(a) {
  const ctx = { a, y: a.sources, check: a.check, ...tools(a), tk: token('bk'), created: [], seeded: [] };
  const video = a.record('search-sources.mp4');
  try {
    await permissionFlow(ctx);
    await bookmarkFlow(ctx);
    await scopeFlow(ctx);
    await countFlow(ctx);
    await handoffFlow(ctx);
    await privateFlow(ctx);
    await revokeFlow(ctx);
    await timingFlow(ctx);
    await shortcutFlow(ctx);
  } finally {
    await video.stop();
    await ctx.dismiss().catch(() => {});
    for (const id of ctx.seeded) await ctx.y.unseed(id).catch(() => {});
    await a.cleanup(ctx.created, []).catch(error => console.log(`INFO sources cleanup: ${error.message}`));
    console.log('SKIP sources: IME composition containing @ (no input method on the test display; covered by unit tests of the composing guard)');
  }
}

// The prompt: in place where the frame has the permissions API, else Settings.
async function permissionFlow(ctx) {
  const { a, y, check, open, dismiss, toSource, press, settle } = ctx;
  check(!(await y.permitted()), 'permission: bookmark access starts off');
  let { kind, s } = await open();
  check(kind === 'overlay' && s.bookmarks.locked && !s.bookmarks.on && !s.access, 'permission: Bookmarks starts locked, with no access panel', brief(s));
  s = await toSource('bookmarks');
  s = await press(['space']);
  const wantLabel = y.promptInOverlay ? 'Allow bookmarks' : 'Enable in Settings';
  check(s.access && s.enable === wantLabel && !s.bookmarks.on && /Search only reads bookmarks/.test(s.note) &&
    (y.promptInOverlay || /Opens Settings in a new tab\./.test(s.note)),
  `permission (overlay): pressing Bookmarks offers "${wantLabel}" and says Search only reads bookmarks`, brief(s));
  // No earlier flow presses Bookmarks, so this is its first press in the profile.
  check(s.tip === 'Tip: type @b to search only bookmarks', 'tips: the first press of Bookmarks shows its one-time tip', s.tip);
  s = await press(['Shift_L', 'Tab']);
  check(s.focus === 'enable-bookmarks', 'permission (overlay): Shift+Tab from the toolbar reaches the enable action', brief(s));
  if (y.promptInOverlay) {
    await a.keys(['Return']);
    const denied = await y.answer('deny');
    s = await ctx.state();
    check(denied.shown && !s.bookmarks.on && !(await y.permitted()), 'permission (overlay): the browser prompt appears in place; Deny keeps Bookmarks off', { denied, s: brief(s) });
    s = await press(['Return']);
    const allowed = await y.answer('allow');
    s = await settle(s => s.bookmarks.on, 6000);
    check(allowed.shown && await y.permitted() && s?.bookmarks.on && !s.access,
      'permission (overlay): Allow turns Bookmarks on while Search stays open, no relaunch', { allowed, s: brief(s) });
    await dismiss();
    const revoked = await y.settings('revoke');
    check(!(await y.permitted()), 'permission: Remove bookmark access in Settings revokes the grant', revoked);
  } else {
    await y.markOptions();
    await a.keys(['Return']);
    const opened = await until(() => y.optionsOpened(), 'settings opened', 6000).catch(() => false);
    const left = await ctx.visible();
    check(opened && left === 1, 'permission (overlay): Enable in Settings opens Settings in a new tab; Search stays in its own tab', { opened, left });
    await y.closeOptions();
    const granted = await y.settings('grant');
    await a.focus(a.originUrl);
    s = await settle(s => s.bookmarks.on, 8000);
    check(granted.state === 'Allowed' && s?.bookmarks.on && !s.access,
      'permission (overlay): after granting in Settings, returning to Search turns Bookmarks on without a relaunch', { granted, s: brief(s) });
    await dismiss();
    const revoked = await y.settings('revoke');
    check(!(await y.permitted()), 'permission: Remove bookmark access in Settings revokes the grant', revoked);
  }
  // The standalone window: its page has the permissions API in both browsers.
  await a.navigateOrigin('about:blank');
  console.log(`INFO origin tab now shows ${await a.activeUrl()}`);
  // The origin tab is selected and focused by navigateOrigin; open Search over it directly.
  kind = await a.open();
  s = kind ? await settle(s => s.busy === 'false') : null;
  check(kind === 'window', 'permission (window): a protected page opens the standalone Search window', kind);
  if (kind === 'window') {
    s = await toSource('bookmarks');
    s = await press(['space']);
    check(s.enable === 'Allow bookmarks', 'permission (window): the enable action asks in place', brief(s));
    s = await press(['Shift_L', 'Tab']);
    await a.keys(['Return']);
    const allowed = await y.answer('allow');
    s = await settle(s => s.bookmarks.on, 6000);
    check((allowed.shown || allowed.regranted) && s?.bookmarks.on, 'permission (window): asking from the window works (prompt, or a silent re-grant); Bookmarks turns on while open', { allowed, s: brief(s) });
    await dismiss();
  }
  await a.navigateOrigin(a.originUrl);
  if (kind === 'window') check(await y.permitted(), 'permission (window): the grant is in the browser permission store');
  if (!(await y.permitted())) await y.settings('grant');
  check(await y.permitted(), 'permission: bookmark access granted for the rest of the run');
}

async function bookmarkFlow(ctx) {
  const { a, y, check, tk, open, dismiss, setSource, settle, press, typeKeys } = ctx;
  const page = slug => `${a.base}/disposable/${tk}-${slug}`;
  const u = { one: page('one'), two: page('two'), open: page('open'), shared: page('shared') };
  // Folders, a separator, a bookmarklet and a non-web URL are never listed; a URL in two folders shows once.
  ctx.seeded.push(await y.seed([
    { title: `Quokka ${tk} one`, url: u.one },
    { folder: `Quokka ${tk} folder`, children: [
      { title: `Quokka ${tk} two`, url: u.two },
      { title: `Quokka ${tk} shared`, url: u.shared },
      { separator: true },
      { title: `Quokka ${tk} bookmarklet`, url: 'javascript:void(0)' },
      { title: `Quokka ${tk} file`, url: 'file:///tmp/quokka' },
    ] },
    { folder: `Quokka ${tk} second`, children: [{ title: `Quokka ${tk} shared again`, url: u.shared }] },
    { title: `Quokka ${tk} open page`, url: u.open },
  ]));
  await a.addTab('origin', u.open);
  ctx.created.push(u.open);
  let { s } = await open();
  check(s.rows.some(r => r.url === u.open && r.kind === 'tab' && r.star), 'bookmarks: an open bookmarked tab shows ★ with Bookmarks off', brief(s));
  await typeKeys(`quokka ${tk}`);
  s = await settle(s => s.busy === 'false' && s.bookmarks.count !== '', 4000);
  // Only the bookmark titles carry the word, so no tab matches; the open page is not counted again.
  check(s.bookmarks.count === '3' && s.rows.length === 0 && s.message === 'No open tabs match. 3 bookmarks do.' && s.include,
    'bookmarks: Bookmarks off shows its count (open page removed) and offers to include them', brief(s));
  s = await setSource('bookmarks', true);
  s = await settle(s => s.rows.filter(r => r.kind === 'bookmark').length >= 3);
  const marks = s.rows.filter(r => r.kind === 'bookmark');
  check(same(marks.map(r => r.url).sort(), [u.one, u.two, u.shared].sort()) && s.rows[0].kind === 'tab' && s.rows[0].url === u.open,
    'bookmarks: the open page shows once as its tab; web bookmarks follow; folders, separator, bookmarklet and file: are skipped', brief(s));
  const shared = marks.find(r => r.url === u.shared);
  check(/›/.test(marks.find(r => r.url === u.two)?.path ?? '') && /\+1 folder/.test(shared?.path ?? ''),
    'bookmarks: rows show the folder path, and a URL in two folders says +1 folder', brief(s));
  await a.shot('sources-bookmarks-light', 'Bookmarks on: open bookmarked tab with ★, then bookmark rows with folder paths');
  // Tabs off: the open bookmarked page becomes a bookmark row marked Open; Enter switches to it.
  s = await setSource('tabs', false);
  s = await settle(s => !s.tabs.on && s.rows.some(r => r.url === u.open && r.kind === 'bookmark'));
  check(s.rows.every(r => r.kind === 'bookmark') && s.rows.find(r => r.url === u.open)?.open && !s.select,
    'bookmarks: with Tabs off an open page is a bookmark marked Open, and Select multiple is hidden', brief(s));
  for (let i = 0; i < 6 && !s.rows.find(r => r.active)?.open; i++) s = await press(['Down'], 150);
  await a.startRemovals();
  const before = await a.tabCount();
  await a.keys(['Return']);
  const switched = await until(async () => (await a.activeUrl()) === u.open, 'switched to open bookmark', 6000).catch(() => false);
  check(switched && await a.tabCount() === before && !(await ctx.visible()), 'bookmarks: Enter on an open bookmark switches to that tab; no new tab', { active: await a.activeUrl(), before, after: await a.tabCount() });
  // A bookmark that is not open opens in a new tab.
  ({ s } = await open());
  check(s.tabs.on && !s.bookmarks.on, 'bookmarks: the next search starts from the default again (Tabs only)', brief(s));
  await setSource('bookmarks', true);
  await typeKeys(`quokka ${tk} two`);
  s = await settle(s => s.rows.some(r => r.url === u.two));
  for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== u.two; i++) s = await press(['Down'], 150);
  await a.keys(['Return']);
  const opened = await until(async () => (await a.activeUrl()) === u.two, 'bookmark opened', 6000).catch(() => false);
  check(opened, 'bookmarks: Enter on a bookmark opens it in a new tab', await a.activeUrl());
  ctx.created.push(u.two);
  await a.focus(a.originUrl);
  // Save as default, then reset it, from the source row itself.
  ({ s } = await open());
  s = await setSource('bookmarks', true);
  check(s.save, 'defaults: Save as default appears when the row differs from the default', brief(s));
  s = await ctx.toSource('bookmarks');
  s = await press(['End']);
  s = await press(['Return']);
  check(!s.save, 'defaults: Save as default saves and then hides', brief(s));
  await dismiss();
  ({ s } = await open());
  check(s.bookmarks.on && s.tabs.on, 'defaults: the saved default (Tabs + Bookmarks) applies on the next launch', brief(s));
  s = await setSource('bookmarks', false);
  s = await ctx.toSource('tabs');
  s = await press(['End']);
  await press(['Return']);
  await dismiss();
  ({ s } = await open());
  check(s.tabs.on && !s.bookmarks.on, 'defaults: saving Tabs only restores the original default', brief(s));
  await dismiss();
  ctx.u = u;
}

async function scopeFlow(ctx) {
  const { a, check, tk, open, dismiss, settle, press, typeKeys, state } = ctx;
  let { s } = await open();
  s = await typeKeys('@');
  check(same(s.list, ['tabs', 'bookmarks', 'history', 'contents', 'all']) && s.ariaControls === 'scope-list',
    'scope: typing @ opens the list of scope words, wired to the query', brief(s));
  s = await press(['Down']);
  s = await press(['Return']);
  check(s.chip === 'Only bookmarks' && s.bookmarks.on && !s.tabs.on && s.query === '' && s.ariaControls === 'results',
    'scope: arrow and Enter pick a scope word from the list', brief(s));
  s = await press(['BackSpace']);
  check(!s.chip && s.tabs.on && !s.bookmarks.on, 'scope: Backspace in an empty query removes the chip', brief(s));
  // A typed space after the whole-query word converts it.
  s = await typeKeys('@b ');
  check(s.chip === 'Only bookmarks' && s.query === '' && s.bookmarks.on && !s.tabs.on, 'scope: "@b" then a typed space becomes the Only bookmarks chip', brief(s));
  await a.type(`quokka ${tk}`);
  s = await settle(s => s.rows.length >= 3 && s.busy === 'false');
  check(s.rows.every(r => r.kind === 'bookmark'), 'scope: with the chip, results are bookmarks only', brief(s));
  await a.type('');
  s = await press(['BackSpace']);
  check(!s.chip, 'scope: Backspace removes the chip after the query is cleared', brief(s));
  s = await typeKeys('@b ');
  s = await press(['BackSpace']);
  check(!s.chip && s.query === '@b ', 'scope: Backspace right after converting restores the typed "@b "', brief(s));
  // Real queries that start with @ stay text.
  s = await typeKeys('@types ');
  check(!s.chip && s.query === '@types ' && !s.list.length, 'scope: "@types " stays literal text with no list', brief(s));
  s = await typeKeys('@all ');
  check(s.chip === 'All sources' && s.tabs.on && s.bookmarks.on && s.history.on && (s.content.on || s.access),
    'scope: @all turns on every source, and Contents shows its enable action without access', brief(s));
  await press(['BackSpace']);
  // A pasted scope word never converts.
  await ctx.toQuery();
  const pasted = await a.paste('@b ');
  s = await state();
  check(pasted && !s.chip && s.tabs.on && !s.bookmarks.on, 'scope: pasting "@b " never converts', { pasted, s: brief(s) });
  await dismiss();
}

async function countFlow(ctx) {
  const { a, y, check, tk, open, dismiss, settle, press, typeKeys } = ctx;
  // 105 history entries for one word: the History count reads 100+.
  const word = token('hc');
  const urls = Array.from({ length: 105 }, (_, i) => `${a.base}/archive/${word}-${i}`);
  await y.seedHistory(urls, `Heron ${word}`);
  let { s } = await open();
  s = await typeKeys(word);
  s = await settle(s => s.history.count !== '', 6000);
  check(s.history.count === '100+' && s.rows.length === 0, 'counts: History counts 100+ when the browser has more than 100 matches', brief(s));
  check(/^No open tabs match\. 100\+ history pages do\.$/.test(s.message) && s.include, 'counts: an empty list offers to include the sources that match', brief(s));
  // Double Enter: the first includes History; the second must not open a page.
  const tabsBefore = await a.tabCount();
  await a.keys(['Return', 'Return']);
  await sleep(1200);
  s = await settle(s => s.history.on && s.rows.length > 0, 6000);
  check(s.history.on && s.rows.length >= 100 && !s.rows.some(r => r.active) && await a.tabCount() === tabsBefore && await ctx.visible(),
    'counts: double Enter includes History once, arms no row and opens nothing', { tabsBefore, after: await a.tabCount(), s: brief(s) });
  s = await press(['Down']);
  check(s.rows.find(r => r.active)?.kind === 'history', 'counts: the first move arms the first included row', brief(s));
  await dismiss();
  // Counts never reorder the list or move the highlight.
  ({ s } = await open());
  await typeKeys(`quokka ${tk}`);
  s = await press(['Down']);
  const active = s.rows.find(r => r.active)?.url;
  s = await settle(s => s.bookmarks.count !== '', 4000);
  check(s.rows.find(r => r.active)?.url === active, 'counts: a counts reply keeps the highlighted row', brief(s));
  // One-time tips: the Bookmarks tip shown in the permission flow does not repeat.
  await dismiss();
  ({ s } = await open());
  s = await ctx.setSource('bookmarks', true);
  check(!s.tip, 'tips: the Bookmarks tip does not repeat on a later launch', brief(s));
  await dismiss();
}

// Host handoff with Bookmarks on and Tabs off: the replacement keeps both.
async function handoffFlow(ctx) {
  const { a, check, tk, open, dismiss, setSource, settle, press, typeKeys } = ctx;
  const page = slug => `${a.base}/disposable/${tk}-h-${slug}`;
  const u = { host: page('host'), other: page('other') };
  try {
    await a.createWindow('srcho', [u.host, u.other]);
    ctx.created.push(u.host, u.other);
    let { kind, s } = await open(u.host);
    check(kind === 'overlay', 'handoff: overlay over the host', kind);
    await setSource('bookmarks', true);
    s = await setSource('tabs', false);
    // An empty query lists recent tabs even with Tabs off, so the host can be closed.
    s = await settle(s => s.rows.filter(r => r.kind === 'tab').length >= 2);
    s = await press(['Tab']);
    for (let i = 0; i < 8 && s.rows.find(r => r.active)?.url !== u.host; i++) s = await press(['Down'], 150);
    await a.startRemovals();
    await a.keys(['x']);
    const ui = await follow(a, { not: u.host });
    s = ui.kind && await settle(s => s.busy === 'false', 4000);
    // Without website access the replacement is the standalone window (R11.13); either way it keeps the sources.
    check(Boolean(ui.kind) && s?.bookmarks.on && !s.tabs.on && (await a.removed()).includes(u.host),
      'handoff: closing the host with Bookmarks on and Tabs off keeps both in the replacement', { kind: ui.kind, s: brief(s) });
    await dismiss();
  } catch (error) {
    check(false, 'handoff: scenario stopped', error.message);
    await dismiss().catch(() => {});
  } finally {
    await a.cleanup([], ['srcho']).catch(() => {});
    await a.focus(a.originUrl).catch(() => {});
  }
}

async function privateFlow(ctx) {
  const { a, y, check, tk } = ctx;
  const title = `Private bookmarks ${token('pb')}`;
  const privPage = `${a.base}/disposable/${tk}-private`;
  const p = await y.privateWindow([privPage], title);
  const t = tools(p);
  try {
    const { kind } = await t.open(privPage);
    check(kind === 'overlay', 'private: overlay opens in the private window', kind);
    let s = await t.state();
    check(!s.bookmarks.locked && s.history.locked, 'private: Bookmarks is available (shared store); History is not', brief(s));
    s = await t.setSource('bookmarks', true);
    await p.type(`quokka ${tk} one`);
    s = await t.settle(s => s.rows.some(r => r.url === ctx.u.one));
    check(s.rows.some(r => r.kind === 'bookmark' && r.url === ctx.u.one) && s.history.count === '',
      'private: bookmarks are listed in a private window, and History is never counted', brief(s));
    for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== ctx.u.one; i++) s = await t.press(['Down'], 150);
    await p.keys(['Return']);
    const opened = await until(async () => (await p.privateTabs()).includes(ctx.u.one), 'bookmark opened privately', 6000).catch(() => false);
    check(opened, 'private: opening a bookmark creates the tab in the private window', { private: await p.privateTabs() });
  } finally {
    await p.close();
  }
}

async function revokeFlow(ctx) {
  const { a, y, check, tk, open, dismiss, setSource, settle, typeKeys } = ctx;
  let { s } = await open();
  await setSource('bookmarks', true);
  await typeKeys(`quokka ${tk}`);
  s = await settle(s => s.rows.some(r => r.kind === 'bookmark'));
  await y.settings('revoke');
  await a.focus(a.originUrl);
  await a.keys(['Right']); // Back in the search, a key press re-reads access.
  s = await settle(s => !s.bookmarks.on && !s.rows.some(r => r.kind === 'bookmark'), 8000);
  check(s && !s.bookmarks.on && s.bookmarks.locked && !s.rows.some(r => r.kind === 'bookmark' || r.star),
    'revoke: removing bookmark access while Search is open drops Bookmarks and every ★', brief(s));
  await dismiss();
  await y.settings('grant');
}

async function timingFlow({ y, check }) {
  const timing = await y.treeTiming(10_000);
  console.log(`INFO bookmarks.getTree on ${timing.count} bookmarks: ${timing.ms} ms (index build ${timing.buildMs} ms)`);
  check(timing.count >= 10_000 && timing.ms < 3000, 'timing: getTree on 10,000 bookmarks finishes well under the debounce budget for a once-per-worker build', timing);
}

// Does a user's remap of the Search shortcut to Cmd/Ctrl+K reach the extension?
async function shortcutFlow(ctx) {
  const { a, y, check, dismiss } = ctx;
  const result = await y.remap('Ctrl+K');
  let reached = false;
  if (result.applied) {
    await a.focus(a.originUrl);
    await y.pressRemapped();
    reached = await until(async () => (await ctx.visible()) > 0, 'remapped shortcut opened search', 5000).catch(() => false);
    await dismiss();
  }
  // A finding, not a pass/fail: whether the browser lets Ctrl+K reach an extension command.
  console.log(`INFO shortcut remap Ctrl+K: ${JSON.stringify({ ...result, reachedExtension: reached })}`);
  await y.restoreShortcut();
  await a.focus(a.originUrl);
  const kind = await a.open();
  check(kind === 'overlay', 'shortcut: after restoring, the default shortcut opens Search again', kind);
  await dismiss();
}
