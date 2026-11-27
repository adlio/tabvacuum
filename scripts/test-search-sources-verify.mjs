// Independent verification of Search sources (PR #25, issue #24): harder cases
// than test-search-sources.mjs. Run with either harness and --verify-only:
//
//   node scripts/test-firefox.mjs --verify-only
//   node scripts/test-chromium.mjs --verify-only
//
// Extra adapter hooks (added beside closing.sources in each harness):
//   y.browserName                'firefox' | 'chromium'
//   y.ext(src, arg)              runs `(src)(browserNamespace, arg)` in an extension page
//   y.tabsInfo()                 [{ url, private, selected, userContextId? }]
//   y.containerTab(url, id)      Firefox only: a background tab in container `id`
//   y.chromeFocus()              Firefox only: what the browser window focused
//
// Each scenario is isolated: a thrown error records one FAIL and the run goes on.
// Every bookmark, history entry and setting lives in the throwaway profile.
import { sleep, until } from './test-browser-fixtures.mjs';
import { tools, brief, token } from './test-search-sources.mjs';

const TIMES = {};
const info = (label, value) => console.log(`INFO verify ${label}: ${JSON.stringify(value)}`);

export async function runVerifySearch(a) {
  const y = a.sources;
  const ctx = { a, y, check: a.check, ...tools(a), created: [], seeded: [], windows: [] };
  const scenarios = [
    freshInstall, largeTree, liveChanges, failureThenToggle, scopeEdges, countsFlow, tabsOff, a11yFlow, tipsFlow,
    defaultsFlow, allNeedsPermission, revokeThenUse, fallbackDeny, dupesExemption, containersFlow,
    privateFlow, shortcutFlow,
  ];
  const only = process.env.VERIFY_ONLY?.split(',');
  for (const scenario of scenarios) {
    if (only && !only.includes(scenario.name)) continue;
    console.log(`INFO verify: --- ${scenario.name} ---`);
    try { await scenario(ctx); } catch (error) {
      ctx.check(false, `${scenario.name}: scenario stopped`, error.stack?.split('\n').slice(0, 3).join(' | '));
    } finally {
      await ctx.dismiss().catch(() => {});
      await a.focus(a.originUrl).catch(() => {});
    }
  }
  for (const id of ctx.seeded) await y.unseed(id).catch(() => {});
  await a.cleanup(ctx.created, ctx.windows).catch(() => {});
  info('timings', TIMES);
}

const grant = async y => { if (!(await y.permitted())) await y.settings('grant'); return y.permitted(); };
const storage = (y, values) => y.ext(`async (api, v) => { await api.storage.local.set(v); return true; }`, values);
const stored = (y, keys) => y.ext(`async (api, k) => api.storage.local.get(k)`, keys);
const bm = (y, op, arg) => y.ext(`async (api, { op, arg }) => {
  const find = async url => (await api.bookmarks.search({ url }))[0];
  if (op === 'create') return (await api.bookmarks.create(arg)).id;
  if (op === 'folder') return (await api.bookmarks.create({ title: arg.title })).id;
  if (op === 'rename') { const n = await find(arg.url); await api.bookmarks.update(n.id, { title: arg.title }); return n.id; }
  if (op === 'move') { const n = await find(arg.url); await api.bookmarks.move(n.id, { parentId: arg.parentId }); return n.id; }
  if (op === 'remove') { const n = await find(arg.url); await api.bookmarks.remove(n.id); return n.id; }
  if (op === 'removeTree') { await api.bookmarks.removeTree(arg.id); return true; }
}`, { op, arg });

// In-frame timing: last input event to the last change of the result list.
const ARM = `
  const q = document.getElementById('query'), list = document.getElementById('results');
  window.__tv = { input: 0, done: 0 };
  if (!window.__tvArmed) {
    window.__tvArmed = true;
    q.addEventListener('input', () => { window.__tv.input = performance.now(); window.__tv.done = 0; });
    new MutationObserver(() => { if (window.__tv.input) window.__tv.done = performance.now(); })
      .observe(list, { childList: true, subtree: true, characterData: true });
  }
  return true;`;
const READ = 'return window.__tv && window.__tv.done ? Math.round(window.__tv.done - window.__tv.input) : null;';

// --- 0. Fresh install: no "New" mark, Tabs-only default --------------------------
async function freshInstall({ a, check, open }) {
  const { s } = await open();
  check(s && !s.newMark && s.tabs.on && !s.bookmarks.on && !s.history.on,
    'fresh install: no "New" mark on Bookmarks and Tabs is the only source on', brief(s));
  check(s?.placeholder === 'Search tabs · type @ for more', 'fresh install: placeholder hints at @', s?.placeholder);
}

