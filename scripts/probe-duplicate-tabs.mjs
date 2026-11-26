// Probe: what tabs.onCreated / onUpdated / onRemoved report in real Firefox and
// Chromium for the ways a duplicate tab can appear, before duplicate-tab
// prevention (R13) relies on openerTabId, index, pendingUrl, status or discarded.
//
// Isolation: a generated probe extension (tabs permission only, NOT the product
// build) runs in a disposable profile under $KIROCREW_SCRATCH, on an isolated Xvfb
// display, against a loopback-only (127.0.0.1) fixture + command server. Browser
// gestures (middle-click, Ctrl/Cmd-click, Ctrl+T + typing, Ctrl+Shift+T) are
// real XTest input on that display (scripts/test-native-key.py).
//
// Usage (from the package root):
//   node scripts/probe-duplicate-tabs.mjs [--browser=firefox|chromium|both]
// Env: KIROCREW_SCRATCH (required), FIREFOX_BINARY, GECKODRIVER, CHROMIUM_BINARY, XVFB_BINARY.
// Results: $KIROCREW_SCRATCH/probe-duplicate-tabs/<run>/<browser>/result.json and summary.md.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDisplay } from './test-display.mjs';
import { nativeKeys } from './test-browser-fixtures.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const BROWSERS = (arg('browser') || 'both') === 'both' ? ['firefox', 'chromium'] : [arg('browser')];
const scratch = process.env.KIROCREW_SCRATCH;
if (!scratch) throw new Error('Set KIROCREW_SCRATCH to an isolated scratch directory');
const runDir = process.env.PROBE_DUPES_RUN || path.join(scratch, 'probe-duplicate-tabs', new Date().toISOString().replace(/[:.]/g, '-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- loopback fixture pages + command channel ------------------------------
const doc = (title, body = '', head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}
  <style>html,body{margin:0;height:100%}a,button{display:block;width:100vw;height:100vh;font:40px sans-serif;border:0;background:#ddf}</style></head>
  <body>${body}</body></html>`;
function startServer() {
  const queue = [], waiters = [], pending = new Map();
  let seq = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const to = url.searchParams.get('to') || '/tab/none';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/cmd') {
      let done = false;
      const send = cmd => { done = true; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(cmd)); };
      if (queue.length) return send(queue.shift());
      const waiter = { send };
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); send({ op: 'noop' }); }, 10000);
      waiters.push(waiter);
      res.on('close', () => { if (done) return; clearTimeout(waiter.timer); const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
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
        pending.delete(reply.id); clearTimeout(p.timer);
        reply.error ? p.reject(new Error(`${p.op}: ${reply.error}`)) : p.resolve(reply.ok);
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', to); return res.end(); }
    if (url.pathname === '/jsredirect') return res.end(doc('Probe [jsredirect]', '', `<script>setTimeout(()=>location.replace(${JSON.stringify(to)}),300)</script>`));
    const [, kind, slug] = url.pathname.match(/^\/(tab|slow|link|open)\/([a-z0-9-]{1,40})$/) || [];
    const title = `Probe [${slug || 'none'}]`;
    if (kind === 'slow') return setTimeout(() => res.end(doc(title, '<p>slow</p>')), 3000);
    if (kind === 'link') {
      const rel = url.searchParams.get('rel') ? ` rel="${url.searchParams.get('rel')}"` : '';
      const href = to === 'self' ? url.pathname + url.search : to; // 'self' links to this very page
      return res.end(doc(title, `<a id="go" href="${href.replaceAll('"', '&quot;')}"${rel} autofocus>link to ${href}</a>`));
    }
    if (kind === 'open') {
      const features = url.searchParams.get('noopener') ? "'_blank','noopener'" : "'_blank'";
      return res.end(doc(title, `<button id="go" autofocus onclick="window.open(${JSON.stringify(to).replaceAll('"', "'")},${features})">open ${to}</button>`));
    }
    res.end(doc(title, `<h1>${title}</h1>`));
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
    base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, call,
    close: () => new Promise(r => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.send({ op: 'noop' }); } server.close(r); server.closeAllConnections?.(); }),
  })));
}

