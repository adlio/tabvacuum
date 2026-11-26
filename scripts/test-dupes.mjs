// Real-browser acceptance harness for opt-in duplicate-tab prevention (R14,
// issue #20, Switch mode). Loads the PRODUCT build into a disposable profile on
// a private Xvfb display, against a loopback fixture site, and runs every
// scenario from issue #20 plus the plan-review P5 additions.
//
// Usage, from the package root after `npm run build`:
//   node scripts/test-dupes.mjs firefox|chromium [--only=ID,ID]
// Env: KIROCREW_SCRATCH or TMPDIR (required), FIREFOX_BINARY, GECKODRIVER,
//   CHROMIUM_BINARY, XVFB_BINARY, UPGRADE_FROM (git ref of the "old" build for
//   the upgrade check, default origin/main), TABVACUUM_DIST (a different build
//   directory to test, for before/after comparisons).
// Output: $KIROCREW_SCRATCH/dupes/<browser>-<run>/result.json and summary.md.
//
// How each gesture is produced is recorded per scenario ("via"):
//   native   - real XTest keys/pointer on the isolated display (test-native-key.py)
//   external - a second browser invocation handing a URL to the running profile
//              (stands in for a chat or mail app opening a link)
//   browser  - the browser's own UI command (Firefox chrome code), no XTest
//   api      - tabs/windows API from the extension's background, as a proxy for
//              a gesture this harness cannot produce natively
// The harness only reads the product's state (tabs, storage) and writes its
// settings through storage.local; it never calls product internals.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { startDisplay } from './test-display.mjs';
import { outputDir, sleep, until, nativeKeys } from './test-browser-fixtures.mjs';

const name = process.argv[2];
if (!['firefox', 'chromium'].includes(name)) throw new Error('usage: node scripts/test-dupes.mjs firefox|chromium [--only=ID,...]');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const { scratch, directory } = await outputDir(path.join('dupes', `${name}-${runId}`));
const W = 1280, H = 900;

// ---- loopback fixture site --------------------------------------------------
const titleOf = slug => `Dupe [${slug}]`;
const page = (title, body = `<h1>${title}</h1>`, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}
<style>html,body{margin:0;height:100%}a{display:block;width:100vw;height:100vh;font:40px sans-serif;background:#ddf}</style></head><body>${body}</body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const to = url.searchParams.get('to') || '/tab/none';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', to); return res.end(); }
  if (url.pathname === '/jsredirect') return res.end(page('Redirecting', '<p>wrapper</p>', `<script>setTimeout(()=>location.replace(${JSON.stringify(to)}),300)</script>`));
  const [, kind, slug] = url.pathname.match(/^\/(tab|slow|link)\/([a-z0-9-]{1,60})$/) || [];
  if (kind === 'slow') return setTimeout(() => res.end(page(titleOf(slug))), 2500);
  if (kind === 'link') {
    const href = to === 'self' ? url.pathname + url.search : to;
    const target = url.searchParams.get('target') ? ` target="${url.searchParams.get('target')}"` : '';
    return res.end(page(titleOf(slug), `<a id="go" href="${href.replaceAll('"', '&quot;')}"${target}>link to ${href}</a>`));
  }
  res.end(page(titleOf(slug || 'none')));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const rel = u => (typeof u === 'string' && u.startsWith(base) ? u.slice(base.length) : u);
const abs = u => (u.startsWith('/') ? base + u : u);

// ---- display + native input -------------------------------------------------
const display = await startDisplay(scratch);
const env = display.env;
process.env.DISPLAY = env.DISPLAY;
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
    names = {':': ('colon', True), '/': ('slash', False), '.': ('period', False), '-': ('minus', False), '?': ('question', True), '=': ('equal', False), '#': ('numbersign', True), '&': ('ampersand', True)}
    for ch in sys.argv[2]:
        name, shift = names.get(ch, (ch, False))
        if shift: key('Shift_L', 1)
        key(name, 1); key(name, 0)
        if shift: key('Shift_L', 0)
    key('Return', 1); key('Return', 0)
x11.XCloseDisplay(d)`;
const focus = slug => {
  for (let attempt = 0; ; attempt++) {
    try { return nativeKeys(env, ['Shift_L'], titleOf(slug)); } catch (e) { if (attempt > 20) throw e; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
};
const keys = (list, slug) => { if (slug) focus(slug); nativeKeys(env, list); };
const click = (x, y, button = 1, mods = []) => execFileSync('python3', ['-c', POINTER, 'click', String(Math.round(x)), String(Math.round(y)), String(button), ...mods], { env });
const typeUrl = text => execFileSync('python3', ['-c', POINTER, 'type', text], { env });
const typed = p => `127.0.0.1:${server.address().port}${p}`;

// ---- builds: the PR build, and the old build for the upgrade check ----------
const distDir = path.resolve(process.env.TABVACUUM_DIST || (name === 'firefox' ? 'dist/firefox' : 'dist/chrome')); // TABVACUUM_DIST: test another build
const extDir = path.join(directory, 'extension'); // the installed copy; swapped for the upgrade check
async function buildOld() {
  const ref = process.env.UPGRADE_FROM || 'origin/main';
  const dir = path.join(directory, 'old-src');
  await mkdir(dir, { recursive: true });
  execFileSync('sh', ['-c', `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(dir)}`]);
  if (!existsSync(path.join(dir, 'node_modules'))) symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'));
  execFileSync(process.execPath, ['scripts/build.js'], { cwd: dir, stdio: 'ignore' });
  return { ref, sha: execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim(), dist: path.join(dir, name === 'firefox' ? 'dist/firefox' : 'dist/chrome') };
}
async function install(from) { await rm(extDir, { recursive: true, force: true }); await cp(from, extDir, { recursive: true }); }

// ---- browser adapters -------------------------------------------------------
// Each returns: api(body) in the extension background (api = browser), optionsEval(body),
// reload(), external(url), sleepWorker(), openPrivate(url), privateApi(body), plus
// browser-specific helpers. Unsupported helpers are null.
// Firefox runs each harness evaluation in a fresh sandbox, so a sandbox global does not
// survive to the next read; there the log is kept on the background page's DOM, which
// every sandbox shares. Chromium's worker has no DOM and keeps one global.
const LOGSTORE = `const el = globalThis.document?.documentElement;
  const store = el ? { has: () => el.hasAttribute('data-dl'), init: () => el.setAttribute('data-dl', ''), push: x => el.setAttribute('data-dl', el.getAttribute('data-dl') + x + '\\n'),
      take: () => { const v = el.getAttribute('data-dl') || ''; if (el.hasAttribute('data-dl')) el.setAttribute('data-dl', ''); return v.split('\\n').filter(Boolean); } }
    : { has: () => !!globalThis.__dl, init: () => { globalThis.__dl = []; }, push: x => globalThis.__dl.push(x), take: () => (globalThis.__dl || []).splice(0) };`;
const INSTRUMENT = `${LOGSTORE}
  if (!store.has()) { store.init(); const L = (type, d) => store.push(JSON.stringify({ t: Date.now(), type, ...d }));
  api.tabs.onCreated.addListener(t => L('created', { id: t.id, url: t.url, pending: t.pendingUrl, opener: t.openerTabId, index: t.index, win: t.windowId, discarded: t.discarded, status: t.status }));
  api.tabs.onUpdated.addListener((id, c) => { if (c.url !== undefined || c.status) L('updated', { id, url: c.url, status: c.status }); });
  api.tabs.onRemoved.addListener(id => L('removed', { id }));
  api.tabs.onActivated.addListener(i => L('activated', { id: i.tabId, win: i.windowId }));
  api.windows.onFocusChanged.addListener(w => L('focus', { win: w })); }
  return true;`;

async function firefoxAdapter() {
  const { Builder } = await import('selenium-webdriver');
  const firefox = (await import('selenium-webdriver/firefox.js')).default;
  process.env.TMPDIR = directory;
  const ADDON = 'tabvacuum@adlio', uuid = 'a3906219-0180-4fa2-a2d8-a90270e6e501', ext = `moz-extension://${uuid}`;
  const binary = process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox');
  const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
  const profile = path.join(directory, 'profile');
  await mkdir(profile, { recursive: true });
  const options = new firefox.Options().setBinary(binary).addArguments('-profile', profile)
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('browser.tabs.warnOnClose', false)
    .setPreference('browser.sessionstore.warnOnQuit', false)
    .setPreference('dom.disable_open_during_load', false)
    .setPreference('privacy.userContext.enabled', true)
    .setPreference('extensions.background.idle.timeout', 600000)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON]: uuid }));
  const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
  if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) service.addArguments('--allow-system-access');
  else options.addArguments('-remote-allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  await driver.manage().window().setRect({ x: 0, y: 0, width: W, height: H });
  await driver.installAddon(extDir, true);
  await driver.get(abs('/tab/home'));
  await driver.setContext('chrome');
  const run = (body, args) => driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    (async()=>{${body}})().then(done,e=>done({testError:String(e)}));`, ...args).then(v => { if (v?.testError) throw new Error(v.testError); return v; });
  // Chrome-context scripts run in the window the driver is attached to; when a scenario
  // closes that window (Merge Windows, setup), re-attach to a window that still exists.
  const chrome = async (body, ...args) => {
    try { return await run(body, args); } catch (e) {
      if (!/discarded|no such window|NoSuchWindow/i.test(String(e))) throw e;
      const handles = await driver.getAllWindowHandles();
      await driver.switchTo().window(handles[0]);
      return run(body, args);
    }
  };
  const inContext = (bcExpr, body) => chrome(`const bc=${bcExpr}; if(!bc) throw new Error('context not running');
    return bc.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',{script:arguments[0],args:[],opts:{}});`,
  `return (async()=>{const api=browser;${body}})()`, ADDON);
  const BG = 'WebExtensionPolicy.getByID(arguments[1])?.extension?.backgroundContext?.xulBrowser?.browsingContext';
  const api = body => inContext(BG, body);
  const running = () => until(async () => (await api('return !!api.runtime.id')) === true, 'background running', 15000);
  await running();
  // Private windows allowed (the store about:addons writes), throwaway profile only.
  await chrome(`const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    await ExtensionPermissions.add(arguments[0], { permissions: ['internal:privateBrowsingAllowed'], origins: [] });
    await (await AddonManager.getAddonByID(arguments[0])).reload(); return true;`, ADDON);
  await sleep(1000); await running();
  return {
    ext, profile, binary, driver,
    versions: { browser: (await driver.getCapabilities()).get('browserVersion'), driver: execFileSync(driverPath, ['--version'], { encoding: 'utf8' }).split('\n')[0] },
    api, chrome, running,
    // An extension page in a background tab, evaluated, then closed.
    async optionsEval(body) {
      await chrome(`window.__opt=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),inBackground:true}); return true;`, `${ext}/options.html`);
      const FIND = `(()=>{ for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.currentURI.spec.startsWith('${ext}/options.html')) return t; })()`;
      let value;
      await until(async () => { value = await inContext(`${FIND}?.linkedBrowser.browsingContext`, `await new Promise(r=>setTimeout(r,300)); ${body}`); return true; }, 'options page', 15000);
      await chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('${ext}/options.html')) w.gBrowser.removeTab(t); return true;`);
      return value;
    },
    async reload() {
      await chrome(`const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await (await AddonManager.getAddonByID(arguments[0])).reload(); return true;`, ADDON);
      await sleep(1000); await running();
    },
    external: url => execFileSync(binary, ['-profile', profile, '--new-tab', url], { env, timeout: 20000 }),
    async sleepWorker() {
      await chrome('await WebExtensionPolicy.getByID(arguments[0]).extension.terminateBackground(); return true;', ADDON);
      await sleep(500);
      return chrome('return !WebExtensionPolicy.getByID(arguments[0]).extension.backgroundContext;', ADDON);
    },
    privateApi: body => api(body), // one background serves both contexts
    async openPrivate(url) { return api(`return (await api.windows.create({ incognito: true, url: ${JSON.stringify(abs(url))}, left: 0, top: 0, width: ${W}, height: ${H} })).id;`); },
    // A tab in Firefox container 1, opened the way the browser's own UI does.
    containerTab: url => chrome(`gBrowser.selectedTab = gBrowser.addTab(arguments[0], { userContextId: 1, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, abs(url)),
    // Native right-click on the selected tab, then a native click on Duplicate Tab.
    async duplicateNative() {
      await chrome('window.focus(); return true;');
      const t = await chrome(`const t=gBrowser.selectedTab, r=t.getBoundingClientRect(); return {x: window.mozInnerScreenX + r.left + r.width / 2, y: window.mozInnerScreenY + r.top + r.height / 2};`);
      click(t.x, t.y, 3);
      await until(() => chrome('return document.getElementById("tabContextMenu").state === "open"'), 'tab context menu open');
      await sleep(300);
      const i = await chrome(`const i=document.getElementById('context_duplicateTab'); const r=i.getBoundingClientRect(); return {x: i.screenX + r.width / 2, y: i.screenY + r.height / 2, hidden: i.hidden};`);
      click(i.x, i.y, 1);
      return { via: 'native', menuItem: i };
    },
    // History > Reopen closed window, the browser's own command.
    reopenWindow: () => chrome('SessionStore.undoCloseWindow(0); return true;'),
    restart: null,
    // TabVacuum Search's own "open this history result" request, sent from a real
    // Search page that holds a launch token. Search is launched from a foreground
    // Settings tab (its origin), which cannot host the overlay, so Search opens as a popup window.
    async searchHistory(url) {
      const tabBy = prefix => `(()=>{ for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.currentURI.spec.startsWith('${prefix}')) return t; })()`;
      await chrome(`gBrowser.selectedTab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, `${ext}/options.html`);
      await until(() => inContext(`${tabBy(`${ext}/options.html`)}?.linkedBrowser.browsingContext`, 'return !!document.getElementById("prevent-duplicates");'), 'options page', 15000);
      await inContext(`${tabBy(`${ext}/options.html`)}?.linkedBrowser.browsingContext`, 'api.runtime.sendMessage({ command: "launchSearch" }).catch(() => {}); return true;');
      const ok = await until(() => chrome(`return !!${tabBy(`${ext}/search.html?token=`)};`), 'search page', 10000).catch(() => false);
      let reply = { error: 'no popup Search page opened' };
      if (ok) {
        reply = await inContext(`${tabBy(`${ext}/search.html?token=`)}?.linkedBrowser.browsingContext`,
          `return await api.runtime.sendMessage({ command: 'activateHistoryResult', token: new URLSearchParams(location.search).get('token'), url: ${JSON.stringify(url)} });`)
          .catch(e => ({ replyLost: String(e.message).split('\n')[0] }));
      }
      await sleep(4000); // past the 3 s re-judge grace, then drop the Settings tab
      await chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('${ext}/options.html')) w.gBrowser.removeTab(t); return true;`);
      return reply;
    },
    async shutdown() { await driver.quit(); },
  };
}

