// test-age-journal-chromium.mjs — integrated real-browser verification of the
// Chromium last-ACTIVATED stale-tab age + rollback-safety journal (R4/R7).
//
// Drives the ACTUAL built dist/chrome extension in a real (headless) Chromium
// through its REAL surfaces only:
//   - the product message protocol, sent from the real options/popup extension
//     pages via chrome.runtime.sendMessage (getStaleState / setStaleRule), so the
//     product's runtime.onMessage handler and stale service run end-to-end;
//   - real tabs.onActivated events, produced by real browser tab activation
//     (CDP Target.activateTarget via page.bringToFront());
//   - the real storage.local journal and storage.session age records, read back
//     from an extension page.
// No product helper is invoked directly; no product source/test/doc is edited.
//
// Isolation: a disposable profile under the scratch dir, a fixture site bound to
// 127.0.0.1 only (every other host fails to resolve), a short harness-owned
// TMPDIR (Chromium's ProcessSingleton socket must stay < ~107 bytes), and a
// Chromium process this harness spawns and owns. "Crash" is SIGKILL of THAT pid
// only. Nothing on the machine's real browser, clock, or storage is touched.
//
// Fixtures (labelled in result.json, never hidden):
//   [fixture clock]  An isolated +offset on Date.now INSIDE the extension
//                    service worker only, re-applied after every (re)launch and
//                    before every read. tab.lastAccessed stays the real browser
//                    clock, so journal anchors are real-clock values; only the
//                    stale-threshold comparison is accelerated. The machine clock
//                    is untouched. This is how a tab "activated minutes ago"
//                    reads as older than the (1 hour, also a fixture) threshold.
//   [fixture rule]   staleThresholdMs set to 1 hour via the real setStaleRule
//                    message (the smallest the product validator accepts).
//   [fault]          Scenario F induces a storage.local write failure to exercise
//                    the product's fail-closed path; clearly separated from native
//                    facts.
// This does NOT prove a real 7-day soak, nor simultaneous Chrome+extension write
// loss; both are reported as limitations.
//
// Usage (after `npm run build`), from the package root:
//   KIROCREW_SCRATCH=<dir> node scripts/test-age-journal-chromium.mjs
// Env: CHROMIUM_BINARY (defaults to Playwright's bundled Chromium).
// Output: $KIROCREW_SCRATCH/age-journal-chromium/<run>/ (result.json, log.txt, PNGs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOUR = 3600_000;
const OFFSET = 3 * HOUR;          // [fixture clock] worker-only Date.now advance
const THRESHOLD = HOUR;           // [fixture rule] smallest validator-accepted threshold
// A clean session-restore re-stamps tab.lastAccessed by a few ms; stale-age.js
// documents shifts "up to ~8 ms" and sizes ANCHOR_DRIFT_MS = 10 to absorb them.
// The guarantee is that the native value survives WITHIN that drift (and that
// the tab stays eligible), not that it is bit-identical.
const RESTORE_DRIFT_MS = 10;      // == product ANCHOR_DRIFT_MS
const CHROME = process.env.CHROMIUM_BINARY || chromium.executablePath();
if (!existsSync(CHROME)) throw new Error(`Chromium binary not found: ${CHROME}`);
const EXT = path.resolve('dist/chrome');
if (!existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`Build first: ${EXT}/manifest.json missing`);

const scratch = process.env.KIROCREW_SCRATCH || process.env.TMPDIR;
if (!scratch) throw new Error('Set KIROCREW_SCRATCH or TMPDIR to an isolated test directory');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(scratch, 'age-journal-chromium', runId);
const PROFILE = path.join(OUT, 'profile');
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(PROFILE, 'Default'), { recursive: true });
// "Continue where you left off" in this throwaway profile only, so tab
// lastAccessed is restored after a restart.
await writeFile(path.join(PROFILE, 'Default/Preferences'), JSON.stringify({ session: { restore_on_startup: 1 }, profile: { exit_type: 'Normal' } }));
const SHORT_TMP = await mkdtemp(path.join(os.tmpdir(), 'atvj-'));

// ---- soft checks + provenance ----------------------------------------------
const results = { passed: [], failed: [] };
const logLines = [];
const fixtures = [];
const limitations = [];
const log = m => { const s = `${new Date().toISOString()} ${m}`; logLines.push(s); console.log(s); };
const check = (cond, label, detail) => {
  if (cond) { results.passed.push(label); log(`PASS ${label}`); return true; }
  const d = detail === undefined ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  results.failed.push(label + d); log(`FAIL ${label}${d}`); return false;
};
const fixture = (what, detail) => { fixtures.push({ what, detail }); log(`FIXTURE ${what} ${JSON.stringify(detail)}`); };
const limit = (what, why) => { limitations.push({ what, why }); log(`LIMIT ${what}: ${why}`); };

