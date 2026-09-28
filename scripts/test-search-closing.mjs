// Real-browser tab menu, selection and closing flows, shared by the Firefox and
// Chromium harnesses. Each harness passes an adapter over the real extension UI:
//
//   check, base, originUrl
//   ui(body, arg)        run a function body (with `arg`) in the current search UI
//   keys(keysyms)        native X keys to the window showing the search UI
//   hold(keysym, ms)     native X key held down (server autorepeat)
//   type(text)           real typing into the focused query
//   click(selector)      real pointer click in the search UI
//   open()               native shortcut on the active tab -> 'overlay' | 'window' | undefined
//   uiCount()            { overlays, windows } across the browser
//   sessions()           live normal-mode launch sessions
//   createWindow(key, urls), addTab(windowKey, url, { pinned }), exists(url),
//   windowAlive(key), focus(url), activeUrl(), startRemovals(), removed() (URLs, in order),
//   multiSelected(), tabCount(), scheme('light' | 'dark' | null), shot(name, what),
//   layouts [{ name, shot?, enter(), exit() }], record(file), cleanup(urls, windowKeys)
//
// The UI has three modes: search (typing), tabs (the tab menu acts on the
// highlight) and select (checked tabs close together).
//
// Disposable tabs use a per-run random token, are created only in the fresh
// test profile through the browser's own privileged APIs, and are removed
// afterwards. The original fixture tabs stay available for the other checks.
import { randomBytes } from 'node:crypto';
import { sleep, until, paletteContrast, disposableTitle } from './test-browser-fixtures.mjs';

export const UI_STATE = `
  const $ = id => document.getElementById(id);
  const shown = el => Boolean(el) && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const rows = [...document.querySelectorAll('.result')].map(row => ({
    title: row.querySelector('.title')?.textContent, url: row.querySelector('.url')?.textContent,
    badges: [...row.querySelectorAll('.badge')].map(b => b.textContent),
    checked: row.dataset.checked === 'true', active: row.dataset.active === 'true', box: shown(row.querySelector('.check')),
    ariaSelected: row.querySelector('.result-option')?.getAttribute('aria-selected'),
    closer: row.querySelector('.row-close')?.id || null,
  }));
  const group = [...document.querySelectorAll('#help .hint-group')].find(g => shown(g));
  const hints = {};
  for (const hint of group ? group.querySelectorAll('.hint') : []) {
    if (!shown(hint)) continue;
    const keys = [...hint.querySelectorAll('kbd')].map(k => k.textContent).join('+');
    hints[keys] = [...hint.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  }
  const q = $('query'), m = $('message');
  return {
    focus: document.activeElement?.id || document.activeElement?.localName || null, mode: $('palette').dataset.mode,
    rows, highlight: rows.findIndex(r => r.active), checked: rows.filter(r => r.checked).length,
    query: q.value, selStart: q.selectionStart, selEnd: q.selectionEnd,
    status: $('selection-status').textContent, close: $('close-tabs').textContent, closeShown: shown($('close-tabs')),
    toggle: $('select-toggle').textContent, hintGroup: group?.id || null, hints,
    message: m.hidden ? null : { state: m.dataset.state, text: m.textContent },
    background: getComputedStyle(document.body).backgroundColor, busy: $('results').getAttribute('aria-busy'),
    actionBackgrounds: [...document.querySelectorAll('.action')].filter(shown).map(b => getComputedStyle(b).backgroundColor),
  };`;

// Action buttons and every non-optional visible hint must lie inside the palette and viewport.
export const LAYOUT = `
  const palette = document.getElementById('palette').getBoundingClientRect();
  const shown = el => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const actions = [document.getElementById('select-toggle'), document.getElementById('close-tabs')].filter(el => !el.hidden);
  const hints = [...document.querySelectorAll('#help .hint-group')].filter(g => !g.hidden).flatMap(g => [...g.querySelectorAll('.hint')]);
  const bad = [], seen = [];
  for (const el of [...actions, ...hints]) {
    const label = (el.id || el.textContent).replace(/\\s+/g, ' ').trim();
    if (!shown(el)) { if (!el.classList.contains('optional')) bad.push(label + ': hidden'); continue; }
    const r = el.getBoundingClientRect();
    seen.push(label);
    const inside = r.width > 0 && r.height > 0 && r.left >= palette.left - 0.5 && r.right <= palette.right + 0.5 &&
      r.top >= palette.top - 0.5 && r.bottom <= palette.bottom + 0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    if (!inside) bad.push(label + ': ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
  }
  if (actions.length === 2) {
    const [a, b] = actions.map(e => e.getBoundingClientRect());
    if (a.right > b.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5) bad.push('action buttons overlap');
  }
  if (document.documentElement.scrollWidth > innerWidth) bad.push('horizontal overflow');
  return { ok: !bad.length, bad, seen, palette: [palette.width, palette.height].map(Math.round), viewport: [innerWidth, innerHeight] };`;

// Observes (never alters) Backspace keydowns reaching the search document.
const REPEAT_PROBE = `
  const root = document.documentElement;
  root.dataset.tvDowns = '0'; root.dataset.tvRepeats = '0';
  window.addEventListener('keydown', e => {
    if (e.key !== 'Backspace') return;
    root.dataset.tvDowns = String(Number(root.dataset.tvDowns) + 1);
    if (e.repeat) root.dataset.tvRepeats = String(Number(root.dataset.tvRepeats) + 1);
  }, true);
  return true;`;
const REPEAT_READ = 'return { downs: Number(document.documentElement.dataset.tvDowns), repeats: Number(document.documentElement.dataset.tvRepeats) };';