// --- 1. 10,000+ bookmarks: launch, keystroke latency and ranking -------------------
async function largeTree(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, typeKeys } = ctx;
  await grant(y);
  const tk = token('lg');
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  const items = Array.from({ length: 10_000 }, (_, i) => ({ title: `Kestrel ${tk} ${i} ${words[i % 4]}`, url: `https://large.example/${tk}/${i}` }));
  items.push({ title: `Zygomorphic orchid ${tk} target`, url: `https://large.example/${tk}/target` });
  // Spread across 20 folders so paths are non-trivial.
  const folders = Array.from({ length: 20 }, (_, f) => ({ folder: `Large ${f}`, children: items.filter((_, i) => i % 20 === f) }));
  let started = Date.now();
  ctx.seeded.push(await y.seed(folders));
  TIMES.seed10k = Date.now() - started;
  // Cold launch: the bookmark change dropped the index; getContext rebuilds it.
  await a.focus(a.originUrl);
  started = Date.now();
  let { s } = await open();
  TIMES.coldOpenMs = Date.now() - started;
  await dismiss();
  started = Date.now();
  ({ s } = await open());
  TIMES.warmOpenMs = Date.now() - started;
  info('open with 10,001 bookmarks (wall clock incl. shortcut)', { cold: TIMES.coldOpenMs, warm: TIMES.warmOpenMs });
  check(TIMES.coldOpenMs < 4000, 'large tree: Search opens in under 4 s right after a bookmark change (cold index)', TIMES.coldOpenMs);
  s = await setSource('bookmarks', true);
  await a.ui(ARM);
  // Typo in "zygomorphic": the fuzzy tab rules should still rank the target first.
  await typeKeys(`zygomorphc ${tk}`);
  s = await settle(st => st.busy === 'false' && st.rows.some(r => r.kind === 'bookmark'), 8000);
  const typoLatency = await a.ui(READ);
  check(s?.rows.find(r => r.kind === 'bookmark')?.url === `https://large.example/${tk}/target`,
    'large tree: a typo query ranks the one matching bookmark first among 10,001', brief(s)?.rows.slice(0, 3));
  // A broad query matching all 10,000: capped at 50 rows.
  await typeKeys(`kestrel ${tk}`);
  s = await settle(st => st.busy === 'false' && st.rows.filter(r => r.kind === 'bookmark').length >= 50, 8000);
  const broad = s?.rows.filter(r => r.kind === 'bookmark').length;
  check(broad === 50, 'large tree: a query matching 10,000 bookmarks lists 50', broad);
  // Per-keystroke latency: one native key each, measured in the frame.
  const lat = [];
  for (const key of ['space', '9', '9', '9', 'BackSpace', 'BackSpace']) {
    await a.ui(ARM.replace("window.__tv = { input: 0, done: 0 };", "window.__tv = { input: 0, done: 0 };"));
    await a.keys([key]);
    await sleep(1500);
    lat.push(await a.ui(READ));
  }
  s = await ctx.state();
  info('keystroke to final list update, 10,001 bookmarks (ms, includes the 250 ms source debounce)', { typo: typoLatency, perKey: lat });
  TIMES.keyLatency = lat;
  const worst = Math.max(...lat.filter(n => n !== null));
  check(lat.every(n => n !== null) && worst < 1000, 'large tree: each keystroke settles the list within 1 s (250 ms debounce included)', lat);
  // Pure ranking cost in the page's own JS engine, synthetic 10,000-entry index.
  const pure = await a.ui(`return (async () => {
    const core = await import(new URL('search-sources-core.js', location.href).href);
    const index = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), title: 'Kestrel ' + i + ' alpha', url: 'https://x.example/' + i, path: 'A › B', folders: 0, dateAdded: i }));
    const out = {};
    for (const q of ['k', 'kestrel', 'kestrel 99', 'zzqx', 'kestrl alpa']) { const t = performance.now(); core.searchBookmarkIndex(index, q); out[q] = Math.round(performance.now() - t); }
    return out; })();`);
  info('searchBookmarkIndex on 10,000 entries in the Search page (ms per query)', pure);
  TIMES.pureRank = pure;
  await dismiss();
}

// --- 2. Bookmarks added, renamed, moved, deleted while Search is open --------------
async function liveChanges(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, typeKeys, press } = ctx;
  await grant(y);
  const tk = token('lv');
  const url = slug => `${a.base}/disposable/${tk}-${slug}`;
  ctx.seeded.push(await y.seed([{ title: `Heron ${tk} one`, url: url('one') }, { title: `Heron ${tk} two`, url: url('two') }]));
  let { s } = await open();
  await setSource('bookmarks', true);
  await typeKeys(`heron ${tk}`);
  s = await settle(st => st.rows.filter(r => r.kind === 'bookmark').length === 2);
  check(s.rows.filter(r => r.kind === 'bookmark').length === 2, 'live: two seeded bookmarks listed', brief(s));
  // Added while open.
  const added = await bm(y, 'create', { title: `Heron ${tk} added`, url: url('added') });
  ctx.seeded.push(added);
  await sleep(800);
  s = await ctx.state();
  const liveWithoutTyping = s.rows.some(r => r.url === url('added'));
  info('list updates by itself after a bookmark is added (no keystroke)', liveWithoutTyping);
  await typeKeys(`heron ${tk}`);
  s = await settle(st => st.rows.some(r => r.url === url('added')));
  check(s.rows.some(r => r.url === url('added')), 'live: a bookmark added while Search is open is found by the next keystroke', brief(s));
  // Renamed.
  await bm(y, 'rename', { url: url('two'), title: `Egret ${tk} renamed` });
  await typeKeys(`egret ${tk}`);
  s = await settle(st => st.rows.some(r => r.url === url('two')));
  check(s.rows.some(r => r.url === url('two') && /Egret/.test(r.title)), 'live: a renamed bookmark is found by its new title', brief(s));
  await typeKeys(`heron ${tk} two`);
  s = await settle(st => st.busy === 'false' && !st.rows.some(r => r.url === url('two')), 4000);
  check(!s.rows.some(r => r.url === url('two')), 'live: the old title no longer finds it', brief(s));
  // Moved to a new folder.
  const folder = await bm(y, 'folder', { title: `Moved ${tk}` });
  ctx.seeded.push(folder);
  await bm(y, 'move', { url: url('one'), parentId: folder });
  await typeKeys(`heron ${tk} one`);
  s = await settle(st => (st.rows.find(r => r.url === url('one'))?.path ?? '').includes(`Moved ${tk}`));
  check((s.rows.find(r => r.url === url('one'))?.path ?? '').includes(`Moved ${tk}`), 'live: a moved bookmark shows its new folder path', brief(s));
  // Deleted after it was listed, then chosen: nothing opens.
  await typeKeys(`heron ${tk} added`);
  s = await settle(st => st.rows.some(r => r.url === url('added')));
  for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== url('added'); i++) s = await press(['Down'], 150);
  await bm(y, 'remove', { url: url('added') });
  const before = await a.tabCount();
  await a.keys(['Return']);
  await sleep(1500);
  s = await ctx.state().catch(() => null);
  const after = await a.tabCount();
  check(after === before && Boolean(s), 'live: Enter on a bookmark deleted after listing opens nothing and Search stays open', { before, after });
  check(s?.message === 'That bookmark is no longer available. Choose another result.', 'live: ...and Search says the bookmark is no longer available', { message: s?.message });
  info('message after Enter on a deleted bookmark (service says "That bookmark is no longer available.")', s?.message);
  await typeKeys(`heron ${tk}`);
  s = await settle(st => st.busy === 'false' && st.rows.length >= 1);
  check(!s.rows.some(r => r.url === url('added')), 'live: a deleted bookmark is gone on the next keystroke', brief(s));
  // ★ for a page bookmarked while Search is open.
  await a.addTab('origin', url('starlater'));
  ctx.created.push(url('starlater'));
  await dismiss();
  ({ s } = await open());
  await typeKeys(`starlater`);
  ctx.seeded.push(await bm(y, 'create', { title: 'Star later', url: url('starlater') }));
  await sleep(500);
  await typeKeys(`${tk} starlater`);
  s = await settle(st => st.busy === 'false', 3000);
  info('★ appears on an open tab bookmarked while Search is open (without relaunch)', s.rows.find(r => r.url === url('starlater'))?.star ?? null);
  await dismiss();
  ({ s } = await open());
  await typeKeys(`${tk} starlater`);
  s = await settle(st => st.rows.some(r => r.url === url('starlater')));
  check(s.rows.find(r => r.url === url('starlater'))?.star === true, 'live: ★ shows on the next launch after bookmarking an open tab', brief(s));
  await dismiss();
}

