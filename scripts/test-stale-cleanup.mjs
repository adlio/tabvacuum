// Native-browser regression and capture harness for stale-tab review and
// opt-in automatic cleanup (R4, R5, R6, R7).
//
// Usage, from the package root after `npm run build`:
//   node scripts/test-stale-cleanup.mjs firefox|chromium
// Env: KIROCREW_SCRATCH or TMPDIR (required), FIREFOX_BINARY, GECKODRIVER,
//   CHROMIUM_BINARY, XVFB_BINARY; RECORD_BROWSER=1 records the enable/sweep MP4.
// Output: $KIROCREW_SCRATCH/stale-cleanup/<browser>-<run>/ (PNGs, MP4, result.json).
//
// Isolation: disposable profile, a private 1280x800 Xvfb display, and a
// fixture site bound to 127.0.0.1. Success paths use the real extension and
// browser APIs. Fault cases replace the popup's transport for one command and
// are labelled [fault]. Fixtures that stand in for elapsed time are labelled
// [fixture] and recorded in result.json:
//   firefox  - the native tab lastAccessed field, set through the privileged
//              tab.updateLastAccessed() in this throwaway profile. Firefox's
//              age adapter trusts native lastAccessed.
//   chromium - an isolated clock offset on Date.now in the extension service
//              worker and the popup only. Chromium age is bounded below by the
//              first time this session observed a tab, so only a clock can age
//              it. The browser process and machine clocks are untouched.
//   schedule - the scheduler's own plan is the next whole local hour. To see a
//              real browser.alarms event reach the product within the run, the
//              recorded plan and the same alarm are moved ~15 s ahead through
//              storage and the alarms API, with no extension view open (an open
//              view re-checks the schedule and replaces an off-hour plan). No
//              product hook is used.
//   toolbar  - Chromium only: the button is pinned through chrome://extensions
//              in the throwaway profile, then found on screen by its icon.
// None of this proves week-long native age tracking; scripts/probe-stale-age.mjs
// covers the native timestamp semantics.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { outputDir, checker, until, sleep, nativeKeys } from './test-browser-fixtures.mjs';

const name = process.argv[2];
assert.ok(['chromium', 'firefox'].includes(name), 'usage: node scripts/test-stale-cleanup.mjs firefox|chromium');
const W = 1280, H = 800;
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const STALE_ALARM = 'atv-stale-sweep';
const ENABLED_TITLE = 'Stale Tabs (Auto-Close Enabled)';
const DISABLED_TITLE = 'Stale Tabs';
const WARNING = 'Tabs are closed, not archived. Unsaved changes may be lost.';
const SHORTCUT = { keys: ['Alt_L', 'Shift_L', 'y'], firefox: 'Alt+Shift+Y', chromium: 'Alt+Shift+Y' };
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const { scratch, directory } = await outputDir(path.join('stale-cleanup', `${name}-${runId}`));
const { check, results } = checker();
const fixtures = [];   // provenance of every age/schedule fixture
const limitations = []; // checks this environment could not exercise
const shots = [];
const fixture = (what, detail) => { fixtures.push({ what, detail, at: new Date().toISOString() }); console.log(`FIXTURE ${what} ${JSON.stringify(detail)}`); };
const limit = (what, why) => { limitations.push({ what, why }); console.log(`LIMIT ${what}: ${why}`); };

// ---- Oracles: written from the spec, not imported from product code ---------
function nextLocalHour(now) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  let at = d.getTime() + HOUR;
  while (at <= now) at += HOUR;
  return at;
}
// English 12-hour: "10p", "10:30p", plus "tomorrow" or a date when not today.
function runTime(at, now) {
  const d = new Date(at), h = d.getHours(), m = d.getMinutes();
  const time = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`;
  const day = t => { const x = new Date(t); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const days = Math.round((day(at) - day(now)) / DAY);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} on ${new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d)}`;
}
const tabs = n => (n === 1 ? '1 tab' : `${n} tabs`);
const caption = (n, at, now) => `Closing ${tabs(n)} automatically at ${runTime(at, now)}.`;

// ---- Display, captures, native input ----------------------------------------
async function startDisplay() {
  const child = spawn(process.env.XVFB_BINARY || path.join(scratch, 'browsers/usr/bin/Xvfb'),
    ['-displayfd', '3', '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: [path.join(scratch, 'browsers/usr/lib64'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Xvfb timeout: ${errors}`)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Xvfb exited ${code}: ${errors}`)); });
    child.stdio[3].once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
  }).catch(error => { child.kill(); throw error; });
  return { env: { ...process.env, DISPLAY: `:${number}` }, stop: () => child.kill() };
}
const display = await startDisplay();
const env = display.env;
process.env.DISPLAY = env.DISPLAY;