// ---- generated probe extension --------------------------------------------
function background(base) {
  return `const BASE = ${JSON.stringify(base)};
const api = globalThis.browser || globalThis.chrome;
const T0 = Date.now();
const events = [];
const rel = u => { if (u === undefined) return undefined; try { const x = new URL(u); return x.origin === BASE ? x.pathname + x.search : u; } catch { return String(u); } };
const log = (type, data) => { events.push({ t: Date.now(), type, ...data }); if (events.length > 2000) events.shift(); };
const shape = t => ({ tabId: t.id, windowId: t.windowId, index: t.index, url: rel(t.url), pendingUrl: rel(t.pendingUrl),
  openerTabId: t.openerTabId, status: t.status, discarded: t.discarded, active: t.active, incognito: t.incognito, cookieStoreId: t.cookieStoreId });
let armed = null; // { path, when: 'created'|'commit' }
const matches = u => armed && typeof u === 'string' && rel(u).startsWith(armed.path);
api.runtime.onStartup?.addListener(() => log('onStartup', {}));
api.windows.onCreated.addListener(w => log('windows.onCreated', { windowId: w.id, windowType: w.type }));
api.tabs.onCreated.addListener(t => {
  log('onCreated', shape(t));
  if (armed?.when === 'created' && matches(t.pendingUrl || t.url)) { armed = null; api.tabs.remove(t.id).then(() => log('armedRemoved', { tabId: t.id, at: 'created' }), e => log('armedRemoveFailed', { error: String(e) })); }
});
api.tabs.onUpdated.addListener((id, c, t) => {
  log('onUpdated', { tabId: id, change: Object.keys(c).join(','), cUrl: rel(c.url), cStatus: c.status, cDiscarded: c.discarded, ...shape(t), tabId: id });
  if (armed?.when === 'commit' && matches(c.url) ) { armed = null; api.tabs.remove(id).then(() => log('armedRemoved', { tabId: id, at: 'commit', status: t.status }), e => log('armedRemoveFailed', { error: String(e) })); }
});
api.tabs.onRemoved.addListener((id, i) => log('onRemoved', { tabId: id, windowClosing: i.isWindowClosing }));
api.tabs.onAttached.addListener((id, i) => log('onAttached', { tabId: id, ...i }));
api.tabs.onDetached.addListener((id, i) => log('onDetached', { tabId: id, ...i }));
api.tabs.onReplaced?.addListener((added, removed) => log('onReplaced', { added, removed }));
const abs = u => (u && u.startsWith('/') ? BASE + u : u);
async function run(c) {
  switch (c.op) {
    case 'ping': return { now: Date.now(), t0: T0 };
    case 'info': return { ua: navigator.userAgent, browserInfo: api.runtime.getBrowserInfo ? await api.runtime.getBrowserInfo() : null };
    case 'snapshot': return { now: Date.now(), tabs: (await api.tabs.query({})).map(shape),
      windows: (await api.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, type: w.type })), events: events.splice(0) };
    case 'create': return shape(await api.tabs.create({ url: abs(c.url), active: c.active, windowId: c.windowId, openerTabId: c.openerTabId }));
    case 'update': return shape(await api.tabs.update(c.tabId, { ...c.props, ...(c.props.url ? { url: abs(c.props.url) } : {}) }));
    case 'duplicate': return shape(await api.tabs.duplicate(c.tabId));
    case 'remove': await api.tabs.remove(c.tabId); return {};
    case 'move': return shape([].concat(await api.tabs.move(c.tabId, { windowId: c.windowId, index: -1 }))[0]);
    case 'windowCreate': { const w = await api.windows.create({ url: abs(c.url), focused: true, left: 0, top: 0, width: 1280, height: 800 }); return { id: w.id, tabs: w.tabs.map(shape) }; }
    case 'windowRemove': await api.windows.remove(c.windowId); return {};
    case 'arm': armed = { path: c.path, when: c.when }; return {};
    default: throw new Error('unknown op ' + c.op);
  }
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

const FIREFOX_ID = 'dupe-probe@tabvacuum.test';
const FIREFOX_UUID = '6d1c2c55-2c0b-4a8e-8f43-5b1b9a8e0d21';
async function writeExtension(dir, browserName, base) {
  await mkdir(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: 'ATV duplicate-tab probe (test only)', version: '0.0.1', permissions: ['tabs'],
    background: browserName === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    ...(browserName === 'firefox' ? { browser_specific_settings: { gecko: { id: FIREFOX_ID } } } : {}) };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, 'background.js'), background(base));
  return dir;
}

// ---- browser launchers (same isolation as probe-stale-age.mjs) -------------
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
        .setPreference('browser.tabs.warnOnClose', false)
        .setPreference('browser.sessionstore.warnOnQuit', false)
        .setPreference('dom.disable_open_during_load', false)
        .setPreference('extensions.background.idle.timeout', 600000);
      const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
      driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
      await driver.manage().window().setRect({ x: 0, y: 0, width: 1280, height: 800 });
      await driver.installAddon(extDir, true);
      return (await driver.getCapabilities()).get('browserVersion');
    },
    // Opens a URL "from another app": a second firefox invocation on the same profile.
    external: url => execFileSync(binary, ['-profile', profile, '--new-tab', url], { env, timeout: 15000 }),
    async stop() { if (driver) { const d = driver; driver = undefined; await d.quit(); } },
  };
}

async function chromiumLauncher(dir, env, extDir) {
  const { chromium } = await import('playwright');
  const profile = path.join(dir, 'profile');
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const binary = process.env.CHROMIUM_BINARY || chromium.executablePath();
  let context;
  return {
    binary, profile,
    async start() {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: binary, headless: false, env, viewport: null,
        ignoreDefaultArgs: ['about:blank'],
        args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--restore-last-session',
          '--window-position=0,0', '--window-size=1280,800', '--no-first-run', '--no-default-browser-check'],
      });
      return context.browser()?.version() || 'unknown';
    },
    // Opens a URL "from another app": a second chromium invocation hands it to the running profile.
    external: url => execFileSync(binary, [`--user-data-dir=${profile}`, '--no-sandbox', url], { env, timeout: 15000 }),
    async stop() { if (context) { const c = context; context = undefined; await c.close(); } },
  };
}

// ---- native pointer + typing on the isolated display ----------------------
const POINTER = `
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6"); xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]; x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]; x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x11.XKeysymToKeycode.restype = ctypes.c_uint
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d: raise SystemExit("Cannot open test display")
def key(name, down):
    xtst.XTestFakeKeyEvent(d, x11.XKeysymToKeycode(d, x11.XStringToKeysym(name.encode())), down, 0); x11.XFlush(d); time.sleep(0.02)
if sys.argv[1] == 'click':
    x, y, b = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]); mods = sys.argv[5:]
    xtst.XTestFakeMotionEvent(d, -1, x, y, 0); x11.XFlush(d); time.sleep(0.15)
    for m in mods: key(m, 1)
    xtst.XTestFakeButtonEvent(d, b, 1, 0); x11.XFlush(d); time.sleep(0.05)
    xtst.XTestFakeButtonEvent(d, b, 0, 0); x11.XFlush(d); time.sleep(0.05)
    for m in reversed(mods): key(m, 0)