// --- 3. Scope-word edge cases --------------------------------------------------------
// N1: the deleted-bookmark message clears on a source action, the Include offer
// then shows, and Enter presses it only once it is visible.
async function failureThenToggle(ctx) {
  const { a, y, check, open, setSource, settle, typeKeys, press } = ctx;
  await grant(y);
  const tk = token('gn');
  const url = slug => `${a.base}/disposable/${tk}-${slug}`;
  ctx.seeded.push(await y.seed(['one', 'two', 'three'].map(n => ({ title: `Gone ${tk} ${n}`, url: url(n) }))));
  let { s } = await open();
  await setSource('bookmarks', true);
  await typeKeys(`gone ${tk}`);
  s = await settle(st => st.rows.filter(r => r.kind === 'bookmark').length === 3);
  for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== url('two'); i++) s = await press(['Down'], 150);
  await bm(y, 'remove', { url: url('two') });
  await a.keys(['Return']);
  await sleep(1200);
  s = await ctx.state();
  check(s.message === 'That bookmark is no longer available. Choose another result.', 'N1: Enter on the deleted bookmark explains why', { message: s.message });
  s = await setSource('bookmarks', false);
  s = await settle(st => st.include, 6000);
  // "one" and "three" remain.
  check(s.message === 'No open tabs match. 2 bookmarks do.' && s.include && s.rows.length === 0 && s.bookmarks.count === '2',
    'N1: turning Bookmarks off clears the old message and shows the Include offer', { message: s.message, include: s.include, count: s.bookmarks.count, rows: s.rows.length });
  await a.keys(['Return']);
  s = await settle(st => st.bookmarks.on && st.rows.some(r => r.url === url('three')), 6000);
  check(s.bookmarks.on && s.rows.some(r => r.url === url('three')) && !/no longer available/.test(s.message),
    'N1: Enter then presses the visible offer, and the old message stays gone', brief(s));
}