function capture(label, what) {
  const file = path.join(directory, `${label}.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${W}x${H}`, '-i', env.DISPLAY, '-frames:v', '1', file], { env });
  shots.push({ file, what });
}
function recorder(file) {
  if (process.env.RECORD_BROWSER !== '1') return { file: null, stop: async () => {} };
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${W}x${H}`,
    '-framerate', '12', '-i', env.DISPLAY, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { env });
  child.stderr.on('data', data => process.stderr.write(data));
  const done = new Promise(resolve => child.once('exit', resolve));
  let stopped = false;
  return { file, async stop() { if (stopped) return; stopped = true; child.stdin.write('q'); await done; } };
}
// A real X pointer click (button 1) or context click (button 3) on the test display.
const CLICK = `
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6"); xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]; x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d: raise SystemExit("Cannot open test display")
b = int(sys.argv[3])
xtst.XTestFakeMotionEvent(d, -1, int(sys.argv[1]), int(sys.argv[2]), 0); x11.XFlush(d); time.sleep(0.15)
xtst.XTestFakeButtonEvent(d, b, 1, 0); x11.XFlush(d); time.sleep(0.05)
xtst.XTestFakeButtonEvent(d, b, 0, 0); x11.XFlush(d)
x11.XCloseDisplay(d)`;
// The extension's toolbar button on screen: pixels close to the icon's own
// saturated colour in the toolbar band, accepted only as one icon-sized cluster.
const FIND_ICON = `
import json, sys
from PIL import Image
shot = Image.open(sys.argv[1]).convert('RGB'); icon = Image.open(sys.argv[2]).convert('RGBA')
px = [p[:3] for p in icon.getdata() if p[3] > 200]
sat = [p for p in px if max(p) - min(p) > 80] or px
ref = tuple(sum(c[i] for c in sat) / len(sat) for i in range(3))
W, H = shot.size
hits = [(x, y) for y in range(30, 110) for x in range(W // 3, W) if sum((a - b) ** 2 for a, b in zip(shot.getpixel((x, y)), ref)) < 3600]
if len(hits) < 10:
    print(json.dumps({'found': False, 'hits': len(hits)})); sys.exit(0)
xs, ys = [h[0] for h in hits], [h[1] for h in hits]
box = [min(xs), min(ys), max(xs), max(ys)]
print(json.dumps({'found': box[2] - box[0] <= 32 and box[3] - box[1] <= 32, 'x': round(sum(xs) / len(xs)), 'y': round(sum(ys) / len(ys)), 'hits': len(hits), 'box': box}))`;
function nativeClick(x, y, button = 1) {
  if (!env.DISPLAY?.startsWith(':')) throw new Error('An isolated local DISPLAY is required');
  execFileSync('python3', ['-c', CLICK, String(Math.round(x)), String(Math.round(y)), String(button)], { env });
}

// ---- Loopback fixture site ------------------------------------------------------
const TONE = (() => {
  const rate = 8000, n = rate * 2, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), 44 + i * 2);
  return b;
})();
const titleOf = slug => `Fixture ${slug.replaceAll('-', ' ')}`;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/tone.wav') { res.setHeader('Content-Type', 'audio/wav'); res.end(TONE); return; }
  const slug = url.match(/^\/t\/([a-z0-9-]{1,40})$/)?.[1] ?? 'none';
  const audio = slug.startsWith('audio') ? '<audio src="/tone.wav" autoplay loop></audio>' : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${titleOf(slug)}</title>
    <style>:root{color-scheme:light dark}body{font:16px system-ui,sans-serif;margin:40px}</style></head>
    <body><h1>${titleOf(slug)}</h1><p>Disposable stale-tab fixture on 127.0.0.1.</p>${audio}</body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const urlOf = slug => `${base}/t/${slug}`;

// ---- Browser adapters -----------------------------------------------------------
// Each returns: api(body) in an extension context, open({ private }), isOpen(),
// popup(body) in the visible menu, scheme(value), nowB() (the extension clock),
// plus browser-specific fixture and lifecycle helpers.
async function firefoxAdapter() {
  process.env.TMPDIR = directory;
  const uuid = 'a3906219-0180-4fa2-a2d8-a90270e6e501';
  const ADDON = 'tabvacuum@adlio';
  const ext = `moz-extension://${uuid}`;
  const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
  const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
  const options = new firefox.Options()
    .setBinary(process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox'))
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('browser.tabs.warnOnClose', false)
    .setPreference('media.autoplay.default', 0)
    .setPreference('media.autoplay.blocking_policy', 0)
    .setPreference('media.block-autoplay-until-in-foreground', false)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON]: uuid }));
  if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) service.addArguments('--allow-system-access');
  else options.addArguments('-remote-allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  await driver.manage().window().setRect({ x: 0, y: 0, width: W, height: H });
  await driver.installAddon(path.resolve('dist/firefox'), true);
  await driver.get(urlOf('origin'));
  await driver.setContext('chrome');
  const mainHandle = await driver.getWindowHandle();
  const execute = (body, ...args) => driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    (async()=>{${body}})().then(done,e=>done({testError:String(e)}));`, ...args).then(value => {
      if (value?.testError) throw new Error(value.testError); return value;
    });
  // Private windows: the same permission store about:addons writes, then its reload (throwaway profile only).
  await execute(`const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    await ExtensionPermissions.add(arguments[0], { permissions: ['internal:privateBrowsingAllowed'], origins: [] });
    await (await AddonManager.getAddonByID(arguments[0])).reload(); return true;`, ADDON);
  await until(() => driver.executeScript('return WebExtensionPolicy.getByID(arguments[0])?.privateBrowsingAllowed === true', ADDON), 'private allowed');
  let evaluatorReady;
  let viaBackground = false; // see bg() below
  async function openEvaluator() {
    await until(() => driver.executeScript('return !!WebExtensionPolicy.getByID(arguments[0])?.extension', ADDON), 'add-on running');
    await execute(`window.__staleOptions=gBrowser.addTab(arguments[0], {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),inBackground:true}); return true;`, `${ext}/options.html`);
    evaluatorReady = until(async () => (await api('return !!api.runtime.id;')) === true, 'extension evaluator', 15000);
    await evaluatorReady;
  }
  const api = body => (viaBackground ? bg(body) : execute(`const bc=window.__staleOptions.linkedBrowser.browsingContext;
    return bc.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',
      {script:arguments[0],args:[],opts:{}});`, `return (async()=>{const api=browser;${body}})()`));
  await openEvaluator();
  // The background page itself, for windows where no extension view may be open.
  const bg = body => execute(`const bc=WebExtensionPolicy.getByID(arguments[1])?.extension?.backgroundContext?.xulBrowser?.browsingContext;
    if (!bc) throw new Error('background page not running');
    return bc.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',
      {script:arguments[0],args:[],opts:{}});`, `return (async()=>{const api=browser;${body}})()`, ADDON);
  const VIEWS = `const views=[]; for (const w of Services.wm.getEnumerator('navigator:browser'))
    for (const b of w.document.querySelectorAll('browser.webextension-popup-browser')) if (b.getClientRects().length > 0) views.push(b);`;
  const isOpen = () => driver.executeScript(`${VIEWS} return views.length > 0;`);
  const popup = body => execute(`${VIEWS} const view=views[0]; if(!view) throw new Error('No visible popup');
    return view.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',
      {script:arguments[0],args:[],opts:{}});`, `return (async()=>{${body}})()`);
  let privateHandle = null;
  return {
    driver, ext, versions: { browser: (await driver.getCapabilities()).get('browserVersion'), driver: execFileSync(driverPath, ['--version'], { encoding: 'utf8' }).split('\n')[0] },
    api, isOpen, popup, nowB: () => Date.now(),
    focus: () => driver.executeScript('window.focus(); gBrowser.selectedBrowser.focus();'),
    async open({ private: priv = false } = {}) {
      await driver.switchTo().window(priv ? privateHandle : mainHandle);
      await driver.executeScript('window.focus(); gBrowser.selectedBrowser.focus(); CustomizableUI.addWidgetToArea("tabvacuum_adlio-browser-action", "nav-bar");');
      await driver.findElement(By.id('tabvacuum_adlio-BAP')).click();
      await driver.switchTo().window(mainHandle);
      await until(isOpen, 'popup open');
      await until(async () => await popup('return document.body.classList.contains("ready")'), 'popup ready');
    },
    scheme: value => execute(`const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await (await AddonManager.getAddonByID(arguments[0])).enable(); return true;`, `firefox-compact-${value}@mozilla.org`),
    // [fixture] Native lastAccessed for the tab showing `url`, in this throwaway profile.
    setLastAccessed: (url, at) => driver.executeScript(`for (const w of Services.wm.getEnumerator('navigator:browser'))
      for (const t of w.gBrowser.tabs) if (t.linkedBrowser.currentURI.spec === arguments[0]) {
        if (t.selected) return 'selected';
        t.updateLastAccessed(arguments[1]); return t.lastAccessed; }
      return 'missing';`, url, at),
    async raiseMain() { nativeKeys(env, ['Shift_L'], titleOf('origin')); await sleep(200); },
    async setShortcut() { await api(`await api.commands.update({name:'close-stale', shortcut:${JSON.stringify(SHORTCUT.firefox)}}); return true;`); },
    // A native context click on the selected tab, then a native click on our menu item.
    async contextMenu() {
      const tab = await driver.executeScript(`const t=gBrowser.selectedTab, r=t.getBoundingClientRect();
        return {x: window.mozInnerScreenX + r.left + r.width / 2, y: window.mozInnerScreenY + r.top + r.height / 2};`);
      nativeClick(tab.x, tab.y, 3);
      await until(() => driver.executeScript('return document.getElementById("tabContextMenu").state === "open"'), 'tab context menu open');
      await sleep(400);
      capture('context-menu', 'Native tab context menu with the stale item');
      const FIND = `const i=[...document.querySelectorAll('#tabContextMenu menuitem')].find(m=>m.label==='Review Stale Tabs…');`;
      const where = el => `const r=${el}.getBoundingClientRect(); return ${el}.screenX > 0 ? {x:${el}.screenX + r.width / 2, y:${el}.screenY + r.height / 2} : {x: window.mozInnerScreenX + r.left + r.width / 2, y: window.mozInnerScreenY + r.top + r.height / 2};`;
      await until(() => driver.executeScript(`${FIND} return !!i;`), 'stale menu item');
      // Firefox groups several extension items under one submenu named after the add-on.
      const parent = await driver.executeScript(`${FIND} const m=i.parentElement.closest('menu'); if(!m) return null; ${where('m')}`);
      if (parent) {
        nativeClick(parent.x, parent.y, 1);
        await until(() => driver.executeScript(`${FIND} return i.parentElement.state === 'open';`), 'extension submenu open');
        await sleep(300);
        capture('context-menu', 'Native tab context menu, extension submenu open');
      }
      const item = await driver.executeScript(`${FIND} ${where('i')}`);
      console.log(`INFO context menu item at ${JSON.stringify(item)}, tab at ${JSON.stringify(tab)}`);
      nativeClick(item.x, item.y, 1);
      return true;
    },
    async openPrivate(url) {
      const before = await driver.getAllWindowHandles();
      const id = await api(`return (await api.windows.create({incognito:true, url:${JSON.stringify(url)}, left:0, top:0, width:${W}, height:${H}})).id;`);
      await until(async () => (await driver.getAllWindowHandles()).length > before.length, 'private window');
      privateHandle = (await driver.getAllWindowHandles()).find(h => !before.includes(h));
      await until(async () => (await api('return (await api.tabs.query({})).some(t => t.incognito && t.url === ' + JSON.stringify(url) + ' && t.status === "complete")')), 'private page loaded');
      return { close: async () => { await api(`await api.windows.remove(${id}); return true;`); privateHandle = null; } };
    },
    attachOpen: async () => {
      await until(isOpen, 'popup open');
      await until(async () => await popup('return document.body.classList.contains("ready")'), 'popup ready');
    },
    // Extension restart: the add-on reload about:addons performs. Session storage is cleared.
    async reloadExtension() {
      await execute(`const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await (await AddonManager.getAddonByID(arguments[0])).reload(); return true;`, ADDON);
      await sleep(1000);
      await openEvaluator();
    },
    restart: null,
    // No extension view open (each one re-checks the schedule): evaluate in the background page.
    async noViews() {
      await execute('gBrowser.removeTab(window.__staleOptions); window.__staleOptions = null; return true;');
      viaBackground = true;
      await until(async () => (await api('return !!api.runtime.id;')) === true, 'background evaluator', 15000);
    },
    async restoreViews() { viaBackground = false; await openEvaluator(); },
    async shutdown() { await driver.quit(); },
  };
}

async function chromiumAdapter() {
  const profile = await mkdtemp(path.join(directory, 'profile-'));
  const extension = path.resolve('dist/chrome');
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_BINARY || chromium.executablePath(), headless: false, env, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required',
      '--window-position=0,0', `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check'],
  });
  let context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const ext = worker.url().replace(/\/background\.js$/, '');
  const extId = new URL(ext).host;
  let page = context.pages()[0];
  await page.goto(urlOf('origin'));
  let cdp = await context.browser().newBrowserCDPSession();
  const sessions = new Map();
  let nextId = 0;
  const send = (session, method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error(`CDP timeout ${method}`)); }, 10000);
    function receive(event) {
      if (event.sessionId !== session) return;
      const value = JSON.parse(event.message);
      if (value.id !== id) return;
      clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive);
      if (value.error || value.result?.exceptionDetails) reject(new Error(JSON.stringify(value.error || value.result.exceptionDetails).slice(0, 600)));
      else resolve(value.result);
    }
    cdp.on('Target.receivedMessageFromTarget', receive);
    cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method, params }) })
      .catch(error => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); reject(error); });
  });
  async function attach(targetId) {
    if (!sessions.has(targetId)) sessions.set(targetId, (await cdp.send('Target.attachToTarget', { targetId, flatten: false })).sessionId);
    return sessions.get(targetId);
  }
  const evalIn = async (targetId, expression) => (await send(await attach(targetId), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const workerTarget = async () => (await targets()).find(t => t.type === 'service_worker' && t.url === `${ext}/background.js`);
  let normalContextId = (await workerTarget())?.browserContextId;

  // Developer settings in this throwaway profile: incognito access (reloads the
  // extension) and a binding for the unbound close-stale command.
  async function developerPrivate(fn, arg) {
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    const value = await manager.evaluate(fn, arg);
    await manager.close();
    return value;
  }
  const previousWorker = worker;
  await developerPrivate(async ([id, key]) => {
    const call = (fn, arg) => new Promise((resolve, reject) => chrome.developerPrivate[fn](arg, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(true))));
    await call('updateProfileConfiguration', { inDeveloperMode: true });
    await call('updateExtensionConfiguration', { extensionId: id, incognitoAccess: true });
    return true;
  }, [extId]);
  await sleep(1500);
  const waker = await context.newPage();
  await waker.goto(`${ext}/options.html`).catch(() => {});
  await until(() => (worker = context.serviceWorkers().find(w => w !== previousWorker && w.url().startsWith(ext))), 'reloaded worker', 15000);
  await waker.close();
  normalContextId = (await workerTarget())?.browserContextId ?? normalContextId;

  // Bounded, so a refused or hung extension call fails a check instead of the run.
  const api = body => Promise.race([worker.evaluate(`(async()=>{const api=browser; ${body}})()`),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker evaluate timeout (30s)')), 30000))]);
  let offset = 0;
  const CLOCK = ms => `(()=>{ if (!globalThis.__harnessRealNow) { globalThis.__harnessRealNow = Date.now.bind(Date);
    Date.now = () => globalThis.__harnessRealNow() + globalThis.__harnessOffset; } globalThis.__harnessOffset = ${ms}; return Date.now(); })()`;
  let popupTarget = null;
  let privateContextId = null; // set while the harness's incognito window is open
  let scheme = 'light';
  const popups = async () => (await targets()).filter(t => t.url === `${ext}/popup.html` && (!privateContextId || t.browserContextId === privateContextId));
  const isOpen = async () => (await popups()).length > 0;
  const popup = body => evalIn(popupTarget, `(async()=>{${body}})()`);
  const media = () => send(sessions.get(popupTarget), 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  const incognitoWorker = async () => (await targets()).find(t => t.type === 'service_worker' && t.url === `${ext}/background.js` && t.browserContextId !== normalContextId);
  // Attaches to the menu that is open now, however it was opened.
  async function attachOpen() {
    await until(isOpen, 'popup open');
    popupTarget = (await popups())[0].targetId;
    await attach(popupTarget);
    await until(async () => await popup('return document.body.classList.contains("ready")'), 'popup ready');
    await media();
    // [fixture] the popup shares the worker's clock, then refreshes once.
    if (offset) {
      await evalIn(popupTarget, CLOCK(offset));
      await api('await api.storage.session.set({"harness.tick": Math.random()});');
      await sleep(600);
    }
  }
  return {
    ext, profile, get context() { return context; },
    versions: { browser: context.browser().version(), binary: process.env.CHROMIUM_BINARY || chromium.executablePath() },
    api, isOpen, popup, nowB: () => Date.now() + offset, attachOpen,
    focus: () => page.bringToFront(),
    async open({ private: priv = false } = {}) {
      if (priv) {
        const sw = await incognitoWorker();
        if (!sw) throw new Error('No incognito worker');
        await evalIn(sw.targetId, 'chrome.action.openPopup()');
      } else {
        await page.bringToFront();
        await api('await api.action.openPopup();');
      }
      await attachOpen();
    },
    scheme: async value => { scheme = value; if (await isOpen()) await media(); },
    // [fixture] isolated extension clock: worker plus any open popup.
    async setOffset(ms) {
      offset = ms;
      const workerNow = await worker.evaluate(CLOCK(ms));
      if (await isOpen()) await evalIn(popupTarget, CLOCK(ms));
      return workerNow;
    },
    async raiseMain() { await page.bringToFront(); nativeKeys(env, ['Shift_L'], titleOf('origin')); await sleep(200); },
    async setShortcut() {
      await developerPrivate(([id, key]) => new Promise((resolve, reject) => chrome.developerPrivate.updateExtensionCommand(
        { extensionId: id, commandName: 'close-stale', keybinding: key }, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(true)))),
      [extId, SHORTCUT.chromium]);
    },
    // A native right-click on the toolbar button, found on screen by the
    // extension's own icon colour, then native keys to the stale item.
    async contextMenu() {
      await developerPrivate(id => new Promise((resolve, reject) => chrome.developerPrivate.updateExtensionConfiguration(
        { extensionId: id, pinnedToToolbar: true }, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(true)))), extId);
      await page.bringToFront();
      await sleep(800);
      capture('toolbar-pinned', 'Chromium toolbar with the extension button pinned [fixture: pinned in the throwaway profile]');
      const file = path.join(directory, 'toolbar-pinned.png');
      const found = JSON.parse(execFileSync('python3', ['-c', FIND_ICON, file, path.join(extension, 'icons/toolbar-chrome-16.png')], { encoding: 'utf8' }));
      fixture('chromium toolbar button located from screenshot', found);
      if (!found.found) throw new Error(`toolbar button not found on screen: ${JSON.stringify(found)}`);
      nativeClick(found.x, found.y, 3);
      await sleep(1200);
      capture('context-menu', 'Native toolbar-button context menu');
      // Menu order is the registration order in background.js: the disabled
      // extension-name header, then Close Duplicate Tabs, Merge All Windows,
      // Sort Tabs, Review Stale Tabs…. Only that item opens the stale controls.
      for (let i = 0; i < 4; i++) { nativeKeys(env, ['Down']); await sleep(150); }
      await sleep(300);
      capture('context-menu-stale-highlighted', 'Native context menu with Review Stale Tabs… highlighted');
      nativeKeys(env, ['Return']);
      return found;
    },
    // The split-mode incognito worker, evaluated in place.
    async privateApi(body) {
      const sw = await incognitoWorker();
      if (!sw) throw new Error('No incognito worker');
      return evalIn(sw.targetId, `(async()=>{const api=chrome; ${body}})()`);
    },
    async openPrivate(url) {
      // In split mode the normal worker cannot see the incognito window it creates.
      await api(`await api.windows.create({incognito:true, url:${JSON.stringify(url)}, left:0, top:0, width:${W}, height:${H}}); return true;`);
      await until(async () => (await targets()).some(t => t.type === 'page' && t.url === url && t.browserContextId !== normalContextId), 'incognito page', 15000);
      const ctx = (await targets()).find(t => t.type === 'page' && t.url === url && t.browserContextId !== normalContextId).browserContextId;
      // The incognito worker may start lazily; an extension page in that context wakes it.
      const started = await until(async () => Boolean(await incognitoWorker()), 'incognito worker', 6000).catch(() => false);
      if (!started) {
        await cdp.send('Target.createTarget', { url: `${ext}/options.html`, browserContextId: ctx, background: true });
        await until(async () => Boolean(await incognitoWorker()), 'incognito worker (woken)', 15000);
      }
      fixture('chromium incognito window', { wokenByOptionsPage: !started });
      privateContextId = ctx;
      // Closing every incognito tab target closes the window (the normal worker cannot see it).
      return { close: async () => {
        for (const t of (await targets()).filter(x => x.type === 'page' && x.browserContextId === ctx)) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
        await until(async () => !(await targets()).some(x => x.type === 'page' && x.browserContextId === ctx), 'incognito window closed', 10000);
        privateContextId = null;
      } };
    },
    // Extension restart through runtime.reload(); the worker and session storage start over.
    async reloadExtension() {
      const old = worker;
      await worker.evaluate('setTimeout(() => chrome.runtime.reload(), 50); true').catch(() => {});
      offset = 0;
      await sleep(1500);
      const wake = await context.newPage();
      await wake.goto(`${ext}/options.html`).catch(() => {});
      await until(() => (worker = context.serviceWorkers().find(w => w !== old && w.url().startsWith(ext))), 'reloaded worker', 15000);
      await wake.close();
      sessions.clear();
    },
    // Full browser restart on the same throwaway profile.
    async restart() {
      await context.close();
      offset = 0;
      context = await launch();
      worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      page = context.pages()[0];
      cdp = await context.browser().newBrowserCDPSession();
      sessions.clear();
      normalContextId = (await workerTarget())?.browserContextId ?? normalContextId;
    },
    // The worker is the evaluator; close any extension page (each one re-checks the schedule).
    async noViews() { for (const p of context.pages()) if (p.url().startsWith(ext)) await p.close(); },
    async restoreViews() {},
    async shutdown() { await context.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); },
  };
}

