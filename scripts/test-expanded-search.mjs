// Real-browser History and Page-contents flows for the Search in menu, shared by
// the Firefox and Chromium harnesses. Uses the closing adapter (see
// test-search-closing.mjs) plus `a.expanded`:
//
//   historyHas(url)            the browser's own history has the URL
//   permitted()                permissions.contains for http/https, read from a fresh extension page
//   markOptions(), optionsOpened(), closeOptions()   pages opened by "Enable in Settings"
//   settingsOpen(), settingsClose()                  a Settings tab owned by the test
//   request('allow' | 'deny')  clicks Allow website access, answers the browser's own prompt
//                              -> { state, message, method }
//   revoke()                   clicks Remove website access and confirms -> { state, message, method }
//   discard(url), isDiscarded(url), navigate(url, to)
//   privateWindow(urls, title) opens a real private window on the fixture URLs (first one active,
//                              retitled `title`) -> an adapter with the same ui/keys/type/open/
//                              focus/uiCount/shot members bound to that window, plus close()
//
// History is seeded only by loading fixture pages in the throwaway profile, and
// website access is granted only there, through the browser's own prompt.
import { randomBytes } from 'node:crypto';
import { sleep, until, contentPages, pageTitles, hits } from './test-browser-fixtures.mjs';
import { LAYOUT } from './test-search-closing.mjs';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const newToken = prefix => `${prefix}${[...randomBytes(6)].map(b => LETTERS[b % 26]).join('')}`;
const pathOf = url => new URL(url).pathname;

const STATE = `
  const $ = id => document.getElementById(id);
  const shown = el => Boolean(el) && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const rowOf = row => ({ title: row.querySelector('.title')?.textContent, url: row.querySelector('.url')?.textContent,
    history: row.classList.contains('result-history'), snippet: row.querySelector('.snippet')?.textContent || null,
    closer: row.querySelector('.row-close')?.id || null, box: shown(row.querySelector('.check')),
    checked: row.dataset.checked === 'true', active: row.dataset.active === 'true' });
  const groups = [...document.querySelectorAll('#results > .result-group')].map(g => ({
    role: g.getAttribute('role'),
    heading: [...g.children].filter(c => !c.classList.contains('result') && shown(c)).map(c => c.textContent.trim()).join(' '),
    rows: [...g.querySelectorAll('.result')].map(rowOf) }));
  const box = id => ({ checked: $(id).checked, disabled: $(id).disabled });
  return { focus: document.activeElement?.id || document.activeElement?.localName || null, mode: $('palette').dataset.mode,
    query: $('query').value, groups, rows: groups.flatMap(g => g.rows), menu: shown($('source-menu')),
    expanded: $('search-in').getAttribute('aria-expanded'), history: box('source-history'), content: box('source-content'),
    enable: shown($('enable-content')), accessNote: shown($('content-access-note')), historyNote: shown($('history-private-note')), status: $('source-status').textContent,
    sources: $('palette').dataset.sources, busy: $('results').getAttribute('aria-busy') };`;

// Source controls inside the viewport, and 4.5:1 text contrast using computed styles.
const FIT = `
  const shown = el => Boolean(el) && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const luminance = color => {
    const c = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const bad = [], low = [], checked = new Set();
  for (const el of document.querySelectorAll('#search-in, #source-menu, #source-menu .source-option, #source-menu .source-note, #enable-content')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) bad.push((el.id || el.className) + ': ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
  }
  if (document.documentElement.scrollWidth > innerWidth) bad.push('horizontal overflow');
  const selectors = ['#search-in', '#source-menu .source-option', '#source-menu .source-note', '.source-always', '#enable-content',
    '#source-status', '.snippet', '.result-group .title', '.result-group .url', '.badge', '#result-count', '.hint', 'kbd'];
  for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
    if (!shown(el) || !el.textContent.trim() || el.disabled) continue;
    let surface = el;
    while (surface && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
    if (!surface) continue;
    const a = luminance(getComputedStyle(el).color), b = luminance(getComputedStyle(surface).backgroundColor);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    checked.add(selector);
    if (ratio < 4.5) low.push(selector + ' ' + ratio.toFixed(2));
  }
  return { ok: !bad.length && !low.length, bad, low, checked: [...checked], viewport: [innerWidth, innerHeight] };`;