async function scopeEdges(ctx) {
  const { a, check, open, dismiss, press, typeKeys, state } = ctx;
  await grant(a.sources);
  let { s } = await open();
  // Real X key presses, one character at a time, into an emptied query.
  const KEYSYM = { '@': ['Shift_L', 'at'], '.': ['period'], '/': ['slash'], ' ': ['space'], '-': ['minus'] };
  const typeNative = async text => {
    await ctx.toQuery();
    await a.type('');
    for (const ch of text) await a.keys(KEYSYM[ch] ?? (/[A-Z]/.test(ch) ? ['Shift_L', ch.toLowerCase()] : [ch]));
    await sleep(300);
    return state();
  };
  const literal = async (text, label) => {
    s = await typeNative(text);
    check(!s.chip && s.tabs.on && !s.bookmarks.on && s.query === text, `scope: ${label} stays text`, brief(s));
  };
  await literal('foo @b ', '"foo @b " (word not at the start)');
  await literal('a@b ', '"a@b " (inside an email-like word)');
  await literal('me@bookmarks.com ', '"me@bookmarks.com " (an email address)');
  await literal('@types ', '"@types "');
  await literal('@angular/core ', '"@angular/core "');
  await literal('@bo ', '"@bo " (an unknown prefix)');
  s = await typeNative('@BOOKMARKS ');
  check(s.chip === 'Only bookmarks', 'scope: "@BOOKMARKS " (upper case) converts', brief(s));
  await press(['BackSpace']);
  await a.type('');
  s = await press(['BackSpace']);
  // Caret not at the end: "@b " typed before existing text.
  s = await typeKeys('foo');
  await press(['Home']);
  for (const k of [['Shift_L', 'at'], ['b'], ['space']]) await a.keys(k);
  await sleep(300);
  s = await state();
  check(!s.chip && s.query === '@b foo', 'scope: "@b " typed in front of existing text (caret not at the end) stays text', brief(s));
  // Backspace after conversion restores; deleting the space and typing it again must not re-convert.
  s = await typeKeys('@h ');
  check(s.chip === 'Only history', 'scope: "@h " converts', brief(s));
  s = await press(['BackSpace']);
  check(!s.chip && s.query === '@h ', 'scope: Backspace right after converting restores "@h "', brief(s));
  s = await press(['BackSpace']);
  s = await press(['space']);
  check(!s.chip && s.query === '@h ', 'scope: after a restore, retyping the space does not convert again', brief(s));
  // Backspace after typing text into a chip edits text, not the chip.
  s = await typeKeys('@t ');
  await a.keys(['x']);
  await sleep(200);
  s = await press(['BackSpace']);
  check(s.chip === 'Only open tabs' && s.query === '', 'scope: Backspace deletes typed text first and keeps the chip', brief(s));
  s = await press(['BackSpace']);
  check(!s.chip && s.query === '' && s.tabs.on, 'scope: the next Backspace (not right after conversion) removes the chip, no text restored', brief(s));
  // Paste never converts; a pasted word followed by a typed space.
  await ctx.toQuery();
  await a.type('');
  await a.paste('@all ');
  s = await state();
  check(!s.chip && !s.history.on, 'scope: pasting "@all " does not convert', brief(s));
  await a.type('');
  await a.paste('@b');
  await a.keys(['space']);
  await sleep(300);
  s = await state();
  info('pasted "@b" followed by a typed space', { chip: s.chip, query: s.query });
  if (s.chip) { await press(['BackSpace']); await a.type(''); await press(['BackSpace']); }
  // A bare @ prefix ranks and counts nothing; the list owns arrows; Escape closes the list first.
  s = await typeKeys('@b');
  check(s.list.length >= 1 && s.bookmarks.count === '' && s.history.count === '', 'scope: a bare "@b" prefix opens the list and counts nothing', brief(s));
  s = await press(['Escape']);
  check(!s.list.length && await ctx.visible(), 'scope: Escape closes the @ list first and Search stays open', brief(s));
  s = await typeKeys('@');
  s = await press(['Tab']);
  check(s.chip === 'Only open tabs' && !s.list.length && s.focus === 'query', 'scope: Tab picks the highlighted @ word and keeps focus in the query', brief(s));
  await press(['BackSpace']); await a.type(''); await press(['BackSpace']);
  s = await typeKeys('@');
  s = await press(['Shift_L', 'Tab']);
  check(!s.chip && !s.list.length && s.focus !== 'query', 'scope: Shift+Tab closes the @ list and moves focus', brief(s));
  await dismiss();
}

// --- 4. Counts: never steer Enter, dedup, the cap ----------------------------------
async function countsFlow(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, press, typeKeys } = ctx;
  await grant(y);
  const w = token('ct');
  const url = slug => `${a.base}/disposable/${w}-${slug}`;
  // An open tab whose title has the word, plus bookmarks with it that are not open.
  await a.addTab('origin', url('tab'));
  ctx.created.push(url('tab'));
  ctx.seeded.push(await y.seed([{ title: `${w} mark one`, url: url('m1') }, { title: `${w} mark two`, url: url('m2') }]));
  let { s } = await open();
  await typeKeys(w);
  s = await settle(st => st.bookmarks.count !== '' && st.rows.length > 0, 6000);
  const highlighted = s.rows.find(r => r.active);
  check(highlighted?.kind === 'tab' && s.bookmarks.count === '2', 'counts: with a tab match and 2 bookmark matches, the tab is highlighted and Bookmarks counts 2', brief(s));
  await a.keys(['Return']);
  const switched = await until(async () => (await a.activeUrl()) === url('tab'), 'switched', 5000).catch(() => false);
  const closed = await until(async () => !(await ctx.visible()), 'search closed', 4000).then(() => true, () => false);
  check(switched && closed, 'counts: Enter with counts showing opens the highlighted tab (does not include sources)', await a.activeUrl());
  await a.focus(a.originUrl);
  // Dedup: two URLs both bookmarked and in history, one history-only.
  const h = token('dd');
  const hu = slug => `${a.base}/archive/${h}-${slug}`;
  await y.seedHistory([hu('both1'), hu('both2'), hu('only')], `${h} page`);
  ctx.seeded.push(await y.seed([{ title: `${h} page`, url: hu('both1') }, { title: `${h} page`, url: hu('both2') }]));
  ({ s } = await open());
  await typeKeys(h);
  s = await settle(st => st.bookmarks.count !== '' && st.history.count !== '', 6000);
  // Each button counts what it alone adds (History 3); the Include sentence counts each page once (2 + 1).
  check(s.bookmarks.count === '2' && s.history.count === '3' && s.message === 'No open tabs match. 2 bookmarks and 1 history page do.',
    'counts: each button counts what it alone adds, and the Include sentence counts bookmarked history pages once', { b: s.bookmarks.count, h: s.history.count, message: s.message });
  s = await setSource('history', true);
  s = await settle(st => st.busy === 'false' && st.rows.some(r => r.kind === 'history'), 6000);
  const historyRows = s.rows.filter(r => r.kind === 'history').length;
  check(historyRows === 3, 'counts: turning on History alone adds as many rows as its count said (3)', { historyRows, rows: brief(s).rows });
  await dismiss();
  // Cap: 60 bookmark matches.
  const c = token('cp');
  ctx.seeded.push(await y.seed(Array.from({ length: 60 }, (_, i) => ({ title: `${c} capped ${i}`, url: `https://cap.example/${c}/${i}` }))));
  ({ s } = await open());
  await typeKeys(c);
  s = await settle(st => st.bookmarks.count !== '', 6000);
  info('Bookmarks count with 60 matching bookmarks (results are capped at 50)', { count: s.bookmarks.count, message: s.message });
  check(s.bookmarks.count === '50+' && s.message === 'No open tabs match. 50+ bookmarks do.', 'counts: 60 matching bookmarks read 50+, on the button and in the sentence', { count: s.bookmarks.count, message: s.message });
  await dismiss();
}