// Visible footer captions per mode, keyed by their keycaps. J/K and arrows are optional (hidden when narrow).
const HINTS = {
  search: { '↵': 'Switch', Tab: 'Tab menu', Esc: 'Close' },
  tabs: { '↵': 'Switch', 'X+Del': 'Close tab', M: 'Select multiple', Esc: 'Search' },
  select: { Space: 'Toggle Selection', A: 'Select all', 'X+Del': 'Close selected', M: 'Done', Esc: 'Back' },
};
/** Mode plus everything that must follow it: hints, action buttons and checkboxes. */
export function inMode(s, mode) {
  const hints = s.hintGroup === `hints-${mode}` && Object.entries(HINTS[mode]).every(([k, c]) => s.hints[k] === c);
  const select = mode === 'select';
  const chrome = select ? s.closeShown && s.toggle === 'Done' && s.rows.every(r => r.box)
    : !s.closeShown && s.toggle === 'Select multiple' && s.checked === 0 && !s.rows.some(r => r.box);
  return s.mode === mode && hints && chrome;
}
// LAYOUT labels are textContent, so adjacent keycaps run together ("XDel").
const SELECT_HINTS = [/^A Select all$/, /^XDel Close selected$/, /^M Done$/, /^Space Toggle Selection$/];
const brief = s => ({ focus: s.focus, mode: s.mode, rows: s.rows.length, highlight: s.highlight, checked: s.checked,
  toggle: s.toggle, closeShown: s.closeShown, hintGroup: s.hintGroup, hints: s.hints, message: s.message });

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const newToken = (prefix = 'qz') => `${prefix}${[...randomBytes(6)].map(b => LETTERS[b % 26]).join('')}`;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function tools(a) {
  const state = () => a.ui(UI_STATE);
  async function press(keys, settle = 250) {
    await a.keys(keys);
    await sleep(settle);
    return state();
  }
  // Returns the first state meeting `ok`, or the last one seen, so checks report details.
  async function settle(ok, ms = 6000) {
    let last;
    await until(async () => ok(last = await state()), 'search state', ms).catch(() => {});
    return last;
  }
  async function moveTo(index) {
    let s = await state();
    for (let i = 0; i < 20 && s.highlight !== index; i++) s = await press([s.highlight < index ? 'Down' : 'Up'], 150);
    return s;
  }
  async function toResults() {
    let s = await state();
    for (let i = 0; i < 4 && s.focus !== 'results'; i++) s = await press(['Shift_L', 'Tab']);
    return s;
  }
  // Escape steps back select -> tabs -> search -> dismissed.
  async function dismiss() {
    const s = await state();
    const steps = { select: 3, tabs: 2, search: 1 }[s.mode] ?? 1;
    // The last Escape removes the UI, so it cannot be followed by a state read.
    for (let i = 0; i < steps; i++) { await a.keys(['Escape']); await sleep(250); }
    await until(async () => (await a.uiCount()).overlays + (await a.uiCount()).windows === 0, 'search dismissed', 5000).catch(() => {});
  }
  return { state, press, settle, moveTo, toResults, dismiss };
}

/**
 * Native focus order with results: query -> results (tab menu) -> highlighted row's X ->
 * Select multiple -> (Close, select mode only) -> query, and the reverse with Shift+Tab.
 * Starts and ends with the query focused, search open.
 */
export async function runTabCycle(a, label) {
  const { check } = a;
  const { state, press } = tools(a);
  const origin = await a.activeUrl();
  const start = await state();
  check(start.focus === 'query' && inMode(start, 'search') && start.rows.length > 0, `${label}: cycle starts in the query with results`, brief(start));
  const x = s => s.rows[s.highlight]?.closer;
  const steps = [
    [['Tab'], 'results', 'tabs', 'Tab: query -> results opens the tab menu, no checkboxes'],
    [['space'], 'results', 'tabs', 'Space in the tab menu checks nothing', s => s.checked === 0],
    [['Shift_L', 'Tab'], 'query', 'search', 'Shift+Tab: results -> query returns to search'],
    [['Tab'], 'results', 'tabs', 'Tab: query -> results again'],
    [['Tab'], x, 'tabs', 'Tab: results -> highlighted row X'],
    [['Tab'], 'select-toggle', 'tabs', 'Tab: row X -> Select multiple; Close is hidden'],
    [['Tab'], 'query', 'search', 'Tab: Select multiple -> query wraps (Close skipped outside select)'],
    [['Shift_L', 'Tab'], 'select-toggle', 'search', 'Shift+Tab: query -> Select multiple'],
    [['Shift_L', 'Tab'], x, 'search', 'Shift+Tab: Select multiple -> row X'],
    [['Shift_L', 'Tab'], 'results', 'tabs', 'Shift+Tab: row X -> results opens the tab menu'],
    [['m'], 'results', 'select', 'M: tab menu -> select mode with checkboxes, none checked', s => s.checked === 0],
    [['space'], 'results', 'select', 'Space in select mode checks the highlight', s => s.checked === 1],
    [['Tab'], x, 'select', 'Tab: results -> row X in select mode', s => s.checked === 1],
    [['Tab'], 'select-toggle', 'select', 'Tab: row X -> Done'],
    [['Tab'], 'close-tabs', 'select', 'Tab: Done -> Close (select mode only)', s => s.close === 'Close 1 tab'],
    [['Shift_L', 'Tab'], 'select-toggle', 'select', 'Shift+Tab: Close -> Done'],
    [['Shift_L', 'Tab'], x, 'select', 'Shift+Tab: Done -> row X'],
    [['Shift_L', 'Tab'], 'results', 'select', 'Shift+Tab: row X -> results keeps select mode and checks', s => s.checked === 1],
    [['Escape'], 'results', 'tabs', 'Escape: select -> tab menu clears checks'],
    [['m'], 'results', 'select', 'M again starts select mode with nothing checked', s => s.checked === 0],
    [['space'], 'results', 'select', 'Space checks a row again', s => s.checked === 1],
    [['Tab'], x, 'select', 'Tab: to row X'],
    [['Tab'], 'select-toggle', 'select', 'Tab: to Done'],
    [['Tab'], 'close-tabs', 'select', 'Tab: to Close'],
    [['Tab'], 'query', 'search', 'Tab: Close -> query wraps, leaves select mode and clears checks'],
    [['Tab'], 'results', 'tabs', 'Tab: query -> tab menu, checks still cleared'],
    [['Escape'], 'query', 'search', 'Escape: tab menu -> query, search stays open'],
  ];
  for (const [keys, focus, mode, name, extra = () => true] of steps) {
    const s = await press(keys);
    const ui = await a.uiCount();
    const want = typeof focus === 'function' ? focus(s) : focus;
    const ok = Boolean(want) && s.focus === want && inMode(s, mode) && extra(s) && ui.overlays + ui.windows === 1;
    check(ok, `${label}: native ${name}`, { want, ...brief(s), ui });
    if (a.modalFocus) check(await a.modalFocus(), `${label}: focus stays in the modal after ${keys.join('+')}`);
  }
  check(await a.activeUrl() === origin, `${label}: moving through the tab menu never activates a tab`, await a.activeUrl());
}