// ---- loopback fixture site --------------------------------------------------
function startSite() {
  const hits = new Map();
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.set(url, (hits.get(url) || 0) + 1);
    const slug = url.slice(1) || 'root';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture ${slug}</title></head>`
      + `<body><h1>Fixture ${slug}</h1><p>Loopback stale-age fixture.</p></body></html>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, hits,
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
  })));
}

// ---- owned Chromium process + Playwright over CDP ---------------------------
function chromeArgs() {
  return ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-component-update', '--disable-background-networking', '--disable-default-apps', '--disable-breakpad',
    '--password-store=basic', '--use-mock-keychain', '--no-sandbox',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--restore-last-session', '--window-size=1280,900'];
}
async function spawnChrome() {
  await rm(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
  const child = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: SHORT_TMP } });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  let port;
  for (;;) {
    try { port = (await readFile(portFile, 'utf8')).trim().split('\n')[0]; if (port) break; } catch {}
    if (child.exitCode !== null) throw new Error(`chromium exited early: ${stderr.slice(-1200)}`);
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`CDP port timeout: ${stderr.slice(-1200)}`); }
    await sleep(150);
  }
  return { child, endpoint: `http://127.0.0.1:${port}`, exited, stderr: () => stderr };
}

let proc, browser, context;
// The product service worker is driven over a raw CDP WebSocket to its target
// (discovered via Chrome's /json/list), because Playwright's connectOverCDP does
// not reliably surface extension service-worker targets. `worker.evaluate(fn,arg)`
// keeps the same shape as Playwright's worker handle, so call sites are unchanged.
let swWs = null, swSeq = 0;
const swPending = new Map();
function swDispatch(m) {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.consoleAPICalled') {
    const a = (d.params.args || []).map(x => x.value ?? x.description ?? '').join(' ');
    log(`[sw-console:${d.params.type}] ${a}`);
    return;
  }
  const p = swPending.get(d.id);
  if (!p) return;
  swPending.delete(d.id);
  d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
}
function swSend(method, params = {}) {
  const id = ++swSeq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (swPending.delete(id)) rej(new Error(`sw CDP timeout: ${method}`)); }, 20000);
    swPending.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
    swWs.send(JSON.stringify({ id, method, params }));
  });
}
async function openSwChannel(ms = 30000) {
  const t0 = Date.now();
  let sw;
  for (;;) {
    try {
      const list = await (await fetch(`${proc.endpoint}/json/list`)).json();
      sw = list.find(t => t.type === 'service_worker' && /background\.js$/.test(t.url || ''));
    } catch {}
    if (sw) break;
    if (Date.now() - t0 > ms) throw new Error('product service worker target not found in /json/list');
    await sleep(200);
  }
  extOrigin = sw.url.replace(/\/background\.js$/, '');
  if (swWs) { try { swWs.close(); } catch {} swWs = null; }
  swWs = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { swWs.onopen = () => res(); swWs.onerror = () => rej(new Error('sw ws error')); });
  swWs.onmessage = swDispatch;
  await swSend('Runtime.enable', {});
  return extOrigin;
}
async function swEvaluate(fn, arg) {
  const expr = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
  const r = await swSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
const worker = { evaluate: swEvaluate };
async function connect() {
  browser = await chromium.connectOverCDP(proc.endpoint);
  context = browser.contexts()[0];
  // A fresh tab fires tabs.onCreated, which wakes the lazy MV3 service worker.
  try { const wake = await context.newPage(); await wake.goto(base, { waitUntil: 'domcontentloaded' }).catch(() => {}); } catch {}
  await openSwChannel();
  await openControl();
  return extOrigin;
}
// [fixture clock] re-apply the worker-only Date.now offset.
async function applyOffset() {
  try {
    return await worker.evaluate(off => {
      globalThis.__atvRealNow ??= Date.now.bind(Date);
      globalThis.__atvOff = off;
      Date.now = () => globalThis.__atvRealNow() + globalThis.__atvOff;
      return { now: Date.now(), real: globalThis.__atvRealNow(), off };
    }, OFFSET);
  } catch (e) { log(`applyOffset failed (worker may be recycling): ${e.message}`); return null; }
}

// ---- product message protocol, from a real extension page ------------------
let extOrigin, ctl; // ctl = a persistent options page used as the message sender
async function openControl() {
  ctl = await context.newPage();
  ctl.on('console', msg => log(`[opt-console:${msg.type()}] ${msg.text()}`));
  await ctl.goto(`${extOrigin}/options.html`);
  await ctl.waitForLoadState('domcontentloaded');
}
const winId = () => ctl.evaluate(() => chrome.windows.getCurrent().then(w => w.id));
async function send(command, extra = {}) {
  const windowId = await winId();
  return ctl.evaluate(({ command, windowId, extra }) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ command, windowId, ...extra }, resp => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(resp);
    });
  }), { command, windowId, extra });
}
const journal = () => ctl.evaluate(() => chrome.storage.local.get('staleAgeJournal').then(o => o.staleAgeJournal ?? null));
const dirtyMarker = () => ctl.evaluate(() => chrome.storage.session.get('stale.journalDirty').then(o => o['stale.journalDirty'] ?? null));

