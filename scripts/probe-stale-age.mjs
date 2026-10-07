// Probe: what browser.tabs.Tab.lastAccessed really reports in real Firefox and
// Chromium across the tab lifecycle, before the stale-tab age adapter relies on it.
//
// Isolation: a generated probe extension (tabs permission only, NOT the product
// build) runs in a disposable profile under $KIROCREW_SCRATCH, on an isolated Xvfb
// display, against a loopback-only (127.0.0.1) fixture + command server. The
// extension long-polls that server for fixed tab operations and replies with
// browser.tabs.query() snapshots, so every timestamp is read through the real
// WebExtension API from the extension's own background context.
//
// Usage (from the package root):
//   node scripts/probe-stale-age.mjs [--browser=firefox|chromium|both]
// Env: KIROCREW_SCRATCH (required), FIREFOX_BINARY, GECKODRIVER, CHROMIUM_BINARY, XVFB_BINARY.
// Exit code 1 when any assertion fails. Results: $KIROCREW_SCRATCH/probe-stale-age/<run>/.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDisplay } from './test-display.mjs';
import { nativeKeys } from './test-browser-fixtures.mjs';

const GAP = 1200; // ms between operations, so each one is distinguishable in timestamps
const TOL = 50; // ms clock/IPC tolerance
const RESTART_GAP = 3000;
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const BROWSERS = (arg('browser') || 'both') === 'both' ? ['firefox', 'chromium'] : [arg('browser')];
const scratch = process.env.KIROCREW_SCRATCH;
if (!scratch) throw new Error('Set KIROCREW_SCRATCH to an isolated scratch directory');
const runDir = process.env.PROBE_STALE_AGE_RUN || path.join(scratch, 'probe-stale-age', new Date().toISOString().replace(/[:.]/g, '-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- loopback fixture pages + command channel ------------------------------
function startServer() {
  const queue = [], waiters = [], pending = new Map(), hits = new Map();
  let seq = 0, lastPoll = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/cmd') {
      lastPoll = Date.now();
      let done = false;
      const send = cmd => { done = true; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(cmd)); };
      if (queue.length) return send(queue.shift());
      const waiter = { send };
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); send({ op: 'noop' }); }, 10000);
      waiters.push(waiter);
      res.on('close', () => {
        if (done) return;
        clearTimeout(waiter.timer);
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
      });
      return;
    }
    if (url.pathname === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.end('ok');
        const reply = JSON.parse(body);
        const p = pending.get(reply.id);
        if (!p) return;
        pending.delete(reply.id);
        clearTimeout(p.timer);
        reply.error ? p.reject(new Error(`${p.op}: ${reply.error}`)) : p.resolve(reply.ok);
      });
      return;
    }
    const slug = url.pathname.match(/^\/tab\/([a-z0-9-]{1,40})$/)?.[1];
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probe [${slug || 'none'}]</title></head>`
      + `<body><h1>Probe [${slug || 'none'}]</h1><p>Disposable stale-age probe fixture.</p></body></html>`);
  });
  function call(op, args = {}, ms = 20000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${op}`)); }, ms);
      pending.set(id, { resolve, reject, timer, op });
      const cmd = { id, op, ...args };
      const waiter = waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.send(cmd); } else queue.push(cmd);
    });
  }
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, call, hits, lastPoll: () => lastPoll,
    close: () => new Promise(r => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.send({ op: 'noop' }); } server.close(r); server.closeAllConnections?.(); }),
  })));
}