// --- 5. Tabs off with an empty query --------------------------------------------------
async function tabsOff(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, press } = ctx;
  await grant(y);
  let { s } = await open();
  await setSource('bookmarks', true);
  s = await setSource('tabs', false);
  s = await settle(st => !st.tabs.on && st.busy === 'false');
  check(!s.tabs.on && s.rows.length >= 1 && s.rows.every(r => r.kind === 'tab') && s.select,
    'tabs off: an empty query still lists recent tabs, and Select multiple is shown for them', brief(s));
  s = await press(['Tab']);
  s = await press(['m']);
  check(s.mode === 'select', 'tabs off: m enters Select multiple from the recent-tab list', s.mode);
  await press(['Escape']);
  await dismiss();
  // At least one source stays on: Tabs off and then Bookmarks off.
  ({ s } = await open());
  await setSource('bookmarks', true);
  await setSource('tabs', false);
  s = await setSource('bookmarks', false);
  check(['tabs', 'bookmarks', 'history', 'content'].some(n => s[n].on), 'tabs off: turning off the last source keeps one on', brief(s));
  await dismiss();
}

// --- 6. Keyboard reach and screen-reader labels --------------------------------------
async function a11yFlow(ctx) {
  const { a, check, open, dismiss, press, toQuery, state } = ctx;
  let { s } = await open();
  const dom = await a.ui(`const row = document.getElementById('sources');
    const buttons = [...row.querySelectorAll('button[id^="source-"]')];
    const name = el => el.getAttribute('aria-label') || el.textContent.trim().replace(/\\s+/g, ' ');
    const desc = el => (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    return { role: row.getAttribute('role'), label: row.getAttribute('aria-label'),
      buttons: buttons.map(b => ({ id: b.id, name: name(b), desc: desc(b), pressed: b.getAttribute('aria-pressed'), tabindex: b.getAttribute('tabindex') })),
      listRole: document.getElementById('scope-list').getAttribute('role'),
      chipRemove: document.getElementById('scope-chip-remove').getAttribute('aria-label'),
      live: document.getElementById('announcement').getAttribute('aria-live') };`);
  info('source row DOM', dom);
  check(dom.role === 'toolbar' && Boolean(dom.label) && dom.buttons.length === 4 && dom.buttons.every(b => b.pressed === 'true' || b.pressed === 'false'),
    'a11y: the source row is a labelled toolbar of 4 aria-pressed buttons', dom);
  check(dom.buttons.filter(b => b.tabindex === '0').length === 1, 'a11y: the toolbar is one Tab stop (roving tabindex)', dom.buttons.map(b => b.tabindex));
  check(dom.buttons.every(b => !/\d/.test(b.name)), 'a11y: counts are not part of the button names', dom.buttons.map(b => b.name));
  check(dom.listRole === 'listbox' && Boolean(dom.chipRemove), 'a11y: @ list is a listbox and the chip remove button is labelled', { listRole: dom.listRole, chipRemove: dom.chipRemove });
  await toQuery();
  s = await press(['Shift_L', 'Tab']);
  check(/^source-/.test(s.focus || ''), 'keyboard: Shift+Tab from the query reaches the source row', s.focus);
  const visits = { start: s.focus };
  for (const k of ['Home', 'Right', 'Right', 'Right', 'Left', 'End']) { s = await press([k], 200); visits[k + Object.keys(visits).length] = s.focus; }
  const seq = Object.values(visits);
  check(seq[1] === 'source-tabs' && seq[2] === 'source-bookmarks' && seq[3] === 'source-history' && seq[4] === 'source-content' && seq[5] === 'source-history',
    'keyboard: Home/Right/Left move along the source buttons in order', visits);
  info('End in the source row lands on', seq[6]);
  s = await press(['Home'], 200);
  s = await press(['Right'], 200);
  s = await press(['Right'], 200);
  s = await press(['space']);
  check(s.history.on, 'keyboard: Space toggles the focused source on', brief(s));
  s = await press(['Return']);
  check(!s.history.on, 'keyboard: Enter toggles it off again', brief(s));
  const pressed = await a.ui(`return document.getElementById('source-history').getAttribute('aria-pressed')`);
  check(pressed === 'false', 'a11y: aria-pressed follows the state', pressed);
  await toQuery();
  s = await ctx.typeKeys('@b ');
  const chipLabel = await a.ui(`return document.getElementById('scope-chip-remove').getAttribute('aria-label')`);
  check(/bookmark/i.test(chipLabel || ''), 'a11y: the chip remove button names the filter', chipLabel);
  await dismiss();
}