// ---- tabs via the real browser ---------------------------------------------
let base;
async function openTab(slug) {
  const p = await context.newPage();
  await p.goto(`${base}/${slug}`);
  return p;
}
const activate = p => p.bringToFront();                       // real Target.activateTarget -> tabs.onActivated
async function tabInfo(slug) {
  return worker.evaluate(async u => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url && x.url.endsWith(u));
    return t ? { id: t.id, windowId: t.windowId, active: t.active, lastAccessed: t.lastAccessed, url: t.url } : null;
  }, `/${slug}`);
}

// ---- journal is timestamp-only ----------------------------------------------
function journalIsTimestampOnly(j, forbiddenStrings) {
  if (j === null) return { ok: true, reason: 'absent' };
  const keys = Object.keys(j).sort().join(',');
  if (keys !== 'floor,j,v') return { ok: false, reason: `unexpected keys: ${keys}` };
  if (typeof j.v !== 'number' || typeof j.floor !== 'number') return { ok: false, reason: 'v/floor not numbers' };
  if (!Array.isArray(j.j)) return { ok: false, reason: 'j not array' };
  for (const e of j.j) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'number' || typeof e[1] !== 'number') {
      return { ok: false, reason: `entry not [number,number]: ${JSON.stringify(e)}` };
    }
  }
  const text = JSON.stringify(j);
  for (const s of forbiddenStrings) if (s && text.includes(String(s))) return { ok: false, reason: `leaked ${s}` };
  return { ok: true, reason: 'numbers only' };
}

// ---- restart / crash --------------------------------------------------------
async function disconnect() { try { await browser.close(); } catch {} }
async function graceful() {
  // Clean quit so the session (and tab lastAccessed) is restored next launch.
  const page = await context.newPage();
  try { const s = await context.newCDPSession(page); await s.send('Browser.close').catch(() => {}); } catch {}
  await disconnect();
  const exit = await Promise.race([proc.exited, sleep(12000).then(() => null)]);
  if (!exit) { proc.child.kill('SIGTERM'); await Promise.race([proc.exited, sleep(5000).then(() => null)]); }
  if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGKILL'); await proc.exited; }
  log(`graceful quit exit=${JSON.stringify(await Promise.race([proc.exited, Promise.resolve({ code: proc.child.exitCode, signal: proc.child.signalCode })]))}`);
}
async function crash() {
  await disconnect();
  proc.child.kill('SIGKILL');                                 // the owned pid only
  const exit = await proc.exited;
  log(`crash (SIGKILL own pid) exit=${JSON.stringify(exit)}`);
}
async function relaunch() {
  proc = await spawnChrome();
  extOrigin = await connect();
  await applyOffset();
}

// ---- run --------------------------------------------------------------------
const screenshots = [];
async function shoot(page, name, what) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots.push({ file, what });
  log(`SHOT ${name}: ${what}`);
}
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