// ---- generated probe extension --------------------------------------------
function background(base) {
  return `const BASE = ${JSON.stringify(base)};
const api = globalThis.browser || globalThis.chrome;
const events = [];
const rel = u => { if (u === undefined) return undefined; try { const x = new URL(u); return x.origin === BASE ? x.pathname : x.protocol + x.pathname; } catch { return String(u); } };
const log = (type, data) => { events.push({ t: Date.now(), type, ...data }); if (events.length > 1000) events.shift(); };
api.tabs.onActivated.addListener(i => log('onActivated', { tabId: i.tabId, previousTabId: i.previousTabId, windowId: i.windowId }));
api.tabs.onCreated.addListener(t => log('onCreated', { tabId: t.id, active: t.active, lastAccessed: t.lastAccessed, url: rel(t.pendingUrl || t.url) }));
api.tabs.onUpdated.addListener((id, c, t) => log('onUpdated', { tabId: id, change: Object.keys(c).join(','), status: c.status, discarded: c.discarded, lastAccessed: t.lastAccessed }));
api.tabs.onReplaced.addListener((added, removed) => log('onReplaced', { added, removed }));
api.tabs.onRemoved.addListener((id, i) => log('onRemoved', { tabId: id, windowClosing: i.isWindowClosing }));
api.windows.onFocusChanged.addListener(w => log('onFocusChanged', { windowId: w }));
const tab = t => ({ id: t.id, windowId: t.windowId, index: t.index, active: t.active, discarded: !!t.discarded,
  status: t.status, url: rel(t.url), lastAccessed: t.lastAccessed, incognito: t.incognito });
const abs = u => (u && u.startsWith('/') ? BASE + u : u);
async function run(c) {
  const before = Date.now();
  let result;
  switch (c.op) {
    case 'ping': break;
    case 'info': result = { ua: navigator.userAgent, browserInfo: api.runtime.getBrowserInfo ? await api.runtime.getBrowserInfo() : null }; break;
    case 'snapshot': result = { tabs: (await api.tabs.query({})).map(tab),
      windows: (await api.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, type: w.type, incognito: w.incognito })),
      events: events.splice(0) }; break;
    case 'create': result = tab(await api.tabs.create({ url: abs(c.url), active: c.active, windowId: c.windowId })); break;
    case 'update': result = tab(await api.tabs.update(c.tabId, { ...c.props, ...(c.props.url ? { url: abs(c.props.url) } : {}) })); break;
    case 'reload': await api.tabs.reload(c.tabId); break;
    case 'discard': { const t = await api.tabs.discard(c.tabId); result = t ? tab(t) : null; break; }
    case 'duplicate': result = tab(await api.tabs.duplicate(c.tabId)); break;
    case 'remove': await api.tabs.remove(c.tabId); break;
    case 'windowCreate': { const w = await api.windows.create({ url: abs(c.url), focused: c.focused, left: 700, top: 400, width: 560, height: 460 });
      result = { id: w.id, tabs: w.tabs.map(tab) }; break; }
    case 'windowUpdate': await api.windows.update(c.windowId, { focused: c.focused }); break;
    default: throw new Error('unknown op ' + c.op);
  }
  return { before, now: Date.now(), ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }) };
}
(async function loop() {
  for (;;) {
    let c;
    try { c = await (await fetch(BASE + '/cmd', { cache: 'no-store' })).json(); }
    catch { await new Promise(r => setTimeout(r, 250)); continue; }
    if (c.op === 'noop') { await api.runtime.getPlatformInfo(); continue; }
    let reply;
    try { reply = { id: c.id, ok: await run(c) }; } catch (e) { reply = { id: c.id, error: String(e && e.message || e) }; }
    try { await fetch(BASE + '/result', { method: 'POST', body: JSON.stringify(reply) }); } catch {}
  }
})();
`;
}

const FIREFOX_ID = 'stale-age-probe@tabvacuum.test';
const FIREFOX_UUID = '0f4f9a4e-5f1d-4c4e-9a59-0c1f1b7e2a11';
async function writeExtension(dir, browserName, base) {
  await mkdir(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: 'ATV stale-age probe (test only)', version: '0.0.1', permissions: ['tabs'],
    background: browserName === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    ...(browserName === 'firefox' ? { browser_specific_settings: { gecko: { id: FIREFOX_ID } } } : {}) };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, 'background.js'), background(base));
  return dir;
}