// --- 7. One-time tips; no New mark ----------------------------------------------------
async function tipsFlow(ctx) {
  const { a, y, check, open, dismiss, toSource, press } = ctx;
  await storage(y, { searchTipsShown: {} });
  let { s } = await open();
  // History on (its tip), Tabs off then on (its tip), History off again.
  const pressTips = async () => {
    const out = {};
    s = await toSource('history'); s = await press(['space']); out.history = s.tip;
    s = await toSource('tabs'); s = await press(['space']); out.tabs = s.tip; out.tabsOffWorked = !s.tabs.on;
    s = await press(['space']);
    s = await toSource('history'); s = await press(['space']);
    return out;
  };
  const first = await pressTips();
  await dismiss();
  ({ s } = await open());
  const second = await pressTips();
  await dismiss();
  check(first.history === 'Tip: type @h to search only history' && first.tabs === 'Tip: type @t to search only open tabs',
    'tips: first press of History and of Tabs each show their tip', first);
  check(!second.history && !second.tabs, 'tips: neither repeats on a later launch', second);
  // A counter left by 0.10.0 shows nothing: the mark is gone.
  await storage(y, { searchBookmarksNew: 5 });
  ({ s } = await open());
  check(!s.newMark, 'new mark: a leftover 0.10.0 counter shows no "New" mark on Bookmarks', { newMark: s.newMark });
  await dismiss();
}

// --- 8. Save as default: Contents never saved ------------------------------------------
async function defaultsFlow(ctx) {
  const { a, y, check, open, dismiss, setSource, toSource, press, typeKeys } = ctx;
  await grant(y);
  const x = a.expanded;
  const hadHost = await x.permitted();
  if (!hadHost) { await x.settingsOpen(); await x.request('allow'); await x.settingsClose(); }
  try {
    check(await x.permitted(), 'defaults: website access granted for the Contents case');
    let { s } = await open();
    s = await setSource('content', true);
    check(s.content.on && !s.save, 'defaults: Save as default stays hidden when only Contents differs', brief(s));
    s = await setSource('history', true);
    check(s.save, 'defaults: Save as default shows once History also differs', brief(s));
    s = await toSource('history');
    s = await press(['End']);
    s = await press(['Return']);
    const saved = await stored(y, ['searchSources']);
    check(saved.searchSources && !('content' in saved.searchSources) && saved.searchSources.history === true,
      'defaults: the saved default has no Contents key', saved);
    await dismiss();
    ({ s } = await open());
    check(s.history.on && s.tabs.on && !s.content.on, 'defaults: next launch has History on and Contents off', brief(s));
    await dismiss();
    // @all then save: Contents still dropped.
    ({ s } = await open());
    s = await typeKeys('@all ');
    check(s.save, 'defaults: after @all, Save as default is offered', brief(s));
    await dismiss();
  } finally {
    await storage(y, { searchSources: { tabs: true, bookmarks: false, history: false } });
    if (!hadHost) { await x.settingsOpen(); await x.revoke(); await x.settingsClose(); }
  }
}

// --- 9. @all while some sources still need permission ----------------------------------
async function allNeedsPermission(ctx) {
  const { a, y, check, open, dismiss, typeKeys, settle } = ctx;
  if (await y.permitted()) await y.settings('revoke');
  let { s } = await open();
  s = await typeKeys('@all ');
  s = await settle(st => st.busy === 'false', 3000);
  check(s.chip === 'All sources' && s.tabs.on && s.history.on && !s.bookmarks.on && !s.content.on && s.access,
    'all: @all with Bookmarks and Contents not allowed turns on Tabs and History and shows the access panel', brief(s));
  // Native keys: no select-all + Backspace, which would undo the conversion.
  for (const k of 'current') await a.keys([k]);
  s = await settle(st => st.busy === 'false' && st.rows.length > 0, 4000);
  check(s.chip === 'All sources' && s.rows.length > 0 && !/error|could not/i.test(s.message), 'all: searching under @all with missing access still lists results', brief(s));
  await dismiss();
  await grant(y);
}

// --- 10. Revoke in Settings, then use Search -------------------------------------------
async function revokeThenUse(ctx) {
  const { a, y, check, open, dismiss, setSource, toSource, press, typeKeys, settle } = ctx;
  await grant(y);
  // Save Tabs + Bookmarks as the default, then revoke.
  let { s } = await open();
  s = await setSource('bookmarks', true);
  s = await toSource('bookmarks'); s = await press(['End']); s = await press(['Return']);
  await dismiss();
  await y.settings('revoke');
  ({ s } = await open());
  check(s.tabs.on && !s.bookmarks.on && s.bookmarks.locked && !s.rows.some(r => r.star),
    'revoke: with Bookmarks saved as default and access removed, Search opens with Tabs only, Bookmarks locked, no ★', brief(s));
  s = await typeKeys('@b ');
  info('"@b " with no bookmark access', brief(s));
  await ctx.append('current');
  s = await settle(st => st.query === 'current' && st.busy === 'false', 4000);
  check(s.chip === 'Only bookmarks' && ['tabs', 'bookmarks', 'history', 'content'].every(n => !s[n].on) && !s.rows.length && s.access && s.enable && !s.heading && !s.captions.length,
    'revoke: "@b " without access shows only the access action: no tab rows, no source On', brief(s));
  await a.type('');
  await press(['BackSpace']);
  await a.type('current');
  s = await settle(st => st.rows.length > 0, 4000);
  check(s.rows.length > 0 && s.rows[0].kind === 'tab', 'revoke: tab search still works after the revoke', brief(s));
  await dismiss();
  await grant(y);
  ({ s } = await open());
  check(s.bookmarks.on, 'revoke: re-granting brings the saved Bookmarks default back', brief(s));
  await dismiss();
  await storage(y, { searchSources: { tabs: true, bookmarks: false, history: false } });
}