const brief = s => s && ({ focus: s.focus, mode: s.mode, query: s.query, menu: s.menu, history: s.history, content: s.content,
  enable: s.enable, status: s.status, sources: s.sources,
  groups: s.groups.map(g => ({ heading: g.heading, rows: g.rows.map(r => `${r.history ? 'H ' : ''}${r.url?.replace(/^https?:\/\/[^/]+/, '')}${r.snippet ? ' +snippet' : ''}${r.active ? ' *' : ''}`) })) });

function tools(a) {
  const state = () => a.ui(STATE);
  const press = async (keys, ms = 300) => { await a.keys(keys); await sleep(ms); return state(); };
  async function settle(ok, ms = 8000) {
    let last;
    await until(async () => ok(last = await state()), 'expanded state', ms).catch(() => {});
    return last;
  }
  const visible = async () => { const c = await a.uiCount(); return c.overlays + c.windows; };
  async function open(url = a.originUrl) {
    await a.focus(url);
    const kind = await a.open();
    return { kind, s: await settle(s => s.busy === 'false') };
  }
  async function dismiss() {
    for (let i = 0; i < 5 && await visible(); i++) { await a.keys(['Escape']); await sleep(300); }
    await until(async () => !(await visible()), 'search dismissed', 4000).catch(() => {});
  }
  async function toQuery() {
    let s = await state();
    for (let i = 0; i < 8 && s.focus !== 'query'; i++) s = await press([s.menu ? 'Escape' : 'Tab']);
    return s;
  }
  async function openMenu() {
    let s = await toQuery();
    s = await press(['Shift_L', 'Tab']);
    if (s.focus === 'search-in' && !s.menu) s = await press(['Return']);
    return s;
  }
  // Keyboard only: Search in -> Tab to the checkbox -> Space -> Escape -> Tab back to the query.
  async function setSource(name, on) {
    let s = await state();
    if (!s.menu) s = await openMenu();
    for (let i = 0; i < 6 && s.focus !== `source-${name}`; i++) s = await press(['Tab']);
    if (s.focus === `source-${name}` && s[name].checked !== on) s = await press(['space']);
    await press(['Escape']);
    return toQuery();
  }
  return { state, press, settle, open, dismiss, toQuery, openMenu, setSource, visible };
}

export async function runExpandedSearch(a) {
  const x = a.expanded;
  const ctx = { a, x, check: a.check, ...tools(a), tok: newToken('qu'), needle: newToken('nd'), created: [], methods: {} };
  const video = a.record('expanded-search.mp4');
  try {
    await defaults(ctx);
    await historyFlow(ctx);
    await contentFlow(ctx);
  } finally {
    await video.stop();
    await a.scheme(null).catch(() => {});
    await ctx.dismiss().catch(() => {});
    await a.cleanup(ctx.created, []).catch(error => console.log(`INFO expanded cleanup: ${error.message}`));
    console.log(`INFO expanded permission methods: ${JSON.stringify(ctx.methods)}`);
    console.log('SKIP expanded: permission persistence across a browser restart (checked from a fresh extension page only)');
  }
}