// ---- Shared probes ---------------------------------------------------------------
const STATE = `const $=id=>document.getElementById(id);
  return { title:$('stale-title').textContent, caption:$('stale-caption').hidden ? null : $('stale-caption').textContent,
    captionTone:$('stale-caption').dataset.tone || '', expanded:$('btn-stale').getAttribute('aria-expanded'), panel:!$('stale-panel').hidden,
    chevron:getComputedStyle($('btn-stale').querySelector('.chevron')).transform, sortExpanded:$('btn-sort').getAttribute('aria-expanded'),
    value:$('stale-value').value, unit:$('stale-unit').value, invalid:$('stale-value').getAttribute('aria-invalid'),
    auto:$('stale-auto').checked, autoMixed:$('stale-auto').indeterminate, autoDisabled:$('stale-auto').getAttribute('aria-disabled'),
    autoDetail:$('stale-auto-detail').textContent, warning:$('stale-warning').textContent, count:$('stale-count').textContent,
    protect:$('stale-protect').textContent, close:$('stale-close').textContent, closeDisabled:$('stale-close').getAttribute('aria-disabled'),
    review:$('stale-review').getAttribute('aria-expanded'), listHidden:$('stale-review-list').hidden,
    rows:[...$('stale-review-list').querySelectorAll('li')].map(li => ({ title: li.querySelector('.stale-tab-title')?.textContent ?? null,
      meta: li.querySelector('.stale-tab-meta')?.textContent ?? li.textContent })),
    message:$('stale-message').textContent, ruleError:$('stale-rule-error').hidden ? '' : $('stale-rule-error').textContent,
    status:{ tone:$('status').dataset.tone || '', title:$('status-title').textContent, detail:$('status-detail').textContent },
    focus:document.activeElement?.id || document.activeElement?.tagName, lang:navigator.language,
    hourCycle:new Intl.DateTimeFormat(undefined,{hour:'numeric'}).resolvedOptions().hourCycle,
    h:innerHeight, w:innerWidth, scrollH:document.documentElement.scrollHeight, scrollW:document.documentElement.scrollWidth };`;