export async function runSearchClosing(a) {
  const { base } = a;
  const tokens = { main: newToken(), cross: newToken(), guarded: newToken(), jx: newToken('amazon'), rowx: newToken('amazon') };
  const disposable = slug => `${base}/disposable/${slug}`;
  const keep = slug => `${base}/keep/${slug}`;
  const series = (token, n) => Array.from({ length: n }, (_, i) => disposable(`${token}-n${i + 1}`));
  const t = tokens;
  const f = {
    main: Object.fromEntries(['alpha', 'bravo', 'charlie', 'delta', 'pinned', 'echo', 'foxtrot', 'golf']
      .map(word => [word, disposable(`${t.main}-${word}`)])),
    keeps: Array.from({ length: 12 }, (_, i) => keep(`main-${i + 1}`)),
    jx: [...series(t.jx, 7), disposable(`${t.jx}-late`)],
    rowx: [...series(t.rowx, 8), disposable(`${t.rowx}-late-one`), disposable(`${t.rowx}-late-two`)],
    cross: { origin: disposable(`${t.cross}-source`), same: disposable(`${t.cross}-xray`), other: disposable(`${t.cross}-yankee`),
      keepSame: keep('cross-origin-window'), keepOther: keep('cross-other-window') },
  };
  const protectedTitle = `Protected ${t.guarded} origin`;
  f.guarded = { origin: `data:text/html,%3Ctitle%3E${protectedTitle.replaceAll(' ', '%20')}%3C/title%3E`,
    first: disposable(`${t.guarded}-yellow`), second: disposable(`${t.guarded}-zulu`), keep: keep('protected-window') };
  const created = [...Object.values(f.main), ...f.keeps, ...f.jx, ...f.rowx, ...Object.values(f.cross), ...Object.values(f.guarded)];
  const ctx = {
    a, t, f, ...tools(a),
    name: url => url?.startsWith('data:') ? 'protected origin' : url?.slice(base.length),
    urlsOf: s => s.rows.map(r => r.url),
    titleOf: url => disposableTitle(url.split('/').at(-1)),
    missing: async urls => (await Promise.all(urls.map(async url => (await a.exists(url)) ? null : ctx.name(url)))).filter(Boolean),
  };
  const video = a.record('search-closing.mp4');
  try {
    await mainFlow(ctx);
    await emptyQuery(ctx);
    await jxPattern(ctx);
    await rowCloseAndBatch(ctx);
    await layouts(ctx);
    await crossWindow(ctx);
    await fallback(ctx);
  } finally {
    await video.stop();
    await a.scheme(null).catch(() => {});
    await a.cleanup(created, ['cross-origin', 'cross-other', 'protected']).catch(error => console.log(`INFO closing cleanup: ${error.message}`));
  }
}