async function defaults({ a, x, check, state, press, open, dismiss, toQuery }) {
  const { kind, s } = await open();
  check(kind === 'overlay', 'defaults: shortcut opens the overlay', kind);
  check(!s.history.checked && !s.content.checked && !s.menu && s.expanded === 'false' && s.sources === 'tabs',
    'defaults: fresh launch has History and Contents off and the menu closed', brief(s));
  check(s.rows.length > 0 && s.rows.every(r => !r.history && !r.snippet) && !s.status, 'defaults: initial list is open tabs only', brief(s));
  let t = await press(['Shift_L', 'Tab']);
  check(t.focus === 'search-in' && !t.menu && t.mode === 'search', 'defaults: Shift+Tab from the query reaches Search in', brief(t));
  t = await press(['Return']);
  check(t.menu && t.expanded === 'true' && t.focus === 'search-in', 'defaults: Enter on Search in opens the source menu', brief(t));
  const granted = await x.permitted();
  check(!granted && t.content.disabled && t.accessNote && t.enable && !t.history.disabled,
    'defaults: without website access Contents is disabled with a Settings link; History is available', brief(t));
  const order = [];
  for (let i = 0; i < 4; i++) order.push((await press(['Tab'])).focus);
  check(JSON.stringify(order) === JSON.stringify(['source-history', 'enable-content', 'search-in', 'source-history']),
    'defaults: Tab cycles the available menu controls and the trigger', order);
  t = await press(['space']);
  check(t.history.checked && t.focus === 'source-history', 'defaults: Space checks History from the keyboard', brief(t));
  t = await press(['space']);
  check(!t.history.checked, 'defaults: Space unchecks History again', brief(t));
  t = await press(['Escape']);
  check(!t.menu && t.focus === 'search-in' && t.mode === 'search' && await x.permitted() === false && (await a.uiCount()).overlays === 1,
    'defaults: Escape closes only the menu and returns focus to Search in', brief(t));
  // From the tab menu: Escape closes the menu before stepping back a mode.
  await toQuery();
  t = await press(['Tab']);
  for (let i = 0; i < 4 && t.focus !== 'search-in'; i++) t = await press(['Tab']);
  const before = t.mode;
  t = await press(['Return']);
  t = await press(['Escape']);
  check(before === 'tabs' && !t.menu && t.mode === 'tabs' && t.focus === 'search-in', 'defaults: in the tab menu, Escape closes the source menu first', brief(t));
  t = await press(['Escape']);
  check(t.mode === 'search' && t.focus === 'query' && (await a.uiCount()).overlays === 1, 'defaults: next Escape steps back to search, still open', brief(t));
  await dismiss();
  check((await a.uiCount()).overlays + (await a.uiCount()).windows === 0, 'defaults: search dismissed');
}