// --- 11. Firefox Settings fallback, deny path --------------------------------------------
async function fallbackDeny(ctx) {
  const { a, y, check, open, dismiss, toSource, press, settle } = ctx;
  if (await y.permitted()) await y.settings('revoke');
  let { kind, s } = await open();
  s = await toSource('bookmarks');
  s = await press(['space']);
  if (y.promptInOverlay) {
    check(s.enable === 'Allow bookmarks', 'fallback: Chromium overlay asks in place (no Settings detour)', brief(s));
    await dismiss();
  } else {
    check(kind === 'overlay' && s.enable === 'Enable in Settings', 'fallback: Firefox overlay offers Enable in Settings', brief(s));
    const hasApi = await a.ui('return typeof browser !== "undefined" && typeof browser.permissions');
    info('typeof browser.permissions in the Firefox overlay frame', hasApi);
    check(hasApi === 'undefined', 'fallback: browser.permissions is undefined in the Firefox overlay frame (premise of the fallback)', hasApi);
    s = await press(['Shift_L', 'Tab']);
    await y.markOptions();
    await a.keys(['Return']);
    const opened = await until(() => y.optionsOpened(), 'settings opened', 6000).catch(() => false);
    check(opened && (await ctx.visible()) === 1, 'fallback: Settings opens in a new tab and Search stays open', opened);
    await y.closeOptions();
    const denied = await y.settings('deny');
    await a.focus(a.originUrl);
    s = await settle(st => st.busy === 'false', 4000);
    check(!s.bookmarks.on && !(await y.permitted()), 'fallback: denying in Settings leaves Bookmarks off when you return', { denied, s: brief(s) });
    s = await toSource('bookmarks');
    s = await press(['space']);
    check(s.enable === 'Enable in Settings', 'fallback: the enable action is offered again after a deny', brief(s));
    await dismiss();
  }
  await grant(y);
}

// --- 12. Duplicate prevention keeps a page Search opens (normal windows) -----------------
async function dupesExemption(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, press, typeKeys } = ctx;
  await grant(y);
  const tk = token('dp');
  const u = `${a.base}/disposable/${tk}-dupe`;
  const host = `${a.base}/disposable/${tk}-host`;
  ctx.seeded.push(await y.seed([{ title: `Dupe ${tk} mark`, url: u }]));
  await a.addTab('origin', u);
  await a.createWindow('vdupe', [host]);
  ctx.windows.push('vdupe');
  await storage(y, { searchScope: 'current', preventDuplicates: true, preventDuplicatesMode: 'switch' });
  try {
    let { s } = await open(host);
    await setSource('bookmarks', true);
    await typeKeys(`dupe ${tk}`);
    s = await settle(st => st.rows.some(r => r.url === u));
    for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== u; i++) s = await press(['Down'], 150);
    await a.keys(['Return']);
    await sleep(2500);
    const copies = (await y.tabsInfo()).filter(t => t.url === u).length;
    check(copies === 2, 'dupes: with prevention on, a bookmark Search opens (page open in another window, scope current) is kept', { copies });
  } finally {
    await storage(y, { searchScope: 'all', preventDuplicates: false });
    await a.cleanup([u], ['vdupe']).catch(() => {});
    await a.focus(a.originUrl);
  }
}

// --- 13. Firefox containers -----------------------------------------------------------------
async function containersFlow(ctx) {
  const { a, y, check, open, dismiss, setSource, settle, press, typeKeys } = ctx;
  if (y.browserName !== 'firefox') { console.log('SKIP verify containers: Firefox only'); return; }
  await grant(y);
  const tk = token('cn');
  const u = `${a.base}/disposable/${tk}-container`;
  const fresh = `${a.base}/disposable/${tk}-fresh`;
  ctx.seeded.push(await y.seed([{ title: `Container ${tk} mark`, url: u }, { title: `Container ${tk} fresh`, url: fresh }]));
  await y.containerTab(u, 1);
  ctx.created.push(u, fresh);
  let { s } = await open();
  await setSource('bookmarks', true);
  await typeKeys(`container ${tk} mark`);
  s = await settle(st => st.rows.some(r => r.url === u));
  check(s.rows.find(r => r.url === u)?.kind === 'tab' && s.rows.find(r => r.url === u)?.star, 'containers: a bookmarked page open in a container shows as its tab with ★', brief(s));
  s = await setSource('tabs', false);
  s = await settle(st => st.rows.some(r => r.url === u && r.open));
  for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== u; i++) s = await press(['Down'], 150);
  await a.keys(['Return']);
  await sleep(1500);
  let tabs = (await y.tabsInfo()).filter(t => t.url === u);
  check(tabs.length === 1 && tabs[0].userContextId === 1 && tabs[0].selected, 'containers: Enter on the Open bookmark switches to the container tab', tabs);
  await a.focus(a.originUrl);
  ({ s } = await open());
  await setSource('bookmarks', true);
  await typeKeys(`container ${tk} fresh`);
  s = await settle(st => st.rows.some(r => r.url === fresh));
  for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== fresh; i++) s = await press(['Down'], 150);
  await a.keys(['Return']);
  await sleep(1500);
  tabs = (await y.tabsInfo()).filter(t => t.url === fresh);
  check(tabs.length === 1 && tabs[0].userContextId === 0, 'containers: a bookmark that is not open opens in the default container', tabs);
}