async function chromiumAdapter() {
  const { chromium } = await import('playwright');
  const profile = path.join(directory, 'profile');
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const binary = process.env.CHROMIUM_BINARY || chromium.executablePath();
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath: binary, headless: false, env, viewport: null, ignoreDefaultArgs: ['about:blank'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--restore-last-session',
      '--window-position=0,0', `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check'],
  });
  let context = await launch();
  const findWorker = async (ms = 15000) => {
    let w;
    await until(() => (w = context.serviceWorkers().find(s => s.url().endsWith('/background.js') && !dead.has(s))), 'service worker', ms);
    return w;
  };
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const ext = worker.url().replace(/\/background\.js$/, '');
  const extId = new URL(ext).host;
  let pg = context.pages()[0] || await context.newPage();
  await pg.goto(abs('/tab/home'));
  let cdp = await context.browser().newBrowserCDPSession();
  // Raw CDP to targets Playwright does not track (the incognito worker).
  const sessions = new Map(); let nextId = 0;
  const send = (session, method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error(`CDP timeout ${method}`)); }, 15000);
    function receive(event) {
      if (event.sessionId !== session) return;
      const value = JSON.parse(event.message);
      if (value.id !== id) return;
      clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive);
      if (value.error || value.result?.exceptionDetails) reject(new Error(JSON.stringify(value.error || value.result.exceptionDetails).slice(0, 600)));
      else resolve(value.result);
    }
    cdp.on('Target.receivedMessageFromTarget', receive);
    cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method, params }) }).catch(e => { clearTimeout(timer); reject(e); });
  });
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const workerTargets = async () => (await targets()).filter(t => t.type === 'service_worker' && t.url === `${ext}/background.js`);
  async function evalIn(targetId, body) {
    if (!sessions.has(targetId)) sessions.set(targetId, (await cdp.send('Target.attachToTarget', { targetId, flatten: false })).sessionId);
    const r = await send(sessions.get(targetId), 'Runtime.evaluate', { expression: `(async()=>{const api=globalThis.browser||chrome;${body}})()`, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }
  let normalContextId = (await workerTargets())[0]?.browserContextId;
  // Evaluates in the normal-context worker through raw CDP: Playwright keeps a
  // dead handle after a worker stops and does not report the restarted one.
  const dead = new WeakSet();
  const api = async (body, retry = true) => {
    let t = (await workerTargets()).find(x => x.browserContextId === normalContextId);
    if (!t) {
      await wake();
      await until(async () => (t = (await workerTargets()).find(x => x.browserContextId === normalContextId)), 'normal worker', 15000);
    }
    try {
      return await evalIn(t.targetId, body);
    } catch (e) {
      if (!retry || /exceptionId/.test(String(e.message))) throw e; // a JS exception is a real answer
      sessions.delete(t.targetId);
      await sleep(500);
      return api(body, false);
    }
  };
  const developerPrivate = async (fn, arg) => {
    const m = await context.newPage(); await m.goto('chrome://extensions/');
    const v = await m.evaluate(fn, arg); await m.close(); return v;
  };
  const wake = async () => { const p = await context.newPage(); await p.goto(`${ext}/options.html`).catch(() => {}); await p.close(); };
  return {
    ext, profile, binary,
    get context() { return context; },
    versions: { browser: context.browser().version(), binary },
    api,
    running: () => api(INSTRUMENT),
    async optionsEval(body) {
      const p = await context.newPage();
      await p.goto(`${ext}/options.html`); await sleep(500);
      const v = await p.evaluate(`(async()=>{const api=globalThis.browser||chrome;${body}})()`);
      await p.close();
      return v;
    },
    async reload() {
      await api('setTimeout(() => chrome.runtime.reload(), 50); return true;').catch(() => {});
      await sleep(2000); sessions.clear();
      await until(async () => (await api('return chrome.runtime.id;').catch(() => null)) === extId, 'reloaded worker', 20000);
    },
    // Another app opening a URL. A second chromium invocation cannot hand a URL to
    // the running profile on this host (its ProcessSingleton connect fails and it
    // aborts with "Failed to create ... SingletonLock: File exists"), so the browser
    // opens the tab itself: CDP Target.createTarget, a new foreground tab with no
    // opener appended to the window, the shape an external open has.
    // shortcut: CDP stand-in, switch to a real second invocation where the singleton handoff works.
    external: async url => { await cdp.send('Target.createTarget', { url }); },
    externalVia: 'browser (CDP Target.createTarget; second-process launch blocked on this host)',
    async sleepWorker() {
      const [t] = await workerTargets();
      if (!t) return 'no worker';
      // ServiceWorker.stopAllWorkers on a page session stops the extension's worker the way idle termination does.
      const s = await context.newCDPSession(context.pages()[0] || await context.newPage());
      await s.send('ServiceWorker.enable').catch(() => {});
      const r = await s.send('ServiceWorker.stopAllWorkers').then(() => 'stopAllWorkers', e => String(e));
      await s.detach().catch(() => {});
      await sleep(1500);
      return { method: r, workerGone: (await workerTargets()).length === 0 };
    },
    async enableIncognito() {
      const old = worker;
      await developerPrivate(async ([id]) => {
        const call = (fn, arg) => new Promise((resolve, reject) => chrome.developerPrivate[fn](arg, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(true))));
        await call('updateProfileConfiguration', { inDeveloperMode: true });
        await call('updateExtensionConfiguration', { extensionId: id, incognitoAccess: true });
        return true;
      }, [extId]);
      await sleep(2000); sessions.clear();
      await until(async () => (await api('return chrome.runtime.id;').catch(() => null)) === extId, 'reloaded worker', 20000);
    },
    // Split incognito: the normal worker gets no window back, so read the id from the incognito worker.
    async openPrivate(url) {
      await api(`await api.windows.create({ incognito: true, url: ${JSON.stringify(abs(url))}, left: 0, top: 0, width: ${W}, height: ${H} }); return true;`);
      let id;
      await until(async () => (id = await this.privateApi('return (await api.windows.getAll()).find(w => w.incognito)?.id;')), 'incognito window', 15000);
      return id;
    },
    async privateApi(body) {
      let t;
      await until(async () => (t = (await workerTargets()).find(x => x.browserContextId !== normalContextId)), 'incognito worker', 15000);
      return evalIn(t.targetId, body);
    },
    containerTab: null,
    async duplicateNative() {
      // Native right-click on the first tab in the strip, then the menu's "Duplicate" mnemonic.
      await (context.pages()[0] || pg).bringToFront();
      click(110, 20, 3); await sleep(700);
      nativeKeys(env, ['d']);
      return { via: 'native (tab strip right-click, D mnemonic)' };
    },
    reopenWindow: null,
    async restart() {
      await context.close(); await sleep(1500);
      context = await launch();
      pg = context.pages()[0];
      cdp = await context.browser().newBrowserCDPSession(); sessions.clear();
      await until(async () => (normalContextId = (await workerTargets())[0]?.browserContextId), 'worker after restart', 20000);
    },
    // TabVacuum Search's own "open this history result" request, sent from a
    // real Search page that holds a launch token (popup-window Search).
    async searchHistory(url) {
      const before = context.pages().length;
      const p = await context.newPage(); await p.goto(`${ext}/options.html`);
      await p.evaluate(() => chrome.runtime.sendMessage({ command: 'launchSearch' })).catch(() => {});
      // The Settings tab is Search's origin: closing it dismisses Search, so it stays open until the result opens.
      let search;
      await until(() => (search = context.pages().find(x => x.url().startsWith(`${ext}/search.html?token=`))), 'search page', 10000).catch(() => {});
      if (!search) { await p.close().catch(() => {}); return { error: `no popup search page (pages ${before} -> ${context.pages().length})` }; }
      // Search closes its window once the result opens, which can drop the reply.
      const reply = await search.evaluate(u => chrome.runtime.sendMessage({ command: 'activateHistoryResult', token: new URLSearchParams(location.search).get('token'), url: u }), url)
        .catch(e => ({ replyLost: String(e.message).split('\n')[0] }));
      await sleep(4000); // past the 3 s re-judge grace, then drop the Settings tab
      await p.close().catch(() => {});
      return reply;
    },
    async shutdown() { await context.close(); },
  };
}

// ---- state helpers ----------------------------------------------------------
let b; // adapter
const results = [];
const SNAP = `const tabs = (await api.tabs.query({})).map(t => ({ id: t.id, win: t.windowId, index: t.index, url: t.url, active: t.active, pinned: t.pinned,
  discarded: t.discarded, status: t.status, incognito: t.incognito, cs: t.cookieStoreId, lastAccessed: t.lastAccessed }));
  const wins = (await api.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, incognito: w.incognito }));
  ${LOGSTORE} const log = store.take().map(x => JSON.parse(x));
  const sess = await api.storage.session.get(['dupe.normal', 'dupe.private']);
  return { tabs, wins, log, store: sess };`;
const snap = async (priv = false) => {
  const s = await (priv ? b.privateApi(SNAP) : b.api(SNAP));
  for (const t of s.tabs) t.url = rel(t.url);
  for (const e of s.log) { if (e.url) e.url = rel(e.url); if (e.pending) e.pending = rel(e.pending); }
  return s;
};
const instrument = () => b.api(INSTRUMENT);
const set = patch => b.api(`await api.storage.local.set(${JSON.stringify(patch)}); return true;`);
const ON = { preventDuplicates: true, preventDuplicatesMode: 'switch', preventDuplicatesNever: [], ignoreFragments: false, ignoreQueryParams: false };

// One normal window holding exactly `urls` (all loaded), with the feature OFF while
// setting up, so the fixture tabs are existing tabs. Then the feature is turned on.
async function setup(urls, settings = {}, { activeIndex = 0 } = {}) {
  await set({ preventDuplicates: false });
  await sleep(150);
  let s = await snap();
  const normal = s.wins.filter(w => !w.incognito);
  const keep = normal.find(w => w.focused) || normal[0];
  for (const w of s.wins) if (w.id !== keep.id) await b.api(`await api.windows.remove(${w.id}); return true;`).catch(() => {});
  const inWin = s.tabs.filter(t => t.win === keep.id);
  const first = inWin[0];
  await b.api(`await api.tabs.update(${first.id}, { url: ${JSON.stringify(abs(urls[0]))}, active: true, pinned: false }); return true;`);
  for (const t of inWin.slice(1)) await b.api(`await api.tabs.remove(${t.id}); return true;`).catch(() => {});
  const ids = [first.id];
  for (const u of urls.slice(1)) ids.push(await b.api(`return (await api.tabs.create({ url: ${JSON.stringify(abs(u))}, windowId: ${keep.id}, active: false })).id;`));
  await b.api(`await api.tabs.update(${ids[activeIndex]}, { active: true }); await api.windows.update(${keep.id}, { focused: true }); return true;`);
  await until(async () => { s = await snap(); return ids.every(id => s.tabs.find(t => t.id === id)?.status === 'complete'); }, 'setup loaded', 15000);
  await set({ ...ON, ...settings });
  await instrument();
  await sleep(1300); // past the bulk-open burst window of the setup tabs
  await snap(); // drain the log
  return { ids, win: keep.id };
}
// Polls until pred(snapshot) holds or ms passes; always returns the last snapshot and the whole log.
async function observe(pred, ms = 5000, priv = false) {
  const deadline = Date.now() + ms, log = [];
  let s;
  for (;;) {
    s = await snap(priv); log.push(...s.log);
    if ((pred && pred(s)) || Date.now() > deadline) break;
    await sleep(150);
  }
  s.log = log;
  return s;
}
const count = (s, p) => s.tabs.filter(t => t.url === p).length;
const activeIn = (s, win) => s.tabs.find(t => t.win === win && t.active);
const reasons = (s, space = 'dupe.normal') => Object.fromEntries(Object.entries(s.store?.[space]?.tabs || {}).map(([id, r]) => [id, r.done || r.ignored || 'judging']));
const brief = s => ({ tabs: s.tabs.map(t => `${t.id}@w${t.win}:${t.url}${t.active ? '*' : ''}${t.pinned ? ' pinned' : ''}${t.discarded ? ' asleep' : ''}${t.incognito ? ' private' : ''}${t.cs && t.cs !== 'firefox-default' && t.cs !== 'firefox-private' ? ` ${t.cs}` : ''}`),
  focused: s.wins.find(w => w.focused)?.id, records: reasons(s), log: s.log.map(e => `+${e.t - (s.log[0]?.t ?? e.t)}ms ${e.type} ${e.id ?? ''}${e.url ? ` ${e.url}` : ''}${e.pending ? ` pending=${e.pending}` : ''}${e.opener !== undefined ? ` opener=${e.opener}` : ''}${e.status ? ` ${e.status}` : ''}${e.win !== undefined && e.type !== 'created' ? ` w${e.win}` : ''}`) });

// A scenario returns { pass: bool, observed: string, detail } or { untestable: why }.
const scenarios = [];
const scenario = (id, title, expected, fn) => scenarios.push({ id, title, expected, fn });
// Switch latency: for each new tab that was removed, ms from onCreated and from its first web URL to onRemoved.
const latency = s => (s?.log || []).filter(e => e.type === 'created').map(c => {
  const gone = s.log.find(e => e.type === 'removed' && e.id === c.id);
  const commit = s.log.find(e => e.type === 'updated' && e.id === c.id && /^\//.test(e.url ?? ''));
  return gone ? { id: c.id, fromCreated: gone.t - c.t, fromCommit: commit ? gone.t - commit.t : null } : null;
}).filter(Boolean);
const verdict = (pass, observed, s, extra = {}) => ({ pass, observed, detail: { ...(s ? brief(s) : {}), latency: latency(s), ...extra } });
const slugs = id => ({ doc: `/tab/doc-${id.toLowerCase()}`, other: `/tab/other-${id.toLowerCase()}`, chat: `/tab/chat-${id.toLowerCase()}`, sdoc: `doc-${id.toLowerCase()}` });
// Doc open once, new tab closed, open copy active and (when asked) its window focused.
const switched = (s, doc, docId, { win } = {}) => count(s, doc) === 1 && s.tabs.some(t => t.id === docId && t.active) && (win === undefined || s.wins.find(w => w.focused)?.id === win);
const switchObs = (s, doc, docId) => `${count(s, doc)} copy open; doc tab ${s.tabs.find(t => t.id === docId)?.active ? 'active' : 'not active'}; focused window ${s.wins.find(w => w.focused)?.id}`;

// ============================================================================
// Scenarios. IDs: I* = issue #20 table rows, P* = plan-review P5, X* = extra checks.
// ============================================================================
scenario('X1', 'Off by default on a fresh install', 'Setting off; Settings checkbox unchecked; a duplicate is not closed', async () => {
  const stored = await b.api('return await api.storage.local.get(null);');
  const ui = await b.optionsEval('await new Promise(r => setTimeout(r, 500)); return { checked: document.getElementById("prevent-duplicates").checked, never: document.getElementById("prevent-duplicates-never").value };');
  // No setup(): it would write settings. Open a duplicate with nothing configured.
  const s0 = await snap();
  const home = s0.tabs.find(t => t.url === '/tab/home');
  await b.api(`await api.tabs.create({ url: ${JSON.stringify(abs('/tab/home'))}, active: true }); return true;`);
  const s = await observe(null, 4000);
  const pass = stored.preventDuplicates === undefined && ui.checked === false && count(s, '/tab/home') === 2 && !!home;
  return verdict(pass, `stored.preventDuplicates=${stored.preventDuplicates}; checkbox ${ui.checked ? 'checked' : 'unchecked'}; ${count(s, '/tab/home')} copies after opening a duplicate`, s, { stored, ui });
});
scenario('X2', 'Off after upgrading from the main-branch build', 'Old settings kept; prevention off; checkbox unchecked; duplicate not closed', async ctx => {
  await b.api('await api.storage.local.clear(); return true;');
  await install(ctx.old.dist); await b.reload(); await instrument();
  // A user of the old build changes some settings.
  await set({ ignoreFragments: true, skipPinned: false });
  const oldVersion = await b.api('return api.runtime.getManifest().version;');
  await install(distDir); await b.reload(); await instrument();
  const newVersion = await b.api('return api.runtime.getManifest().version;');
  const stored = await b.api('return await api.storage.local.get(null);');
  const ui = await b.optionsEval('await new Promise(r => setTimeout(r, 500)); return { checked: document.getElementById("prevent-duplicates").checked, fragments: document.getElementById("ignore-fragments").checked };');
  await snap();
  await b.api(`await api.tabs.create({ url: ${JSON.stringify(abs('/tab/home'))}, active: true }); return true;`);
  const s = await observe(null, 4000);
  const copies = count(s, '/tab/home');
  const pass = stored.preventDuplicates !== true && ui.checked === false && ui.fragments === true && copies >= 2;
  return verdict(pass, `upgraded ${ctx.old.ref} (${oldVersion}) -> PR build (${newVersion}); stored.preventDuplicates=${stored.preventDuplicates}; checkbox ${ui.checked ? 'checked' : 'unchecked'}; ignoreFragments kept=${ui.fragments}; ${copies} copies of an open page after opening another`, s, { stored, ui });
});
scenario('I1', 'Chat or email app opens a link to a doc already open', 'Switch: new tab closed, open doc active', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'external' });
});
scenario('I2', 'Link inside a webmail/chat tab to an open doc (Ctrl-click, background)', 'Switch (opener is the chat tab)', async ({ id }) => {
  const { doc, sdoc } = slugs(id);
  const chat = `/link/chat-${id.toLowerCase()}?to=${encodeURIComponent(doc)}`;
  const { ids } = await setup([doc, chat], {}, { activeIndex: 1 });
  focus(`chat-${id.toLowerCase()}`); click(640, 450, 1, ['Control_L']);
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'native' });
});
scenario('I2b', 'Link inside a chat tab, target=_blank (foreground)', 'Switch', async ({ id }) => {
  const { doc } = slugs(id);
  const chat = `/link/chat-${id.toLowerCase()}?to=${encodeURIComponent(doc)}&target=_blank`;
  const { ids } = await setup([doc, chat], {}, { activeIndex: 1 });
  focus(`chat-${id.toLowerCase()}`); click(640, 450, 1);
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'native' });
});
scenario('I3', 'Typed URL in a new tab (Ctrl+T, type the open doc\'s URL)', 'Switch', async ({ id }) => {
  const { doc, other, sdoc } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  keys(['Control_L', 't'], `other-${id.toLowerCase()}`); await sleep(1000); typeUrl(typed(doc));
  const s = await observe(x => switched(x, doc, ids[0]) && !x.tabs.some(t => /newtab/.test(t.url)), 8000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'native' });
});
scenario('I3b', 'Bookmark or history entry opened in a new tab', 'Switch', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  // Opening a bookmark in a new tab creates a tab with no opener and the URL; tabs.create is the same shape.
  await b.api(`await api.tabs.create({ url: ${JSON.stringify(abs(doc))}, active: true }); return true;`);
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'api (tabs.create stands in for a bookmark open)' });
});
scenario('I4a', 'Duplicate Tab on the doc (tab context menu)', 'Keep both (opened from its match)', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other]);
  const via = await b.duplicateNative();
  let s = await observe(x => count(x, doc) === 2, 4000);
  let how = via.via;
  if (count(s, doc) < 2 && name === 'chromium') {
    // Fallback when the native menu missed: the API Duplicate Tab uses.
    await b.api(`await api.tabs.duplicate(${ids[0]}); return true;`);
    how = 'api tabs.duplicate (native menu did not open a copy)';
  }
  s = await observe(null, 4500);
  return verdict(count(s, doc) === 2, `${count(s, doc)} copies after 4.5 s`, s, { via: how });
});
scenario('I4b', 'Ctrl-click a link on the doc to the same page', 'Keep both', async ({ id }) => {
  const self = `/link/doc-${id.toLowerCase()}?to=self`;
  await setup([self, slugs(id).other]);
  focus(`doc-${id.toLowerCase()}`); click(640, 450, 1, ['Control_L']);
  const s = await observe(null, 5000);
  return verdict(count(s, self) === 2, `${count(s, self)} copies after 5 s`, s, { via: 'native' });
});
scenario('I5', 'Paste URL into a new tab to get a second copy, then Reopen Closed Tab', 'First try switches; Ctrl+Shift+T brings it back and it stays', async ({ id }) => {
  const { doc, other, sdoc } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  keys(['Control_L', 't'], `other-${id.toLowerCase()}`); await sleep(1000); typeUrl(typed(doc));
  const s1 = await observe(x => switched(x, doc, ids[0]) && !x.tabs.some(t => /newtab/.test(t.url)), 8000);
  const first = switched(s1, doc, ids[0]);
  await sleep(1500);
  keys(['Control_L', 'Shift_L', 't'], sdoc);
  const s = await observe(null, 5000);
  return verdict(first && count(s, doc) === 2, `first try ${first ? 'switched' : 'did not switch'}; after Ctrl+Shift+T ${count(s, doc)} copies (5 s later)`, s, { first: brief(s1), via: 'native' });
});
scenario('I5b', 'Paste URL into a new tab twice within a minute', 'First switches; the second try is kept', async ({ id }) => {
  const { doc, other, sdoc } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  keys(['Control_L', 't'], `other-${id.toLowerCase()}`); await sleep(1000); typeUrl(typed(doc));
  const s1 = await observe(x => switched(x, doc, ids[0]) && !x.tabs.some(t => /newtab/.test(t.url)), 8000);
  const first = switched(s1, doc, ids[0]);
  await sleep(1500);
  keys(['Control_L', 't'], sdoc); await sleep(1000); typeUrl(typed(doc));
  const s = await observe(null, 6000);
  return verdict(first && count(s, doc) === 2, `first try ${first ? 'switched' : 'did not switch'}; second try left ${count(s, doc)} copies`, s, { first: brief(s1), via: 'native' });
});
scenario('I6', 'An app opens the same link twice within a second (first copy still loading)', 'One tab: the second copy is closed', async ({ id }) => {
  const slow = `/slow/twice-${id.toLowerCase()}`;
  await setup([slugs(id).other]);
  if (name === 'firefox') {
    const launch = () => { const p = spawn(b.binary, ['-profile', b.profile, '--new-tab', abs(slow)], { env, stdio: 'ignore' }); const t = setTimeout(() => p.kill('SIGKILL'), 12000); p.once('exit', () => clearTimeout(t)); return new Promise(r => p.once('exit', r)); };
    const a = launch(); await sleep(250); const c = launch();
    await Promise.all([a, c]);
  }
  else { await b.api(`api.tabs.create({ url: ${JSON.stringify(abs(slow))}, active: true }); await new Promise(r => setTimeout(r, 200)); await api.tabs.create({ url: ${JSON.stringify(abs(slow))}, active: true }); return true;`); }
  const s = await observe(x => count(x, slow) === 1 && x.tabs.find(t => t.url === slow)?.status === 'complete', 9000);
  await sleep(3500);
  const s2 = await observe(null, 0);
  return verdict(count(s2, slow) === 1, `${count(s2, slow)} copies after both loaded`, { ...s2, log: [...s.log, ...s2.log] }, { via: name === 'firefox' ? 'external x2, 250 ms apart' : 'api tabs.create x2, 200 ms apart (Chromium external launches take >1 s each)' });
});
scenario('I7a', 'Merge Windows', 'Ignored: nothing closed', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { win } = await setup([doc, other]);
  await b.api(`await api.windows.create({ url: ${JSON.stringify(abs(doc))}, left: 0, top: 0, width: ${W}, height: ${H} }); return true;`);
  await sleep(2500); // new-window tab is ignored; let it settle
  await b.optionsEval('return await (globalThis.browser||chrome).runtime.sendMessage({ command: "mergeWindows" });');
  const s = await observe(null, 4000);
  return verdict(count(s, doc) === 2 && s.wins.filter(w => !w.incognito).length === 1, `${count(s, doc)} copies, ${s.wins.length} window(s) after Merge Windows`, s, { via: 'TabVacuum Merge Windows command (Settings page message)' });
});
scenario('I7b', 'Drag a tab to another window', 'Ignored: nothing closed', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other, doc.replace('doc', 'third')]);
  const w2 = await b.api(`return (await api.windows.create({ url: ${JSON.stringify(abs(doc))}, left: 0, top: 0, width: ${W}, height: ${H} })).id;`);
  await sleep(2500);
  await b.api(`await api.tabs.move(${ids[0]}, { windowId: ${w2}, index: -1 }); return true;`);
  const s = await observe(null, 4000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} copies after moving the doc into a window that holds a copy`, s, { via: 'api tabs.move (what a drag performs)' });
});
scenario('I7c', 'Reopen a closed window that holds a copy of an open doc', 'Ignored: nothing closed', async ({ id }) => {
  const { doc, other, sdoc } = slugs(id);
  await setup([doc, other]);
  await set({ preventDuplicates: false });
  const w2 = await b.api(`const w = await api.windows.create({ url: ${JSON.stringify(abs(doc))}, left: 0, top: 0, width: ${W}, height: ${H} }); await api.tabs.create({ windowId: w.id, url: ${JSON.stringify(abs(other))} }); return w.id;`);
  await sleep(2500);
  await b.api(`await api.windows.remove(${w2}); return true;`);
  await set(ON); await sleep(1200); await snap();
  if (b.reopenWindow) await b.reopenWindow(); else keys(['Control_L', 'Shift_L', 't'], sdoc);
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2 && count(s, other) === 2, `${count(s, doc)} doc copies, ${count(s, other)} other copies after reopening the window`, s, { via: b.reopenWindow ? 'browser (SessionStore.undoCloseWindow)' : 'native Ctrl+Shift+T' });
});
scenario('I7d', 'Browser restart with session restore (Restore Previous Session)', 'Ignored: restored duplicates kept', async ({ id }) => {
  if (!b.restart) return { untestable: 'Firefox: the product is a temporary add-on in this harness (unsigned builds cannot be installed permanently in release Firefox), so it is gone after a browser restart and cannot observe session restore.' };
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  await set({ preventDuplicates: false });
  await b.api(`await api.tabs.create({ url: ${JSON.stringify(abs(doc))}, active: false }); return true;`);
  await sleep(1500); await set(ON); await sleep(1500);
  await b.restart();
  await sleep(1000);
  await instrument();
  const s = await observe(null, 6000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} copies restored and kept (${s.tabs.length} tabs)`, s, { via: 'browser relaunch with --restore-last-session' });
});
scenario('I8', 'Same-tab link to a page open elsewhere, then Back', 'Ignored: existing tabs are never closed', async ({ id }) => {
  const { doc } = slugs(id);
  const chat = `/link/chat-${id.toLowerCase()}?to=${encodeURIComponent(doc)}`;
  const { ids } = await setup([doc, chat], {}, { activeIndex: 1 });
  focus(`chat-${id.toLowerCase()}`); click(640, 450, 1);
  const s1 = await observe(x => x.tabs.find(t => t.id === ids[1])?.url === doc, 4000);
  await sleep(3000);
  keys(['Alt_L', 'Left'], `doc-${id.toLowerCase()}`);
  await sleep(1000); keys(['Alt_L', 'Right']);
  const s = await observe(null, 4000);
  return verdict(s.tabs.some(t => t.id === ids[1]) && count(s, doc) === 2, `chat tab ${s.tabs.some(t => t.id === ids[1]) ? 'still open' : 'CLOSED'}; ${count(s, doc)} doc copies after link, Back, Forward`, s, { first: brief(s1), via: 'native' });
});
scenario('I9a', 'Same doc, different #fragment, default exact matching', 'Kept', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([`${doc}#gid=1`, other], {}, { activeIndex: 1 });
  await b.external(abs(`${doc}#gid=2`));
  const s = await observe(null, 5000);
  return verdict(count(s, `${doc}#gid=1`) === 1 && count(s, `${doc}#gid=2`) === 1, `#gid=1: ${count(s, `${doc}#gid=1`)}, #gid=2: ${count(s, `${doc}#gid=2`)}`, s, { via: 'external' });
});
scenario('I9b', 'Same doc, different #fragment, "Ignore URL fragments" on', 'Switch', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([`${doc}#gid=1`, other], { ignoreFragments: true }, { activeIndex: 1 });
  await b.external(abs(`${doc}#gid=2`));
  const s = await observe(x => count(x, `${doc}#gid=2`) === 0 && x.tabs.find(t => t.id === ids[0])?.active, 6000);
  return verdict(count(s, `${doc}#gid=2`) === 0 && !!s.tabs.find(t => t.id === ids[0])?.active, `#gid=2 copies: ${count(s, `${doc}#gid=2`)}; #gid=1 tab ${s.tabs.find(t => t.id === ids[0])?.active ? 'active' : 'not active'}`, s, { via: 'external' });
});
scenario('I10a', 'Same page in a Firefox container and the default container', 'Never matched across containers; matched inside one', async ({ id }) => {
  if (!b.containerTab) return { untestable: 'Chromium has no containers.' };
  const { doc, other } = slugs(id);
  await setup([doc, other], {}, { activeIndex: 1 });
  await b.containerTab(doc);
  const s1 = await observe(null, 4500);
  const inContainer = s1.tabs.filter(t => t.url === doc && t.cs === 'firefox-container-1');
  await b.containerTab(doc);
  const s = await observe(x => x.tabs.filter(t => t.url === doc && t.cs === 'firefox-container-1').length === 1 && x.tabs.find(t => t.id === inContainer[0]?.id)?.active, 6000);
  const c1 = s.tabs.filter(t => t.url === doc && t.cs === 'firefox-container-1').length;
  const pass = inContainer.length === 1 && count(s1, doc) === 2 && c1 === 1 && count(s, doc) === 2;
  return verdict(pass, `container copy kept next to default copy: ${inContainer.length === 1 && count(s1, doc) === 2}; a second container copy left ${c1} container copies (${count(s, doc)} total)`, s, { first: brief(s1), via: 'browser (gBrowser.addTab with userContextId, as the container menu does)' });
});
scenario('I10b', 'Same page in a private window and a normal window', 'Never matched across; matched inside private', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  const pw = await b.openPrivate(other.replace('other', 'priv'));
  await sleep(2500);
  await b.privateApi(INSTRUMENT);
  await b.privateApi(`await api.tabs.create({ windowId: ${pw}, url: ${JSON.stringify(abs(doc))}, active: true }); return true;`);
  const s1 = await observe(null, 4500, true);
  const privCopies1 = s1.tabs.filter(t => t.url === doc && t.incognito).length;
  await b.privateApi(`await api.tabs.create({ windowId: ${pw}, url: ${JSON.stringify(abs(doc))}, active: true }); return true;`);
  const s = await observe(x => x.tabs.filter(t => t.url === doc && t.incognito).length === 1 && x.tabs.some(t => t.url === doc && t.incognito && t.active), 6000, true);
  const privCopies = s.tabs.filter(t => t.url === doc && t.incognito).length;
  const normal = (await snap()).tabs.filter(t => t.url === doc && !t.incognito).length;
  await b.api(`await api.windows.remove(${pw}).catch(() => {}); return true;`).catch(() => {});
  if (name === 'chromium') await b.privateApi(`for (const w of await api.windows.getAll()) await api.windows.remove(w.id).catch(() => {}); return true;`).catch(() => {});
  const pass = privCopies1 === 1 && privCopies === 1 && normal === 1;
  return verdict(pass, `private copy next to normal copy kept: ${privCopies1 === 1}; second private copy left ${privCopies} private copies; normal copies ${normal}`, s, { first: brief(s1), via: 'api tabs.create in the private window' });
});
scenario('I11a', 'Never list: URL prefix line', 'Kept', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other], { preventDuplicatesNever: [abs('/tab/doc-')] }, { activeIndex: 1 });
  await b.external(abs(doc));
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} copies`, s, { never: abs('/tab/doc-'), via: 'external' });
});
scenario('I11b', 'Never list: host name line', 'Kept', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other], { preventDuplicatesNever: ['127.0.0.1'] }, { activeIndex: 1 });
  await b.external(abs(doc));
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} copies`, s, { never: '127.0.0.1', via: 'external' });
});
scenario('I11c', 'Never list: /regex/ line', 'Kept; a non-matching regex still switches', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], { preventDuplicatesNever: ['/doc-i11c$/'] }, { activeIndex: 1 });
  await b.external(abs(doc));
  const s = await observe(null, 5000);
  const kept = count(s, doc) === 2;
  // Control: a regex that does not match leaves prevention working.
  const d2 = doc.replace('doc', 'docx');
  const r2 = await setup([d2, other.replace('other', 'otherx')], { preventDuplicatesNever: ['/nomatch-zz/'] }, { activeIndex: 1 });
  await b.external(abs(d2));
  const s2 = await observe(x => switched(x, d2, r2.ids[0]), 6000);
  return verdict(kept && switched(s2, d2, r2.ids[0]), `matching regex: ${count(s, doc)} copies; non-matching regex: ${count(s2, d2)} copies`, s, { control: brief(s2), via: 'external' });
});
scenario('I12a', 'The open copy is pinned', 'Switch to the pinned tab', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.api(`await api.tabs.update(${ids[0]}, { pinned: true }); return true;`);
  await sleep(500);
  await b.external(abs(doc));
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]) && s.tabs.find(t => t.id === ids[0])?.pinned, switchObs(s, doc, ids[0]), s, { via: 'external' });
});
scenario('I12b', 'The open copy is asleep (discarded)', 'Switch; the sleeping tab reloads', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.api(`await api.tabs.discard(${ids[0]}); return true;`);
  await sleep(800);
  const s0 = await snap();
  const asleep = s0.tabs.find(t => t.url === doc)?.discarded;
  await b.external(abs(doc));
  const s = await observe(x => count(x, doc) === 1 && x.tabs.find(t => t.url === doc)?.active && x.tabs.find(t => t.url === doc)?.status === 'complete', 8000);
  const t = s.tabs.find(x => x.url === doc);
  return verdict(asleep === true && count(s, doc) === 1 && t?.active && !t.discarded, `asleep before: ${asleep}; ${count(s, doc)} copy; open copy ${t?.active ? 'active' : 'not active'}, discarded=${t?.discarded}, status=${t?.status}, tab id ${t?.id} (was ${ids[0]})`, s, { via: 'external' });
});
scenario('I12c', 'The open copy is in another window', 'Switch; that window comes forward', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids, win } = await setup([other]);
  const w2 = await b.api(`return (await api.windows.create({ url: ${JSON.stringify(abs(doc))}, left: 0, top: 0, width: ${W}, height: ${H} })).id;`);
  await sleep(2500);
  const docId = (await snap()).tabs.find(t => t.url === doc).id;
  await b.api(`await api.windows.update(${win}, { focused: true }); return true;`);
  focus(`other-${id.toLowerCase()}`);
  await sleep(500);
  await b.external(abs(doc));
  const s = await observe(x => switched(x, doc, docId, { win: w2 }), 6000);
  return verdict(switched(s, doc, docId, { win: w2 }), switchObs(s, doc, docId) + ` (doc window ${w2})`, s, { via: 'external' });
});
scenario('P1', 'Ctrl+T next to an open blank New Tab', 'Both New Tabs kept', async ({ id }) => {
  const { other } = slugs(id);
  await setup([other]);
  keys(['Control_L', 't'], `other-${id.toLowerCase()}`); await sleep(2500);
  keys(['Control_L', 't']);
  const s = await observe(null, 5000);
  const blanks = s.tabs.filter(t => /newtab|about:blank|about:home/.test(t.url)).length;
  return verdict(blanks === 2, `${blanks} New Tabs open`, s, { via: 'native' });
});
scenario('P2a', 'Server redirector link to an open doc', 'Switch on the final URL', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.external(abs(`/redirect?to=${encodeURIComponent(doc)}`));
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'external, 302 wrapper' });
});
scenario('P2b', 'Script redirector (link wrapper page) to an open doc', 'Switch on the final URL', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.external(abs(`/jsredirect?to=${encodeURIComponent(doc)}`));
  const s = await observe(x => switched(x, doc, ids[0]), 7000);
  return verdict(switched(s, doc, ids[0]), switchObs(s, doc, ids[0]), s, { via: 'external, page that redirects after 300 ms' });
});
scenario('P4', 'Ctrl+Shift+T within 0.5 s of a switch', 'The reopened copy is kept', async ({ id }) => {
  const { doc, other, sdoc } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  let s1, closedAt;
  await until(async () => { s1 = await snap(); if (count(s1, doc) === 1 && s1.tabs.find(t => t.id === ids[0])?.active) { closedAt = Date.now(); return true; } return false; }, 'switch', 8000).catch(() => {});
  if (!closedAt) return verdict(false, 'the first copy never switched, so the undo could not be timed', s1);
  nativeKeys(env, ['Control_L', 'Shift_L', 't']);
  const gap = Date.now() - closedAt;
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2, `Ctrl+Shift+T sent ${gap} ms after the switch was observed; ${count(s, doc)} copies 5 s later`, s, { via: 'native' });
});
scenario('P5', 'Open All in Tabs (3+ tabs at once, one already open)', 'Ignored: all kept', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  await b.api(`for (const u of ${JSON.stringify([doc, '/tab/bulk-a', '/tab/bulk-b'].map(abs))}) api.tabs.create({ url: u, active: false }); return true;`);
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} doc copies after a 3-tab bulk open`, s, { via: 'api: 3 tabs.create in one burst (what Open All in Tabs does)' });
});
scenario('P5b', 'Open All in Tabs, the already-open page last of the 3', 'Ignored: all kept', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  await b.api(`for (const u of ${JSON.stringify(['/tab/bulk-c', '/tab/bulk-d', doc].map(abs))}) api.tabs.create({ url: u, active: false }); return true;`);
  const s = await observe(null, 5000);
  return verdict(count(s, doc) === 2, `${count(s, doc)} doc copies after a 3-tab bulk open`, s, { via: 'api: 3 tabs.create in one burst (what Open All in Tabs does)' });
});
scenario('P5c', 'Open All in Tabs from the Bookmark Manager, open page first (Chromium)', 'Ignored: all kept', async ({ id }) => {
  if (name !== 'chromium') return { untestable: 'Chromium-only: drives chrome://bookmarks. Firefox rows P5/P5b use the API burst.' };
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  const urls = [doc, '/tab/bm-a', '/tab/bm-b'].map(abs);
  // The Bookmark Manager page's own APIs: make a folder, then open each bookmark in a
  // new tab the way its "Open all" command does.
  const m = await b.context.newPage();
  await m.goto('chrome://bookmarks/'); await sleep(800);
  const r = await m.evaluate(async list => {
    const folder = await chrome.bookmarks.create({ parentId: '1', title: 'dupes-p5c' });
    const ids = [];
    for (const url of list) ids.push((await chrome.bookmarks.create({ parentId: folder.id, url })).id);
    if (!chrome.bookmarkManagerPrivate?.openInNewTab) return { error: 'bookmarkManagerPrivate.openInNewTab unavailable' };
    for (const i of ids) chrome.bookmarkManagerPrivate.openInNewTab(i);
    return { ids, form: 'openInNewTab per bookmark, in one task' };
  }, urls).catch(e => ({ error: String(e.message).split('\n')[0] }));
  await sleep(300);
  const s = await observe(null, 5000);
  await m.close().catch(() => {});
  if (r.error) return { untestable: `Bookmark Manager open-all not reachable: ${r.error}` };
  const opened = s.tabs.filter(t => /\/tab\/bm-/.test(t.url)).length;
  return verdict(count(s, doc) === 2 && opened === 2, `${count(s, doc)} doc copies; ${opened} of 2 other bookmarks opened (${r.form})`, s, { via: 'browser (chrome://bookmarks bookmarkManagerPrivate.openInNewTab)' });
});
scenario('P5d', 'Bulk open spread over 300 ms (3 tabs 150 ms apart, open page first)', 'Ignored: all kept (3 tabs within 1 s is a bulk open)', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  await b.api(`for (const u of ${JSON.stringify([doc, '/tab/spread-a', '/tab/spread-b'].map(abs))}) { api.tabs.create({ url: u, active: false }); await new Promise(r => setTimeout(r, 150)); } return true;`);
  const s = await observe(null, 4000);
  const created = s.log.filter(e => e.type === 'created').map(e => e.t);
  return verdict(count(s, doc) === 2, `${count(s, doc)} doc copies; burst spread ${created.length > 1 ? created.at(-1) - created[0] : '?'} ms over ${created.length} tabs`, s, { via: 'api: 3 tabs.create, 150 ms apart' });
});
scenario('P5e', 'Open All in Tabs of a 12-bookmark folder from the Bookmark Manager, open page first', 'Ignored: all kept', async ({ id }) => {
  if (name !== 'chromium') return { untestable: 'Chromium-only: drives chrome://bookmarks.' };
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  const urls = [doc, ...Array.from({ length: 11 }, (_, i) => `/tab/bm12-${i}`)].map(abs);
  const m = await b.context.newPage();
  await m.goto('chrome://bookmarks/'); await sleep(800);
  await snap();
  const r = await m.evaluate(async list => {
    const folder = await chrome.bookmarks.create({ parentId: '1', title: 'dupes-p5e' });
    const ids = [];
    for (const url of list) ids.push((await chrome.bookmarks.create({ parentId: folder.id, url })).id);
    for (const i of ids) chrome.bookmarkManagerPrivate.openInNewTab(i);
    return { n: ids.length };
  }, urls).catch(e => ({ error: String(e.message).split('\n')[0] }));
  const s = await observe(null, 5000);
  await m.close().catch(() => {});
  if (r.error) return { untestable: `Bookmark Manager open-all not reachable: ${r.error}` };
  const created = s.log.filter(e => e.type === 'created' && /\/tab\/(doc|bm12)/.test(e.pending ?? e.url ?? '')).map(e => e.t);
  const opened = s.tabs.filter(t => /\/tab\/bm12-/.test(t.url)).length;
  return verdict(count(s, doc) === 2 && opened === 11, `${count(s, doc)} doc copies; ${opened} of 11 other bookmarks open; ${created.length} tabs created over ${created.length > 1 ? created.at(-1) - created[0] : '?'} ms`, s, { via: 'browser (chrome://bookmarks bookmarkManagerPrivate.openInNewTab x12)' });
});
scenario('P6a', 'Doc is the rightmost tab; Ctrl+T and type its URL', 'Switch', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([other, doc], {}, { activeIndex: 1 });
  keys(['Control_L', 't'], `doc-${id.toLowerCase()}`); await sleep(1000); typeUrl(typed(doc));
  const s = await observe(x => switched(x, doc, ids[1]) && !x.tabs.some(t => /newtab/.test(t.url)), 8000);
  return verdict(switched(s, doc, ids[1]), switchObs(s, doc, ids[1]), s, { via: 'native' });
});
scenario('P6b', 'Doc is the rightmost and active tab; an external link to it', 'Switch', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([other, doc], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  const s = await observe(x => switched(x, doc, ids[1]), 6000);
  return verdict(switched(s, doc, ids[1]), switchObs(s, doc, ids[1]), s, { via: 'external' });
});
scenario('P7', 'Foreground link next to a stale-tracked neighbor', 'Switch with no activation of a neighbor', async ({ id }) => {
  const { doc } = slugs(id);
  const chat = `/link/chat-${id.toLowerCase()}?to=${encodeURIComponent(doc)}&target=_blank`;
  const neighbor = `/tab/neighbor-${id.toLowerCase()}`;
  const { ids } = await setup([doc, chat, neighbor], {}, { activeIndex: 1 });
  const before = (await snap()).tabs.find(t => t.id === ids[2]).lastAccessed;
  focus(`chat-${id.toLowerCase()}`); click(640, 450, 1);
  const s = await observe(x => switched(x, doc, ids[0]), 6000);
  await sleep(1000);
  const after = (await snap()).tabs.find(t => t.id === ids[2]).lastAccessed;
  const created = s.log.find(e => e.type === 'created')?.id;
  const activations = s.log.filter(e => e.type === 'activated').map(e => (e.id === created ? 'new' : e.id === ids[0] ? 'doc' : e.id === ids[1] ? 'chat' : e.id === ids[2] ? 'neighbor' : e.id));
  const pass = switched(s, doc, ids[0]) && !activations.includes('neighbor') && !activations.includes('chat') && before === after;
  return verdict(pass, `${switchObs(s, doc, ids[0])}; activations: ${activations.join(' -> ')}; neighbor lastAccessed ${before === after ? 'unchanged' : `changed ${before} -> ${after}`}`, s, { via: 'native' });
});
scenario('P8', 'Background asleep (worker stopped), then a link opens', 'Switch after the wake', async ({ id }) => {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await sleep(4000); // let storage.session writes land
  const slept = await b.sleepWorker();
  await b.external(abs(doc));
  await sleep(500);
  await b.running().catch(() => {});
  const s = await observe(x => switched(x, doc, ids[0]), 8000);
  return verdict(switched(s, doc, ids[0]), `${switchObs(s, doc, ids[0])}; sleep: ${JSON.stringify(slept)}`, s, { via: 'external' });
});
scenario('P9', 'Chrome incognito alongside normal', 'Never matched across; matched inside incognito', async ({ id }) => {
  if (name !== 'chromium') return { untestable: 'Chromium-only row; Firefox private windows are covered by I10b.' };
  return scenarios.find(x => x.id === 'I10b').fn({ id: `${id}-inc` });
});
scenario('P10', 'TabVacuum Search opens a history result with "Ignore URL fragments" on', 'Kept (Search chose to open it)', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([`${doc}#a`, other]);
  await set({ preventDuplicates: false });
  const { ids } = await setup([`${doc}#b`, other], { ignoreFragments: true });
  const r = await b.searchHistory(abs(`${doc}#a`));
  if (r === null) return { untestable: 'Firefox: not automated in this harness (the Search page needs its launch token, and Firefox opens Search as an overlay frame this harness does not drive).' };
  const s = await observe(null, 5000);
  return verdict(count(s, `${doc}#a`) === 1 && count(s, `${doc}#b`) === 1, `search reply ${JSON.stringify(r)}; #a: ${count(s, `${doc}#a`)}, #b: ${count(s, `${doc}#b`)}`, s, { via: 'Search page activateHistoryResult (popup Search)' });
});
scenario('X3', 'Last tab in a window is never closed', 'Kept: a new tab that is alone in its window is not closed', async ({ id }) => {
  const { doc, other } = slugs(id);
  await setup([doc, other]);
  // A second window whose only tab is brand-new but not part of the window's creation burst,
  // so only the last-tab rule (R7.1) can keep it.
  const w2 = await b.api(`return (await api.windows.create({ url: ${JSON.stringify(abs(other.replace('other', 'w2')))}, left: 0, top: 0, width: ${W}, height: ${H} })).id;`);
  await sleep(1500);
  const fresh = await b.api(`const t = await api.tabs.create({ windowId: ${w2}, url: 'about:blank', active: true }); return t.id;`);
  await b.api(`const [a] = (await api.tabs.query({ windowId: ${w2} })).filter(t => t.id !== ${fresh}); await api.tabs.remove(a.id); return true;`);
  await sleep(300);
  await snap();
  await b.api(`await api.tabs.update(${fresh}, { url: ${JSON.stringify(abs(doc))} }); return true;`);
  const s = await observe(null, 6000);
  const r = (await b.api('return (await api.storage.session.get("dupe.normal"))["dupe.normal"]?.tabs?.[' + fresh + '];'));
  return verdict(count(s, doc) === 2 && s.tabs.some(t => t.id === fresh), `${count(s, doc)} copies; the lone new tab ${s.tabs.some(t => t.id === fresh) ? 'kept' : 'CLOSED'}; its record ${JSON.stringify(r)}`, s, { via: 'api (windows.create, tabs.create, tabs.remove, tabs.update)' });
});
// ---- Rows for the settle delay (a new tab is judged only once it is DUPE_SETTLE_MS old) ----
const activationsAfter = (s, t0, ids) => s.log.filter(e => e.type === 'activated' && e.t >= t0).map(e => (ids[e.id] ?? e.id));
// U1a/U1b: Ctrl+W on a duplicate that opened in front. The window is focused first, so the key
// needs no focus step and lands as soon as the tab exists.
async function ctrlW(id, delayMs) {
  const { doc, other } = slugs(id);
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  focus(`other-${id.toLowerCase()}`);
  await sleep(300); await snap();
  await b.external(abs(doc));
  let s0 = await snap(), dup;
  const log = [...s0.log];
  for (let i = 0; i < 60 && !(dup = log.find(e => e.type === 'created' && e.url !== undefined || e.type === 'created')); i++) { await sleep(10); s0 = await snap(); log.push(...s0.log); }
  if (delayMs) { const wait = dup.t + delayMs - Date.now(); if (wait > 0) await sleep(wait); }
  const sent = Date.now();
  nativeKeys(env, ['Control_L', 'w']);
  const s = await observe(null, 2500);
  s.log = [...log, ...s.log];
  const removedDup = s.log.find(e => e.type === 'removed' && e.id === dup?.id);
  const removedDoc = s.log.find(e => e.type === 'removed' && e.id === ids[0]);
  const acts = activationsAfter(s, sent, { [ids[0]]: 'doc', [ids[1]]: 'other', [dup?.id]: 'dup' });
  return { doc, ids, dup, sent, keyMs: dup ? sent - dup.t : null, s, removedDup, removedDoc, acts };
}
scenario('U1a', 'Ctrl+W on the duplicate inside the settle window', 'Only the duplicate closes; nothing else is activated', async ({ id }) => {
  const r = await ctrlW(id, 0);
  const switched = r.s.log.some(e => e.type === 'activated' && e.id === r.ids[0] && e.t < r.sent);
  if (!r.dup || r.keyMs >= 150 || switched) return { untestable: `Ctrl+W left the harness ${r.keyMs} ms after the duplicate was created${switched ? ', after TabVacuum had already switched' : ''}; it must land well inside the 200 ms settle window. Python process start for the key adds tens of ms.` };
  const front = r.s.tabs.find(t => t.active);
  const pass = !!r.removedDup && !r.removedDoc && !r.acts.includes('doc') && count(r.s, r.doc) === 1;
  return verdict(pass, `Ctrl+W sent ${r.keyMs} ms after creation; duplicate ${r.removedDup ? 'closed' : 'OPEN'}; open doc ${r.removedDoc ? 'CLOSED' : 'kept'}; activations after the key: ${r.acts.join(' -> ') || 'none'}; front ${front?.url}`, r.s, { via: 'external + native Ctrl+W', keyMs: r.keyMs });
});
scenario('U1b', 'Ctrl+W about 400 ms after the duplicate opened (after the switch)', 'Documented: TabVacuum has switched, so Ctrl+W closes the open doc now in front', async ({ id }) => {
  const r = await ctrlW(id, 400);
  const switchedBefore = r.removedDup && r.removedDup.t < r.sent;
  const pass = switchedBefore && !!r.removedDoc && count(r.s, r.doc) === 0;
  return verdict(pass, `Ctrl+W sent ${r.keyMs} ms after creation; duplicate closed by TabVacuum ${r.removedDup ? `${r.removedDup.t - r.dup.t} ms after creation` : 'NEVER'}; open doc ${r.removedDoc ? 'closed by the key' : 'kept'}; ${count(r.s, r.doc)} doc copies left`, r.s, { via: 'external + native Ctrl+W', keyMs: r.keyMs });
});
scenario('U2', 'User navigates the duplicate elsewhere within its first second', 'Kept on the new page; the open doc is not activated', async ({ id }) => {
  const { doc, other } = slugs(id);
  const away = `/tab/away-${id.toLowerCase()}`;
  const { ids } = await setup([doc, other], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  let s0;
  await until(async () => { s0 = await snap(); return s0.tabs.some(t => t.url === doc && t.id !== ids[0]); }, 'duplicate committed', 3000).catch(() => {});
  const dup = s0.tabs.find(t => t.url === doc && t.id !== ids[0]);
  const t0 = Date.now();
  if (dup) await b.api(`await api.tabs.update(${dup.id}, { url: ${JSON.stringify(abs(away))} }); return true;`);
  const s = await observe(null, 4000);
  const acts = activationsAfter({ log: [...s0.log, ...s.log] }, t0, { [ids[0]]: 'doc', [ids[1]]: 'other', [dup?.id]: 'dup' });
  const kept = s.tabs.find(t => t.id === dup?.id);
  return verdict(!!dup && kept?.url === away && count(s, doc) === 1 && !acts.includes('doc'),
    `duplicate ${kept ? `kept on ${kept.url}` : 'CLOSED'}; navigated ~${t0 - (s0.log.find(e => e.type === 'created' && e.id === dup?.id)?.t ?? t0)} ms after creation; activations after: ${acts.join(' -> ') || 'none'}`, s, { via: 'external + api tabs.update (stands in for typing a new address)' });
});
scenario('U3', 'User switches to another tab within the duplicate\'s first second', 'Duplicate closed; tester expectation: focus stays on the tab the user chose', async ({ id }) => {
  const { doc, other } = slugs(id);
  const third = `/tab/third-${id.toLowerCase()}`;
  const { ids } = await setup([doc, other, third], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  let s0;
  await until(async () => { s0 = await snap(); return s0.tabs.find(t => t.url === doc && t.id !== ids[0])?.active; }, 'duplicate in front', 3000).catch(() => {});
  const dup = s0.tabs.find(t => t.url === doc && t.id !== ids[0]);
  const t0 = Date.now();
  // The user picks the third tab. Firefox on Linux selects tabs with Alt+number; Ctrl+number selects nothing.
  keys([name === 'firefox' ? 'Alt_L' : 'Control_L', '3'], `doc-${id.toLowerCase()}`);
  const s = await observe(null, 3500);
  const acts = activationsAfter({ log: [...s0.log, ...s.log] }, t0, { [ids[0]]: 'doc', [ids[1]]: 'other', [ids[2]]: 'third', [dup?.id]: 'dup' });
  const front = s.tabs.find(t => t.active);
  return verdict(count(s, doc) === 1 && front?.id === ids[2],
    `${count(s, doc)} doc copies; front tab after 3.5 s: ${front?.url}; activations after the user's switch: ${acts.join(' -> ')}`, s, { via: 'external + native Ctrl+3' });
});
scenario('U3b', 'User switches to another tab within the duplicate\'s first second (API activation)', 'Duplicate closed; tester expectation: focus stays on the tab the user chose', async ({ id }) => {
  const { doc, other } = slugs(id);
  const third = `/tab/third-${id.toLowerCase()}`;
  const { ids } = await setup([doc, other, third], {}, { activeIndex: 1 });
  await b.external(abs(doc));
  let s0;
  await until(async () => { s0 = await snap(); return s0.tabs.find(t => t.url === doc && t.id !== ids[0])?.active; }, 'duplicate in front', 3000).catch(() => {});
  const dup = s0.tabs.find(t => t.url === doc && t.id !== ids[0]);
  const t0 = Date.now();
  const sinceCreated = t0 - (s0.log.find(e => e.type === 'created' && e.id === dup?.id)?.t ?? t0);
  await b.api(`await api.tabs.update(${ids[2]}, { active: true }); return true;`);
  const s = await observe(null, 3500);
  const acts = activationsAfter({ log: [...s0.log, ...s.log] }, t0, { [ids[0]]: 'doc', [ids[1]]: 'other', [ids[2]]: 'third', [dup?.id]: 'dup' });
  const front = s.tabs.find(t => t.active);
  return verdict(count(s, doc) === 1 && front?.id === ids[2],
    `${count(s, doc)} doc copies; user switched ${sinceCreated} ms after the duplicate was created; front tab after 3.5 s: ${front?.url}; activations after: ${acts.join(' -> ')}`, s, { via: 'external + api tabs.update(active) for the user\'s tab click' });
});
scenario('I6b', 'Double-fire of a fast page, both copies inside the first second', 'One tab: the second copy is closed, the first kept', async ({ id }) => {
  const page = `/tab/fast-${id.toLowerCase()}`;
  await setup([slugs(id).other]);
  const ids = await b.api(`const a = await api.tabs.create({ url: ${JSON.stringify(abs(page))}, active: true }); await new Promise(r => setTimeout(r, 100)); const c = await api.tabs.create({ url: ${JSON.stringify(abs(page))}, active: true }); return [a.id, c.id];`);
  const s = await observe(null, 4000);
  const left = s.tabs.filter(t => t.url === page).map(t => t.id);
  return verdict(left.length === 1 && left[0] === ids[0], `${left.length} copies; kept ${left[0] === ids[0] ? 'the first' : left[0] === ids[1] ? 'the SECOND' : 'none'}`, s, { via: 'api tabs.create x2, 100 ms apart' });
});
scenario('X4', 'First switch shows one notice; the flag persists in storage.local', 'preventDuplicatesNoticeShown = true after a switch', async () => {
  const v = await b.api('return (await api.storage.local.get("preventDuplicatesNoticeShown")).preventDuplicatesNoticeShown;');
  return verdict(v === true, `preventDuplicatesNoticeShown=${v}`, null);
});

// ---- run ----------------------------------------------------------------------
const started = new Date().toISOString();
const old = await buildOld();
await install(distDir);
b = await (name === 'firefox' ? firefoxAdapter() : chromiumAdapter());
console.log(`[${name}] ${JSON.stringify(b.versions)} display ${env.DISPLAY} site ${base}`);
await instrument();
// Past the startup quiet period (10 s after runtime.onStartup).
await sleep(11000);
if (name === 'chromium') await b.enableIncognito().then(instrument);
const ctx = { old };
for (const sc of scenarios) {
  if (only && !only.includes(sc.id)) continue;
  const t0 = Date.now();
  let r;
  try { r = await sc.fn({ ...ctx, id: sc.id }); } catch (e) { r = { pass: false, observed: `harness error: ${String(e?.message || e).split('\n')[0]}`, detail: { error: String(e?.stack || e) } }; }
  if (typeof r.detail?.via === 'string' && r.detail.via.startsWith('external')) {
    r.detail.via = (b.externalVia || 'external (second `firefox -profile <p> --new-tab <url>` invocation)') + r.detail.via.slice(8);
  }
  const status = r.untestable ? 'NOT TESTABLE' : r.pass ? 'PASS' : 'FAIL';
  const row = { id: sc.id, title: sc.title, expected: sc.expected, status, observed: r.untestable || r.observed, ms: Date.now() - t0, detail: r.detail };
  results.push(row);
  console.log(`${status} ${sc.id} ${sc.title} -- ${row.observed}`);
  if (status === 'FAIL') console.log(JSON.stringify(r.detail, null, 1).slice(0, 4000));
  await b.api('return true').catch(() => b.running().catch(() => {}));
  await instrument().catch(() => {});
}
const summary = { browser: name, versions: b.versions, prHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), upgradeFrom: old, started, finished: new Date().toISOString(),
  counts: Object.fromEntries(['PASS', 'FAIL', 'NOT TESTABLE'].map(k => [k, results.filter(r => r.status === k).length])), results };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2));
await writeFile(path.join(directory, 'summary.md'), `# ${name} ${b.versions.browser}\n\n| ID | Scenario | Expected | Observed | Result |\n|---|---|---|---|---|\n${results.map(r => `| ${r.id} | ${r.title} | ${r.expected} | ${String(r.observed).replaceAll('|', '/')} | ${r.status} |`).join('\n')}\n`);
console.log(JSON.stringify(summary.counts));
console.log(`Results: ${directory}`);
await b.shutdown().catch(() => {});
display.stop();
server.close(); server.closeAllConnections?.();
await rm(path.join(directory, 'profile'), { recursive: true, force: true });
process.exit(summary.counts.FAIL ? 1 : 0);