// 4 matching targets + pinned match + 12 non-matching keepalives in the origin window.
async function mainFlow({ a, t, f, state, press, settle, moveTo, toResults, dismiss, name, urlsOf, titleOf, missing }) {
  const { check, originUrl } = a;
  const { main, keeps } = f;
  for (const word of ['alpha', 'bravo', 'charlie', 'delta']) await a.addTab('origin', main[word]);
  await a.addTab('origin', main.pinned, { pinned: true });
  for (const url of keeps) await a.addTab('origin', url);
  await a.focus(originUrl);
  await a.startRemovals();
  const nativeBefore = await a.multiSelected();
  const firstMatches = ['alpha', 'bravo', 'charlie', 'delta', 'pinned'].map(w => main[w]);

  check(await a.open() === 'overlay', 'closing: shortcut opens the overlay over the origin page');
  await a.type(t.main);
  let s = await settle(s => s.rows.length === 5);
  check(sameSet(urlsOf(s), firstMatches) && inMode(s, 'search'), 'closing: unique query lists exactly the 5 disposable matches in search mode', urlsOf(s).map(name));

  // ---- Keys in the query edit text only: M, A and X are letters there.
  for (const letter of ['x', 'm', 'a']) s = await press([letter]);
  check(s.focus === 'query' && inMode(s, 'search') && s.query === `${t.main}xma` && s.rows.length === 0,
    'closing: X, M and A in the query type letters and change no mode', brief(s));
  for (let i = 0; i < 3; i++) s = await press(['BackSpace']);
  s = await settle(s => s.rows.length === 5);
  check(s.query === t.main && inMode(s, 'search'), 'closing: Backspace removes the typed letters', { query: s.query });
  s = await press(['BackSpace']);
  check(s.focus === 'query' && s.mode === 'search' && s.query === t.main.slice(0, -1), 'closing: Backspace in the query deletes a character only', { query: s.query, mode: s.mode });
  s = await press(['Control_L', 'a']);
  check(s.focus === 'query' && s.mode === 'search' && s.selStart === 0 && s.selEnd === s.query.length && s.query.length > 0 && s.checked === 0,
    'closing: Ctrl+A in the query selects the query text, not tabs', { selStart: s.selStart, selEnd: s.selEnd, mode: s.mode, checked: s.checked });
  s = await press(['Delete']);
  check(s.focus === 'query' && s.mode === 'search' && s.query === '', 'closing: Delete in the query removes the selected text only', { query: s.query, mode: s.mode });
  check((await a.removed()).length === 0 && !(await missing(firstMatches)).length, 'closing: query letters, Backspace, Ctrl+A and Delete close no tabs', await a.removed());
  check(await a.multiSelected() === nativeBefore, 'closing: query Ctrl+A leaves native tab multi-selection unchanged');
  await a.type(t.main);
  s = await settle(s => s.rows.length === 5);

  // ---- Native Tab: the tab menu. A does nothing here; M enters select mode.
  s = await press(['Tab']);
  check(s.focus === 'results' && inMode(s, 'tabs') && s.rows.length === 5 && s.highlight === 0,
    'closing: native Tab opens the tab menu: no checkboxes, highlight on the first row, tab-menu hints', brief(s));
  check(s.rows[0].ariaSelected === 'true' && s.rows.slice(1).every(r => r.ariaSelected === 'false'), 'closing: tab menu aria-selected follows the highlight', s.rows.map(r => r.ariaSelected));
  check(await a.activeUrl() === originUrl && (await a.uiCount()).overlays === 1, 'closing: entering the tab menu activates no tab');
  const menuLayout = await a.ui(LAYOUT);
  check(menuLayout.ok, 'closing: wide tab menu: buttons and hints fit inside the palette', menuLayout);
  await a.shot('tab-menu', 'wide overlay tab menu: highlight with its row X, X/Del Close tab and M Select multiple hints');
  for (const keys of [['a'], ['Control_L', 'a']]) {
    s = await press(keys);
    check(inMode(s, 'tabs') && s.checked === 0 && (await a.removed()).length === 0, `closing: ${keys.join('+')} in the tab menu selects nothing`, brief(s));
    check(await a.ui('return String(window.getSelection()) === "";'), `closing: ${keys.join('+')} in the tab menu does not highlight page text`);
  }
  s = await press(['m']);
  check(s.focus === 'results' && inMode(s, 'select') && s.checked === 0 && s.close === 'Close 0 tabs' && s.status === '0 of 5 selected',
    'closing: M enters select mode: checkboxes, Done, Close 0 tabs, select hints with Space Toggle Selection', brief(s));
  check(s.rows.every(r => r.ariaSelected === 'false'), 'closing: select mode aria-selected means checked', s.rows.map(r => r.ariaSelected));
  const wide = await a.ui(LAYOUT);
  check(wide.ok && SELECT_HINTS.every(h => wide.seen.some(t => h.test(t))),
    'closing: wide select mode: buttons and A/X/M/Space hints fit inside the palette', wide);

  // Nothing checked: X closes nothing, not even the highlight.
  s = await press(['x']);
  await sleep(600);
  s = await state();
  check(inMode(s, 'select') && s.rows.length === 5 && (await a.removed()).length === 0, 'closing: X in select mode with nothing checked closes nothing', brief(s));

  s = await press(['Control_L', 'a']);
  check(s.checked === 5 && s.status === '5 of 5 selected' && s.close === 'Close 5 tabs', 'closing: native Ctrl+A alias checks the whole result set',
    { checked: s.checked, status: s.status, close: s.close });
  check(await a.multiSelected() === nativeBefore && (await a.removed()).length === 0, 'closing: select-mode Ctrl+A leaves native tab multi-selection unchanged and closes nothing');

  await a.addTab('origin', main.echo);
  s = await settle(s => s.rows.length === 6, 8000);
  const echo = s.rows.find(r => r.url === main.echo);
  check(echo && !echo.checked && s.checked === 5 && s.status === '5 of 6 selected' && inMode(s, 'select'), 'closing: matching tab arriving after select-all is listed unchecked',
    { echo, checked: s.checked, status: s.status });

  // ---- Movement with arrows and J/K; Space toggles.
  s = await moveTo(0);
  const moves = [[['j'], 1], [['j'], 2], [['k'], 1], [['Down'], 2], [['Up'], 1]];
  const path = [s.highlight];
  for (const [keys] of moves) path.push((await press(keys, 150)).highlight);
  check(same(path, [0, ...moves.map(m => m[1])]), 'closing: J/K and Up/Down move the highlight', path);
  const deltaIndex = (await state()).rows.findIndex(r => r.url === main.delta);
  await moveTo(deltaIndex);
  const toggles = [];
  for (let i = 0; i < 3; i++) {
    const r = await press(['space'], 150);
    toggles.push([r.rows[deltaIndex].checked, r.status]);
  }
  check(same(toggles, [[false, '4 of 6 selected'], [true, '5 of 6 selected'], [false, '4 of 6 selected']]), 'closing: Space toggles the highlighted row only', toggles);
  s = await state();
  const checkedNow = s.rows.filter(r => r.checked).map(r => r.url);
  check(sameSet(checkedNow, ['alpha', 'bravo', 'charlie', 'pinned'].map(w => main[w])) && s.close === 'Close 4 tabs', 'closing: checked set before closing', checkedNow.map(name));

  // ---- Real wide selection screenshots in both themes, with text contrast.
  for (const [scheme, background] of [['light', 'rgb(255, 255, 255)'], ['dark', 'rgb(28, 28, 31)']]) {
    await a.scheme(scheme);
    // Buttons transition their background (0.15 s); measure only once it has settled.
    const themed = await settle(s => s.background === background && s.actionBackgrounds.every(c => c === background), 3000);
    check(themed.background === background, `closing: ${scheme} theme in select mode`, { body: themed.background, actions: themed.actionBackgrounds });
    const contrast = await a.ui(`return (${paletteContrast.toString()})()`);
    check(contrast.passes && contrast.checked.includes('.action:not([aria-disabled="true"])') && contrast.checked.includes('.hint'),
      `closing: ${scheme} select-mode text, action and hint contrast meets 4.5:1`, contrast);
    await a.shot(`selection-wide-${scheme}`, `${scheme} wide overlay in select mode: 4 of 6 checked, Space Toggle Selection / A / X / M hints`);
  }
  await a.scheme(null);

  // ---- Row X in select mode closes its own (checked) row only; the rest stay checked.
  s = await state();
  const alpha = s.rows.find(r => r.url === main.alpha);
  await a.click(`#${alpha.closer}`);
  await until(async () => (await missing([main.alpha])).length === 1, 'alpha closed', 8000).catch(() => {});
  s = await settle(s => s.rows.length === 5 && s.busy === 'false');
  await sleep(500);
  s = await state();
  check(same(await a.removed(), [main.alpha]) && inMode(s, 'select') && s.focus === 'results' && s.checked === 3 && s.close === 'Close 3 tabs',
    'closing: row X in select mode closes only its own row; other checks, mode and list focus stay', { removed: (await a.removed()).map(name), ...brief(s) });

  // ---- Close button: exactly the checked IDs; pinned skipped with a reason; search stays open.
  await a.click('#close-tabs');
  const expected = ['alpha', 'bravo', 'charlie'].map(w => main[w]);
  await until(async () => (await missing(expected)).length === 3, 'checked tabs closed', 8000).catch(() => {});
  s = await settle(s => s.rows.length === 3 && s.message?.state === 'notice');
  const removed = await a.removed();
  check(sameSet(removed, expected), 'closing: Close button closes exactly the checked, closable tabs', removed.map(name));
  const stay = [main.pinned, main.delta, main.echo, originUrl, ...keeps];
  check(!(await missing(stay)).length, 'closing: pinned, unchecked, keepalive and origin tabs stay open', await missing(stay));
  check((await a.uiCount()).overlays === 1 && s.query === t.main && inMode(s, 'select') && sameSet(urlsOf(s), [main.pinned, main.delta, main.echo]),
    'closing: search, query and select mode stay with the remaining matches', { query: s.query, ...brief(s), rows: urlsOf(s).map(name) });
  const reason = `Closed 2 of 3 tabs. Skipped 1: ${titleOf(main.pinned)} (pinned tab).`;
  check(s.message?.text === reason, 'closing: pinned tab skip explained in readable text', s.message);

  // ---- Tab menu: single keyboard close of the highlight; the next row takes its place.
  for (const word of ['foxtrot', 'golf']) await a.addTab('origin', main[word]);
  s = await settle(s => s.rows.length === 5, 8000);
  s = await toResults();
  check(s.focus === 'results' && s.mode === 'select', 'closing: Shift+Tab from the Close button returns to results in select mode', brief(s));
  s = await press(['Escape']);
  check(s.focus === 'results' && inMode(s, 'tabs') && s.rows.length === 5, 'closing: Escape in select mode clears checks and returns to the tab menu', brief(s));
  const tapIndex = s.rows.findIndex((r, i) => i > 0 && i < s.rows.length - 1 && r.url !== main.pinned);
  await moveTo(tapIndex);
  const tapped = s.rows[tapIndex].url, next = s.rows[tapIndex + 1].url;
  await press(['BackSpace']);
  await settle(s => s.rows.length === 4);
  await sleep(800);
  let after = await a.removed();
  s = await state();
  check(after.length === 4 && after[3] === tapped && s.rows.length === 4 && s.highlight === tapIndex && s.rows[tapIndex].url === next &&
    inMode(s, 'tabs') && s.focus === 'results',
  'closing: one Backspace in the tab menu closes only the highlight; the next row takes its position',
  { closed: after.slice(3).map(name), highlight: s.highlight, tapIndex, now: name(s.rows[s.highlight]?.url), expected: name(next), mode: s.mode });

  const holdIndex = s.rows.findIndex(r => r.url !== main.pinned);
  s = await moveTo(holdIndex);
  const held = s.rows[holdIndex].url;
  await a.ui(REPEAT_PROBE);
  await a.hold('BackSpace', 1500);
  await settle(s => s.rows.length === 3);
  await sleep(1200);
  s = await state();
  after = await a.removed();
  const probe = await a.ui(REPEAT_READ);
  check(probe.repeats > 0, 'closing: held Backspace delivered native autorepeat keydowns (harness sanity)', probe);
  check(after.length === 5 && after[4] === held && s.rows.length === 3 && inMode(s, 'tabs'), 'closing: held Backspace closes one tab, auto-repeat closes nothing more',
    { closed: after.slice(4).map(name), rows: s.rows.length, probe });

  // ---- Keyboard query focus, pointer query focus and Escape all clear checks.
  s = await press(['m']);
  s = await press(['space']);
  check(s.checked === 1 && s.mode === 'select', 'closing: row checked before clearing');
  s = await press(['Shift_L', 'Tab']);
  check(s.focus === 'query' && inMode(s, 'search'), 'closing: Shift+Tab to the query leaves select mode and clears checks', brief(s));
  s = await press(['Tab']);
  check(s.focus === 'results' && inMode(s, 'tabs'), 'closing: re-entering results opens the tab menu with nothing checked', brief(s));
  await press(['m']);
  s = await press(['space']);
  await a.click('#query');
  s = await state();
  check(s.focus === 'query' && inMode(s, 'search'), 'closing: pointer focus on the query leaves select mode and clears checks', brief(s));
  await press(['Tab']);
  await press(['m']);
  s = await press(['space']);
  s = await press(['Escape']);
  check(s.focus === 'results' && inMode(s, 'tabs'), 'closing: Escape in select mode clears checks and keeps the tab menu', brief(s));
  s = await press(['Escape']);
  check(s.focus === 'query' && inMode(s, 'search') && (await a.uiCount()).overlays === 1, 'closing: Escape in the tab menu returns to the query', brief(s));
  await a.keys(['Escape']);
  await until(async () => (await a.uiCount()).overlays === 0, 'overlay dismissed', 5000).catch(() => {});
  check((await a.uiCount()).overlays === 0 && (await a.removed()).length === 5, 'closing: Escape in search dismisses search without closing tabs');
}