async function historyFlow(ctx) {
  const { a, x, check, press, settle, open, dismiss, setSource, tok } = ctx;
  const { base, originUrl } = a;
  const u = { alpha: `${base}/archive/quasar-${tok}-alpha`, open: `${base}/archive/quasar-${tok}-open`, titled: `${base}/archive/plain-${newToken('pt')}` };
  u.query = `${u.alpha}?v=2`;
  u.hash = `${u.alpha}#part`;
  pageTitles.set(pathOf(u.titled), `Archive quasar ${tok} titled`);
  // Real visits: load each page in a fresh background tab, then close it.
  // u.open is visited and closed like the others, then reopened, so it is in
  // history and open at once. Firefox's history flooding prevention
  // (places.history.floodingPrevention.*) drops visits that follow several
  // others with no user input, so each visit follows a real native key press
  // (an arrow key: modifier-only presses are not user interaction).
  for (const url of [u.alpha, u.alpha, u.query, u.hash, u.titled, u.open]) {
    await a.keys(['Right']);
    await a.addTab('origin', url);
    await a.cleanup([url], []);
  }
  await a.addTab('origin', u.open);
  ctx.created.push(u.open, u.alpha);
  const seedUrls = [u.alpha, u.query, u.hash, u.titled, u.open];
  let seedState;
  const seeded = await until(async () => (seedState = await Promise.all(seedUrls.map(async url => ({ url, seen: await x.historyHas(url) })))).every(item => item.seen), 'history seeded', 8000).catch(() => false);
  check(seeded, 'history: fixture visits recorded in the throwaway profile history', seedState);

  await open();
  await a.type(tok);
  let s = await settle(s => s.rows.length === 1 && s.query === tok, 4000);
  check(s.rows.length === 1 && s.rows[0].url === u.open && !s.rows[0].history, 'history: off by default, only the open tab matches', brief(s));
  await setSource('history', true);
  s = await settle(s => s.rows.filter(r => r.history).length >= 4);
  const hist = s.rows.filter(r => r.history);
  check(s.history.checked && s.query === tok, 'history: enabling History keeps the query', brief(s));
  check(s.groups.length === 2 && s.groups[0].rows.every(r => !r.history) && s.groups[1].rows.every(r => r.history) &&
    /History/.test(s.groups[1].heading) && s.groups.every(g => g.role === 'rowgroup'), 'history: open tabs group first, History group below', brief(s));
  check(hist.filter(r => r.url === u.alpha).length === 1, 'history: a repeat visit is one row', brief(s));
  check(hist.some(r => r.url === u.query), 'history: a query-parameter variant is its own row', brief(s));
  check(hist.some(r => r.url === u.hash), 'history: a hash variant is its own row', brief(s));
  check(!hist.some(r => r.url === u.open) && s.groups[0].rows.some(r => r.url === u.open), 'history: an open URL shows only as the tab', brief(s));
  check(hist.some(r => r.url === u.titled && r.title === `Archive quasar ${tok} titled`), 'history: title-only match from the visited page title', brief(s));
  check(hist.every(r => !r.closer && !r.box), 'history: history rows have no X and no checkbox', brief(s));

  // Tab menu: X/Delete on a history row does nothing.
  await a.startRemovals();
  s = await press(['Tab']);
  for (let i = 0; i < 12 && !s.rows.find(r => r.active)?.history; i++) s = await press(['Down'], 150);
  const target = s.rows.find(r => r.active);
  const count = s.rows.length;
  s = await press(['x'], 500);
  s = await press(['Delete'], 500);
  check(target?.history && s.rows.length === count && s.rows.find(r => r.active)?.url === target.url && (await a.removed()).length === 0 &&
    await x.historyHas(target.url), 'history: X and Delete on a history row close nothing and keep history', { target, rows: s.rows.length, count });
  s = await press(['m']);
  const tabsListed = s.rows.filter(r => !r.history).length;
  s = await press(['a']);
  check(s.mode === 'select' && s.rows.filter(r => r.history).every(r => !r.box && !r.checked) &&
    s.rows.filter(r => r.checked).length === tabsListed, 'history: select mode checks only open tabs', brief(s));
  await press(['Escape']);
  s = await press(['Escape']);

  // Enter on a history row opens it in a new tab; the origin tab is unchanged.
  for (let i = 0; i < 12 && s.rows.find(r => r.active)?.url !== u.alpha; i++) s = await press(['Down'], 150);
  const tabsBefore = await a.tabCount();
  await a.keys(['Return']);
  const opened = await until(async () => (await a.activeUrl()) === u.alpha, 'history page opened', 8000).catch(() => false);
  check(opened && await a.exists(originUrl) && await a.tabCount() === tabsBefore + 1 && !(await ctx.visible()),
    'history: Enter opens the history page in a new tab and closes search; origin tab kept', { active: await a.activeUrl(), tabsBefore, after: await a.tabCount() });

  ({ s } = await open());
  check(!s.history.checked && !s.content.checked && s.query === '' && s.rows.every(r => !r.history), 'history: extras reset on reopen', brief(s));
  await dismiss();
}