else:
    names = {':': ('colon', True), '/': ('slash', False), '.': ('period', False), '-': ('minus', False), '?': ('question', True), '=': ('equal', False)}
    for ch in sys.argv[2]:
        name, shift = names.get(ch, (ch, False))
        if shift: key('Shift_L', 1)
        key(name, 1); key(name, 0)
        if shift: key('Shift_L', 0)
    key('Return', 1); key('Return', 0)
x11.XCloseDisplay(d)`;

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
  const cases = [];
  const record = { browser: browserName, binary: launcher.binary, profile: launcher.profile, display: env.DISPLAY, base: server.base, cases };
  const title = slug => `Probe [${slug}]`;
  const focus = slug => {
    for (let attempt = 0; ; attempt++) {
      try { return nativeKeys(env, ['Shift_L'], title(slug)); } catch (e) { if (attempt > 15) throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  };
  const keys = (list, slug) => { if (slug) focus(slug); nativeKeys(env, list); };
  const click = (button, mods = []) => execFileSync('python3', ['-c', POINTER, 'click', '640', '450', String(button), ...mods], { env });
  const type = text => execFileSync('python3', ['-c', POINTER, 'type', text], { env });
  const drain = async () => (await call('snapshot')).events;
  async function snapshot() { return call('snapshot'); }
  async function waitLoaded(pred, ms = 8000) {
    const deadline = Date.now() + ms; let s;
    while (Date.now() < deadline) { s = await snapshot(); s.tabs.length && buffer.push(...s.events); if (pred(s)) return s; await sleep(150); }
    return s;
  }
  let buffer = [];
  // Resets to one window holding the given fixture tabs, all loaded; returns their ids by slug.
  async function setup(urls) {
    const s0 = await snapshot();
    const win = s0.windows.find(w => w.type === 'normal' && w.focused) || s0.windows.find(w => w.type === 'normal');
    for (const w of s0.windows) if (w.id !== win.id) await call('windowRemove', { windowId: w.id }).catch(() => {});
    const first = s0.tabs.find(t => t.windowId === win.id);
    await call('update', { tabId: first.tabId, props: { url: urls[0], active: true } });
    for (const t of s0.tabs) if (t.windowId === win.id && t.tabId !== first.tabId) await call('remove', { tabId: t.tabId }).catch(() => {});
    const ids = { [urls[0]]: first.tabId };
    for (const u of urls.slice(1)) ids[u] = (await call('create', { url: u, active: false, windowId: win.id })).tabId;
    await call('update', { tabId: first.tabId, props: { active: true } });
    await waitLoaded(s => urls.every(u => s.tabs.some(t => t.url === u && t.status === 'complete')));
    await sleep(500);
    buffer = []; await drain();
    return { ids, windowId: win.id };
  }
  async function run(name, gesture, { urls, act, watch = 4000, note }) {
    const entry = { name, gesture, note };
    try {
      const { ids, windowId } = await setup(urls);
      const before = await snapshot();
      entry.before = before.tabs.filter(t => t.windowId === windowId).map(t => ({ tabId: t.tabId, index: t.index, url: t.url, active: t.active }));
      entry.ids = ids;
      const at = Date.now();
      entry.result = await act({ ids, windowId });
      await sleep(watch);
      const after = await snapshot();
      entry.events = [...buffer, ...after.events].map(e => ({ ...e, ms: e.t - at })); buffer = [];
      entry.after = after.tabs.map(t => ({ tabId: t.tabId, windowId: t.windowId, index: t.index, url: t.url, active: t.active, openerTabId: t.openerTabId, discarded: t.discarded }));
      entry.created = entry.events.filter(e => e.type === 'onCreated');
    } catch (error) {
      entry.error = String(error?.stack || error);
      console.log(`ERROR [${browserName}] ${name}: ${entry.error}`);
    }
    cases.push(entry);
    summarize(browserName, entry);
    return entry;
  }

  const DOC = '/tab/doc', OTHER = '/tab/other';
  try {
    record.version = await launcher.start();
    for (let i = 0; ; i++) { try { await call('ping', {}, 3000); break; } catch { if (i > 10) throw new Error('probe extension did not connect'); } }
    record.info = await call('info');
    console.log(`[${browserName}] ${record.version} ${record.info.ua}`);

    await run('tabs.duplicate', 'api (proxy for Duplicate Tab)', { urls: [DOC, OTHER], act: ({ ids }) => call('duplicate', { tabId: ids[DOC] }) });
    if (browserName === 'chromium') {
      // Chromium has no default Duplicate Tab key; Alt+D focuses the omnibox, Alt+Enter opens its URL in a new tab.
      await run('omnibox Alt+Enter on the doc', 'native keys', { urls: [DOC, OTHER], act: () => { keys(['Alt_L', 'd'], 'doc'); keys(['Alt_L', 'Return']); } });
    } else {
      await run('url bar Alt+Enter on the doc', 'native keys', { urls: [DOC, OTHER], act: () => { keys(['Control_L', 'l'], 'doc'); keys(['Alt_L', 'Return']); } });
    }
    const link = (slug, to, rel) => `/link/${slug}?to=${encodeURIComponent(to)}${rel ? `&rel=${rel}` : ''}`;
    await run('middle-click same-page link (from doc)', 'native middle-click', { urls: [link('doc', 'self'), OTHER], act: () => { focus('doc'); click(2); } });
    await run('Ctrl-click link to the doc, from the doc', 'native ctrl-click', { urls: [link('doc', 'self')], act: () => { focus('doc'); click(1, ['Control_L']); }, note: 'opens the same URL as its opener' });
    await run('Ctrl-click link from chat page to open doc', 'native ctrl-click', { urls: [DOC, link('chat', DOC)], act: ({ ids }) => call('update', { tabId: ids[link('chat', DOC)], props: { active: true } }).then(() => sleep(500)).then(() => { focus('chat'); click(1, ['Control_L']); }) });
    await run('middle-click rel=noopener link from chat page', 'native middle-click', { urls: [DOC, link('chat', DOC, 'noopener')], act: ({ ids }) => call('update', { tabId: ids[link('chat', DOC, 'noopener')], props: { active: true } }).then(() => sleep(500)).then(() => { focus('chat'); click(2); }) });
    await run('plain click target=_blank-less link? (window.open) from chat', 'native click', { urls: [DOC, `/open/chat?to=${encodeURIComponent(DOC)}`], act: ({ ids }) => call('update', { tabId: ids[`/open/chat?to=${encodeURIComponent(DOC)}`], props: { active: true } }).then(() => sleep(500)).then(() => { focus('chat'); click(1); }) });
    await run('window.open noopener from chat', 'native click', { urls: [DOC, `/open/chat?to=${encodeURIComponent(DOC)}&noopener=1`], act: ({ ids }) => call('update', { tabId: ids[`/open/chat?to=${encodeURIComponent(DOC)}&noopener=1`], props: { active: true } }).then(() => sleep(500)).then(() => { focus('chat'); click(1); }) });
    await run('Ctrl+T from the doc, type its URL', 'native keys + typing', { urls: [DOC, OTHER], act: async () => { keys(['Control_L', 't'], 'doc'); await sleep(800); type(`127.0.0.1:${server.port}${DOC}`); } });
    await run('Ctrl+T from the doc (blank new tab only)', 'native keys', { urls: [DOC], act: () => keys(['Control_L', 't'], 'doc') });
    await run('server redirect to open doc (tabs.create)', 'api', { urls: [DOC, OTHER], act: () => call('create', { url: `/redirect?to=${encodeURIComponent(DOC)}`, active: true }) });
    await run('JS redirect to open doc (tabs.create)', 'api', { urls: [DOC, OTHER], act: () => call('create', { url: `/jsredirect?to=${encodeURIComponent(DOC)}`, active: true }) });
    await run('external app opens the doc (doc is rightmost)', 'second browser invocation', { urls: [OTHER, DOC], act: () => launcher.external(`${server.base}${DOC}`) });
    await run('tabs.create doc twice within 200 ms', 'api', { urls: [DOC, OTHER], act: async () => { const a = await call('create', { url: '/slow/twice', active: true }); await sleep(200); const b = await call('create', { url: '/slow/twice', active: true }); return [a, b]; } });

    // D5: close a tab before it commits, then Reopen Closed Tab. A sentinel closed first shows
    // whether Reopen restores the uncommitted tab or skips it for the older one.
    for (const when of ['created', 'commit']) {
      await run(`Reopen Closed Tab after close at ${when}`, 'native ctrl-click + Ctrl+Shift+T', {
        urls: [link('chat', '/slow/target'), '/tab/sentinel'], watch: 6000,
        act: async ({ ids }) => {
          await call('remove', { tabId: ids['/tab/sentinel'] }); await sleep(600);
          await call('arm', { path: '/slow/target', when });
          focus('chat'); click(1, ['Control_L']);
          await sleep(when === 'commit' ? 4500 : 1500);
          keys(['Control_L', 'Shift_L', 't'], 'chat');
        },
      });
    }

    // D6 proxy: close a two-tab window, then restore it (Ctrl+Shift+N in Firefox, Ctrl+Shift+T in Chromium).
    await run('reopen closed window', 'native keys', { urls: [DOC], watch: 5000, act: async ({ windowId }) => {
      const w = await call('windowCreate', { url: '/tab/restored-a' }); await call('create', { url: '/tab/restored-b', windowId: w.id, active: false });
      await sleep(2000); await call('windowRemove', { windowId: w.id }); await sleep(800);
      keys(browserName === 'firefox' ? ['Control_L', 'Shift_L', 'n'] : ['Control_L', 'Shift_L', 't'], 'doc');
      return { windowId };
    } });
    await run('tabs.move doc tab to another window', 'api', { urls: [DOC, OTHER], act: async ({ ids }) => {
      const w = await call('windowCreate', { url: '/tab/elsewhere' }); await sleep(1000); return call('move', { tabId: ids[OTHER], windowId: w.id });
    } });

    // Startup restore (Chromium only: Firefox reinstalls the temporary probe add-on after startup, so it cannot see restore).
    if (browserName === 'chromium') {
      await setup([DOC, OTHER, '/tab/third']);
      await sleep(1500);
      await launcher.stop(); await sleep(1500);
      await launcher.start();
      for (let i = 0; ; i++) { try { await call('ping', {}, 3000); break; } catch { if (i > 10) throw new Error('probe did not reconnect'); } }
      await sleep(5000);
      const s = await snapshot();
      const entry = { name: 'browser restart with session restore', gesture: 'relaunch', events: s.events.map(e => ({ ...e, ms: e.t - s.events[0]?.t })) };
      entry.created = entry.events.filter(e => e.type === 'onCreated');
      cases.push(entry); summarize(browserName, entry);
    }
  } catch (error) {
    record.error = String(error?.stack || error);
    console.log(`ERROR [${browserName}] ${record.error}`);
  } finally {
    await launcher.stop().catch(() => {});
    display.stop();
    await server.close();
  }
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(record, null, 2));
  return record;
}

// One line per new tab: what onCreated said, then the URL/status path until it settled.
function summarize(browserName, entry) {
  const lines = [`\n## [${browserName}] ${entry.name} (${entry.gesture})${entry.error ? ` ERROR ${entry.error.split('\n')[0]}` : ''}`];
  for (const c of entry.created || []) {
    const opener = c.openerTabId === undefined ? 'none' : Object.entries(entry.ids || {}).find(([, id]) => id === c.openerTabId)?.[0] ?? c.openerTabId;
    const later = (entry.events || []).filter(e => e.tabId === c.tabId && e.type !== 'onCreated')
      .map(e => `${e.ms}ms ${e.type === 'onUpdated' ? `${e.change}${e.cUrl ? `=${e.cUrl}` : ''}${e.cStatus ? `=${e.cStatus}` : ''}${e.pendingUrl ? ` pending=${e.pendingUrl}` : ''}` : e.type}`);
    lines.push(`- new tab ${c.tabId} @${c.ms}ms index=${c.index} url=${c.url} pendingUrl=${c.pendingUrl} opener=${opener} status=${c.status} discarded=${c.discarded} active=${c.active}`);
    lines.push(`  ${later.slice(0, 14).join(' | ')}`);
  }
  for (const e of (entry.events || []).filter(x => ['armedRemoved', 'armedRemoveFailed', 'onAttached', 'onDetached', 'onStartup', 'windows.onCreated'].includes(x.type))) lines.push(`- ${e.ms}ms ${e.type} ${JSON.stringify(e)}`);
  if (entry.after) lines.push(`- after: ${entry.after.map(t => `${t.tabId}:${t.url}${t.active ? '*' : ''}`).join(', ')}`);
  entry.summary = lines.join('\n');
  console.log(entry.summary);
}

await mkdir(runDir, { recursive: true });
const results = [];
if (BROWSERS.length > 1) {
  const { spawnSync } = await import('node:child_process');
  for (const b of BROWSERS) {
    spawnSync(process.execPath, [process.argv[1], `--browser=${b}`], { stdio: 'inherit', env: { ...process.env, PROBE_DUPES_RUN: runDir } });
    results.push(JSON.parse(await readFile(path.join(runDir, b, 'result.json'), 'utf8')));
  }
} else results.push(await probe(BROWSERS[0]));
await writeFile(path.join(runDir, 'summary.md'), results.map(r => `# ${r.browser} ${r.version}\n${r.error ? `ERROR ${r.error}\n` : ''}${r.cases.map(c => c.summary).join('\n')}`).join('\n\n'));
console.log(`\nResults: ${runDir}`);