// Empty query: select-all covers the listed recent tabs (max 10), not the browser.
async function emptyQuery({ a, state, press, settle }) {
  const { check, originUrl } = a;
  await a.focus(originUrl);
  check(await a.open() === 'overlay', 'empty query: overlay opens');
  let s = await settle(s => s.rows.length > 0 && s.busy === 'false');
  const total = await a.tabCount();
  const closedBefore = (await a.removed()).length;
  await press(['Tab']);
  s = await press(['a']);
  check(inMode(s, 'tabs') && s.checked === 0, 'empty query: A in the tab menu checks nothing', brief(s));
  await press(['m']);
  s = await press(['a']);
  check(s.query === '' && s.rows.length === 10 && total > 10 && s.checked === 10 && s.status === '10 of 10 selected' && s.close === 'Close 10 tabs',
    'empty query: A in select mode checks the 10 listed recent tabs, not every tab', { rows: s.rows.length, total, checked: s.checked, status: s.status });
  s = await press(['Escape']);
  check(s.focus === 'results' && inMode(s, 'tabs'), 'empty query: Escape clears the 10 checks', brief(s));
  await press(['Escape']);
  s = await state();
  check(s.focus === 'query' && inMode(s, 'search'), 'empty query: second Escape returns to search');
  await a.keys(['Escape']);
  await until(async () => (await a.uiCount()).overlays === 0, 'overlay dismissed', 5000).catch(() => {});
  check((await a.uiCount()).overlays === 0 && (await a.removed()).length === closedBefore && await a.tabCount() === total, 'empty query: dismissed without closing tabs');
}