async function contentFlow(ctx) {
  const { a, x, check, press, settle, open, dismiss, setSource, openMenu, needle } = ctx;
  const { base, originUrl } = a;
  const kinds = ['main', 'main2', 'titled', 'field', 'hidden', 'editable', 'script', 'iframe', 'shadow', 'sleeping'];
  const url = {};
  for (const name of kinds) {
    url[name] = `${base}/content/${name === 'main2' ? 'main' : name}/${newToken('cp')}`;
    contentPages.set(pathOf(url[name]), { kind: name === 'main2' ? 'main' : name, needle });
  }

  // (1) Before access: the Settings link opens the options page.
  let { s } = await open();
  s = await openMenu();
  check(s.menu && s.content.disabled && s.accessNote && s.enable, 'contents: no access -> Contents disabled with Enable in Settings', brief(s));
  await x.markOptions();
  for (let i = 0; i < 4 && s.focus !== 'enable-content'; i++) s = await press(['Tab']);
  await a.keys(['Return']);
  const shownSettings = await until(() => x.optionsOpened(), 'settings opened', 6000).catch(() => false);
  check(s.focus === 'enable-content' && shownSettings, 'contents: Enable in Settings opens the options page', brief(s));
  check(!(await x.permitted()), 'contents: opening Settings grants nothing');
  await x.closeOptions();
  await a.focus(originUrl);
  await ctx.dismiss().catch(() => {});

  // (2) The browser's own prompt: deny, then allow.
  await x.settingsOpen();
  const denied = await x.request('deny');
  ctx.methods.deny = denied.method;
  check(denied.message === 'Website access was not allowed.' && denied.state === 'Not allowed' && !(await x.permitted()),
    'permissions: denying the browser prompt leaves access off', denied);
  const allowed = await x.request('allow');
  ctx.methods.allow = allowed.method;
  check(allowed.state === 'Allowed' && /^Website access allowed/.test(allowed.message), 'permissions: allowing the browser prompt grants access', allowed);
  await x.settingsClose();
  check(await x.permitted(), 'permissions: grant visible to a fresh extension page (browser permission store)');

  // (3) Content tabs, loaded in the background; one is put to sleep.
  for (const name of kinds) await a.addTab('origin', url[name]);
  ctx.created.push(...Object.values(url));
  await x.discard(url.sleeping);
  check(await x.isDiscarded(url.sleeping), 'contents: sleeping fixture tab is discarded');
  const hitsBefore = kinds.map(name => hits.get(pathOf(url[name])) || 0);

  ({ s } = await open());
  s = await openMenu();
  check(!s.content.disabled && !s.accessNote && !s.enable && !s.content.checked, 'contents: with access Contents is available, still off, no Settings link', brief(s));
  await setSource('content', true);
  await a.type(needle);
  const first = await ctx.state();
  s = await settle(s => s.rows.some(r => r.url === url.main && r.snippet) && s.rows.some(r => r.url === url.main2));
  const urls = s.rows.map(r => r.url);
  check(first.rows.length >= 1 && first.rows[0].url === url.titled, 'contents: title match shows immediately', brief(first));
  check([url.titled, url.main, url.main2].every(u => urls.includes(u)) && urls.length === 3,
    'contents: only main-frame rendered text matches (not fields, hidden, editable, script, iframe, shadow, sleeping)', brief(s));
  check(s.rows.find(r => r.url === url.main)?.snippet?.includes(needle), 'contents: content-only row shows a snippet with the match', brief(s));
  check(s.rows.find(r => r.active)?.url === first.rows.find(r => r.active)?.url, 'contents: highlight stays put when content results arrive', brief(s));
  check(/Contents: \d+ of \d+ tabs? searched/.test(s.status) && /skipped/.test(s.status), 'contents: coverage reports skipped tabs honestly', s.status);
  const hitsAfter = kinds.map(name => hits.get(pathOf(url[name])) || 0);
  check(JSON.stringify(hitsBefore) === JSON.stringify(hitsAfter) && await x.isDiscarded(url.sleeping) && await a.activeUrl() === originUrl,
    'contents: read-only scan: no page re-fetched, sleeping tab never loaded or activated', { hitsBefore, hitsAfter });

  await setSource('history', true);
  s = await settle(s => s.history.checked && s.busy === 'false' && s.rows.some(r => r.url === url.main));
  check(s.rows.filter(r => r.url === url.titled).length === 1 && s.rows.filter(r => r.url === url.main).length === 1 && !s.rows.some(r => r.history && urls.includes(r.url)),
    'contents+history: a tab matching by title and body is listed once', brief(s));
  await a.scheme('light');
  await a.shot('expanded-both-sources-light', 'History + Contents on: content snippet row, wide, light');
  let fit = await a.ui(FIT);
  check(fit.ok, 'layout: wide results with both sources fit and meet 4.5:1', fit);
  for (const scheme of ['light', 'dark']) {
    await a.scheme(scheme);
    s = await openMenu();
    await sleep(300);
    await a.shot(`expanded-source-menu-${scheme}`, `Search in menu open, both sources on, ${scheme}`);
    fit = await a.ui(FIT);
    check(s.menu && fit.ok, `layout: source menu fits and meets 4.5:1 (${scheme})`, fit);
    await press(['Escape']);
    await ctx.toQuery();
  }
  await a.scheme(null);

  // (4) Turning Contents off drops content rows without touching the query.
  await setSource('content', false);
  s = await settle(s => !s.rows.some(r => r.url === url.main));
  check(s.query === needle && !s.rows.some(r => r.snippet) && s.rows.some(r => r.url === url.titled), 'contents: turning Contents off clears content rows, query kept', brief(s));
  // A slow source query never blocks Escape.
  await setSource('content', true);
  await a.type(`${needle} slow`);
  await a.keys(['Escape']);
  const gone = await until(async () => !(await ctx.visible()), 'escape during query', 1500).catch(() => false);
  check(gone, 'contents: Escape closes search while a source query is in flight');
  await dismiss();

  // (6) Narrow and low layouts with both sources and the menu.
  for (const layout of a.layouts) {
    await layout.enter();
    try {
      await a.open();
      await settle(s => s.busy === 'false');
      await setSource('history', true);
      await setSource('content', true);
      await a.type(needle);
      await settle(s => s.rows.some(r => r.snippet));
      const footer = await a.ui(LAYOUT);
      fit = await a.ui(FIT);
      check(footer.ok && fit.ok, `layout: ${layout.name} results, footer captions and sources fit with contrast`, { footer, fit });
      if (layout.shot) await a.shot(`expanded-${layout.shot}`, `${layout.name}: both sources with snippet`);
      s = await openMenu();
      fit = await a.ui(FIT);
      check(s.menu && fit.ok, `layout: ${layout.name} source menu fits`, fit);
      if (layout.shot) await a.shot(`expanded-${layout.shot}-menu`, `${layout.name}: source menu open`);
      await dismiss();
    } finally {
      await layout.exit();
    }
  }

  // (5) Navigating a tab away drops its content result.
  await open();
  await setSource('content', true);
  await a.type(needle);
  s = await settle(s => s.rows.some(r => r.url === url.main));
  const moved = `${base}/content/plain/${newToken('pl')}`;
  await x.navigate(url.main, moved);
  ctx.created.push(moved);
  await a.focus(originUrl).catch(() => {});
  s = await settle(s => !s.rows.some(r => r.url === url.main || r.url === moved) && s.rows.some(r => r.url === url.main2), 6000);
  check(s && !s.rows.some(r => r.snippet && r.url === moved) && !s.rows.some(r => r.url === url.main), 'contents: navigating a tab away drops its stale snippet', brief(s));
  await dismiss();

  await privateFlow(ctx);

  // Revoke in Settings; reopened search no longer offers or shows contents.
  await x.settingsOpen();
  const revoked = await x.revoke();
  ctx.methods.revoke = revoked.method;
  await x.settingsClose();
  check(revoked.state === 'Not allowed' && !(await x.permitted()), 'permissions: Remove website access revokes the grant', revoked);
  ({ s } = await open());
  s = await openMenu();
  check(s.content.disabled && !s.content.checked && s.enable, 'permissions: after revoke Contents is disabled with the Settings link again', brief(s));
  await press(['Escape']);
  await ctx.toQuery();
  await a.type(needle);
  s = await settle(s => s.rows.length >= 1);
  check(s.rows.every(r => !r.snippet) && !s.rows.some(r => r.url === url.main2), 'permissions: after revoke no content snippets remain', brief(s));
  await dismiss();
}