const record = {
  tool: 'scripts/test-age-journal-chromium.mjs',
  startedAt: new Date().toISOString(),
  node: process.version, platform: `${os.platform()} ${os.arch()} ${os.release()}`,
  chromeBinary: CHROME, offsetMs: OFFSET, thresholdMs: THRESHOLD,
};
let site;
try {
  site = await startSite();
  base = site.base;
  log(`fixture site ${base}`);
  fixture('clock', { what: 'worker-only Date.now +offset; machine clock untouched; lastAccessed stays real', offsetMs: OFFSET });
  fixture('rule', { what: 'staleThresholdMs via real setStaleRule message', thresholdMs: THRESHOLD });

  proc = await spawnChrome();
  extOrigin = await connect();
  record.chrome = (await browser.version?.()) || (await worker.evaluate(() => navigator.userAgent));
  record.extensionId = extOrigin.replace('chrome-extension://', '').replace(/\/$/, '');
  record.manifestIncognito = await worker.evaluate(() => chrome.runtime.getManifest().incognito);
  record.ageBasisExpected = 'activated';
  await applyOffset();
  log(`extension ${record.extensionId} chrome=${JSON.stringify(record.chrome)} incognito=${record.manifestIncognito}`);

  // Apply the fixture rule through the real message path.
  const saved = await send('setStaleRule', { settings: { staleThresholdMs: THRESHOLD } });
  check(saved?.message === 'Settings saved', 'setStaleRule applied 1h threshold via real message', saved);

  // ---- Scenario A: open+activate background tabs; age basis + journal shape --
  // Open fixture tabs and genuinely activate each (real onActivated).
  const slugs = ['alpha', 'bravo', 'charlie', 'delta'];
  const pages = {};
  for (const s of slugs) pages[s] = await openTab(s);
  await sleep(300);
  for (const s of slugs) { await activate(pages[s]); await sleep(250); }
  // Re-activate alpha (its lastAccessed advances) -> supersession -> journal entry.
  await activate(pages.bravo); await sleep(250);
  await activate(pages.alpha); await sleep(400);
  await activate(pages.bravo); await sleep(400);
  await applyOffset();

  const jA = await journal();
  const shapeA = journalIsTimestampOnly(jA, [base, 'http', 'alpha', 'bravo', 'charlie', 'delta']);
  check(shapeA.ok, 'journal is timestamp-only (no URLs/IDs/titles)', shapeA.reason);
  check(jA && Array.isArray(jA.j) && jA.j.length >= 1, 'genuine reactivation wrote a journal supersession entry', jA);
  check(jA && jA.v === 1, 'journal carries only the version + floor + entries', jA);
  record.journalAfterActivity = jA;

  const stateA = await send('getStaleState');
  check(stateA?.ageBasis === 'activated', 'getStaleState reports ageBasis=activated (Chromium last-activation)', stateA?.ageBasis);
  const candA = new Set((stateA?.preview?.tabs || []).map(t => t.url));
  // The options page is the active tab; the four fixtures are inactive and older
  // than the 1h fixture threshold, so they are candidates.
  const info = {};
  for (const s of slugs) info[s] = await tabInfo(s);
  const activeNow = Object.values(info).filter(i => i?.active).map(i => i.url);
  check(stateA?.preview?.count >= 3, 'inactive tabs older than the fixture threshold are manual candidates', stateA?.preview);
  check(!activeNow.some(u => candA.has(u)), 'the active tab is never a stale candidate (protected)', { activeNow, candA: [...candA] });
  record.stateA = stateA;

  // ---- Scenario B: active tab older than threshold stays kept across windows,
  //      in BOTH manual and automatic plans ------------------------------------
  // Second normal window whose active tab was activated long ago (fixture clock).
  const second = await worker.evaluate(b => chrome.windows.create({ url: b + '/echo', focused: false }).then(w => ({ win: w.id, tab: w.tabs[0].id })), base);
  await sleep(400);
  // Enable automatic cleanup through the real message path (normal window).
  const en = await send('setStaleRule', { settings: { autoCloseStaleEnabled: true } });
  check(en?.message === 'Settings saved', 'autoCloseStaleEnabled enabled via real message', en);
  await applyOffset();
  const stateB = await send('getStaleState');
  record.stateB = stateB;
  check(stateB?.auto?.enabled === true && stateB?.auto?.available === true, 'automatic cleanup is enabled+available', stateB?.auto);
  // Active tabs of each window must not be in the manual candidate set.
  const allInfo = await worker.evaluate(() => chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, url: t.url, lastAccessed: t.lastAccessed }))));
  record.allTabs = allInfo;
  const activeUrls = allInfo.filter(t => t.active).map(t => t.url);
  const previewUrls = new Set((stateB?.preview?.tabs || []).map(t => t.url));
  check(activeUrls.length >= 2, 'two normal windows each have a known active tab', activeUrls);
  check(!activeUrls.some(u => previewUrls.has(u)), 'active tabs kept across windows under MANUAL plan despite age>threshold', { activeUrls, previewUrls: [...previewUrls] });
  // Automatic count must also exclude active tabs: auto.count never includes an
  // active tab (planStale auto policy protects active). Compare to number of
  // inactive web tabs. We assert auto.count>0 (some inactive stale) AND that
  // enabling did not count the active tabs.
  check(typeof stateB?.auto?.count === 'number' && stateB.auto.count >= 1, 'automatic plan has stale candidates (inactive only)', stateB?.auto);
  const inactiveWeb = allInfo.filter(t => !t.active && /^http/.test(t.url));
  check(stateB.auto.count <= inactiveWeb.length, 'automatic count never exceeds inactive web tabs (active tabs excluded)', { autoCount: stateB.auto.count, inactiveWeb: inactiveWeb.length });

  // ---- native UI screenshots (Chrome wording) --------------------------------
  // Popup, collapsed then expanded, showing the "activated" basis wording.
  const popup = await context.newPage();
  popup.on('console', msg => log(`[popup-console:${msg.type()}] ${msg.text()}`));
  await popup.goto(`${extOrigin}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');
  await sleep(600);
  await shoot(popup, 'popup-collapsed', 'toolbar popup, stale row collapsed (Auto-Close Enabled title)');
  // Expand the stale controls.
  let expanded = false;
  try {
    const row = popup.locator('text=Stale Tabs').first();
    await row.click({ timeout: 3000 });
    await sleep(500);
    expanded = true;
  } catch (e) { log(`popup expand click failed: ${e.message}`); }
  await sleep(300);
  const popupText = await popup.evaluate(() => document.body.innerText);
  check(/not activated for/.test(popupText), 'popup shows Chrome wording "not activated for" (ageBasis=activated)', expanded ? popupText.slice(0, 300) : 'row not expanded');
  await shoot(popup, 'popup-expanded', 'toolbar popup, stale controls expanded, "Close tabs not activated for"');
  await popup.close();

  // ---- Scenario C: repeated CLEAN restarts preserve unselected eligibility ---
  const preRestart = await tabInfo('charlie');  // never re-activated after its one activation
  record.restarts = [];
  let keptAcrossRestart = true;
  for (let cycle = 1; cycle <= 3; cycle++) {
    const jBefore = await journal();
    await graceful();
    await sleep(1500);
    await relaunch();
    await sleep(800);
    const after = await tabInfo('charlie');
    const jAfter = await journal();
    const st = await (async () => { await applyOffset(); return send('getStaleState'); })();
    const stillCandidate = (st?.preview?.tabs || []).some(t => t.url.endsWith('/charlie'));
    const r = {
      cycle,
      tabsRestored: after !== null,
      lastAccessedDeltaMs: (after && preRestart) ? after.lastAccessed - preRestart.lastAccessed : null,
      lastAccessedPreserved: !!after && !!preRestart && Math.abs(after.lastAccessed - preRestart.lastAccessed) <= RESTORE_DRIFT_MS,
      journalFloorBefore: jBefore?.floor, journalFloorAfter: jAfter?.floor,
      dirtyMarker: await dirtyMarker(),
      stillCandidate,
      previewCount: st?.preview?.count ?? null,
    };
    record.restarts.push(r);
    log(`restart ${cycle}: ${JSON.stringify(r)}`);
    if (after === null) { keptAcrossRestart = false; limit('clean-restart tab restore', 'headless session restore did not bring fixture tabs back; eligibility-across-restart could not be exercised this cycle'); break; }
    check(r.lastAccessedPreserved, `clean restart ${cycle}: native last-activation (lastAccessed) preserved within restore drift (<=${RESTORE_DRIFT_MS}ms)`, { pre: preRestart?.lastAccessed, post: after?.lastAccessed, deltaMs: r.lastAccessedDeltaMs });
    check(r.dirtyMarker === null, `clean restart ${cycle}: no fail-closed dirty marker set`, r.dirtyMarker);
    check((jAfter?.floor ?? 0) === (jBefore?.floor ?? 0), `clean restart ${cycle}: journal floor not raised (ages not reset)`, { before: jBefore?.floor, after: jAfter?.floor });
    check(stillCandidate, `clean restart ${cycle}: unselected old tab still eligible (NOT reset-on-restart)`, st?.preview);
  }
  record.cleanRestartEligibilityProven = keptAcrossRestart;

  // ---- Scenario D: HARD CRASH; journal survives, native survives, no false fail-closed
  const preCrash = await tabInfo('delta');
  const jPreCrash = await journal();
  await crash();
  await sleep(1500);
  await relaunch();
  await sleep(800);
  const postCrash = await tabInfo('delta');
  const jPostCrash = await journal();
  const crashDirty = await dirtyMarker();
  record.crash = {
    tabsRestored: postCrash !== null,
    nativeDeltaMs: (postCrash && preCrash) ? postCrash.lastAccessed - preCrash.lastAccessed : null,
    nativePreserved: !!postCrash && !!preCrash && Math.abs(postCrash.lastAccessed - preCrash.lastAccessed) <= RESTORE_DRIFT_MS,
    journalBefore: jPreCrash, journalAfter: jPostCrash,
    journalSurvived: JSON.stringify(jPreCrash) === JSON.stringify(jPostCrash),
    dirtyMarker: crashDirty,
  };
  log(`crash restart: ${JSON.stringify(record.crash)}`);
  check(record.crash.journalSurvived, 'hard crash: durable storage.local journal survived unchanged', { before: jPreCrash, after: jPostCrash });
  check(crashDirty === null, 'hard crash: storage.session dirty marker cleared on restart (fail-open only when journal is intact)', crashDirty);
  if (postCrash !== null) {
    check(record.crash.nativePreserved, 'hard crash: native last-activation (lastAccessed) survived the SIGKILL', { pre: preCrash?.lastAccessed, post: postCrash?.lastAccessed });
  } else {
    limit('crash tab restore', 'headless session restore did not bring the tab back after SIGKILL; native-survival-after-crash observed via journal only');
  }

  // ---- Scenario F: induced storage write failure -> labelled fail-closed -----
  // [fault] Make the next durable journal write fail, then cause a journal write
  // via a real reactivation, and confirm the product sets its fail-closed marker.
  const faultInstalled = await worker.evaluate(() => {
    try {
      const area = chrome.storage.local;
      if (!area.__atvOrigSet) area.__atvOrigSet = area.set.bind(area);
      area.set = (...a) => {
        if (a[0] && Object.prototype.hasOwnProperty.call(a[0], 'staleAgeJournal')) {
          return Promise.reject(new Error('[fault] induced storage.local.set failure'));
        }
        return area.__atvOrigSet(...a);
      };
      return true;
    } catch (e) { return String(e.message || e); }
  });
  if (faultInstalled === true) {
    await applyOffset();
    // Reactivate charlie after advancing: produces a supersession journal write.
    const cp = context.pages().find(p => p.url().endsWith('/charlie'));
    if (cp) { await activate(cp); await sleep(300); await activate(context.pages().find(p => p.url().endsWith('/delta')) || cp); await sleep(300); await activate(cp); await sleep(600); }
    const marker = await dirtyMarker();
    const nativeStillOk = await tabInfo('charlie');
    record.fault = { marker, nativeLastAccessed: nativeStillOk?.lastAccessed ?? null };
    check(marker && typeof marker.at === 'number', '[fault] induced storage.local write failure sets the fail-closed dirty marker', marker);
    check(nativeStillOk && typeof nativeStillOk.lastAccessed === 'number', '[fault] native lastAccessed is unaffected by the induced storage fault', nativeStillOk);
    // restore
    await worker.evaluate(() => { const a = chrome.storage.local; if (a.__atvOrigSet) a.set = a.__atvOrigSet; });
    log('[fault] restored chrome.storage.local.set');
  } else {
    limit('induced storage write failure', `could not install fault overlay in the worker: ${faultInstalled}`);
  }

  // ---- Scenario E: split-incognito performs REAL private-only activity, yet
  //      writes NOTHING to the durable (normal) storage.local journal ----------
  // The split private worker owns only the "private" age scope (persistJournal is
  // false there), so genuine private activation must leave the durable journal
  // byte-for-byte unchanged. We prove that with real private tabs and real
  // onActivated events — not a static "no URL in the JSON" check. "Allow in
  // incognito" is granted through the same privileged chrome.developerPrivate
  // path the stale-cleanup harness uses; it reloads the extension, so we
  // reconnect the normal worker + control page and reapply the fixture clock.
  record.manifestIncognitoIsSplit = record.manifestIncognito === 'split';
  // A CDP channel to one service-worker target, independent of the primary swWs.
  function makeChannel(ws) {
    const pending = new Map();
    let seq = 0;
    ws.onmessage = m => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.method === 'Runtime.consoleAPICalled') return;
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`cdp timeout ${method}`)); }, 20000);
      pending.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (fn, arg) => {
      const expr = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      return r.result?.value;
    };
    return { evaluate, close: () => { try { ws.close(); } catch {} } };
  }
  // Finds the background.js service worker whose context is incognito.
  async function openIncognitoWorker(ms = 20000) {
    const t0 = Date.now();
    for (;;) {
      let list = [];
      try { list = await (await fetch(`${proc.endpoint}/json/list`)).json(); } catch {}
      for (const sw of list.filter(t => t.type === 'service_worker' && /background\.js$/.test(t.url || ''))) {
        let ws;
        try {
          ws = new WebSocket(sw.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws open timeout')), 3000); });
        } catch { continue; }
        const chan = makeChannel(ws);
        let inc = false;
        try { inc = await chan.evaluate(() => chrome.extension.inIncognitoContext); } catch {}
        if (inc === true) return chan;
        chan.close();
      }
      if (Date.now() - t0 > ms) return null;
      await sleep(300);
    }
  }
  let incWorker = null;
  let privWindowId = null;
  try {
    const extPage = await context.newPage();
    await extPage.goto('chrome://extensions/');
    await extPage.evaluate(async id => {
      const call = (fn, arg) => new Promise((res, rej) => chrome.developerPrivate[fn](arg, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(true))));
      await call('updateProfileConfiguration', { inDeveloperMode: true });
      await call('updateExtensionConfiguration', { extensionId: id, incognitoAccess: true });
    }, record.extensionId);
    await extPage.close();
    await sleep(2000);
    // The grant reloaded the extension: reconnect and reapply the clock.
    extOrigin = await connect();
    await applyOffset();
    const allowedIncognito = await worker.evaluate(() => new Promise(r => { try { chrome.extension.isAllowedIncognitoAccess(r); } catch { r(null); } }));
    log(`isAllowedIncognitoAccess after grant: ${allowedIncognito}`);
    if (allowedIncognito !== true) throw new Error(`incognito access not effective after developerPrivate grant (isAllowedIncognitoAccess=${allowedIncognito})`);
    const jBefore = await journal();
    // Trigger a real private window. In split mode the normal worker cannot see
    // the incognito window it creates — the call resolves to null — but the
    // window IS created, so we drive and observe it through the dedicated
    // incognito worker instead (the same pattern the stale-cleanup harness uses).
    await worker.evaluate(b => Promise.resolve(chrome.windows.create({ incognito: true, url: b + '/priv-alpha', focused: false })).catch(() => {}), base);
    await sleep(1200);
    incWorker = await openIncognitoWorker();
    if (!incWorker) throw new Error('incognito split worker never appeared in /json/list');
    const incIsPrivate = await incWorker.evaluate(() => chrome.extension.inIncognitoContext);
    check(incIsPrivate === true, 'split mode: a dedicated incognito worker runs for the private window', incIsPrivate);
    // Real private-only activity, driven and observed inside the incognito worker:
    // open two more private tabs, genuinely activate each, then reactivate the
    // first — a supersession the private worker records only in its private
    // session scope, never in the durable journal.
    const privResult = await incWorker.evaluate(async b => {
      const nap = ms => new Promise(r => setTimeout(r, ms));
      const wins = await chrome.windows.getAll({ populate: false });
      const win = (wins.find(w => w.incognito) || wins[0]).id;
      const made = {};
      for (const slug of ['priv-bravo', 'priv-charlie']) {
        const t = await chrome.tabs.create({ windowId: win, url: `${b}/${slug}`, active: false });
        made[slug] = t.id;
        await nap(200);
      }
      for (const slug of ['priv-bravo', 'priv-charlie']) { await chrome.tabs.update(made[slug], { active: true }); await nap(250); }
      const all = await chrome.tabs.query({ windowId: win });
      const first = all.find(t => t.url && t.url.endsWith('/priv-alpha')) || all[0];
      await chrome.tabs.update(first.id, { active: true }); await nap(300);
      await chrome.tabs.update(made['priv-charlie'], { active: true }); await nap(300);
      await chrome.tabs.update(first.id, { active: true }); await nap(400);
      return { win, made, firstId: first.id, tabCount: all.length };
    }, base);
    privWindowId = privResult.win;
    log(`private activity: ${JSON.stringify(privResult)}`);
    // The incognito worker's own private session ages prove the activity landed.
    const privAges = await incWorker.evaluate(() => chrome.storage.session.get('stale.age.private').then(o => o['stale.age.private'] ?? null));
    const privRecs = privAges && privAges.tabs ? Object.values(privAges.tabs) : [];
    const privActivated = privRecs.some(r => r && (r.v > 0 || typeof r.a === 'number'));
    record.privateAges = privAges;
    check(privRecs.length >= 2 && privActivated, 'incognito worker recorded REAL private-tab activity (session ages with activation anchors)', { count: privRecs.length, privActivated });
    // The core guarantee: the durable normal journal is unchanged by real
    // private activity (equality before/after), not merely free of URL strings.
    await applyOffset();
    const jAfter = await journal();
    record.privateJournalBefore = jBefore;
    record.privateJournalAfter = jAfter;
    check(JSON.stringify(jAfter) === JSON.stringify(jBefore), 'real private-window activity wrote NOTHING to the durable journal (split private worker owns only "private")', { before: jBefore, after: jAfter });
    // No private native anchor leaked into the durable journal.
    const privNatives = privRecs.map(r => r.a).filter(a => typeof a === 'number');
    const jAnchors = (jAfter?.j ?? []).flat();
    const leaked = privNatives.filter(a => jAnchors.some(x => Math.abs(x - a) <= 1));
    check(leaked.length === 0, 'no private-tab native anchor appears in the durable journal', { privNatives, jAnchors });
    const shape = journalIsTimestampOnly(jAfter, [base, 'priv-alpha', 'priv-bravo', 'priv-charlie', 'http']);
    check(shape.ok, 'durable journal stays timestamp-only after private activity (no private slugs/URLs)', shape.reason);
    try { if (privWindowId != null) await incWorker.evaluate(w => chrome.windows.remove(w).catch(() => {}), privWindowId); } catch {}
  } catch (err) {
    limit('split-incognito durable-activity check', `could not exercise real private activity end-to-end: ${String(err?.message || err)}. Static facts stand: manifest incognito="split"; stale-service writes the journal only when owned scope includes "normal" (persistJournal), so a split private worker (owned=["private"]) never writes it.`);
  } finally {
    try { incWorker?.close(); } catch {}
  }

  // ---- inherent limits -------------------------------------------------------
  limit('7-day real soak', 'age over a real week is not observed; the 1h threshold + worker-clock offset are disclosed fixtures standing in for elapsed time');
  limit('simultaneous Chrome + extension write loss', 'a crash that loses the native lastAccessed AND the extension journal at once is not reproducible here; by design the restored native age could then be older than reality (documented, kept-only risk)');

} catch (e) {
  record.error = String(e?.stack || e);
  log(`ERROR ${record.error}`);
  check(false, 'harness completed without throwing', record.error);
} finally {
  // ---- source + build provenance --------------------------------------------
  const srcFiles = ['src/stale-age.js', 'src/stale-core.js', 'src/stale-service.js', 'src/stale-ui.js', 'src/background.js', 'dist/chrome/manifest.json', 'dist/chrome/stale-age.js'];
  const sources = {};
  for (const f of srcFiles) { try { sources[f] = await sha256(path.resolve(f)); } catch {} }
  record.sources = sources;
  for (const s of screenshots) { try { s.sha256 = await sha256(s.file); } catch {} }
  record.screenshots = screenshots.map(s => ({ file: path.relative(OUT, s.file), what: s.what, sha256: s.sha256 }));
  record.fixtures = fixtures;
  record.limitations = limitations;
  record.hits = site ? Object.fromEntries(site.hits) : {};
  record.finishedAt = new Date().toISOString();
  record.passed = results.passed.length;
  record.failed = results.failed;
  await writeFile(path.join(OUT, 'result.json'), JSON.stringify(record, null, 2));
  await writeFile(path.join(OUT, 'log.txt'), logLines.join('\n') + '\n');
  // ---- own-process cleanup ---------------------------------------------------
  try { if (swWs) swWs.close(); } catch {}
  try { await browser?.close(); } catch {}
  try { if (proc?.child && proc.child.exitCode === null) { proc.child.kill('SIGKILL'); await proc.exited; } } catch {}
  try { await site?.close(); } catch {}
  await rm(SHORT_TMP, { recursive: true, force: true });
  log(`OUT ${OUT}`);
  console.log(JSON.stringify({ passed: results.passed.length, failed: results.failed.length, out: OUT }));
}
assert.equal(results.failed.length, 0, `${results.failed.length} browser check(s) failed:\n${results.failed.join('\n')}`);