// Tab, then J X J X J X closes original rows 1, 3 and 5 while staying in the tab menu.
async function jxPattern({ a, t, f, state, press, settle, dismiss, name, urlsOf }) {
  const { check, originUrl } = a;
  for (const url of f.jx.slice(0, 7)) await a.addTab('origin', url);
  await a.focus(originUrl);
  await a.startRemovals();
  check(await a.open() === 'overlay', 'j/x: overlay opens');
  await a.type(t.jx);
  let s = await settle(s => s.rows.length === 7);
  const order = urlsOf(s);
  check(sameSet(order, f.jx.slice(0, 7)), `j/x: unique "${t.jx.slice(0, 6)}…" token lists exactly its 7 tabs`, order.map(name));
  s = await press(['Tab']);
  check(s.focus === 'results' && inMode(s, 'tabs') && s.highlight === 0, 'j/x: Tab opens the tab menu on row 0', brief(s));
  // Six native keystrokes in ~120 ms, with no wait for tab removals or UI refresh.
  // Observe the mode/focus through each change without altering extension state.
  await a.ui(`const root = document.documentElement; const steps = [];
    root.dataset.tvModeChanges = '[]';
    const observer = new MutationObserver(() => {
      steps.push({ mode: document.getElementById('palette').dataset.mode, focus: document.activeElement.id });
      root.dataset.tvModeChanges = JSON.stringify(steps);
    }); observer.observe(document.getElementById('results'), { childList: true }); return true;`);
  await a.burst(['j', 'x', 'j', 'x', 'j', 'x']);
  s = await settle(s => s.rows.length === 4 && s.busy === 'false', 8000);
  const steps = await a.ui("return JSON.parse(document.documentElement.dataset.tvModeChanges || '[]');");
  const removed = await a.removed();
  check(same(removed, [order[1], order[3], order[5]]), 'j/x: J X J X J X closes original rows 1, 3 and 5, in order', removed.map(name));
  check(same(urlsOf(s), [order[0], order[2], order[4], order[6]]), 'j/x: original rows 0, 2, 4 and 6 remain', urlsOf(s).map(name));
  check(steps.every(p => p.focus === 'results' && p.mode === 'tabs') && s.highlight === 3 && inMode(s, 'tabs') && (await a.uiCount()).overlays === 1,
    'j/x: every close keeps the tab menu, list focus and the next row at the same index', steps);

  // X, Delete, Backspace and X empty the list; the tab menu stays usable.
  s = await press(['Up']);
  for (const key of ['x', 'Delete', 'BackSpace', 'x']) {
    const before = (await state()).rows.length;
    await press([key]);
    s = await settle(s => s.rows.length === before - 1 && s.busy === 'false');
    await sleep(300);
  }
  s = await state();
  check(s.rows.length === 0 && s.focus === 'results' && inMode(s, 'tabs') && (await a.uiCount()).overlays === 1 && (await a.removed()).length === 7,
    'j/x: X, Delete and Backspace close the highlight; with zero results the tab menu keeps mode and focus', brief(s));
  await a.addTab('origin', f.jx[7]);
  s = await settle(s => s.rows.length === 1, 8000);
  s = await press(['j']);
  s = await press(['k']);
  check(s.rows[0]?.url === f.jx[7] && s.highlight === 0 && s.focus === 'results' && inMode(s, 'tabs'), 'j/x: a tab arriving into the empty tab menu is highlighted and navigable', brief(s));
  await press(['x']);
  s = await settle(s => s.rows.length === 0 && s.busy === 'false');
  check((await a.removed()).at(-1) === f.jx[7] && inMode(s, 'tabs') && s.focus === 'results', 'j/x: X closes the arrival and stays in the tab menu', brief(s));
  check(await a.activeUrl() === originUrl, 'j/x: no close activated a tab');
  await dismiss();
  check((await a.uiCount()).overlays === 0, 'j/x: Escape twice dismisses search');
}