// ---- browser launchers -----------------------------------------------------
async function firefoxLauncher(dir, env, extDir) {
  const { Builder } = await import('selenium-webdriver');
  const firefox = (await import('selenium-webdriver/firefox.js')).default;
  const profile = path.join(dir, 'profile');
  await mkdir(profile, { recursive: true });
  process.env.TMPDIR = dir;
  process.env.DISPLAY = env.DISPLAY;
  const binary = process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox');
  const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
  let driver;
  return {
    binary, driverPath, profile,
    async start() {
      const options = new firefox.Options().setBinary(binary).addArguments('-profile', profile)
        .setPreference('extensions.webextensions.uuids', JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }))
        .setPreference('browser.startup.page', 3) // restore previous session
        .setPreference('browser.sessionstore.resume_session_once', true)
        .setPreference('browser.tabs.warnOnClose', false)
        .setPreference('browser.sessionstore.warnOnQuit', false)
        .setPreference('extensions.background.idle.timeout', 600000); // keep the probe event page awake
      const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
      driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
      // Temporary add-ons do not survive a restart; reinstall (same ID/UUID) each launch.
      await driver.installAddon(extDir, true);
      return (await driver.getCapabilities()).get('browserVersion');
    },
    async stop() { if (driver) { const d = driver; driver = undefined; await d.quit(); } },
  };
}

async function chromiumLauncher(dir, env, extDir) {
  const { chromium } = await import('playwright');
  const profile = path.join(dir, 'profile');
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  // Continue where you left off, in this throwaway profile only.
  await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const binary = process.env.CHROMIUM_BINARY || chromium.executablePath();
  let context;
  return {
    binary, profile,
    async start() {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: binary, headless: false, env, viewport: null,
        // Playwright otherwise appends an about:blank start page that takes focus from restored tabs.
        ignoreDefaultArgs: ['about:blank'],
        args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--restore-last-session',
          '--window-position=0,0', '--window-size=1100,800', '--no-first-run', '--no-default-browser-check'],
      });
      return context.browser()?.version() || 'unknown';
    },
    async stop() { if (context) { const c = context; context = undefined; await c.close(); } },
  };
}