const LAYOUT = `const $=id=>document.getElementById(id);
  const named = el => Boolean(el.getAttribute('aria-label')) || [...(el.labels ?? [])].some(l => l.textContent.trim()) || el.textContent.trim().length > 0;
  const reach = ['btn-stale','stale-value','stale-unit','stale-auto','stale-review','stale-close','stale-review-list'].map(id => {
    const el = $(id); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
    const status = $('status').classList.contains('visible') ? $('status').getBoundingClientRect().top : innerHeight;
    return { id, named: named(el), visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= Math.min(innerHeight, status) + 1 && r.left >= 0 && r.right <= innerWidth + 1 };
  });
  window.scrollTo(0, 0);
  return { h: innerHeight, w: innerWidth, scrollH: document.documentElement.scrollHeight, scrollW: document.documentElement.scrollWidth, reach,
    controls: [$('btn-stale').getAttribute('aria-controls'), $('stale-review').getAttribute('aria-controls')].every(id => id && $(id)),
    live: $('stale-message').getAttribute('aria-live'), statusRole: $('status').querySelector('.status-copy')?.getAttribute('role'),
    listScroll: getComputedStyle($('stale-review-list')).overflowY,
    order: [...document.querySelectorAll('#stale-panel input, #stale-panel select, #stale-panel button')].map(e => e.id) };`;
const STICKY = `const $=id=>document.getElementById(id);
  window.scrollTo(0, document.documentElement.scrollHeight);
  const box = $('status').getBoundingClientRect(), t = $('status-title').getBoundingClientRect();
  const hit = document.elementFromPoint(t.left + Math.min(12, t.width / 2), t.top + t.height / 2);
  const result = { overflow: document.documentElement.scrollHeight > innerHeight, inView: box.top >= 0 && box.bottom <= innerHeight + 1,
    labelHit: Boolean(hit) && $('status').contains(hit), position: getComputedStyle($('status')).position, text: $('status-title').textContent, tone: $('status').dataset.tone };
  window.scrollTo(0, 0);
  return result;`;
// Observation only: records the real reply of the real close command.
const OBSERVE = `const send = browser.runtime.sendMessage.bind(browser.runtime);
  browser.runtime.sendMessage = async msg => { const result = await send(msg);
    if (msg?.command === 'closeStalePreview') await browser.storage.session.set({ 'harness.result': result }); return result; };`;
// [fault] the popup's transport rejects one command; everything else is real.
const FAULT = command => `const send = browser.runtime.sendMessage.bind(browser.runtime);
  browser.runtime.sendMessage = msg => msg?.command === ${JSON.stringify(command)} ? Promise.reject(new Error('Test transport failure')) : send(msg);`;
// [fault] as FAULT, plus an observer that counts every command the popup sends
// (window.__harnessSent), so a recovery step can prove it sent no second close.
const FAULT_COUNTED = command => `const send = browser.runtime.sendMessage.bind(browser.runtime);
  window.__harnessSent = {};
  browser.runtime.sendMessage = msg => { const c = String(msg?.command); window.__harnessSent[c] = (window.__harnessSent[c] ?? 0) + 1;
    return c === ${JSON.stringify(command)} ? Promise.reject(new Error('Test transport failure')) : send(msg); };`;
// Footer geometry: every visible part of the status bar is inside the viewport and unclipped.
const FOOTER = `const $=id=>document.getElementById(id);
  window.scrollTo(0, document.documentElement.scrollHeight);
  const inside = el => { const r = el.getBoundingClientRect(); return { id: el.id, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
    ok: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 }; };
  const parts = ['status','status-title','status-detail','status-review','status-close'].map($).filter(el => !el.hidden).map(inside);
  const hit = id => { const r = $(id).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(e) && $(id).contains(e); };
  const result = { h: innerHeight, w: innerWidth, parts, reviewHit: !$('status-review').hidden && hit('status-review'), closeHit: !$('status-close').hidden && hit('status-close'),
    title: $('status-title').textContent, detail: $('status-detail').textContent, review: $('status-review').hidden ? null : $('status-review').textContent };
  window.scrollTo(0, 0);
  return result;`;
const TABS = 'return (await api.tabs.query({})).map(t => ({ id: t.id, url: t.url, title: t.title, windowId: t.windowId, active: t.active, pinned: t.pinned, audible: t.audible, incognito: t.incognito, status: t.status, lastAccessed: t.lastAccessed }));';

let b;
let video = { stop: async () => {} };
const record = { browser: name, base, display: env.DISPLAY, size: `${W}x${H}`, directory };
async function phase(label, fn) {
  console.log(`---- ${label}`);
  try { await fn(); } catch (error) { check(false, `${label}: completed without error`, String(error?.stack || error).slice(0, 1500)); }
}