// Row X by pointer and keyboard, then select-mode batches with arrivals.
async function rowCloseAndBatch({ a, t, f, state, press, settle, moveTo, dismiss, name, urlsOf }) {
  const { check, originUrl } = a;
  const late = f.rowx.slice(8);
  for (const url of f.rowx.slice(0, 8)) await a.addTab('origin', url);
  await a.focus(originUrl);
  await a.startRemovals();
  check(await a.open() === 'overlay', 'row X: overlay opens');
  await a.type(t.rowx);
  let s = await settle(s => s.rows.length === 8);
  const o = urlsOf(s);
  const expect = [];
  const closed = async (label, url, extra, detail = {}) => {
    expect.push(url);
    await until(async () => !(await a.exists(url)), `${label} closed`, 8000).catch(() => {});
    s = await settle(s => s.rows.every(r => r.url !== url) && s.busy === 'false');
    await sleep(400);
    s = await state();
    const removed = await a.removed();
    check(same(removed, expect) && extra(s) && (await a.activeUrl()) === originUrl && (await a.uiCount()).overlays === 1,
      `row X: ${label}`, { removed: removed.map(name), ...brief(s), ...detail });
  };

  await a.click(`#${s.rows[1].closer}`);
  await closed('pointer X with the query focused closes its row only; search mode and query focus stay', o[1],
    s => s.rows.length === 7 && s.focus === 'query' && inMode(s, 'search'));
  s = await press(['Tab']);
  await a.click(`#${s.rows[2].closer}`);
  await closed('pointer X with the list focused closes its row only; tab menu and list focus stay', o[3],
    s => s.rows.length === 6 && s.focus === 'results' && inMode(s, 'tabs'));

  // Keyboard: focused row X; Enter and Space close it and focus the next row's X, never activating.
  await moveTo(1);
  s = await press(['Tab']);
  check(s.focus === 'row-close-1' && s.rows[1].url === o[2], 'row X: Tab focuses the highlighted row X', brief(s));
  await a.shot('search-row-close', 'tab menu with the highlighted row X keyboard-focused');
  await press(['Return']);
  await closed('Enter on a focused row X closes that row and focuses the next row X', o[2],
    s => s.focus === 'row-close-1' && s.rows[1]?.url === o[4] && inMode(s, 'tabs'));
  await press(['space']);
  await closed('Space on a focused row X closes that row and focuses the next row X', o[4],
    s => s.focus === 'row-close-1' && s.rows[1]?.url === o[5] && inMode(s, 'tabs') && s.rows.length === 4);

  // Select mode: row X closes its own row, checked or not, and leaves other checks alone.
  s = await press(['Shift_L', 'Tab']);
  await press(['m']);
  await moveTo(0);
  await press(['space']);
  await press(['j']);
  s = await press(['space']);
  check(inMode(s, 'select') && s.checked === 2 && same(s.rows.filter(r => r.checked).map(r => r.url), [o[0], o[5]]), 'row X: two rows checked', brief(s));
  await a.click(`#${s.rows[2].closer}`);
  await closed('pointer X on an unchecked row in select mode closes only that row', o[6],
    s => s.rows.length === 3 && s.checked === 2 && s.focus === 'results' && inMode(s, 'select'));
  await a.click(`#${s.rows[0].closer}`);
  await closed('pointer X on a checked row closes only its own row, not the other checked row', o[0],
    s => same(urlsOf(s), [o[5], o[7]]) && s.checked === 1 && s.rows[0].checked && s.focus === 'results' && inMode(s, 'select'));

  // A zero-checked batch closes nothing; M returns to the tab menu to continue.
  s = await press(['Escape']);
  s = await press(['m']);
  await press(['x']);
  await sleep(700);
  s = await state();
  check(inMode(s, 'select') && s.checked === 0 && s.rows.length === 2 && same(await a.removed(), expect),
    'batch: X with nothing checked closes nothing, not even the highlight', brief(s));
  s = await press(['m']);
  check(inMode(s, 'tabs') && s.focus === 'results', 'batch: M returns to the tab menu', brief(s));
  await press(['x']);
  await closed('batch: X in the tab menu then closes the highlight', s.rows[s.highlight].url,
    s => s.rows.length === 1 && inMode(s, 'tabs') && s.focus === 'results');

  // M, A, Delete closes the checked snapshot only; the arrival stays unchecked.
  const survivor = s.rows[0].url;
  await press(['m']);
  s = await press(['a']);
  check(s.checked === 1 && s.status === '1 of 1 selected', 'batch: A checks the one listed tab', brief(s));
  await a.addTab('origin', late[0]);
  s = await settle(s => s.rows.length === 2, 8000);
  check(s.rows.find(r => r.url === late[0])?.checked === false && s.status === '1 of 2 selected', 'batch: arrival after A is unchecked', brief(s));
  await press(['Delete']);
  await closed('batch: Delete closes the checked snapshot only; the arrival stays, unchecked', survivor,
    s => same(urlsOf(s), [late[0]]) && s.checked === 0 && inMode(s, 'select') && s.focus === 'results');
  await press(['a']);
  await press(['x']);
  await closed('batch: A then X closes all listed; zero results keep select mode and list focus', late[0],
    s => s.rows.length === 0 && s.status === '0 of 0 selected' && inMode(s, 'select') && s.focus === 'results');
  await a.addTab('origin', late[1]);
  s = await settle(s => s.rows.length === 1, 8000);
  const arrived = s;
  s = await press(['space']);
  check(!arrived.rows[0].checked && arrived.highlight === 0 && s.checked === 1 && inMode(s, 'select'), 'batch: arrival into empty select mode is unchecked, highlighted and toggleable', brief(s));
  s = await press(['m']);
  check(inMode(s, 'tabs') && s.checked === 0, 'batch: M back to the tab menu clears the check', brief(s));
  await press(['x']);
  await closed('batch: X closes the arrival from the tab menu; zero results keep the tab menu', late[1],
    s => s.rows.length === 0 && inMode(s, 'tabs') && s.focus === 'results');
  await dismiss();
  check((await a.uiCount()).overlays === 0, 'batch: Escape twice dismisses search');
}

// Narrow and low-height layouts: buttons and contextual hints fit.
async function layouts({ a, t, press, settle }) {
  const { check } = a;
  for (const layout of a.layouts) {
    await layout.enter();
    const closedBefore = (await a.removed()).length;
    try {
      const kind = await a.open();
      check(kind === 'overlay', `${layout.name}: overlay opens`, kind);
      await a.type(t.main);
      let s = await settle(s => s.rows.length === 3);
      const queryLayout = await a.ui(LAYOUT);
      check(queryLayout.ok && inMode(s, 'search'), `${layout.name}: search-mode buttons and hints fit inside the palette`, { queryLayout, ...brief(s) });
      s = await press(['Tab']);
      const menu = await a.ui(LAYOUT);
      check(menu.ok && inMode(s, 'tabs'), `${layout.name}: tab menu with X/Del and M hints fits inside the palette`, { menu, ...brief(s) });
      await press(['m']);
      s = await press(['space']);
      check(inMode(s, 'select') && s.checked === 1 && s.close === 'Close 1 tab', `${layout.name}: select mode shows Space Toggle Selection, A, X and M hints`, brief(s));
      const lay = await a.ui(LAYOUT);
      check(lay.ok && SELECT_HINTS.every(h => lay.seen.some(t => h.test(t))),
        `${layout.name}: select-mode buttons and hints fit inside the palette`, lay);
      console.log(`INFO ${layout.name}: palette ${lay.palette.join('x')} in viewport ${lay.viewport.join('x')}`);
      if (layout.shot) await a.shot(layout.shot, `${layout.name}: select mode with contextual inline hints`);
      await press(['Escape']);
      await press(['Escape']);
      await a.keys(['Escape']);
      await until(async () => (await a.uiCount()).overlays === 0, 'layout overlay dismissed', 5000).catch(() => {});
      // Before exit(): a harness may close its own layout host tab there.
      check((await a.uiCount()).overlays === 0 && (await a.removed()).length === closedBefore, `${layout.name}: dismissed without closing tabs`);
    } finally {
      await layout.exit();
    }
  }
}