// ---- scenario --------------------------------------------------------------
async function probe(browserName) {
  const dir = path.join(runDir, browserName);
  await mkdir(dir, { recursive: true });
  const server = await startServer();
  const display = await startDisplay(scratch);
  const env = display.env;
  const extDir = await writeExtension(path.join(dir, 'extension'), browserName, server.base);
  const launcher = await (browserName === 'firefox' ? firefoxLauncher : chromiumLauncher)(dir, env, extDir);
  const { call } = server;
  const steps = [], assertions = [], findings = [];
  const names = new Map(); // tab id -> probe name (this session only)
  const t0 = Date.now();
  const record = { browser: browserName, binary: launcher.binary, driver: launcher.driverPath, profile: launcher.profile,
    extension: extDir, display: env.DISPLAY, base: server.base, t0, steps, assertions, findings };
  const expect = (ok, id, detail) => { assertions.push({ id, pass: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${browserName}] ${id}${ok ? '' : ` -- ${JSON.stringify(detail)}`}`); };
  const note = (id, detail) => { findings.push({ id, detail }); console.log(`NOTE [${browserName}] ${id}: ${JSON.stringify(detail)}`); };
  const titleOf = name => `Probe [${name}]`;
  const native = (keys, focusName) => {
    for (let attempt = 0; ; attempt++) {
      try { return nativeKeys(env, keys, titleOf(focusName)); } catch (e) { if (attempt > 10) throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  };
  async function ready(ms = 30000) {
    const deadline = Date.now() + ms;
    for (;;) {
      try { return await call('ping', {}, 3000); } catch (e) { if (Date.now() > deadline) throw new Error('probe extension did not connect'); }
    }
  }
  async function settle() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = await call('snapshot');
      if (s.events.length) pendingEvents.push(...s.events);
      if (s.tabs.every(t => t.discarded || t.status === 'complete' || !t.url?.startsWith('/tab/'))) break;
      await sleep(100);
    }
    await sleep(250);
  }
  let pendingEvents = [];
  const hitsBefore = () => new Map(server.hits);
  async function step(label, method, action) {
    const hits0 = hitsBefore();
    const start = await call('ping');
    const result = action ? await action() : undefined;
    await settle();
    const snap = await call('snapshot');
    const events = [...pendingEvents, ...snap.events]; pendingEvents = [];
    for (const e of events) {
      if (e.type === 'onCreated' && !names.has(e.tabId)) names.set(e.tabId, `?${e.url}`);
      // Chromium replaces a discarded tab's id; keep following the same tab.
      if (e.type === 'onReplaced' && names.has(e.removed)) names.set(e.added, names.get(e.removed));
    }
    const loads = [...server.hits].filter(([p, n]) => n !== (hits0.get(p) || 0)).map(([p, n]) => `${p}x${n - (hits0.get(p) || 0)}`);
    const entry = { label, method, before: start.now, now: snap.now, result,
      tabs: snap.tabs.map(t => ({ ...t, name: names.get(t.id) || t.url })), windows: snap.windows,
      events: events.map(e => ({ ...e, name: names.get(e.tabId) })), loads };
    steps.push(entry);
    return entry;
  }
  const get = (entry, name) => entry.tabs.find(t => t.name === name);
  const la = (entry, name) => get(entry, name)?.lastAccessed;
  const unchanged = (a, b, name) => la(a, name) === la(b, name);
  const valid = (t, now) => Number.isFinite(t) && t > 0 && t <= now + TOL;
  const activations = (entry, name) => entry.events.filter(e => e.type === 'onActivated' && e.name === name).length;

  try {
    record.version = await launcher.start();
    await ready();
    record.info = await call('info');
    console.log(`[${browserName}] ${record.version} ${record.info.ua}`);

    // Name the starting tab "alpha" and give it a fixture page.
    let s = await step('boot', 'api');
    const w1 = s.windows.find(w => w.focused)?.id ?? s.windows[0].id;
    const start = s.tabs.find(t => t.active && t.windowId === w1);
    names.set(start.id, 'alpha');
    await call('update', { tabId: start.id, props: { url: '/tab/alpha' } });
    await sleep(GAP);

    const sAlpha = await step('alpha loaded in foreground', 'api');
    const create = async (name, props) => { const t = await call('create', props); names.set(t.id, name); return t; };
    const sBravo = await step('open bravo in background', 'api', () => create('bravo', { url: '/tab/bravo', active: false, windowId: w1 }));
    const bravo = sBravo.result;
    note('background-open: bravo lastAccessed minus creation time (ms)', { delta: la(sBravo, 'bravo') - bravo.before, raw: la(sBravo, 'bravo') });
    expect(valid(la(sBravo, 'bravo'), sBravo.now) || la(sBravo, 'bravo') === undefined, 'background-opened tab timestamp is absent or finite, positive, not future', la(sBravo, 'bravo'));
    expect(la(sBravo, 'bravo') !== la(sBravo, 'alpha'), 'background-opened tab does not inherit opener timestamp', { bravo: la(sBravo, 'bravo'), alpha: la(sBravo, 'alpha') });
    await sleep(GAP);

    const sCharlie = await step('open charlie in foreground', 'api', () => create('charlie', { url: '/tab/charlie', active: true, windowId: w1 }));
    note('foreground-open: charlie lastAccessed minus creation (ms)', la(sCharlie, 'charlie') - sCharlie.result.before);
    note('deactivated alpha: lastAccessed minus charlie creation (ms; ~0 => records deactivation, negative => records activation)', la(sCharlie, 'alpha') - sCharlie.result.before);
    await sleep(GAP);
    const sIdle = await step(`idle ${GAP}ms`, 'none');
    note('active tab lastAccessed minus snapshot time (ms; ~0 => live "now")', la(sIdle, 'charlie') - sIdle.now);
    expect(unchanged(sCharlie, sIdle, 'alpha') && unchanged(sCharlie, sIdle, 'bravo'), 'idle: inactive tab timestamps stable', { before: [la(sCharlie, 'alpha'), la(sCharlie, 'bravo')], after: [la(sIdle, 'alpha'), la(sIdle, 'bravo')] });

    const sSwitchApi = await step('switch to bravo (tabs.update active)', 'api', () => call('update', { tabId: bravo.id, props: { active: true } }));
    expect(la(sSwitchApi, 'bravo') >= sSwitchApi.before - TOL, 'API activation moves selected tab timestamp to >= activation time', { la: la(sSwitchApi, 'bravo'), at: sSwitchApi.before });
    note('charlie after being switched away (minus switch time, ms)', la(sSwitchApi, 'charlie') - sSwitchApi.before);
    await sleep(GAP);

    const sSwitchNative = await step('native Ctrl+PageDown bravo -> charlie', 'native', async () => native(['Control_L', 'Next'], 'bravo'));
    expect(get(sSwitchNative, 'charlie')?.active, 'native key switched to charlie', get(sSwitchNative, 'charlie'));
    expect(la(sSwitchNative, 'charlie') >= sSwitchNative.before - TOL, 'native activation moves selected tab timestamp', { la: la(sSwitchNative, 'charlie'), at: sSwitchNative.before });
    expect(unchanged(sSwitchApi, sSwitchNative, 'alpha'), 'native switch leaves unrelated inactive tab untouched', [la(sSwitchApi, 'alpha'), la(sSwitchNative, 'alpha')]);
    await sleep(GAP);

    const sW2 = await step('open focused window two', 'api', async () => {
      const w = await call('windowCreate', { url: '/tab/wtwo', focused: true });
      names.set(w.tabs[0].id, 'wtwo');
      return w;
    });
    const w2 = sW2.result.id;
    note('window-1 active tab (charlie) when window two takes focus, minus focus time (ms)', la(sW2, 'charlie') - sW2.before);
    await sleep(GAP);
    const sFocus1 = await step('native focus window one', 'native', async () => native(['Shift_L'], 'charlie'));
    await sleep(GAP);
    const sFocus2 = await step('native focus window two', 'native', async () => native(['Shift_L'], 'wtwo'));
    await sleep(GAP);
    const sFocus3 = await step('API focus window one', 'api', () => call('windowUpdate', { windowId: w1, focused: true }));
    for (const [e, label] of [[sFocus1, 'native->w1'], [sFocus2, 'native->w2'], [sFocus3, 'api->w1']]) {
      note(`focus ${label}: onFocusChanged=${JSON.stringify(e.events.filter(x => x.type === 'onFocusChanged').map(x => x.windowId))} onActivated=${e.events.filter(x => x.type === 'onActivated').length}`,
        { charlie: la(e, 'charlie') - e.before, wtwo: la(e, 'wtwo') - e.before, focused: e.windows.find(w => w.focused)?.id === w1 ? 'w1' : e.windows.find(w => w.focused)?.id === w2 ? 'w2' : 'none' });
    }
    expect(unchanged(sW2, sFocus3, 'alpha') && unchanged(sW2, sFocus3, 'bravo'), 'window focus changes leave inactive tabs untouched', { before: [la(sW2, 'alpha'), la(sW2, 'bravo')], after: [la(sFocus3, 'alpha'), la(sFocus3, 'bravo')] });
    expect([sFocus1, sFocus2, sFocus3].every(e => e.events.every(x => x.type !== 'onActivated')), 'window focus changes fire no tabs.onActivated', [sFocus1, sFocus2, sFocus3].map(e => activations(e, 'charlie')));
    await sleep(GAP);

    const alphaId = start.id;
    const sReload = await step('reload inactive alpha', 'api', () => call('reload', { tabId: alphaId }));
    expect(sReload.loads.includes('/tab/alphax1'), 'background reload really reloaded', sReload.loads);
    expect(unchanged(sFocus3, sReload, 'alpha'), 'background reload does not change lastAccessed', [la(sFocus3, 'alpha'), la(sReload, 'alpha')]);
    expect(activations(sReload, 'alpha') === 0, 'background reload fires no onActivated', sReload.events.filter(e => e.name === 'alpha').map(e => e.type));
    await sleep(GAP);
    const sNav = await step('navigate inactive alpha to /tab/alpha-next', 'api', () => call('update', { tabId: alphaId, props: { url: '/tab/alpha-next' } }));
    expect(unchanged(sReload, sNav, 'alpha'), 'background navigation does not change lastAccessed', [la(sReload, 'alpha'), la(sNav, 'alpha')]);
    await sleep(GAP);

    const sDelta = await step('open delta in background (same URL as bravo), then view it', 'api', async () => {
      const d = await create('delta', { url: '/tab/bravo', active: false, windowId: w1 });
      await settle();
      await call('update', { tabId: d.id, props: { active: true } });
      return d;
    });
    expect(unchanged(sNav, sDelta, 'bravo'), 'viewing a same-URL tab leaves the other tab untouched', [la(sNav, 'bravo'), la(sDelta, 'bravo')]);
    await sleep(GAP);

    const sDiscard = await step('discard inactive bravo', 'api', () => call('discard', { tabId: bravo.id }));
    const bravoAfter = get(sDiscard, 'bravo');
    note('discard keeps tab id', { before: bravo.id, after: bravoAfter?.id, replaced: sDiscard.events.filter(e => e.type === 'onReplaced') });
    expect(bravoAfter?.discarded, 'bravo is discarded', get(sDiscard, 'bravo'));
    expect(la(sDiscard, 'bravo') === la(sDelta, 'bravo'), 'discard preserves lastAccessed', [la(sDelta, 'bravo'), la(sDiscard, 'bravo')]);
    expect(activations(sDiscard, 'bravo') === 0, 'discard fires no onActivated', sDiscard.events.filter(e => e.name === 'bravo').map(e => e.type));
    await sleep(GAP);
    const sUndiscard = await step('view discarded bravo (restores it)', 'api', () => call('update', { tabId: bravoAfter.id, props: { active: true } }));
    expect(!get(sUndiscard, 'bravo')?.discarded && sUndiscard.loads.includes('/tab/bravox1'), 'viewing a discarded tab reloads it', { tab: get(sUndiscard, 'bravo'), loads: sUndiscard.loads });
    expect(la(sUndiscard, 'bravo') >= sUndiscard.before - TOL, 'viewing a discarded tab updates lastAccessed', { la: la(sUndiscard, 'bravo'), at: sUndiscard.before });
    await sleep(GAP);

    const sDup = await step('duplicate inactive charlie', 'api', async () => { const d = await call('duplicate', { tabId: (get(sUndiscard, 'charlie')).id }); names.set(d.id, 'charlie-dup'); return d; });
    note('duplicate: active, lastAccessed minus duplicate time; original charlie unchanged?', { active: get(sDup, 'charlie-dup')?.active, dup: la(sDup, 'charlie-dup') - sDup.before, charlieUnchanged: unchanged(sUndiscard, sDup, 'charlie') });
    expect(la(sDup, 'charlie-dup') !== la(sDup, 'charlie') || la(sDup, 'charlie') >= sDup.before - TOL, 'duplicate does not inherit original old timestamp', [la(sDup, 'charlie'), la(sDup, 'charlie-dup')]);
    await sleep(GAP);

    const alphaBeforeClose = la(sDup, 'alpha');
    await call('remove', { tabId: alphaId });
    await settle();
    await sleep(GAP);
    const sReopen = await step('native Ctrl+Shift+T reopens closed alpha', 'native', async () => native(['Control_L', 'Shift_L', 't'], get(sDup, 'charlie-dup')?.active ? 'charlie' : 'bravo'));
    const reopened = sReopen.tabs.find(t => t.url === '/tab/alpha-next');
    if (reopened) { names.set(reopened.id, 'alpha-reopened'); reopened.name = 'alpha-reopened'; }
    note('reopened closed tab', { newId: reopened?.id !== alphaId, active: reopened?.active, minusReopen: reopened && reopened.lastAccessed - sReopen.before, equalsOldValue: reopened?.lastAccessed === alphaBeforeClose });
    expect(reopened, 'native reopen-closed-tab restored alpha', sReopen.tabs.map(t => t.url));
    expect(reopened?.id !== alphaId, 'reopened tab gets a new id', { old: alphaId, now: reopened?.id });
    await sleep(GAP);

    // Restart setup: close same-URL/duplicate tabs so the probe can match restored
    // tabs by URL (the probe only; the product must not correlate by URL).
    for (const name of ['delta', 'charlie-dup']) { const t = get(sReopen, name); if (t) await call('remove', { tabId: t.id }); }
    await settle();
    await call('update', { tabId: get(sReopen, 'charlie').id, props: { active: true } });
    await call('discard', { tabId: get(sReopen, 'bravo').id }).catch(e => note('pre-restart discard failed', e.message));
    await sleep(RESTART_GAP);
    const sPre = await step('before full browser close', 'none');
    const pre = new Map(sPre.tabs.filter(t => t.url?.startsWith('/tab/')).map(t => [t.url, t]));
    const quitAt = Date.now();
    const hitsAtQuit = new Map(server.hits);
    await launcher.stop();
    await sleep(RESTART_GAP);
    names.clear();
    record.versionAfterRestart = await launcher.start();
    await ready();
    const relaunchAt = Date.now();
    let sPost;
    for (let i = 0; i < 40; i++) {
      sPost = await step('after reopen (same profile)', 'restart');
      if ([...pre.keys()].every(u => sPost.tabs.some(t => t.url === u))) break;
      steps.pop();
      await sleep(250);
    }
    for (const t of sPost.tabs) if (pre.has(t.url)) { names.set(t.id, pre.get(t.url).name); t.name = pre.get(t.url).name; }
    const restored = [...pre.values()].map(p => {
      const q = sPost.tabs.find(t => t.url === p.url);
      return { name: p.name, url: p.url, preActive: p.active, postActive: q?.active, preDiscarded: p.discarded, postDiscarded: q?.discarded, postStatus: q?.status,
        pre: p.lastAccessed, post: q?.lastAccessed, delta: q && q.lastAccessed - p.lastAccessed, sinceRelaunch: q && q.lastAccessed - relaunchAt, idChanged: q && q.id !== p.id };
    });
    const loadsDuringRestore = [...server.hits].filter(([p, n]) => n !== (hitsAtQuit.get(p) || 0)).map(([p, n]) => `${p}x${n - (hitsAtQuit.get(p) || 0)}`);
    record.restart = { quitAt, relaunchAt, restored, loadsDuringRestore,
      startupActivations: sPost.events.filter(e => e.type === 'onActivated').map(e => e.name || e.tabId),
      extraTabs: sPost.tabs.filter(t => !pre.has(t.url)).map(t => ({ url: t.url, active: t.active })) };
    console.table(restored);
    note('restart: page loads between quit and first post-restart snapshot', loadsDuringRestore);
    // Only tabs inactive both before and after can show persisted age; a window's
    // active tab is re-activated by the restore itself.
    const inactive = restored.filter(r => !r.preActive && !r.postActive);
    expect(restored.every(r => r.post !== undefined), 'all fixture tabs restored after full restart', restored.map(r => [r.name, r.post !== undefined]));
    expect(restored.every(r => r.post === undefined || valid(r.post, sPost.now)), 'restored timestamps are finite, positive, not future', restored.map(r => r.post));
    expect(inactive.length > 0 && inactive.every(r => Math.abs(r.delta) <= 1000), 'CONTINUITY: restored inactive tabs keep pre-restart lastAccessed (within 1s)', inactive.map(r => [r.name, r.delta]));
    note('restart: restored inactive deltas exactly 0?', inactive.map(r => [r.name, r.delta === 0, r.delta]));
    expect(inactive.every(r => r.post <= quitAt), 'restored inactive tabs are not reset to startup time', inactive.map(r => [r.name, r.sinceRelaunch]));
    expect(restored.filter(r => r.postActive).every(r => r.post >= relaunchAt - RESTART_GAP), 'restored active tabs report restart-time viewing', restored.filter(r => r.postActive).map(r => [r.name, r.sinceRelaunch]));
    await sleep(GAP);
    const sPost2 = await step(`after reopen + ${GAP}ms idle`, 'none');
    expect(inactive.every(r => la(sPost2, r.name) === la(sPost, r.name)), 'restored inactive timestamps stable while idle', inactive.map(r => [r.name, la(sPost, r.name), la(sPost2, r.name)]));
    const wake = inactive.find(r => r.name === 'wtwo') || inactive[0];
    if (wake) {
      const sWake = await step(`view restored ${wake.name}`, 'api', () => call('update', { tabId: get(sPost2, wake.name).id, props: { active: true } }));
      expect(la(sWake, wake.name) >= sWake.before - TOL, 'viewing a restored tab updates lastAccessed', { la: la(sWake, wake.name), at: sWake.before });
      note('viewing a restored tab loaded it', sWake.loads);
    }
  } catch (error) {
    record.error = String(error?.stack || error);
    expect(false, 'probe completed without error', record.error);
  } finally {
    await launcher.stop().catch(e => note('stop failed', String(e)));
    display.stop();
    await server.close();
  }
  record.summary = { passed: assertions.filter(a => a.pass).length, failed: assertions.filter(a => !a.pass).map(a => a.id) };
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(record, null, 2));
  printTable(record);
  return record;
}

function printTable(r) {
  const tracked = ['alpha', 'bravo', 'charlie', 'wtwo', 'delta', 'charlie-dup', 'alpha-reopened'];
  const sec = v => (Number.isFinite(v) ? ((v - r.t0) / 1000).toFixed(2) : String(v));
  console.log(`\n${r.browser} ${r.version}: lastAccessed as seconds after probe start (* active, d discarded)`);
  console.table(r.steps.map(s => Object.fromEntries([['op', `${s.label} [${s.method}] @${sec(s.before)}`],
    ...tracked.map(n => { const t = s.tabs.find(x => x.name === n); return [n, t ? `${sec(t.lastAccessed)}${t.active ? '*' : ''}${t.discarded ? 'd' : ''}` : '']; })])));
}

await mkdir(runDir, { recursive: true });
const results = [];
if (BROWSERS.length > 1) {
  // One child process per browser: launchers set process-wide env (TMPDIR, DISPLAY).
  const { spawnSync } = await import('node:child_process');
  for (const b of BROWSERS) {
    spawnSync(process.execPath, [process.argv[1], `--browser=${b}`], { stdio: 'inherit', env: { ...process.env, PROBE_STALE_AGE_RUN: runDir } });
    results.push(JSON.parse(await readFile(path.join(runDir, b, 'result.json'), 'utf8')));
  }
} else results.push(await probe(BROWSERS[0]));
const summary = results.map(r => ({ browser: r.browser, version: r.version, binary: r.binary, driver: r.driver, profile: r.profile, ...r.summary,
  result: path.join(runDir, r.browser, 'result.json') }));
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.some(s => s.failed.length) ? 1 : 0;