// --- 14. Private windows: default, ★, @h, duplicate exemption -----------------------------
async function privateFlow(ctx) {
  const { a, y, check } = ctx;
  await grant(y);
  const tk = token('pv');
  const u = `${a.base}/disposable/${tk}-priv`;
  const uB = `${a.base}/disposable/${tk}-privb`;
  const uOff = `${a.base}/disposable/${tk}-off`, uOn = `${a.base}/disposable/${tk}-on`;
  ctx.seeded.push(await y.seed([{ title: `Private ${tk} mark`, url: u }, { title: `Ptwin ${tk} off`, url: uOff }, { title: `Ptwin ${tk} on`, url: uOn }]));
  const p1 = await y.privateWindow([u, uOff, uOn], `Private A ${tk}`);
  let p2;
  try {
    p2 = await y.privateWindow([uB], `Private B ${tk}`);
    const t = tools(p2);
    let { kind, s } = await t.open(uB);
    check(kind === 'overlay', 'private: Search opens over the second private window', kind);
    // @h where History is unavailable.
    await t.toQuery();
    await p2.type('');
    for (const k of [['Shift_L', 'at'], ['h'], ['space']]) await p2.keys(k);
    await sleep(300);
    s = await t.state();
    info('"@h " in a private window', brief(s));
    for (const k of ['p', 'r']) await p2.keys([k]);
    await sleep(300);
    s = await t.state();
    check(s.chip === 'Only history' && ['tabs', 'bookmarks', 'history', 'content'].every(n => !s[n].on) && !s.rows.length && s.privateNote && !s.heading,
      'private: "@h " in a private window turns nothing on, lists no tabs, and shows only the private-window status', brief(s));
    await p2.type(''); await sleep(200);
    await p2.keys(['BackSpace']); await sleep(200);
    await p2.type(''); await p2.keys(['BackSpace']); await sleep(200);
    // ★ on a private tab whose URL is bookmarked.
    await p2.type(`private ${tk}`);
    s = await t.settle(st => st.rows.some(r => r.url === u));
    check(s.rows.find(r => r.url === u)?.star === true, 'private: a bookmarked private tab shows ★', brief(s));
    // Save as default from a private window.
    s = await t.setSource('bookmarks', true);
    s = await t.toSource('bookmarks'); s = await t.press(['End']); s = await t.press(['Return']);
    const saved = await stored(y, ['searchSources']);
    check(saved.searchSources?.bookmarks === true, 'private: Save as default from a private window is stored', saved);
    // Duplicate prevention with scope current: open the bookmark from window B while A has it.
    // Control first (prevention off), then prevention on. Tabs polled every 100 ms.
    for (const prevent of [false, true]) {
      const u = prevent ? uOn : uOff;
      await storage(y, { searchScope: 'current', preventDuplicates: prevent, preventDuplicatesMode: 'switch' });
      await t.dismiss();
      ({ s } = await t.open(uB));
      await t.typeKeys(`ptwin ${tk} ${prevent ? 'on' : 'off'}`);
      s = await t.settle(st => st.rows.some(r => r.url === u && r.kind === 'bookmark'));
      for (let i = 0; i < 6 && s.rows.find(r => r.active)?.url !== u; i++) s = await t.press(['Down'], 150);
      const before = (await y.privateUrls()).filter(x => x === u).length;
      if (y.browserName === 'firefox') await a.startRemovals();
      await p2.keys(['Return']);
      let most = before;
      const samples = [];
      for (let i = 0; i < 25; i++) { await sleep(100); const n = (await y.privateUrls()).filter(x => x === u).length; samples.push(n); most = Math.max(most, n); }
      const removed = y.browserName === 'firefox' ? (await a.removed()).filter(x => x === u).length : null;
      const final = (await y.privateUrls()).filter(x => x === u).length;
      info(`private dupes (prevention ${prevent ? 'on' : 'off'})`, { before, most, final, removedEvents: removed, samples: samples.join('') });
      check(final === before + 1, `private: ${prevent ? 'with' : 'without'} duplicate prevention, a bookmark Search opens in a private window (page open in another private window) is kept`, { before, most, final, removed });
    }
  } finally {
    await storage(y, { searchScope: 'all', preventDuplicates: false, searchSources: { tabs: true, bookmarks: false, history: false } });
    await (p2 ?? p1).close().catch(() => {});
    await p1.close().catch(() => {});
  }
  const { s } = await ctx.open();
  check(s && !s.bookmarks.on, 'private: the normal window sees the reset default', brief(s));
}

// --- 15. Ctrl+K remap ---------------------------------------------------------------------------
async function shortcutFlow(ctx) {
  const { a, y, check, dismiss } = ctx;
  const result = await y.remap('Ctrl+K');
  let reached = false;
  let focus = null;
  if (result.applied) {
    await a.focus(a.originUrl);
    await y.pressRemapped();
    reached = await until(async () => (await ctx.visible()) > 0, 'remapped shortcut', 5000).catch(() => false);
    if (y.chromeFocus) focus = await y.chromeFocus();
    await dismiss();
    if (y.chromeFocus) await a.keys(['Escape']);
  }
  info('Ctrl+K remap', { ...result, reachedExtension: reached, browserFocusAfterPress: focus });
  check(result.applied, 'shortcut: the browser accepts Ctrl+K as the Search shortcut', result);
  await y.restoreShortcut();
  await a.focus(a.originUrl);
  const kind = await a.open();
  check(Boolean(kind), 'shortcut: the default shortcut opens Search after restoring', kind);
}