// Cross-window selection including the origin: origin closes last, no orphan UI.
async function crossWindow({ a, t, f, press, settle, name, urlsOf, missing }) {
  const { check } = a;
  const { cross } = f;
  await a.createWindow('cross-other', [cross.other, cross.keepOther]);
  await a.createWindow('cross-origin', [cross.origin, cross.keepSame, cross.same]);
  await a.focus(cross.origin);
  await a.startRemovals();
  check(await a.open() === 'overlay', 'cross-window: overlay opens over the origin tab');
  await a.type(t.cross);
  let s = await settle(s => s.rows.length === 3);
  const originRow = s.rows.find(r => r.url === cross.origin), otherRow = s.rows.find(r => r.url === cross.other);
  check(sameSet(urlsOf(s), [cross.origin, cross.same, cross.other]) && originRow?.badges.includes('Current') && otherRow?.badges.includes('Other window'),
    'cross-window: results show the origin as Current and the other-window match', s.rows.map(r => [name(r.url), r.badges]));
  await press(['Tab']);
  await press(['m']);
  s = await press(['Control_L', 'a']);
  check(s.checked === 3 && s.close === 'Close 3 tabs', 'cross-window: all three matches checked', { close: s.close });
  for (let i = 0; i < 3; i++) s = await press(['Tab']);
  check(s.focus === 'close-tabs', 'cross-window: Close button focused by Tab (results -> row X -> Done -> Close)', s.focus);
  await a.keys(['Return']);
  await until(async () => (await missing([cross.origin, cross.same, cross.other])).length === 3, 'cross-window closed', 8000).catch(() => {});
  await sleep(1500);
  const order = await a.removed();
  check(sameSet(order, [cross.origin, cross.same, cross.other]) && order.at(-1) === cross.origin, 'cross-window: exactly the checked tabs close, origin last', order.map(name));
  check(!(await missing([cross.keepSame, cross.keepOther])).length && await a.windowAlive('cross-origin') && await a.windowAlive('cross-other'),
    'cross-window: keepalive tab in each window keeps both windows open');
  const orphans = { ...(await a.uiCount()), sessions: await a.sessions() };
  check(orphans.overlays === 0 && orphans.windows === 0 && orphans.sessions === 0, 'cross-window: no orphan palette, search window or session after the origin closes', orphans);
  await a.cleanup([], ['cross-origin', 'cross-other']);
}

// Protected-page fallback window: close selected tabs, then the origin itself.
async function fallback({ a, t, f, state, press, settle, moveTo, toResults, name, titleOf, missing }) {
  const { check } = a;
  const { guarded } = f;
  const protectedTitle = `Protected ${t.guarded} origin`;
  await a.createWindow('protected', [guarded.origin, guarded.keep, guarded.first, guarded.second]);
  await a.focus(guarded.origin);
  await a.startRemovals();
  check(await a.open() === 'window', 'fallback: protected origin opens the separate search window');
  await a.type(t.guarded);
  let s = await settle(s => s.rows.length === 3);
  check(sameSet(s.rows.map(r => r.title), [protectedTitle, titleOf(guarded.first), titleOf(guarded.second)]), 'fallback: lists the protected origin and its matches', s.rows.map(r => r.title));
  s = await press(['Tab']);
  check(s.focus === 'results' && inMode(s, 'tabs'), 'fallback: native Tab opens the tab menu', brief(s));
  s = await press(['m']);
  check(inMode(s, 'select'), 'fallback: M enters select mode', brief(s));
  for (const url of [guarded.first, guarded.second]) {
    await moveTo((await state()).rows.findIndex(r => r.url === url));
    await press(['space'], 150);
  }
  s = await state();
  check(s.status === '2 of 3 selected' && s.close === 'Close 2 tabs', 'fallback: two non-origin matches checked', { status: s.status });
  await a.click('#close-tabs');
  await until(async () => (await missing([guarded.first, guarded.second])).length === 2, 'fallback targets closed', 8000).catch(() => {});
  s = await settle(s => s.rows.length === 1);
  check(sameSet(await a.removed(), [guarded.first, guarded.second]) && (await a.uiCount()).windows === 1 && s.query === t.guarded &&
    s.rows[0]?.title === protectedTitle && inMode(s, 'select'),
  'fallback: Close closes the checked tabs; the search window stays in select mode', { removed: (await a.removed()).map(name), ...brief(s) });
  s = await toResults();
  s = await press(['Control_L', 'a']);
  check(s.checked === 1 && s.close === 'Close 1 tab', 'fallback: Ctrl+A checks the origin', { close: s.close });
  await a.keys(['Delete']);
  await until(async () => !(await a.exists(guarded.origin)), 'fallback origin closed', 8000).catch(() => {});
  await sleep(1500);
  const orphans = { ...(await a.uiCount()), sessions: await a.sessions() };
  const order = await a.removed();
  check(order.at(-1) === guarded.origin && order.length === 3, 'fallback: Delete closes the checked origin tab', order.map(name));
  check(orphans.windows === 0 && orphans.overlays === 0 && orphans.sessions === 0, 'fallback: search window closes with its origin; no orphan', orphans);
  check(await a.exists(guarded.keep) && await a.windowAlive('protected'), 'fallback: keepalive keeps the origin window open');
}