try {
  b = name === 'firefox' ? await firefoxAdapter() : await chromiumAdapter();
  record.versions = b.versions;
  console.log(`INFO ${name} ${JSON.stringify(b.versions)}`);
  const { api, popup, isOpen } = b;
  const state = () => popup(STATE);
  const waitState = (pred, label, ms = 10000) => until(async () => pred(await state()), label, ms).then(() => state());
  const snapshot = () => api(TABS);
  const openUrls = async () => (await snapshot()).map(t => t.url);
  const local = keys => api(`return await api.storage.local.get(${JSON.stringify(keys)});`);
  const alarm = () => api(`return (await api.alarms.get(${JSON.stringify(STALE_ALARM)})) ?? null;`);
  const closePopup = async () => { if (await isOpen()) await popup('window.close(); return true;').catch(() => {}); await until(async () => !await isOpen(), 'popup closed'); };
  const expandStale = () => popup('const b=document.getElementById("btn-stale"); if (b.getAttribute("aria-expanded") !== "true") b.click(); return true;');
  const shot = async (label, what) => { await sleep(450); capture(label, what); };
  const themed = async (label, what, prepare) => {
    for (const theme of ['light', 'dark']) {
      await b.scheme(theme);
      if (prepare) await prepare(theme);
      await shot(`${label}-${theme}`, `${what} (${theme})`);
    }
    await b.scheme('light');
  };

  const windows = await api('return (await api.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, incognito: w.incognito }));');
  const mainWindow = windows.find(w => w.focused)?.id ?? windows[0].id;

  // ---- Fixtures ----------------------------------------------------------------
  const STALE = ['stale-alpha', 'stale-bravo', 'stale-charlie', 'stale-delta'];
  const create = (slug, props = {}) => api(`return (await api.tabs.create({ url: ${JSON.stringify(urlOf(slug))}, active: false, windowId: ${mainWindow}, ...${JSON.stringify(props)} })).id;`);
  const loaded = slugs => until(async () => {
    const all = await snapshot();
    return slugs.every(s => all.some(t => t.url === urlOf(s) && t.status === 'complete'));
  }, `fixtures loaded: ${slugs.join(',')}`, 20000);
  const ids = {};
  const lastViewed = {}; // slug -> fixture last-viewed time on the extension clock
  const protectedAuto = new Set(['stale-pinned', 'lonely']);
  let audible = false;

  await phase('fixtures', async () => {
    check(!(await local(['autoCloseStaleEnabled'])).autoCloseStaleEnabled && !(await alarm()), 'fresh profile: automation off and no stale alarm');
    const meta = await local(['autoCloseStaleEnabled', 'staleNextRunAt', 'staleThresholdMs']);
    check(meta.autoCloseStaleEnabled !== true && meta.staleNextRunAt == null && (meta.staleThresholdMs ?? 7 * DAY) === 7 * DAY,
      'fresh profile metadata: opt-in not set, no recorded run, 7-day default', meta);
    for (const slug of STALE) ids[slug] = await create(slug);
    ids['stale-pinned'] = await create('stale-pinned', { pinned: true });
    ids['audio-stale'] = await create('audio-stale');
    const lonely = await api(`const w = await api.windows.create({ url: ${JSON.stringify(urlOf('lonely'))}, left: 900, top: 540, width: 360, height: 240 }); return { id: w.id, tab: w.tabs[0].id };`);
    ids.lonely = lonely.tab;
    if (name === 'firefox') { ids.crossing = await create('crossing'); ids.late = await create('late'); }
    await loaded([...STALE, 'stale-pinned', 'audio-stale', 'lonely', ...(name === 'firefox' ? ['crossing', 'late'] : [])]);
    await api(`await api.windows.update(${mainWindow}, { focused: true }); return true;`);
    await b.raiseMain();
    const now = b.nowB();
    const nextRun = nextLocalHour(now);
    if (name === 'firefox') {
      const old = now - 8 * DAY - HOUR;
      for (const slug of [...STALE, 'stale-pinned', 'audio-stale']) {
        const got = await b.setLastAccessed(urlOf(slug), old);
        lastViewed[slug] = old;
        if (got !== old) throw new Error(`lastAccessed fixture not applied to ${slug}: ${got}`);
      }
      // Not stale now; stale by the next run (crosses one minute before it).
      lastViewed.crossing = nextRun - WEEK - MIN;
      await b.setLastAccessed(urlOf('crossing'), lastViewed.crossing);
      lastViewed.late = now; // fresh until the close-flow step ages it
      fixture('firefox native lastAccessed', { stale: STALE.concat('stale-pinned', 'audio-stale'), staleAt: new Date(old).toISOString(),
        crossing: new Date(lastViewed.crossing).toISOString(), nextRun: new Date(nextRun).toISOString() });
      if (nextRun - now < 8 * MIN) limit('projected count (crossing tab)', `only ${Math.round((nextRun - now) / MIN)} min to the next whole hour; crossing tab may turn stale during the run`);
    } else {
      // Stale group ages from real creation; crossing is created at hh:50 on the
      // shifted clock, then the clock moves to hh:05 one week minus 45 min later.
      const realNow = Date.now();
      let first = 8 * DAY;
      const at50 = t => { const d = new Date(t); d.setMinutes(50, 0, 0); let x = d.getTime(); while (x < t) x += HOUR; return x; };
      first = at50(realNow + first + 5000) - realNow;
      await b.setOffset(first);
      const crossingAt = b.nowB();
      ids.crossing = await create('crossing');
      await loaded(['crossing']);
      for (const slug of [...STALE, 'stale-pinned', 'audio-stale']) lastViewed[slug] = realNow; // created on the real clock
      lastViewed.crossing = crossingAt;
      const target = crossingAt + WEEK - 45 * MIN;
      await b.setOffset(target - Date.now());
      ids.late = await create('late');
      await loaded(['late']);
      lastViewed.late = b.nowB();
      fixture('chromium isolated extension clock', { offsetDays: +((target - Date.now()) / DAY).toFixed(4), crossingCreatedAt: new Date(crossingAt).toISOString(),
        extensionNow: new Date(b.nowB()).toISOString(), nextRun: new Date(nextLocalHour(b.nowB())).toISOString() });
    }
    const all = await snapshot();
    audible = all.find(t => t.id === ids['audio-stale'])?.audible === true;
    if (!audible) {
      // Give autoplay a moment, then decide.
      await sleep(2500);
      audible = (await snapshot()).find(t => t.id === ids['audio-stale'])?.audible === true;
    }
    if (audible) protectedAuto.add('audio-stale');
    else limit('audio protection', 'fixture tab never reported audible=true in this display/audio environment; it is treated as an ordinary stale tab');
    record.ids = ids;
    record.audible = audible;
  });

  const isOpenSlug = async slug => (await openUrls()).includes(urlOf(slug));
  // Expected counts from fixture times; skipPinned/skipAudible stay at their defaults (true).
  const expected = async (policy, at) => {
    const open = await openUrls();
    return Object.keys(lastViewed).filter(slug => open.includes(urlOf(slug)) && !protectedAuto.has(slug) && at - lastViewed[slug] >= WEEK);
  };

  // ---- A. Off state, no immediate close, inline controls -------------------------
  let preview = [];
  await phase('A off state', async () => {
    const before = await snapshot();
    const winsBefore = await api('return (await api.windows.getAll()).length;');
    await b.open();
    let s = await waitState(x => x.title === DISABLED_TITLE && x.count !== '', 'off state loaded');
    check(s.lang.startsWith('en') && /h1[12]/.test(s.hourCycle || 'h12'), 'popup locale is English 12-hour (oracle applies)', { lang: s.lang, hourCycle: s.hourCycle });
    check(s.title === DISABLED_TITLE && s.caption === null, 'off: title "Stale Tabs" with no automation caption', s);
    check(s.expanded === 'false' && !s.panel, 'off: stale row starts collapsed', s);
    const collapsedChevron = s.chevron;
    await themed('off', 'Automation off, collapsed main menu');
    await expandStale();
    await sleep(1200);
    s = await state();
    check(s.expanded === 'true' && s.panel && s.sortExpanded === 'false', 'row click expands inline controls (aria-expanded=true)', s);
    const turned = (() => { const m = s.chevron.match(/^matrix\(([^)]+)\)$/); if (!m) return false; const [a, bb, c, d] = m[1].split(',').map(Number);
      return Math.abs(a) < 1e-6 && Math.abs(bb - 1) < 1e-6 && Math.abs(c + 1) < 1e-6 && Math.abs(d) < 1e-6; })();
    check(collapsedChevron === 'none' && turned, 'chevron turns from right-facing to down-facing (rotate 90deg)', { collapsedChevron, expanded: s.chevron });
    check(await isOpen(), 'expanding keeps the menu open (no detached window)');
    check((await api('return (await api.windows.getAll()).length;')) === winsBefore, 'expanding opens no new window');
    check((await snapshot()).length === before.length, 'opening Stale Tabs closes nothing', { before: before.length });
    s = await waitState(x => x.closeDisabled !== 'true' || /no tabs/.test(x.count), 'manual preview');
    const nowB = b.nowB();
    const manual = await expected('manual', nowB);
    const auto = await expected('auto', nextLocalHour(nowB));
    record.expectedA = { manual, auto };
    check(s.value === '7' && s.unit === 'days' && s.auto === false && !s.autoMixed, 'controls show 7 days and an unchecked automation box', s);
    check(s.warning === WARNING, 'controls show the closed-not-archived warning');
    check(s.count === `Close now: ${tabs(manual.length)} not viewed for 7 days, across 1 window.`, 'manual count uses eligibility now, with scope', { got: s.count, manual });
    check(s.close === `Close ${tabs(manual.length)} now`, 'Close N tabs now names the manual count', s.close);
    const nextRun = nextLocalHour(b.nowB());
    // A projected count above the manual count says why: tabs that reach the rule before the run.
    const horizon = auto.length > manual.length ? ' Includes tabs that reach 7 days before then.' : '';
    check(s.autoDetail === `If turned on, ${tabs(auto.length)} would close automatically at ${runTime(nextRun, b.nowB())}.${horizon} Nothing closes before then.`,
      'pre-enable line: projected count at the next whole local hour, explained when above the manual count', { got: s.autoDetail, auto, manual });
    check(auto.length > manual.length, 'projection includes a tab that crosses the threshold before the run', { manual: manual.length, auto: auto.length });
    check(s.protect.includes('Close now keeps pinned tabs and tabs playing audio.')
      && s.protect.includes("Both keep each window's active tab and last tab. Automatic cleanup always keeps pinned tabs and tabs playing audio."),
      'protections: manual keeps pinned/audio by setting; both keep active and last tab; automatic always keeps pinned/audio', s.protect);

    // Unit conversion: 7 days shows as 168 hours and saves nothing.
    const rule0 = await local(['staleThresholdMs', 'staleRuleRevision']);
    await popup('const u=document.getElementById("stale-unit"); u.value="hours"; u.dispatchEvent(new Event("change",{bubbles:true})); return true;');
    s = await state();
    check(s.value === '168' && s.unit === 'hours' && !s.ruleError, 'days -> hours shows 168 hours', s);
    await popup('const v=document.getElementById("stale-value"); v.dispatchEvent(new Event("change",{bubbles:true})); return true;');
    await sleep(800);
    const rule1 = await local(['staleThresholdMs', 'staleRuleRevision']);
    check((rule1.staleThresholdMs ?? 7 * DAY) === 7 * DAY && JSON.stringify(rule1) === JSON.stringify(rule0), 'unit switch and 168-hour commit do not shrink or rewrite the saved threshold', { rule0, rule1 });
    await popup('const u=document.getElementById("stale-unit"); u.value="days"; u.dispatchEvent(new Event("change",{bubbles:true})); return true;');
    s = await state();
    check(s.value === '7' && s.unit === 'days', 'hours -> days returns to 7 days', s);

    // Escape abandons a half-typed duration, then collapses the controls.
    await popup('const v=document.getElementById("stale-value"); v.focus(); v.value="3"; v.dispatchEvent(new Event("input",{bubbles:true})); return true;');
    s = await state();
    check(s.value === '3', 'half-typed duration shown before Escape', s.value);
    await popup('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})); return true;');
    await sleep(400);
    s = await state();
    check(s.value === '7' && s.unit === 'days' && !s.panel && s.expanded === 'false' && s.focus === 'btn-stale', 'Escape restores the saved 7 days and collapses to the row', s);
    check(await isOpen(), 'first Escape keeps the menu open');
    check(JSON.stringify(await local(['staleThresholdMs', 'staleRuleRevision'])) === JSON.stringify(rule0), 'Escape saved nothing');

    // Review list.
    await expandStale();
    await waitState(x => x.closeDisabled !== 'true', 'preview ready');
    await popup('document.getElementById("stale-review").click(); return true;');
    s = await waitState(x => !x.listHidden && x.rows.length > 0, 'review list');
    const titles = manual.map(slug => titleOf(slug));
    check(s.review === 'true' && s.rows.length === manual.length && s.rows.every(r => titles.includes(r.title)), 'Review lists exactly the manual candidates', { rows: s.rows, titles });
    check(s.rows.every(r => r.meta.includes('127.0.0.1') && /Viewed \d+ days ago/.test(r.meta)), 'review rows show domain and time since viewed', s.rows);
    const layout = await popup(LAYOUT);
    check(layout.h <= 600 && layout.w <= 800 && layout.scrollW <= layout.w, 'popup within browser limits (<=600px tall) with no horizontal overflow', layout);
    check(layout.reach.every(r => r.visible && r.named), 'every stale control is labelled and scrolls into view', layout.reach);
    check(layout.controls && layout.live === 'polite' && layout.statusRole === 'status' && layout.listScroll === 'auto', 'aria-controls targets, polite live regions and a scrollable list', layout);
    check(JSON.stringify(layout.order) === JSON.stringify(['stale-value', 'stale-unit', 'stale-auto', 'stale-review', 'stale-close']), 'tab order: duration, unit, automation, Review, Close', layout.order);
    record.layout = layout;
    await themed('expanded-review', 'Automation off, stale controls with review list',
      () => popup('document.getElementById("stale-review-list").scrollIntoView({block:"end"}); return true;'));
    await popup('window.scrollTo(0,0); document.getElementById("stale-review").focus(); return true;');
    await popup('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})); return true;');
    s = await state();
    check(s.listHidden && s.panel && s.focus === 'stale-review', 'Escape collapses the review list before the controls', s);
    preview = manual;
  });

  // ---- A8. Close N closes only the previewed tabs ---------------------------------
  await phase('A close previewed only', async () => {
    let s = await state();
    if (!s.panel) await expandStale();
    let outsider = 'late';
    if (name === 'chromium') {
      // Previews expire after two minutes on the extension clock, so the clock
      // first moves 'late' to 30 s short of the rule, a fresh preview is taken,
      // and only then does a 60 s step age 'late' past the rule.
      await b.setOffset(lastViewed.late + WEEK - 30e3 - Date.now());
      await api('await api.storage.session.set({"harness.tick": Math.random()}); return true;');
      preview = await expected('manual', b.nowB());
      await waitState(x => x.close === `Close ${tabs(preview.length)} now` && x.closeDisabled !== 'true', 'fresh preview after clock step', 12000);
      fixture('chromium clock moved so late is 30s short of 7 days', { preview });
    }
    s = await waitState(x => x.closeDisabled !== 'true', 'close enabled');
    const label = s.close;
    await popup(OBSERVE);
    await api('await api.storage.session.remove("harness.result"); return true;');
    // Make one tab eligible after the preview without any tab event.
    if (name === 'firefox') { lastViewed.late = b.nowB() - 8 * DAY; await b.setLastAccessed(urlOf('late'), lastViewed.late); }
    else { await b.setOffset(b.nowB() + 60e3 - Date.now()); }
    fixture('tab ages past the rule after the preview', { slug: outsider, browser: name });
    const clicked = await popup('const l=document.getElementById("stale-close").textContent; document.getElementById("stale-close").click(); return l;');
    check(clicked === label, 'clicked the preview shown before the fixture change', { label, clicked });
    await until(() => api('return (await api.storage.session.get("harness.result"))["harness.result"] ?? null;'), 'close result', 20000);
    const result = await api('return (await api.storage.session.get("harness.result"))["harness.result"];');
    record.manualClose = result;
    const open = await openUrls();
    check(result.closed === preview.length && !result.failed, 'real close removed exactly the previewed count', { result, preview });
    check(preview.every(slug => !open.includes(urlOf(slug))), 'every previewed tab is gone', preview);
    check(open.includes(urlOf(outsider)), 'a tab that became eligible after the preview stays open', outsider);
    check(['stale-pinned', 'origin', 'lonely'].every(slug => open.includes(urlOf(slug))), 'pinned, active and single-tab-window tabs survive manual close');
    if (audible) check(open.includes(urlOf('audio-stale')), 'audible tab survives manual close');
    check(new RegExp(`^Closed ${tabs(preview.length)} not viewed recently\\.`).test(result.message), 'result reports the actual count', result.message);
    if (result.notificationError) { console.log(`NOTICE notification rejected: ${result.notificationError}`); await popup('document.getElementById("status-close").click(); return true;').catch(() => {}); }
    await until(async () => !await isOpen(), 'menu closes after success', 8000).catch(async () => closePopup());
  });

  // ---- B. Enable, exact enabled caption, shared settings --------------------------
  await phase('B enable', async () => {
    const before = (await snapshot()).length;
    await b.open();
    await expandStale();
    let s = await waitState(x => x.autoDisabled !== 'true' && /If turned on/.test(x.autoDetail), 'enable allowed');
    await popup('document.getElementById("stale-auto").click(); return true;');
    await until(async () => (await local(['autoCloseStaleEnabled'])).autoCloseStaleEnabled === true, 'enabled saved');
    const stored = await local(['staleNextRunAt']);
    const a = await alarm();
    const nowB = b.nowB();
    check(a && a.scheduledTime === stored.staleNextRunAt && stored.staleNextRunAt === nextLocalHour(nowB), 'enabling plans one alarm at the next whole local hour', { alarm: a, stored, expected: nextLocalHour(nowB) });
    await sleep(2000);
    check((await snapshot()).length === before, 'enabling closes nothing immediately', { before });
    s = await waitState(x => x.auto === true && /Closing|No tabs/.test(x.autoDetail), 'enabled detail');
    {
      const at = stored.staleNextRunAt, t = b.nowB();
      const sched = await expected('auto', at), now = await expected('manual', t);
      const want = sched.length
        ? `Closing ${tabs(sched.length)} automatically at ${runTime(at, t)}.${sched.length > now.length ? ' Includes tabs that reach 7 days before then.' : ''}`
        : `No tabs would close automatically at ${runTime(at, t)}.`;
      check(s.autoDetail === want, 'enabled line: scheduled count, explained when above the manual count', { got: s.autoDetail, want, scheduled: sched, manual: now, count: s.count });
      record.enabledLine = { autoDetail: s.autoDetail, count: s.count };
    }
    await themed('enabled-expanded', 'Automation on, expanded controls: scheduled count vs Close now count');
    await popup('document.getElementById("btn-stale").click(); return true;');
    s = await waitState(x => !x.panel && x.title === ENABLED_TITLE && x.caption, 'enabled caption');
    const auto = await expected('auto', stored.staleNextRunAt);
    record.expectedB = auto;
    check(s.caption === caption(auto.length, stored.staleNextRunAt, b.nowB()), 'enabled caption: exact count and scheduled local time', { got: s.caption, want: caption(auto.length, stored.staleNextRunAt, b.nowB()), auto });
    check(!/7-day|due|Auto on|~/.test(s.caption), 'caption avoids substitute wording');
    await themed('enabled-count', 'Automation on, collapsed main menu with caption');
    await closePopup();
  });

  await phase('B shared settings', async () => {
    // The Settings page and the menu read and write one saved rule.
    const view = name === 'firefox' ? 'options' : null;
    const optionsEval = async body => {
      if (name === 'firefox') return api(`${body}`);
      return b.context.pages().find(p => p.url().startsWith(`${b.ext}/options.html`)).evaluate(`(async()=>{${body}})()`);
    };
    if (name === 'chromium') { const p = await b.context.newPage(); await p.goto(`${b.ext}/options.html`); await b.raiseMain(); }
    else {
      await api('setTimeout(() => location.reload(), 20); return true;');
      await sleep(1500);
      await until(async () => (await api('return document.readyState')) === 'complete', 'settings reloaded', 10000);
    }
    await sleep(1500);
    const read = 'const $=id=>document.getElementById(id); return { value:$("stale-value").value, unit:$("stale-unit").value, auto:$("stale-auto").checked, warning:$("stale-warning").textContent };';
    const settingsView = await until(async () => { const v = await optionsEval(read); return v.value === '7' && v.auto === true; }, 'settings shows saved rule', 10000).then(() => optionsEval(read));
    check(settingsView.value === '7' && settingsView.unit === 'days' && settingsView.auto === true && settingsView.warning === WARNING, 'Settings shows the menu-saved rule and the warning', { settingsView, view });
    await optionsEval('const v=document.getElementById("stale-value"); v.value="8"; v.dispatchEvent(new Event("input",{bubbles:true})); v.dispatchEvent(new Event("change",{bubbles:true})); return true;');
    await until(async () => (await local(['staleThresholdMs'])).staleThresholdMs === 8 * DAY, 'settings saved 8 days');
    await b.open();
    await expandStale();
    let s = await waitState(x => x.value === '8' && x.unit === 'days', 'menu shows 8 days');
    check(true, 'menu shows the Settings-saved 8 days');
    await popup('const v=document.getElementById("stale-value"); v.value="7"; v.dispatchEvent(new Event("input",{bubbles:true})); v.dispatchEvent(new Event("change",{bubbles:true})); return true;');
    await until(async () => (await local(['staleThresholdMs'])).staleThresholdMs === 7 * DAY, 'menu saved 7 days');
    check(true, 'menu saves 7 days back to the shared rule');
    s = await state();
    check(s.auto === true, 'threshold edits keep automation on', s.auto);
    await closePopup();
    if (name === 'chromium') await b.context.pages().find(p => p.url().startsWith(`${b.ext}/options.html`))?.close();
  });

  // ---- C1. An open menu re-checks the schedule -------------------------------------
  // Since 7b22590 a plan off the whole local hour counts as a clock or time-zone
  // change, and every status refresh from an open menu replaces it. So a test
  // plan ~20 s ahead cannot survive an open menu; that replacement is checked
  // here. Deferral at a real alarm while editing needs a real whole hour.
  const OBSERVE_ALARM = `if (!self.__harnessAlarms) { self.__harnessAlarms = [];
    api.alarms.onAlarm.addListener(a => self.__harnessAlarms.push({ name: a.name, scheduledTime: a.scheduledTime })); }
    self.__harnessAlarms.length = 0; return true;`;
  const observedAlarms = () => api('return self.__harnessAlarms ?? null;');
  await phase('C open menu replaces an off-hour plan', async () => {
    const before = await openUrls();
    await b.open();
    await expandStale();
    await waitState(x => x.panel, 'controls open');
    await api(OBSERVE_ALARM);
    const at = Date.now() + 20000;
    await api(`await api.storage.local.set({ staleNextRunAt: ${at} }); await api.alarms.create(${JSON.stringify(STALE_ALARM)}, { when: ${at} }); return true;`);
    fixture('off-hour plan ~20s ahead (controls open)', { at: new Date(at).toISOString() });
    await until(async () => { const a = await alarm(); return a && a.scheduledTime !== at; }, 'plan replaced', 15000);
    const replacedAt = Date.now();
    const stored = await local(['staleNextRunAt']);
    const a = await alarm();
    check(replacedAt < at && a.scheduledTime === stored.staleNextRunAt && stored.staleNextRunAt === nextLocalHour(b.nowB()),
      'open menu replaces an off-hour plan with the next whole local hour before it is due', { a, stored, msBeforeDue: at - replacedAt });
    await sleep(Math.max(0, at - Date.now()) + 4000);
    const seen = await observedAlarms();
    check(Array.isArray(seen) && seen.length === 0, 'the replaced off-hour alarm never fired', seen);
    const after = await openUrls();
    check(before.every(u => after.includes(u)), 'nothing closed while the controls were open', { before: before.length, after: after.length });
    const s = await waitState(x => x.caption && x.caption.endsWith(`at ${runTime(stored.staleNextRunAt, b.nowB())}.`), 'caption shows the whole-hour time', 12000);
    check(true, 'caption shows the replanned whole-hour time', s.caption);
    limit('deferral at a real alarm while editing', 'needs a real whole local hour with the controls open; the open menu replaces any earlier test plan (see above)');
    await closePopup();
    await until(async () => {
      const leases = await api('return (await api.storage.session.get("stale.lease.normal"))["stale.lease.normal"] ?? {};');
      const t = b.nowB();
      return Object.values(leases).every(l => !(l.exp > t));
    }, 'editor lease released or expired', 25000);
  });

  // ---- B5/B6. Disable survives a status failure; failures stay visible ------------
  await phase('B safe disable during status failure', async () => {
    await b.open();
    await expandStale();
    await popup(FAULT('getStaleState'));
    let s = await waitState(x => x.captionTone === 'error', 'status unavailable', 12000);
    check(s.title === ENABLED_TITLE && s.caption === 'Stale-tab status unavailable.' && /unavailable/.test(s.count), '[fault] failed status: enabled title kept, unavailable caption, no zero count', s);
    check(s.closeDisabled === 'true' && s.close === 'Close tabs now', '[fault] failed status disables Close', s);
    check(s.autoDisabled !== 'true' && s.auto === true, '[fault] automation can still be turned off', s);
    await themed('error', '[fault] stale status unavailable while automation is on');
    await popup('document.getElementById("stale-auto").click(); return true;');
    await until(async () => (await local(['autoCloseStaleEnabled'])).autoCloseStaleEnabled === false, 'disabled saved');
    await until(async () => !(await alarm()), 'alarm cleared');
    check(true, '[fault] disable saved and the alarm cleared despite the status failure');
    await until(async () => (await local(['staleNextRunAt'])).staleNextRunAt == null, 'recorded run cleared', 5000).catch(() => {});
    check((await local(['staleNextRunAt'])).staleNextRunAt == null && (await api('return (await api.alarms.getAll()).length;')) === 0,
      '[fault] disabled metadata: no recorded run and no alarm of any name');
    await closePopup();
  });

  await phase('B sticky close failure', async () => {
    await b.open();
    await expandStale();
    await waitState(x => x.closeDisabled !== 'true', 'close enabled');
    await popup('document.getElementById("stale-review").click(); return true;');
    await waitState(x => !x.listHidden, 'review open');
    const before = (await snapshot()).length;
    await popup(FAULT_COUNTED('closeStalePreview'));
    fixture('[fault] closeStalePreview transport rejects; popup commands counted', { observer: 'window.__harnessSent in the popup' });
    await popup('document.getElementById("stale-close").click(); return true;');
    await waitState(x => x.status.tone === 'error', 'close failure shown');
    const sticky = await popup(STICKY);
    record.sticky = sticky;
    check(sticky.inView && sticky.labelHit && sticky.position === 'sticky' && /Could not close stale tabs/.test(sticky.text), '[fault] close failure label stays visible in the clipped popup', sticky);
    if (!sticky.overflow) limit('sticky status under overflow', 'expanded content fit inside the popup, so clipping was not exercised');
    check((await snapshot()).length === before, '[fault] failed close removes nothing');
    const footer = await popup(FOOTER);
    record.closeFailureFooter = footer;
    check(footer.h <= 600 && footer.review === 'Review remaining tabs' && footer.detail === 'The close result could not be confirmed. Review the remaining tabs before closing again.',
      '[fault] close failure offers Review remaining tabs with the unconfirmed-result explanation', footer);
    check(footer.parts.length === 5 && footer.parts.every(p => p.ok) && footer.reviewHit && footer.closeHit, '[fault] error footer, both buttons and copy are unclipped and hittable at <=600px', footer);
    await themed('close-failure', '[fault] close failure with expanded review');
    // Recovery: the real #status-review button fetches a fresh read-only preview and focuses it.
    const sentBefore = await popup('return { ...window.__harnessSent };');
    check(sentBefore.closeStalePreview === 1, '[fault] exactly one close message sent before recovery', sentBefore);
    await popup('document.getElementById("status-review").click(); return true;');
    let s = await waitState(x => x.panel && !x.listHidden && x.focus === 'stale-review-list' && x.closeDisabled !== 'true', 'review reopened with a fresh preview', 12000);
    let sent = await popup('return { ...window.__harnessSent };');
    const remaining = (await expected('manual', b.nowB())).map(titleOf);
    check(sent.closeStalePreview === 1 && (sent.getStaleState ?? 0) > (sentBefore.getStaleState ?? 0), 'Review remaining tabs refreshes the preview and sends no second close', { sentBefore, sent });
    check(s.rows.length === remaining.length && s.rows.every(r => remaining.includes(r.title)) && s.close === `Close ${tabs(remaining.length)} now`,
      'recovered review lists the remaining candidates and Close names their count', { rows: s.rows, remaining, close: s.close });
    check((await snapshot()).length === before, 'recovery closes nothing');
    record.recovery = { sentBefore, sent, focus: s.focus, close: s.close };
    // The focused list must not sit entirely behind the sticky status footer.
    const seen = await popup(`const l = document.getElementById('stale-review-list').getBoundingClientRect(), f = document.getElementById('status').getBoundingClientRect();
      return { listTop: Math.round(l.top), listBottom: Math.round(l.bottom), footerTop: Math.round(f.top), h: innerHeight, scrollY: Math.round(scrollY),
        visiblePx: Math.round(Math.max(0, Math.min(l.bottom, f.top) - Math.max(l.top, 0))) };`);
    record.recovery.focusGeometry = seen;
    check(seen.visiblePx >= 24, 'focused review list is visible above the error footer, not obscured', seen);
    await themed('close-recovery', '[fault] after Review remaining tabs: fresh review list focused');
    // From collapsed controls the same button opens both the controls and the list.
    await popup('document.getElementById("btn-stale").click(); return true;');
    await waitState(x => !x.panel, 'controls collapsed');
    const hiddenReview = await popup('return document.getElementById("status-review").hidden;');
    if (!hiddenReview) {
      await popup('document.getElementById("status-review").click(); return true;');
      s = await waitState(x => x.panel && !x.listHidden && x.focus === 'stale-review-list', 'controls and review reopened', 12000);
      sent = await popup('return { ...window.__harnessSent };');
      check(s.expanded === 'true' && sent.closeStalePreview === 1, 'from collapsed controls, Review remaining tabs opens controls and list with no close', { expanded: s.expanded, sent });
    } else check(false, 'Review remaining tabs stays offered after collapsing the controls', { hiddenReview });
    check((await snapshot()).length === before, 'second recovery closes nothing');
    await popup('document.getElementById("status-close").click(); return true;');
    await until(async () => !await isOpen(), 'failure dismissed');
  });

  // ---- C2. Real alarm sweep, recorded: enable -> sweep -> result -------------------
  await phase('C sweep', async () => {
    await b.open();
    video = recorder(path.join(directory, 'enable-sweep-result.mp4'));
    record.video = video.file;
    await sleep(800);
    await expandStale();
    await waitState(x => x.autoDisabled !== 'true' && x.auto === false && /If turned on/.test(x.autoDetail), 'enable allowed');
    await sleep(800);
    await popup('document.getElementById("stale-auto").click(); return true;');
    await until(async () => (await local(['autoCloseStaleEnabled'])).autoCloseStaleEnabled === true, 'enabled saved');
    await sleep(1200);
    await popup('document.getElementById("btn-stale").click(); return true;');
    const nowB = b.nowB();
    const due = await expected('auto', nowB);
    const keep = ['stale-pinned', 'origin', 'lonely', ...(audible ? ['audio-stale'] : [])];
    await sleep(500);
    await until(async () => { const l = await api('return (await api.storage.session.get("stale.lease.normal"))["stale.lease.normal"] ?? {};'); const t = b.nowB(); return Object.values(l).every(x => !(x.exp > t)); }, 'lease released', 25000);
    // The menu is dismissed and no extension view stays open, as when a user
    // enables cleanup and walks away; an open view would replace the off-hour plan.
    await closePopup();
    await b.noViews();
    await api(OBSERVE_ALARM);
    const at = Date.now() + 15000;
    await api(`await api.storage.local.set({ staleNextRunAt: ${at} }); await api.alarms.create(${JSON.stringify(STALE_ALARM)}, { when: ${at} }); return true;`);
    fixture('schedule moved ~15s ahead (no extension view open)', { at: new Date(at).toISOString(), due, evaluator: name === 'firefox' ? 'background page' : 'service worker' });
    await until(async () => (await observedAlarms())?.length > 0, 'alarm event', 60000);
    const seen = await observedAlarms();
    check(seen.length === 1 && seen[0].name === STALE_ALARM && seen[0].scheduledTime === at, 'the browser fired the planned alarm itself (not replaced)', seen);
    await until(async () => { const open = await openUrls(); return due.every(slug => !open.includes(urlOf(slug))); }, 'sweep removed due tabs', 15000).catch(() => {});
    await sleep(2500);
    const open = await openUrls();
    check(due.length > 0 && due.every(slug => !open.includes(urlOf(slug))), 'real alarm sweep closed every due tab', { due, open });
    check(keep.every(slug => open.includes(urlOf(slug))), 'sweep kept pinned, active, single-tab-window' + (audible ? ' and audible' : '') + ' tabs', keep);
    const stored = await local(['staleNextRunAt']);
    const a = await alarm();
    check(a && a.scheduledTime === stored.staleNextRunAt && stored.staleNextRunAt === nextLocalHour(b.nowB()), 'after the sweep, one alarm at the next whole local hour', { a, stored });
    await b.restoreViews();
    await b.open();
    // Tabs still projected for the next run (e.g. the crossing tab) keep a
    // caption, correctly. Closing them by hand leaves an enabled-zero state.
    const projected = await expected('auto', stored.staleNextRunAt);
    let s = await state();
    if (projected.length) {
      check(s.caption === caption(projected.length, stored.staleNextRunAt, b.nowB()), 'after the sweep, the caption still counts tabs projected for the next run', { got: s.caption, projected });
      await api(`for (const t of await api.tabs.query({})) if (${JSON.stringify(projected.map(urlOf))}.includes(t.url)) await api.tabs.remove(t.id); return true;`);
    }
    s = await waitState(x => x.title === ENABLED_TITLE && x.caption === null, 'enabled zero', 12000).catch(() => state());
    check(s.title === ENABLED_TITLE && s.caption === null, 'enabled with zero projected closures: title kept, caption hidden', s);
    await sleep(1500);
    await video.stop();
    await themed('enabled-zero', 'Automation on, nothing projected: caption hidden');
    await closePopup();
  });

  // ---- D. Keyboard and context-menu entry points ----------------------------------
  await phase('D entry points', async () => {
    await b.setShortcut();
    const shortcut = await api('return (await api.commands.getAll()).find(c => c.name === "close-stale")?.shortcut ?? "";');
    check(/Alt\+Shift\+Y/i.test(shortcut), 'close-stale bound in the throwaway profile', shortcut);
    const before = (await snapshot()).length;
    await b.raiseMain();
    nativeKeys(env, SHORTCUT.keys, titleOf('origin'));
    await b.attachOpen();
    let s = await waitState(x => x.expanded === 'true' && x.panel, 'shortcut opens stale controls', 8000);
    check(s.expanded === 'true' && s.panel && (await snapshot()).length === before, 'native shortcut opens the menu with Stale Tabs expanded and closes nothing', s);
    await closePopup();
    await b.open();
    s = await state();
    await sleep(800);
    s = await state();
    check(s.expanded === 'false' && !s.panel, 'next toolbar open does not inherit the consumed intent', s);
    await closePopup();
    if (b.contextMenu) {
      const beforeMenu = await openUrls();
      await b.raiseMain();
      await b.contextMenu();
      await b.attachOpen();
      s = await waitState(x => x.expanded === 'true' && x.panel, 'context menu opens stale controls', 8000);
      check(JSON.stringify((await openUrls()).sort()) === JSON.stringify(beforeMenu.sort()), 'context-menu entry closes and moves nothing');
      check(s.expanded === 'true' && s.panel, `native ${name === 'firefox' ? 'tab' : 'toolbar-button'} context-menu item opens the menu with Stale Tabs expanded`, s);
      await closePopup();
    } else {
      limit('context-menu entry', 'Chromium registers the item on the toolbar action context menu; no stable native pixel target for the browser-UI action icon in this harness');
    }
  });

  // ---- F. Opt-in survives extension and browser restarts ----------------------------
  await phase('F reload preservation', async () => {
    await b.open();
    await expandStale();
    const s0 = await waitState(x => x.autoDisabled !== 'true', 'toggle ready');
    if (!s0.auto) {
      await popup('document.getElementById("stale-auto").click(); return true;');
      await until(async () => (await local(['autoCloseStaleEnabled'])).autoCloseStaleEnabled === true, 'enabled');
    }
    await closePopup();
    // A fresh stale candidate (Firefox) checks that a restart does not bulk-close.
    if (name === 'firefox') {
      await create('after-reload');
      await loaded(['after-reload']);
      await b.setLastAccessed(urlOf('after-reload'), Date.now() - 8 * DAY);
      fixture('firefox native lastAccessed (restart candidate)', { slug: 'after-reload' });
    }
    const before = await openUrls();
    await b.reloadExtension();
    await sleep(3000);
    const stored = await local(['autoCloseStaleEnabled', 'staleNextRunAt', 'staleThresholdMs']);
    const a = await alarm();
    check(stored.autoCloseStaleEnabled === true && stored.staleThresholdMs === 7 * DAY, 'extension restart keeps the opt-in and threshold', stored);
    check(a && a.scheduledTime === stored.staleNextRunAt && a.scheduledTime > Date.now() && a.scheduledTime <= nextLocalHour(Date.now()), 'extension restart restores one future alarm', { a, stored });
    const after = await openUrls();
    check(before.filter(u => u.startsWith(base)).every(u => after.includes(u)), 'extension restart does not bulk-close', { before: before.length, after: after.length });
    if (b.restart) {
      await b.restart();
      await sleep(3000);
      const s = await local(['autoCloseStaleEnabled', 'staleNextRunAt']);
      const a2 = await alarm();
      check(s.autoCloseStaleEnabled === true && a2 && a2.scheduledTime === s.staleNextRunAt && a2.scheduledTime > Date.now(), 'full browser restart keeps the opt-in and one future alarm', { s, a2 });
    } else {
      limit('full browser restart', 'temporary Firefox add-ons do not survive a restart; covered by the extension restart above');
    }
  });

  // ---- E. Private window --------------------------------------------------------------
  await phase('E private window', async () => {
    const win = await b.openPrivate(urlOf('private-only'));
    await sleep(1000);
    await b.open({ private: true });
    await expandStale();
    const s = await waitState(x => /normal windows only/.test(x.autoDetail) && x.count !== 'Checking…' && x.count !== 'Updating count…', 'private state', 12000);
    check(s.autoDetail === 'Automatic cleanup runs in normal windows only. Private windows are not included.', 'private menu: automatic count unavailable', s.autoDetail);
    check(s.caption === null || !/Closing \d/.test(s.caption), 'private menu shows no normal-window projection', s.caption);
    check(/^Close now: no tabs have gone unviewed/.test(s.count), 'private manual preview is scoped to private tabs', s.count);
    await shot('private-window', 'Private window: automation count unavailable');
    // Nothing from normal windows may appear in private-scope state.
    const normalTabs = (await snapshot()).filter(t => !t.incognito && t.url.startsWith(base));
    const leaks = text => normalTabs.filter(t => text.includes(t.url) || text.includes(t.title)).map(t => t.title);
    const privateReply = await popup('const w = await browser.windows.getCurrent(); return await browser.runtime.sendMessage({ command: "getStaleState", windowId: w.id });');
    check(privateReply?.preview && leaks(JSON.stringify(privateReply)).length === 0, 'private status reply names no normal-window tab', { leaks: leaks(JSON.stringify(privateReply ?? {})), count: privateReply?.preview?.count });
    const sessionAll = await api('return await api.storage.session.get(null);');
    const privateKeys = Object.fromEntries(Object.entries(sessionAll).filter(([k]) => k.endsWith('.private')));
    check(leaks(JSON.stringify(privateKeys)).length === 0, 'private session records hold no normal-window URL or title', { keys: Object.keys(privateKeys) });
    if (name === 'chromium') {
      const contexts = { normal: await api('return api.extension.inIncognitoContext;'), private: await b.privateApi('return api.extension.inIncognitoContext;') };
      check(contexts.normal === false && contexts.private === true, 'split mode: separate normal and incognito workers', contexts);
      const normalWindow = await api('return (await api.windows.getAll()).find(w => !w.incognito)?.id ?? null;');
      const privateWindow = await b.privateApi('return (await api.windows.getAll()).find(w => w.incognito)?.id ?? null;');
      // Wrong context: the private menu asks about a normal window.
      const wrong = await popup(`return await browser.runtime.sendMessage({ command: "getStaleState", windowId: ${normalWindow} });`);
      check(typeof wrong?.error === 'string' && !wrong.preview && !wrong.settings && leaks(JSON.stringify(wrong)).length === 0,
        'private worker refuses a normal window id with a plain error and no data', wrong);
      // Wrong context the other way: a normal extension page asks about the private window.
      const page = await b.context.newPage();
      await page.goto(`${b.ext}/options.html`);
      const reverse = await page.evaluate(id => chrome.runtime.sendMessage({ command: 'getStaleState', windowId: id }), privateWindow);
      await page.close();
      check(typeof reverse?.error === 'string' && !reverse.preview && !reverse.settings && !JSON.stringify(reverse).includes('private-only'),
        'normal worker refuses the private window id with a plain error and no data', reverse);
      // Each worker writes only its own age records.
      const ages = async () => { const all = await api('return await api.storage.session.get(["stale.age.normal","stale.age.private"]);');
        return { normal: Object.keys(all['stale.age.normal']?.tabs ?? {}).sort(), private: all['stale.age.private']?.tabs ?? {} }; };
      const before = await ages();
      check(Object.keys(before.private).length > 0, 'incognito worker recorded private tab ages', before);
      const normals = await snapshot();
      const other = normals.find(t => !t.incognito && !t.active && t.windowId === normalWindow);
      const activeTab = normals.find(t => !t.incognito && t.active && t.windowId === normalWindow);
      if (other && activeTab) {
        await api(`await api.tabs.update(${other.id}, { active: true }); await new Promise(r => setTimeout(r, 400)); await api.tabs.update(${activeTab.id}, { active: true }); return true;`);
      }
      await api(`await api.tabs.create({ url: ${JSON.stringify(urlOf('normal-after-private'))}, active: false, windowId: ${normalWindow} }); return true;`);
      await sleep(1500);
      const mid = await ages();
      // "Untouched" means no record dropped or re-baselined; the incognito worker
      // itself may still mark its own active tab viewed when focus moves.
      const kept = (a, z) => Object.keys(a).every(id => z[id] && z[id].s === a[id].s && z[id].v >= a[id].v);
      check(kept(before.private, mid.private) && Object.keys(mid.private).length === Object.keys(before.private).length,
        'normal-worker activity leaves private age records in place (no record dropped or re-baselined)', { before: before.private, after: mid.private });
      await b.privateApi(`await api.tabs.create({ url: ${JSON.stringify(urlOf('private-second'))}, active: true, windowId: ${privateWindow} }); return true;`);
      await sleep(1500);
      const end = await ages();
      check(mid.normal.every(id => end.normal.includes(id)) && Object.keys(end.private).length > Object.keys(mid.private).length,
        'incognito-worker activity adds private ages and leaves normal ages untouched', { mid, end });
    }
    await closePopup();
    const keys = Object.keys(await api('return await api.storage.local.get(null);'));
    check(!keys.some(k => /private|age|preview|lease|intent/i.test(k)), 'no private or per-tab metadata in persistent storage', keys);
    await win.close();
    // The browser may have restarted (phase F), so look the normal window up again.
    await api('const w = (await api.windows.getAll()).find(x => !x.incognito); if (w) await api.windows.update(w.id, { focused: true }); return true;');
    await b.raiseMain().catch(() => {});
  });

  record.passed = results.passed;
  record.failed = results.failed;
} catch (error) {
  results.failed.push(`harness: ${String(error?.stack || error)}`);
  console.log(`FAIL harness -- ${error?.stack || error}`);
} finally {
  await video.stop().catch(() => {});
  await b?.shutdown().catch(error => console.log(`WARN shutdown: ${error}`));
  await new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  display.stop();
  Object.assign(record, { passed: results.passed, failed: results.failed, fixtures, limitations, shots });
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ browser: name, passed: results.passed.length, failed: results.failed, limitations, directory }, null, 2));
  process.exitCode = results.failed.length ? 1 : 0;
}