// Private window, while website access is granted: the palette there never reads
// normal history or normal tabs, Contents reads only the private page, and nothing
// from the private window reaches a later normal search.
async function privateFlow(ctx) {
  const { a, x, check, needle, tok } = ctx;
  const privNeedle = newToken('pn');
  const title = `Private sentinel ${newToken('ps')}`;
  const privContent = `${a.base}/content/main/${newToken('cp')}`;
  // Same title words as the normal History fixtures, visited only privately.
  const privVisit = `${a.base}/archive/quasar-${tok}-private`;
  contentPages.set(pathOf(privContent), { kind: 'main', needle: privNeedle });
  const p = await x.privateWindow([privContent, privVisit], title);
  const t = tools(p);
  try {
    const { kind, s: first } = await t.open(privContent);
    check(kind === 'overlay' && first.rows.length === 2 && first.rows.every(r => [privContent, privVisit].includes(r.url)),
      'private: shortcut over a private page opens the overlay listing only private tabs', { kind, state: brief(first) });
    let s = await t.openMenu();
    check(s.menu && s.history.disabled && !s.history.checked && s.historyNote && !s.content.disabled && !s.accessNote && !s.enable,
      'private: History is disabled with its note; Contents is available with website access', brief(s));
    const order = [];
    for (let i = 0; i < 3; i++) order.push((await t.press(['Tab'])).focus);
    check(!order.includes('source-history') && order.includes('source-content'), 'private: Tab skips the disabled History checkbox', order);
    await t.press(['Escape']);
    await t.setSource('history', true);
    await p.type(tok);
    await t.settle(s => s.query === tok && s.busy === 'false', 4000);
    await sleep(1000);
    s = await t.state();
    check(!s.history.checked && s.rows.length === 1 && s.rows[0].url === privVisit && !s.rows.some(r => r.history),
      'private: History stays off; words matching normal visits show only the private tab', brief(s));

    await t.setSource('content', true);
    const fetched = hits.get(pathOf(privContent)) || 0;
    await p.type(privNeedle);
    s = await t.settle(s => s.rows.some(r => r.url === privContent && r.snippet));
    check(s.content.checked && s.rows.length === 1 && s.rows[0].url === privContent && !s.rows[0].history && s.rows[0].snippet?.includes(privNeedle),
      'private: Contents finds the private page body, with a snippet', brief(s));
    console.log(`INFO private contents status: ${s.status}`);
    await p.shot('expanded-private-contents', 'private window: Contents on, body-only match with snippet, History disabled');
    await p.type(needle);
    await t.settle(s => s.query === needle && s.busy === 'false', 4000);
    await sleep(1500);
    s = await t.state();
    check(s.rows.length === 0, 'private: text from normal-window pages never appears', brief(s));
    check((hits.get(pathOf(privContent)) || 0) === fetched, 'private: the scan read the loaded page without re-fetching it', { fetched, now: hits.get(pathOf(privContent)) });
    await t.dismiss();
  } finally {
    await p.close();
  }

  check(!(await x.historyHas(privContent)) && !(await x.historyHas(privVisit)), 'private: private visits are not in browser history');
  await ctx.open();
  await ctx.setSource('history', true);
  await ctx.setSource('content', true);
  await a.type(privNeedle);
  await ctx.settle(s => s.query === privNeedle && s.busy === 'false', 4000);
  await sleep(1500);
  let s = await ctx.state();
  check(s.history.checked && s.content.checked && s.rows.length === 0, 'private closed: normal search with History and Contents finds nothing private', brief(s));
  await a.type(tok);
  s = await ctx.settle(s => s.rows.some(r => r.history));
  check(s.rows.some(r => r.history) && !s.rows.some(r => r.url === privVisit || r.url === privContent),
    'private closed: normal History lists only normal visits', brief(s));
  await ctx.dismiss();
}
