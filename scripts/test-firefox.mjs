// Real Firefox + the built extension in a throwaway profile on an isolated X
// display. The search shortcut is a native X key. Page content cannot reach the
// closed-shadow dialog, so the harness addresses the extension iframe from the
// privileged side: its BrowsingContext under the tab, through Marionette's own
// per-frame actor, the same way it reaches toolbar popups.
import { execFileSync } from 'node:child_process';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDisplay } from './test-display.mjs';
import { inspectPopup, SEARCH_KEYS } from './test-popup-fixture.mjs';
import { TITLES, startSite, outputDir, checker, until, sleep, nativeKeys as sendKeys, nativeHold, nativeSequence, captureDisplay, recorder, paletteContrast } from './test-browser-fixtures.mjs';
import { runTabCycle, runSearchClosing } from './test-search-closing.mjs';

// X window titles can show a fallback URL, launch token included, when its page
// fails to load. Never let such a title reach the log through a key-send error.
const redact = text => String(text).replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>');
function nativeKeys(...args) {
  try { return sendKeys(...args); } catch (error) { throw new Error(redact(error.stderr?.toString() || error.message)); }
}

const UUID = 'a3906219-0180-4fa2-a2d8-a90270e6e501';
const EXT = `moz-extension://${UUID}`;
const SEARCH = `${EXT}/search.html`;
// --acceptance-only runs setup plus the privacy/lifecycle checks, skipping the main flow.
// --closing-only runs setup plus the selection/closing flows (scripts/test-search-closing.mjs).
const ACCEPTANCE_ONLY = process.argv.includes('--acceptance-only');
const EXPANDED_ONLY = process.argv.includes('--expanded-only');
// --expanded-only runs setup plus the History/Contents flows (scripts/test-expanded-search.mjs).
const CLOSING_ONLY = EXPANDED_ONLY || process.argv.includes('--closing-only');
import { runExpandedSearch } from './test-expanded-search.mjs';
import { nativeClick } from './test-browser-fixtures.mjs';
const { scratch, directory } = await outputDir('tabvacuum-firefox');
// geckodriver creates its throwaway profile under TMPDIR; keep it in scratch.
process.env.TMPDIR = directory;
const site = await startSite();
const { base } = site;
const display = await startDisplay(scratch);
const env = display.env;
process.env.DISPLAY = env.DISPLAY;
const { check, finish } = checker();
const shots = [];
const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
const driverService = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
const options = new firefox.Options()
  .setBinary(process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox'))
  .setPreference('browser.startup.homepage_override.mstone', 'ignore')
  .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'tabvacuum@adlio': UUID }));
// Privileged inspection is limited to this throwaway browser; newer drivers own
// the opt-in rather than accepting it as a Firefox capability.
if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) driverService.addArguments('--allow-system-access');
else options.addArguments('-remote-allow-system-access');
let driver;
let video = { stop: async () => {} };

// Chrome-context helpers. `kind` is 'overlay' (unnamed extension iframe inside
// any tab; page-made test frames are named) or 'window' (the separate search
// window's top document).
const LOCATE = `function locate(kind, url) {
  const found = [];
  for (const win of Services.wm.getEnumerator('navigator:browser')) {
    for (const b of win.gBrowser.browsers) {
      const top = b.browsingContext;
      if (!top) continue;
      if (kind === 'window') { if (top.currentURI?.spec.startsWith(url + '?')) found.push(top); continue; }
      for (const c of top.getAllBrowsingContextsInSubtree()) if (c !== top && c.currentURI?.spec === url && !c.name) found.push(c);
    }
  }
  return found;
}
function originWindow(url) {
  for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.gBrowser.tabs.some(t => t.linkedBrowser.currentURI.spec === url)) return w;
}
function actor(bc) { return bc.currentWindowGlobal.getActor('MarionetteCommands'); }`;

try {
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
    .setFirefoxService(driverService).build();
  await driver.manage().window().setRect({ x: 0, y: 0, width: 1280, height: 900 });
  await driver.installAddon(path.resolve('dist/firefox'), true);
  const version = (await driver.getCapabilities()).get('browserVersion');

  // Real tabs in two windows. The remote window is opened first and left behind.
  const originHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow('window');
  await driver.get(`${base}/remote`);
  await driver.switchTo().window(originHandle);
  for (const url of ['/previous', '/fuzzy']) {
    await driver.switchTo().newWindow('tab');
    await driver.get(`${base}${url}`);
  }
  await driver.switchTo().window(originHandle);
  await driver.get(`${base}/current`);
  await driver.setContext('chrome');
  await driver.executeScript('window.focus(); gBrowser.selectedBrowser.focus();');

  const chrome = (script, ...args) => driver.executeScript(script, ...args);
  const chromeAsync = (body, ...args) => driver.executeAsyncScript(`${LOCATE}
    const done = arguments[arguments.length - 1];
    (async () => { ${body} })().then(done, e => done({ error: String(e) }));`, ...args);
  // Script inside the extension frame / window, with the extension's principal.
  const inSearch = (kind, script, args = []) => chromeAsync(`
    const [kind, url, script, args] = arguments;
    const [bc] = locate(kind, url);
    if (!bc) return { error: 'no ' + kind };
    return actor(bc).sendQuery('MarionetteCommandsParent:executeScript', { script, args, opts: {} });`, kind, SEARCH, script, args);
  const count = kind => chromeAsync('return locate(arguments[0], arguments[1]).length;', kind, SEARCH);
  // Marionette's in-frame key synthesis: trusted events in the focused frame.
  async function key(kind, name, printable = false) {
    const code = printable ? (/[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : name === '-' ? 'Minus' : name) : name;
    const result = await chromeAsync(`
      const [kind, url, eventData] = arguments;
      const [bc] = locate(kind, url);
      if (!bc) return 'no ' + kind;
      await actor(bc).sendQuery('MarionetteCommandsParent:_dispatchEvent', { eventName: 'synthesizeKeyDown', details: { eventData } });
      await actor(bc).sendQuery('MarionetteCommandsParent:_dispatchEvent', { eventName: 'synthesizeKeyUp', details: { eventData } }).catch(() => {});
      return null;`, kind, SEARCH, { key: name, code, location: 0, printable });
    await sleep(printable ? 20 : 120);
    return result;
  }
  async function type(kind, text) {
    await inSearch(kind, 'const q=document.getElementById("query"); q.value=""; q.dispatchEvent(new Event("input",{bubbles:true})); q.focus();');
    for (const character of text) await key(kind, character, true);
    await sleep(100);
  }
  const ready = kind => until(async () => (await inSearch(kind, 'return document.getElementById("results")?.getAttribute("aria-busy")')) === 'false', `${kind} ready`);
  const rows = (kind = 'overlay') => inSearch(kind, 'return [...document.querySelectorAll(".result .title")].map(t => t.textContent)');
  const selected = (kind = 'overlay') => inSearch(kind, 'return document.querySelector(".result[data-active=\\"true\\"] .title")?.textContent');
  const activeUrl = () => chrome('return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec');
  const activeTitle = () => chrome('return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.contentTitle || ""');
  async function content(script, ...args) {
    await driver.setContext('content');
    try { return await driver.executeScript(script, ...args); } finally { await driver.setContext('chrome'); }
  }
  const hosts = () => content('return document.querySelectorAll("tabvacuum-search").length');
  async function shortcut() {
    await chrome('const w=Services.wm.getMostRecentWindow("navigator:browser"); w.focus(); w.gBrowser.selectedBrowser.focus();');
    const title = (await activeTitle()) || 'Mozilla Firefox';
    for (let attempt = 0; ; attempt++) {
      try { nativeKeys(env, SEARCH_KEYS, title); return; } catch (error) { if (attempt > 10) throw error; await sleep(200); }
    }
  }
  async function openOverlay() {
    await shortcut();
    await until(async () => (await count('overlay')) > 0, 'overlay frame');
    await ready('overlay');
  }
  const closed = () => until(async () => (await count('overlay')) === 0 && (await hosts()) === 0, 'overlay removed');
  // Frame viewport vs page viewport, both in screen pixels.
  async function geometry() {
    const frame = await inSearch('overlay', 'return { x: mozInnerScreenX, y: mozInnerScreenY, w: innerWidth, h: innerHeight }');
    const page = await content('return { x: mozInnerScreenX, y: mozInnerScreenY, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, dpr: devicePixelRatio }');
    // mozInnerScreen* are CSS px of the screen, so both sides share units.
    const dx = Math.abs(frame.x + frame.w / 2 - (page.x + page.w / 2));
    const dy = Math.abs(frame.y + frame.h / 2 - (page.y + page.h / 2));
    return { frame, page, dx, dy };
  }
  async function shot(name, what) {
    if (name === 'light-two-results' || name === 'dark-two-results') {
      // Buttons transition their background (0.15 s) after a theme switch.
      await until(() => inSearch('overlay', `const body = getComputedStyle(document.body).backgroundColor;
        return [...document.querySelectorAll('.action')].every(b => getComputedStyle(b).backgroundColor === body);`), 'action backgrounds settled', 3000).catch(() => {});
      const contrast = await inSearch('overlay', `return (${paletteContrast.toString()})()`);
      check(contrast.passes, `${name}: text contrast meets 4.5:1`, contrast);
    }
    const file = path.join(directory, `${name}.png`);
    await sleep(400);
    captureDisplay(env, file);
    shots.push({ file, what });
  }
  // Private windows. Permission is granted only in this throwaway profile,
  // through the same extension permission store about:addons' "Run in Private
  // Windows" toggle writes, followed by the add-on reload that toggle performs.
  const ADDON = 'tabvacuum@adlio';
  const privateAllowed = () => chrome('return WebExtensionPolicy.getByID(arguments[0])?.privateBrowsingAllowed === true', ADDON);
  async function allowPrivate() {
    const allowed = await privateAllowed();
    console.log(`INFO add-on allowed in private windows before this step: ${allowed}`);
    if (allowed) return;
    await chromeAsync(`const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await ExtensionPermissions.add(arguments[0], { permissions: ['internal:privateBrowsingAllowed'], origins: [] });
      await (await AddonManager.getAddonByID(arguments[0])).reload();
      return true;`, ADDON);
    await until(privateAllowed, 'private allowed after reload', 10000).catch(() => {});
    await sleep(1000);
  }
  const setScheme = value => chrome('Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", arguments[0]);', value);

  // Adapter for the shared selection/closing flows. Disposable tabs and windows
  // are made with gBrowser/OpenBrowserWindow in this throwaway profile only; the
  // removal log is the browser's own TabClose events, in order.
  const ORIGIN = `${base}/current`;
  const FIXTURE = `${LOCATE}
    function findTab(url) {
      for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.currentURI.spec === url) return { w, t };
    }
    function keyedWindow(key, origin) {
      if (key === 'origin') return originWindow(origin);
      for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.__tvKey === key && !w.closed) return w;
    }
    function removalLog(origin) {
      const log = (originWindow(origin).__tvRemoved ??= []);
      for (const w of Services.wm.getEnumerator('navigator:browser')) {
        if (w.__tvTracked) continue;
        w.__tvTracked = true;
        w.gBrowser.tabContainer.addEventListener('TabClose', e => log.push(e.target.linkedBrowser.currentURI.spec));
      }
      return log;
    }
    const sp = Services.scriptSecurityManager.getSystemPrincipal();`;
  const ui = { kind: 'overlay', title: TITLES['/current'] };
  async function retryNative(send) {
    for (let attempt = 0; ; attempt++) {
      try { return send(); } catch (error) {
        if (attempt > 10) throw new Error(redact(error.stderr?.toString() || error.message));
        await sleep(200);
      }
    }
  }
  const loaded = urls => until(() => chrome(`${FIXTURE} return arguments[0].every(url => {
    const f = findTab(url); return Boolean(f && !f.t.hasAttribute('busy') && f.t.linkedBrowser.contentTitle); });`, urls), 'fixture tabs loaded', 15000);
  const closing = {
    check, base, originUrl: ORIGIN,
    ui: (body, arg) => inSearch(ui.kind, `const arg = arguments[0]; ${body}`, [arg ?? null]),
    keys: keys => retryNative(() => nativeKeys(env, keys, ui.title)),
    burst: keys => nativeSequence(env, keys, ui.title),
    hold: (keysym, ms) => retryNative(() => nativeHold(env, keysym, ms, ui.title)),
    async type(text) {
      const focus = await inSearch(ui.kind, 'return document.activeElement?.id');
      if (focus !== 'query') throw new Error(`type() needs the query focused, not ${focus}`);
      await type(ui.kind, text);
    },
    // A synthesized native-widget click at the element's centre, scrolled into view first as Playwright does.
    async click(selector) {
      const point = await inSearch(ui.kind, 'const el = document.querySelector(arguments[0]); el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };', [selector]);
      const failed = await chromeAsync(`const [kind, url, x, y] = arguments; const [bc] = locate(kind, url);
        if (!bc) return 'no ' + kind;
        await actor(bc).sendQuery('MarionetteCommandsParent:_dispatchEvent', { eventName: 'synthesizeMouseAtPoint', details: { x, y, eventData: {} } });
        return null;`, ui.kind, SEARCH, point.x, point.y);
      if (failed) throw new Error(failed);
      await sleep(250);
    },
    async open() {
      ui.title = (await activeTitle()) || 'Mozilla Firefox';
      await shortcut();
      let kind;
      await until(async () => {
        if ((await count('overlay')) > 0) return (kind = 'overlay');
        if ((await count('window')) > 0) return (kind = 'window');
      }, 'search UI', 9000).catch(() => {});
      if (kind) {
        ui.kind = kind;
        if (kind === 'window') ui.title = 'Search tabs';
        await ready(kind);
      }
      return kind;
    },
    uiCount: async () => ({ overlays: await count('overlay'), windows: await count('window') }),
    // Each search UI with its host tab: the overlay frame's top-level tab, or the window itself.
    searchUIs: () => chrome(`${FIXTURE} const [url, origin] = arguments; const out = [];
      for (const kind of ['overlay', 'window']) for (const bc of locate(kind, url)) {
        const browser = bc.top.embedderElement, w = browser?.ownerGlobal;
        out.push({ kind, url: kind === 'overlay' ? bc.top.currentURI.spec : null,
          window: kind === 'window' ? null : w === originWindow(origin) ? 'origin' : w?.__tvKey ?? null,
          title: kind === 'window' ? 'Search tabs' : browser?.contentTitle || '' });
      }
      return out;`, SEARCH, ORIGIN),
    retarget(target) { ui.kind = target.kind; ui.title = target.title; },
    // Read from a background extension tab in the origin window; its own TabClose is filtered out.
    sessions: () => chromeAsync(`${LOCATE} const [url, origin] = arguments;
      const w = originWindow(origin);
      const tab = w.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      try {
        for (let i = 0; i < 100 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 300));
        return await actor(tab.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { args: [], opts: {}, script:
          "return browser.storage.session.get('search.sessions').then(s => Object.keys(s['search.sessions'] || {}).length)" });
      } finally { w.gBrowser.removeTab(tab); }`, `${EXT}/options.html`, ORIGIN),
    async createWindow(key, urls) {
      await chromeAsync(`${FIXTURE} const [key, urls, origin] = arguments;
        const w = OpenBrowserWindow();
        await new Promise(r => w.addEventListener('load', r, { once: true }));
        await new Promise(r => setTimeout(r, 500));
        w.moveTo(0, 0); w.resizeTo(1280, 900); w.__tvKey = key;
        removalLog(origin);
        w.gBrowser.loadURI(Services.io.newURI(urls[0]), { triggeringPrincipal: sp });
        for (const url of urls.slice(1)) w.gBrowser.addTab(url, { triggeringPrincipal: sp, inBackground: true });
        return true;`, key, urls, ORIGIN);
      await loaded(urls);
    },
    async addTab(key, url, { pinned = false } = {}) {
      await chrome(`${FIXTURE} const [key, url, pinned, origin] = arguments;
        const w = keyedWindow(key, origin);
        removalLog(origin);
        const t = w.gBrowser.addTab(url, { triggeringPrincipal: sp, inBackground: true });
        if (pinned) w.gBrowser.pinTab(t);`, key, url, pinned, ORIGIN);
      await loaded([url]);
    },
    exists: url => chrome(`${FIXTURE} return Boolean(findTab(arguments[0]));`, url),
    windowAlive: key => chrome(`${FIXTURE} return Boolean(keyedWindow(arguments[0], arguments[1]));`, key, ORIGIN),
    async focus(url) {
      await chrome(`${FIXTURE} const f = findTab(arguments[0]); f.w.gBrowser.selectedTab = f.t; f.w.focus(); f.w.gBrowser.selectedBrowser.focus();`, url);
      await until(async () => (await activeUrl()) === url, `focus ${url.slice(0, 40)}`, 5000);
      await sleep(300);
    },
    activeUrl,
    startRemovals: () => chrome(`${FIXTURE} removalLog(arguments[0]).length = 0;`, ORIGIN),
    removed: () => chrome(`${FIXTURE} return removalLog(arguments[0]).filter(u => !u.startsWith('moz-extension:'));`, ORIGIN),
    multiSelected: () => chrome(`let n = 0; for (const w of Services.wm.getEnumerator('navigator:browser')) n += w.gBrowser.multiSelectedTabsCount; return n;`),
    tabCount: () => chrome(`let n = 0; for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.toolbar.visible) n += w.gBrowser.tabs.length; return n;`),
    scheme: value => setScheme(value === 'light' ? 1 : value === 'dark' ? 0 : 2),
    async shot(name, what) {
      const file = path.join(directory, `${name}.png`);
      await sleep(400);
      captureDisplay(env, file);
      shots.push({ file, what: `Firefox ${version}: ${what}` });
    },
    modalFocus: async () => (await inSearch('overlay', 'return document.hasFocus()')) === true &&
      (await content('return document.activeElement && document.activeElement.localName')) === 'tabvacuum-search',
    // Firefox keeps a ~500 CSS px minimum window width, so 320 px narrow is Chromium-only;
    // a 2.5x device scale gives a real ~512x290 CSS px low-height viewport.
    layouts: [{
      name: 'Firefox low height (2.5x device scale)', shot: 'selection-low',
      async enter() {
        await chrome('Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2.5");');
        await sleep(800);
        await closing.focus(ORIGIN);
      },
      async exit() {
        await chrome('Services.prefs.clearUserPref("layout.css.devPixelsPerPx");');
        await sleep(800);
      },
    }],
    record: file => recorder(env, path.join(directory, file)),
    async cleanup(urls, keys) {
      await chrome(`${FIXTURE} const [urls, keys, origin] = arguments;
        for (const key of keys) keyedWindow(key, origin)?.close();
        for (const url of urls) { const f = findTab(url); if (f && !f.w.closed) f.w.gBrowser.removeTab(f.t); }`, urls, keys, ORIGIN);
      await sleep(500);
    },
  };

  await driver.setContext('content');
  await driver.switchTo().window(originHandle);
  await driver.setContext('chrome');
  video = recorder(env, path.join(directory, 'search-flow.mp4'));

  if (!ACCEPTANCE_ONLY && !CLOSING_ONLY) {
    // --- shortcut → centered modal over the real page --------------------------
    await content('document.getElementById("page-input").focus()');
    await openOverlay();
    check(await hosts() === 1 && await count('overlay') === 1, 'shortcut injects one dialog + one frame');
    check(await inSearch('overlay', 'return location.search === "" && location.hash === ""'), 'overlay iframe URL carries no token');
    check(await inSearch('overlay', 'return document.hasFocus() && document.activeElement.id === "query"'), 'query focused inside frame');
    const shown = await rows();
    check(shown.at(-1) === TITLES['/current'], 'empty query current-last', shown);
    check(shown.includes(TITLES['/remote']), 'all-windows results by default', shown);
    const g = await geometry();
    check(g.dx <= 2 && g.dy <= 2 && Math.round(g.frame.w) === Math.min(640, g.page.w - 48), 'dialog centered at 640px', g);
    const isolation = await content(`const host=document.querySelector('tabvacuum-search');
      let doc = window.frames.length ? undefined : 'no-window-reference';
      for (let i=0;i<window.frames.length;i++) { try { doc = window.frames[i].document.body.innerText; } catch (e) { doc = e.name; } }
      return { shadow: host && host.shadowRoot, text: host && host.textContent, children: host && host.children.length, doc };`);
    check(isolation.shadow === null && isolation.text === '' && isolation.children === 0, 'page sees only an empty closed host', isolation);
    check(['SecurityError', 'no-window-reference'].includes(isolation.doc), 'page cannot read cross-origin result document', isolation.doc);

    // Embedded Firefox frames have runtime but not tabs. Live refresh below
    // must pass through the authorized refresh path, irrespective of API surface.
    const frameApis = await inSearch('overlay', 'return { tabs: typeof browser.tabs, runtime: typeof browser.runtime }');
    check(frameApis.runtime === 'object', 'overlay frame has runtime for authorized refresh', frameApis);
    await key('overlay', 'ArrowDown');
    check(await selected() === shown[1], 'ArrowDown moves highlight in frame');
    check(await activeUrl() === `${base}/current`, 'arrow does not switch tabs');
    await type('overlay', 'roadmap');
    check(await selected() === TITLES['/current'], 'typed exact: current tab can be first');
    check((await rows()).includes(TITLES['/fuzzy']), 'fuzzy match listed below exact', await rows());
    await type('overlay', 'checklist');
    check(await selected() === TITLES['/remote'], 'query reaches frame for leak check');
    const dump = await content(`const parts=[document.documentElement.outerHTML, location.href, document.title, document.cookie];
      for (const el of document.querySelectorAll('*')) for (const a of el.attributes) parts.push(a.value);
      try { parts.push(JSON.stringify({...localStorage}), JSON.stringify({...sessionStorage})); } catch {}
      return parts.join('\\n');`);
    // Compared inside the extension frame; the token never reaches this process.
    // A background extension tab reads the sessions; the overlay tab stays active.
    const tokenLeak = await chromeAsync(`const [url, dump] = arguments;
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      const tab = w.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      try {
        for (let i = 0; i < 100 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 300));
        return await actor(tab.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { args: [dump], opts: {}, script:
          "return browser.storage.session.get('search.sessions').then(s => { const k = Object.keys(s['search.sessions'] || {}); return { count: k.length, leaked: k.some(t => arguments[0].includes(t)) }; })" });
      } finally { w.gBrowser.removeTab(tab); }`, `${EXT}/options.html`, dump);
    check(tokenLeak.count === 1 && !tokenLeak.leaked, 'launch token absent from host DOM/URL/storage', tokenLeak);
    const words = ['checklist', TITLES['/remote'], TITLES['/fuzzy'], TITLES['/previous']].filter(w => dump.includes(w));
    check(words.length === 0, 'query and other tab titles absent from host DOM', words);
    await type('overlay', 'raodmap');
    check(await selected() === TITLES['/current'], 'typo tolerance');

    // Native Tab / Shift+Tab walk query -> results -> buttons -> query inside the modal.
    ui.kind = 'overlay';
    ui.title = TITLES['/current'];
    await runTabCycle(closing, 'overlay');

    await type('overlay', 'project');
    check((await rows()).length === 2, 'two results for screenshot query', await rows());
    await setScheme(1);
    await until(async () => (await inSearch('overlay', 'return getComputedStyle(document.body).backgroundColor')) === 'rgb(255, 255, 255)', 'light', 3000).catch(() => {});
    check(await inSearch('overlay', 'return getComputedStyle(document.body).backgroundColor') === 'rgb(255, 255, 255)', 'light theme in frame');
    await shot('light-two-results', `Firefox ${version} full 1280x900 X display: real page + native-shortcut overlay, light, query "project"`);
    await setScheme(0);
    await until(async () => (await inSearch('overlay', 'return getComputedStyle(document.body).backgroundColor')) === 'rgb(28, 28, 31)', 'dark', 3000).catch(() => {});
    check(await inSearch('overlay', 'return getComputedStyle(document.body).backgroundColor') === 'rgb(28, 28, 31)', 'dark theme in frame');
    await shot('dark-two-results', `Firefox ${version} full 1280x900 X display: same overlay, content prefers-color-scheme pref = dark`);
    await setScheme(2);

    await shortcut();
    await sleep(1500);
    check(await hosts() === 1 && await count('overlay') === 1, 'reopen does not duplicate dialog');
    await ready('overlay').catch(() => {});

    await type('overlay', 'zzzzzzzz');
    check((await rows()).length === 0, 'empty-result state');
    await key('overlay', 'Enter');
    check(await activeUrl() === `${base}/current` && await hosts() === 1, 'Enter without results does nothing');
    await key('overlay', 'Escape');
    await closed().then(() => check(true, 'Escape dismisses'), e => check(false, 'Escape dismisses', e.message));
    check(await activeUrl() === `${base}/current`, 'Escape keeps same page and tab');
    const after = await content('return { focus: document.hasFocus(), active: document.activeElement && document.activeElement.id }');
    check(after.focus && after.active === 'page-input', 'Escape restores page focus', after);

    await openOverlay();
    await driver.setContext('content');
    await driver.actions().move({ x: 8, y: 8 }).click().perform();
    await driver.setContext('chrome');
    await closed().then(() => check(true, 'backdrop click dismisses'), e => check(false, 'backdrop click dismisses', e.message));

    await openOverlay();
    await type('overlay', 'release');
    check(await selected() === TITLES['/remote'], 'other-window match selected');
    await key('overlay', 'Enter');
    await until(async () => (await activeUrl()) === `${base}/remote`, 'remote focus')
      .then(() => check(true, 'Enter focuses target tab and its window'), e => check(false, 'Enter focuses target tab and its window', e.message));
    await until(async () => (await count('overlay')) === 0, 'overlay gone after activation')
      .then(() => check(true, 'overlay closes after activation'), e => check(false, 'overlay closes after activation', e.message));
    // Back to the origin window.
    await chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.gBrowser.selectedBrowser.currentURI.spec === arguments[0]) w.focus();`, `${base}/current`);
    await until(async () => (await activeUrl()) === `${base}/current`, 'origin refocus');
    await driver.setContext('content'); await driver.switchTo().window(originHandle); await driver.setContext('chrome');

    // Narrow: a 4x device scale shrinks the CSS viewport of the real window. Firefox
    // keeps a ~500 CSS px minimum window width, so 320 px itself is Chromium-only.
    await chrome('Services.prefs.setCharPref("layout.css.devPixelsPerPx", "4");');
    await sleep(600);
    await openOverlay();
    const small = await geometry();
    console.log(`INFO Firefox narrow viewport: ${small.page.w}x${small.page.h} CSS px`);
    check(small.page.w <= 520 && Math.round(small.frame.w) === small.page.w - 48 && small.dx <= 2 && small.dy <= 2, 'narrow (Firefox minimum width): dialog fits and is centered', small);
    check(await inSearch('overlay', 'return document.documentElement.scrollWidth <= innerWidth'), 'narrow: no horizontal overflow');
    await key('overlay', 'Escape');
    await closed().catch(() => {});
    await chrome('Services.prefs.clearUserPref("layout.css.devPixelsPerPx");');
    await sleep(600);

    // Other fixture pages in the origin tab (one at a time, then back).
    async function visit(url) {
      await driver.setContext('content'); await driver.get(url); await driver.setContext('chrome');
    }
    await visit(`${base}/hostile-css`);
    await openOverlay();
    const loud = await geometry();
    const loudFont = await inSearch('overlay', 'return getComputedStyle(document.querySelector(".title")).fontSize');
    check(loud.dx <= 2 && Math.round(loud.frame.w) === 640 && loudFont === '14px', 'page CSS does not reach dialog', { loud, loudFont });
    await key('overlay', 'Escape');
    await closed().catch(() => {});

    await visit(`${base}/embed`);
    await content(`const f=document.createElement('iframe'); f.src=arguments[0];
      f.addEventListener('load', () => f.contentWindow.postMessage({ type: 'tabvacuum:init', token: 'A'.repeat(43) }, '*'));
      document.body.append(f);`, SEARCH);
    // Wait for the frame's terminal UI state, not a fixed delay measured before
    // its document and module scripts have even loaded. Keep rejection strict.
    await until(async () => (await inSearch('overlay', 'return document.getElementById("message")?.dataset.state')) === 'error', 'unauthorized frame error state', 10000);
    const rogue = await inSearch('overlay', 'return { rows: document.querySelectorAll(".result").length, state: document.getElementById("message").dataset.state }');
    check(rogue && rogue.rows === 0 && rogue.state === 'error', 'page-made iframe without launch gets no tabs', rogue);
    await visit(`${base}/current`);

    await visit(`${base}/csp`);
    await shortcut();
    let cspMode;
    await until(async () => {
      if ((await inSearch('overlay', 'return document.querySelectorAll(".result").length'))?.error === undefined &&
          (await inSearch('overlay', 'return document.querySelectorAll(".result").length')) > 0) return (cspMode = 'overlay');
      if ((await count('window')) > 0 && (await inSearch('window', 'return document.querySelectorAll(".result").length')) > 0) return (cspMode = 'window');
    }, 'CSP search', 9000).catch(() => {});
    console.log(`INFO CSP page search mode: ${cspMode}`);
    check(Boolean(cspMode), 'restrictive CSP page still gets working search', cspMode);
    if (cspMode === 'window') {
      check(await hosts() === 0, 'CSP fallback leaves no blank modal on page');
      await key('window', 'Escape');
      await until(async () => (await count('window')) === 0, 'CSP window closed').catch(() => {});
    } else if (cspMode === 'overlay') { await key('overlay', 'Escape'); await closed().catch(() => {}); }

    // Browser-internal pages get the separate extension window.
    for (const internal of ['about:blank', 'about:addons']) {
      await visit(internal);
      if (internal === 'about:blank') await content('document.title = "Blank origin"');
      await sleep(400);
      try {
        await shortcut();
        await until(async () => (await count('window')) === 1, `${internal} window`, 8000);
        await ready('window');
        const info = await chrome(`${LOCATE} const [bc] = locate('window', arguments[0]); const w = bc.topChromeWindow;
          return { popup: !w.toolbar.visible, token: /\\?token=[A-Za-z0-9_-]{43}$/.test(bc.currentURI.spec), width: w.outerWidth };`, SEARCH);
        check(info.token && info.popup, `${internal}: separate popup search window`, { popup: info.popup, width: info.width, tokenShape: info.token });
        check(await inSearch('window', 'return document.activeElement.id') === 'query' && (await rows('window')).length > 0, `${internal}: window search usable`);
        await key('window', 'Escape');
        await until(async () => (await count('window')) === 0, 'window closed');
        const back = await activeUrl();
        check(back === (internal === 'about:blank' ? 'about:blank' : 'about:addons'), `${internal}: Escape returns to origin tab`, back);
      } catch (error) {
        check(false, `${internal}: fallback window`, error.message);
      }
    }
    await visit(`${base}/current`);

    // Toolbar menu → Search tabs with a real click on the toolbar button.
    await chrome('CustomizableUI.addWidgetToArea("tabvacuum_adlio-browser-action", "nav-bar"); gBrowser.selectedBrowser.focus();');
    await driver.findElement(By.id('tabvacuum_adlio-BAP')).click();
    await until(async () => (await chromeAsync(`const view = document.querySelector('browser.webextension-popup-browser');
      if (!view) return false; return actor(view.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script: 'return !!document.getElementById("btn-search")', args: [], opts: {} });`)) === true, 'menu');
    const inspectMenu = script => chromeAsync(`const view = document.querySelector('browser.webextension-popup-browser');
      return actor(view.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script: arguments[0], args: [], opts: {} });`, script);
    await until(async () => (await inspectMenu('return document.querySelectorAll("#search-shortcut kbd").length')) === 3, 'menu shortcut loaded');
    for (const [scheme, value] of [['light', 1], ['dark', 0]]) {
      await setScheme(value);
      // Toolbar extension pages follow Firefox's browser theme, not the page
      // color-scheme override used for the embedded search frame above.
      await chromeAsync(`const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await (await AddonManager.getAddonByID(arguments[0])).enable(); return true;`,
        `firefox-compact-${scheme}@mozilla.org`);
      const expectedBackground = scheme === 'dark' ? 'rgb(28, 28, 31)' : 'rgb(255, 255, 255)';
      await until(async () => await inspectMenu('return getComputedStyle(document.body).backgroundColor') === expectedBackground, 'native menu theme');
      await sleep(200);
      const menu = await inspectMenu(`return (${inspectPopup.toString()})()`);
      check(menu.scheme === expectedBackground, `${scheme}: native menu follows browser theme`, menu.scheme);
      check(menu.visible && menu.noOverflow && menu.sort && menu.status, `${scheme}: native menu layout, sort expansion and status semantics`, menu);
      check(JSON.stringify(menu.shortcut) === JSON.stringify(['Ctrl', 'Shift', '.']) && menu.shortcutLabel === 'Control + Shift + .', `${scheme}: native menu shows actual shortcut as accessible keycaps`, menu);
      check(menu.contrast >= 4.5, `${scheme}: native menu text contrast meets 4.5:1`, menu.contrast);
      await shot(`menu-${scheme}`, 'Native toolbar menu with actual browser shortcuts');
    }
    await setScheme(1);
    await chromeAsync(`const view = document.querySelector('browser.webextension-popup-browser');
      return actor(view.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script: 'document.getElementById("btn-search").click()', args: [], opts: {} });`);
    let menuMode;
    await until(async () => {
      if ((await count('overlay')) > 0 && (await inSearch('overlay', 'return document.getElementById("results").getAttribute("aria-busy")')) === 'false') return (menuMode = 'overlay');
      if ((await count('window')) > 0) return (menuMode = 'window');
    }, 'menu search', 8000).catch(() => {});
    console.log(`INFO toolbar menu search mode: ${menuMode}`);
    check(menuMode === 'overlay', 'toolbar menu opens overlay over page', menuMode);
    if (menuMode === 'overlay') { await key('overlay', 'Escape'); await closed().catch(() => {}); }
    else if (menuMode === 'window') { await key('window', 'Escape'); await until(async () => (await count('window')) === 0, 'closed').catch(() => {}); }
    await video.stop();

    // Settings page only: current-window scope persists across reload.
    await visit(`${EXT}/options.html`);
    await driver.setContext('content');
    await driver.wait(async () => driver.executeScript('return document.getElementById("search-scope").value === "all"'), 8000);
    await driver.executeScript('const s=document.getElementById("search-scope"); s.value="current"; s.dispatchEvent(new Event("change",{bubbles:true}));');
    await driver.wait(async () => driver.executeAsyncScript('const done=arguments[arguments.length-1]; browser.storage.local.get("searchScope").then(s=>done(s.searchScope==="current"))'), 8000);
    await driver.navigate().refresh();
    await driver.wait(async () => driver.executeScript('return document.getElementById("search-scope").value === "current"'), 8000).catch(() => {});
    check(await driver.executeScript('return document.getElementById("search-scope").value') === 'current', 'scope setting survives reload');
    await driver.setContext('chrome');
    await visit(`${base}/current`);
    await openOverlay();
    check(!(await rows()).includes(TITLES['/remote']), 'current-window scope excludes other window', await rows());
    check(await inSearch('overlay', 'return [...document.querySelectorAll("select,input[type=checkbox],input[type=range]")].every(el => ["source-history", "source-content"].includes(el.id))'), 'no persistent settings controls in search (only explicit source choices)');

    await key('overlay', 'Escape');
    await closed().catch(() => {});
    // Many tabs: real background tabs in this throwaway profile.
    await chrome(`${LOCATE} const sp = Services.scriptSecurityManager.getSystemPrincipal(); const { gBrowser } = originWindow(arguments[0]);
      for (let i = 0; i < 150; i++) gBrowser.addTab('about:blank#search-scale-' + i, { triggeringPrincipal: sp, inBackground: true });`, `${base}/current`);
    await openOverlay();
    await type('overlay', 'search-scale');
    await until(async () => (await rows()).length === 150, '150 rows').catch(() => {});
    check((await rows()).length === 150, 'many150: all matches listed', (await rows()).length);
    for (let i = 0; i < 12; i++) await key('overlay', 'ArrowDown');
    check(await inSearch('overlay', 'return document.getElementById("scroll").scrollTop > 0'), 'many150: keyboard highlight scrolls list');
    await sleep(1100);
    await inSearch('overlay', 'document.getElementById("scroll").scrollTop = 0');
    await sleep(1200);
    check(await inSearch('overlay', 'return document.getElementById("scroll").scrollTop === 0'), 'unchanged Firefox refresh preserves manual scrolling');
    await chrome(`${LOCATE} const { gBrowser } = originWindow(arguments[0]); gBrowser.removeTab(gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith('#search-scale-0')));`, `${base}/current`);
    await until(async () => (await rows()).length === 149, 'refresh').then(() => check(true, 'results refresh when a tab closes'), e => check(false, 'results refresh when a tab closes', e.message));
    await key('overlay', 'Escape');
    await closed().catch(() => {});

    // Two tabs, then one (current-window scope).
    await chrome(`${LOCATE} const { gBrowser } = originWindow(arguments[0]); for (const t of [...gBrowser.tabs]) { const u = t.linkedBrowser.currentURI.spec; if (!u.endsWith('/current') && !u.endsWith('/previous')) gBrowser.removeTab(t); }`, `${base}/current`);
    await sleep(500);
    await openOverlay();
    check(JSON.stringify(await rows()) === JSON.stringify([TITLES['/previous'], TITLES['/current']]), 'two tabs: previous first, current last', await rows());
    await type('overlay', 'roadmap');
    check(await selected() === TITLES['/current'], 'two tabs: current wins typed search');
    await type('overlay', '');
    await chrome(`${LOCATE} const { gBrowser } = originWindow(arguments[0]); gBrowser.removeTab(gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith('/previous')));`, `${base}/current`);
    await key('overlay', 'Escape');
    await closed().catch(() => {});
    await openOverlay();
    check(JSON.stringify(await rows()) === JSON.stringify([TITLES['/current']]), 'one tab: current listed', await rows());
    await key('overlay', 'Enter');
    await sleep(300);
    check(await activeUrl() === `${base}/current`, 'one tab: Enter keeps that tab');
    if (await count('overlay')) { await key('overlay', 'Escape'); await closed().catch(() => {}); }

    // Hostile title, rendered literally (search in the page's own tab).
    await content('document.title = "<img src=x onerror=alert(1)> hostile title"');
    await sleep(500);
    await chrome('Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", 2);');
    await shortcut().catch(() => {});
    await until(async () => (await count('overlay')) > 0, 'hostile overlay').catch(() => {});
    await ready('overlay').catch(() => {});
    await type('overlay', 'hostile');
    check(await inSearch('overlay', 'return document.querySelector(".result .title")?.textContent') === '<img src=x onerror=alert(1)> hostile title', 'hostile title rendered literally');
    check(await inSearch('overlay', 'return document.querySelectorAll("#results img").length') === 0, 'title markup creates no elements');

  }

  if (!CLOSING_ONLY) {
    // ===== Privacy and lifecycle acceptance ====================================
    // Runs after the main flow (or alone with --acceptance-only) from a known state.
    const go = async url => { await driver.setContext('content'); await driver.switchTo().window(originHandle); await driver.get(url); await driver.setContext('chrome'); };
    const focusOrigin = () => chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.gBrowser.selectedBrowser.currentURI.spec === arguments[0]) { w.focus(); w.gBrowser.selectedBrowser.focus(); }`, `${base}/current`);
    if (await count('overlay')) { await key('overlay', 'Escape'); await sleep(300); }
    await go(`${base}/current`);
    await focusOrigin();
    // Privileged reads from a background extension tab; the searched tab stays active.
    const extEval = (script, args = []) => chromeAsync(`const [url, script, args] = arguments;
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      const tab = w.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      try {
        for (let i = 0; i < 100 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 300));
        return await actor(tab.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script, args, opts: {} });
      } finally { w.gBrowser.removeTab(tab); }`, `${EXT}/options.html`, script, args);
    await extEval('return browser.storage.local.set({ searchScope: "all" })');
    const topLevelWindows = () => chrome('let n = 0; for (const w of Services.wm.getEnumerator(null)) n++; return n;');
    const urls = (kind = 'overlay') => inSearch(kind, 'return [...document.querySelectorAll(".result .url")].map(e => e.textContent)');
    // Script in a top-level page (by URL, any window), with that page's principal.
    const pageEval = (url, script) => chromeAsync(`const [url, script] = arguments;
      for (const w of Services.wm.getEnumerator('navigator:browser')) for (const b of w.gBrowser.browsers)
        if (b.currentURI.spec === url) return actor(b.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script, args: [], opts: {} });
      return { error: 'no page' };`, url, script);
    console.log(`INFO Firefox fission.autostart: ${await chrome('return Services.appinfo.fissionAutostart')}`);

    // (1) Private windows, allowed through allowPrivate() above.
    await allowPrivate();
    check(await privateAllowed(), 'private: extension allowed in private windows in throwaway profile only');

    const privUrl = `${base}/private-only`, privTwo = `${base}/private-two`;
    await chromeAsync(`const [one, two] = arguments;
      const w = OpenBrowserWindow({ private: true });
      await new Promise(r => w.addEventListener('load', r, { once: true }));
      await new Promise(r => setTimeout(r, 500));
      w.moveTo(0, 0); w.resizeTo(1280, 900);
      const sp = Services.scriptSecurityManager.getSystemPrincipal();
      w.gBrowser.loadURI(Services.io.newURI(one), { triggeringPrincipal: sp });
      w.gBrowser.addTab(two, { triggeringPrincipal: sp, inBackground: true });
      w.focus();
      return true;`, privUrl, privTwo);
    const privateWindow = `for (const w of Services.wm.getEnumerator('navigator:browser')) if (PrivateBrowsingUtils.isWindowPrivate(w)) return w;`;
    await until(async () => (await pageEval(privUrl, 'return document.readyState')) === 'complete', 'private page loaded');
    await pageEval(privUrl, 'document.title = "Private sentinel"');
    await chrome(`const w = (() => { ${privateWindow} })(); w.focus(); w.gBrowser.selectedBrowser.focus();`);
    await sleep(500);
    let privMode;
    await shortcut();
    await until(async () => {
      if ((await count('overlay')) > 0 && (await inSearch('overlay', 'return document.getElementById("results").getAttribute("aria-busy")')) === 'false') return (privMode = 'overlay');
      if ((await count('window')) > 0) return (privMode = 'window');
    }, 'private search', 9000).catch(() => {});
    console.log(`INFO private page search mode: ${privMode}`);
    check(privMode === 'overlay', 'private: shortcut opens overlay over private page', privMode);
    if (privMode === 'overlay') {
      const shownPrivate = await urls();
      check(shownPrivate.length === 2 && shownPrivate.every(u => u === privUrl || u === privTwo), 'private: overlay lists only private tabs', shownPrivate);
      await key('overlay', 'Escape');
      await until(async () => (await count('overlay')) === 0, 'private overlay closed', 5000)
        .then(() => check(true, 'private: Escape closes overlay'), e => check(false, 'private: Escape closes overlay', e.message));
    }

    // Normal search after the add-on reload: excludes private tabs, and the
    // pre-existing page's overlay still closes after activation.
    await focusOrigin();
    await sleep(300);
    await openOverlay();
    const normalUrls = await urls();
    check(normalUrls.length > 0 && !normalUrls.some(u => u === privUrl || u === privTwo), 'normal: search excludes private tabs', normalUrls);
    await type('overlay', 'release');
    await key('overlay', 'Enter');
    await until(async () => (await activeUrl()) === `${base}/remote`, 'remote after reload', 5000)
      .then(() => check(true, 'normal after reload: Enter activates target'), e => check(false, 'normal after reload: Enter activates target', e.message));
    await until(async () => (await count('overlay')) === 0, 'overlay closed', 5000)
      .then(() => check(true, 'normal after reload: overlay closes after activation'), e => check(false, 'normal after reload: overlay closes after activation', e.message));
    await focusOrigin();

    // Private protected page: the separate search window must itself be private.
    await chrome(`const w = (() => { ${privateWindow} })();
      w.gBrowser.selectedTab = w.gBrowser.addTab('about:blank', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.focus(); w.gBrowser.selectedBrowser.focus();`);
    await sleep(500);
    await pageEval('about:blank', 'document.title = "Private blank"');
    await sleep(300);
    try {
      await shortcut();
      await until(async () => (await count('window')) === 1, 'private fallback window', 8000);
      await ready('window');
      const info = await chrome(`${LOCATE} const [bc] = locate('window', arguments[0]); const w = bc.topChromeWindow;
        return { popup: !w.toolbar.visible, private: PrivateBrowsingUtils.isWindowPrivate(w) };`, SEARCH);
      check(info.popup && info.private, 'private protected page: separate private popup window', info);
      const shownFallback = await urls('window');
      check(shownFallback.length > 0 && shownFallback.every(u => [privUrl, privTwo, 'about:blank'].includes(u)), 'private fallback: search page loads and lists only private tabs', shownFallback);
      await key('window', 'Escape');
      await until(async () => (await count('window')) === 0, 'private fallback closed', 5000);
      const back = await chrome(`const w = Services.wm.getMostRecentWindow('navigator:browser'); return { url: w.gBrowser.selectedBrowser.currentURI.spec, private: PrivateBrowsingUtils.isWindowPrivate(w) };`);
      check(back.url === 'about:blank' && back.private, 'private fallback: Escape returns to private origin tab', back);
    } catch (error) {
      check(false, 'private protected page: fallback window', redact(error.message));
    }
    await chrome(`const w = (() => { ${privateWindow} })(); w?.close();`);
    await sleep(500);
    await focusOrigin();

    // (2) A native navigation right after the shortcut ends that launch: no
    // fallback window appears after the claim timeout, and the next launch works.
    for (const variant of ['immediately', 'after the dialog mounts']) {
      await go(`${base}/current`);
      await focusOrigin();
      const before = await topLevelWindows();
      await shortcut();
      const mounted = variant === 'immediately' || await until(async () => (await count('overlay')) > 0, 'mounted', 5000).then(() => true, () => false);
      await go(`${base}/previous`);
      await sleep(5500); // Past the 4 s claim timeout.
      const after = { windows: await topLevelWindows(), before, fallback: await count('window'), overlays: await count('overlay'), hosts: await hosts() };
      check(mounted && after.windows === before && after.fallback === 0 && after.overlays === 0 && after.hosts === 0, `navigation ${variant} after shortcut: no fallback window or stray dialog`, { mounted, ...after });
    }
    await go(`${base}/current`);
    await focusOrigin();
    await openOverlay();
    check((await rows()).length > 0, 'after navigation cases: next shortcut opens overlay normally');
    await key('overlay', 'Escape');
    await closed().catch(() => {});

    // (3) Background event page terminated while the overlay is open, the
    // same operation as about:debugging's "Terminate background script".
    await openOverlay();
    const backgroundState = () => chrome('return WebExtensionPolicy.getByID(arguments[0]).extension.backgroundState', ADDON);
    await chromeAsync('await WebExtensionPolicy.getByID(arguments[0]).extension.terminateBackground(); return true;', ADDON);
    const terminated = await backgroundState();
    check(terminated === 'stopped', 'background terminated while overlay open', terminated);
    await type('overlay', 'release');
    check(await selected() === TITLES['/remote'], 'after background stop: typing still filters in frame');
    await key('overlay', 'Enter');
    await until(async () => (await activeUrl()) === `${base}/remote`, 'remote after restart', 8000)
      .then(() => check(true, 'after background restart: Enter activates target tab'), e => check(false, 'after background restart: Enter activates target tab', e.message));
    await until(async () => (await count('overlay')) === 0, 'overlay closed', 5000)
      .then(() => check(true, 'after background restart: overlay closes'), e => check(false, 'after background restart: overlay closes', e.message));
    check(await backgroundState() === 'running', 'Enter restarts the background', await backgroundState());
    await focusOrigin();

    // (4) Page-visible resource timing, and page-made frames around a real launch.
    const secretsIn = text => extEval(`return browser.storage.session.get('search.sessions').then(s => {
      const k = Object.keys(s['search.sessions'] || {}); return { count: k.length, leaked: k.some(t => arguments[0].includes(t)) }; })`, [text]);
    const addFrame = name => content(`const f = document.createElement('iframe'); f.name = arguments[1]; f.src = arguments[0];
      f.addEventListener('load', () => { for (const token of ['A'.repeat(43), 'B'.repeat(43), 'not-a-token']) f.contentWindow.postMessage({ type: 'tabvacuum:init', token }, '*'); });
      document.body.append(f);`, SEARCH, name);
    const namedState = name => chromeAsync(`const [url, name] = arguments;
      for (const w of Services.wm.getEnumerator('navigator:browser')) for (const b of w.gBrowser.browsers)
        for (const c of b.browsingContext.getAllBrowsingContextsInSubtree()) if (c.name === name && c.currentURI?.spec === url)
          return actor(c).sendQuery('MarionetteCommandsParent:executeScript', { args: [], opts: {}, script:
            'return { rows: document.querySelectorAll(".result").length, state: document.getElementById("message").dataset.state }' });
      return { error: 'no frame' };`, SEARCH, name);
    await go(`${base}/embed`);
    await focusOrigin();
    await openOverlay();
    await type('overlay', 'checklist');
    check(await selected() === TITLES['/remote'], 'embed page: query reaches overlay');
    const timing = await content('return performance.getEntries().map(e => e.name).join("\\n")');
    const timingSecrets = await secretsIn(timing);
    check(timingSecrets.count === 1 && !timingSecrets.leaked, 'page resource timing: no launch token', timingSecrets);
    const timingWords = ['checklist', TITLES['/remote'], TITLES['/current'], 'token='].filter(w => timing.includes(w));
    check(timingWords.length === 0, 'page resource timing: no query, tab titles, or token parameter', timingWords);
    console.log(`INFO page resource timing shows the extension frame URL: ${timing.includes(SEARCH)} (stable per-install extension UUID fingerprint; not a secret)`);
    await addFrame('page-made-after');
    await sleep(5600); // Past the frame's 5 s init timeout.
    const afterLaunch = await namedState('page-made-after');
    check(afterLaunch?.rows === 0 && afterLaunch.state === 'error', 'page-made frame after a valid launch gets no tabs', afterLaunch);
    check(await selected() === TITLES['/remote'] && (await secretsIn('')).count === 1, 'real overlay unaffected by page-made frame');
    await key('overlay', 'Escape');
    await closed().catch(() => {});

    await go(`${base}/embed`);
    await focusOrigin();
    const created = Date.now();
    await addFrame('page-made-before');
    await sleep(300);
    await openOverlay();
    await sleep(Math.max(0, 5600 - (Date.now() - created)));
    const beforeLaunch = await namedState('page-made-before');
    check(beforeLaunch?.rows === 0 && beforeLaunch.state === 'error', 'page-made frame before a valid launch gets no tabs', beforeLaunch);
    check((await rows()).length > 0, 'real overlay still lists tabs beside page-made frame');
    await key('overlay', 'Escape');
    await closed().catch(() => {});
    await go(`${base}/current`);
  }

  if (!ACCEPTANCE_ONLY) {
    // ===== Selection and closing, on disposable tabs only =====================
    if (await count('overlay')) { await key('overlay', 'Escape'); await closed().catch(() => {}); }
    // The 4x narrow check widens the window past the display (500 CSS px minimum); restore it.
    await chrome(`${LOCATE} const w = originWindow(arguments[0]); w.moveTo(0, 0); w.resizeTo(1280, 900);`, ORIGIN);
    await sleep(500);
    // Expanded-search adapter: history via Places, permissions via a fresh extension
    // page, and the browser's own permission doorhanger clicked with a real X pointer.
    const OPT = `${EXT}/options.html?tv=settings`;
    const extEval = script => chromeAsync(`const [url, origin, script] = arguments;
      const w = originWindow(origin);
      const tab = w.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      try {
        for (let i = 0; i < 100 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 300));
        return await actor(tab.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { args: [], opts: {}, script });
      } finally { w.gBrowser.removeTab(tab); }`, `${EXT}/options.html`, ORIGIN, script);
    const inOptions = script => chromeAsync(`${FIXTURE} const [url, script] = arguments; const f = findTab(url);
      if (!f) return { error: 'no options tab' };
      return actor(f.t.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script, args: [], opts: {} });`, OPT, script);
    const readOptions = () => inOptions('const $ = id => document.getElementById(id); return { state: $("content-access-state").textContent, message: $("content-access-message").textContent };');
    async function clickOptions(selector) {
      // Raise the Settings window first: a real pointer click lands on whatever window is on top.
      nativeKeys(env, ['Shift_L'], 'TabVacuum Settings');
      await sleep(300);
      const p = await inOptions(`const button = document.querySelector(${JSON.stringify(selector)}); button.scrollIntoView({ block: 'center' }); const r = button.getBoundingClientRect();
        return { x: mozInnerScreenX + r.left + r.width / 2, y: mozInnerScreenY + r.top + r.height / 2 };`);
      nativeClick(env, p.x, p.y);
    }
    const doorhanger = decision => chrome(`const w = Services.wm.getMostRecentWindow('navigator:browser'); const panel = w.PopupNotifications.panel;
      const n = panel.state === 'open' && [...panel.children].find(c => c.getAttribute('popupid') === 'addon-webext-permissions');
      if (!n) return null;
      const b = arguments[0] === 'allow' ? n.button : n.secondaryButton;
      const r = b.getBoundingClientRect();
      return { x: w.mozInnerScreenX + r.left + r.width / 2, y: w.mozInnerScreenY + r.top + r.height / 2, label: b.label };`, decision);
    let optionsBaseline = [];
    const optionTabs = () => chrome(`const out = []; for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of w.gBrowser.tabs) {
      const u = t.linkedBrowser.currentURI.spec; if (u.startsWith('about:addons') || (u.startsWith(arguments[0]) && !u.includes('?tv='))) out.push(u); } return out;`, `${EXT}/options.html`);
    closing.expanded = {
      historyHas: url => chromeAsync('return (await PlacesUtils.history.fetch(arguments[0])) !== null;', url).then(v => v === true),
      permitted: async () => (await extEval("return browser.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })")) === true,
      markOptions: async () => { optionsBaseline = await optionTabs(); },
      optionsOpened: async () => (await optionTabs()).length > optionsBaseline.length,
      closeOptions: () => chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of [...w.gBrowser.tabs]) {
        const u = t.linkedBrowser.currentURI.spec; if (u.startsWith('about:addons')) w.gBrowser.removeTab(t); }`),
      async settingsOpen() {
        await closing.addTab('origin', OPT);
        await closing.focus(OPT);
        await until(async () => (await readOptions()).state !== 'Checking…', 'settings ready', 5000);
      },
      async settingsClose() { await closing.cleanup([OPT], []); await closing.focus(ORIGIN); },
      async request(decision) {
        await closing.focus(OPT);
        await clickOptions('#content-access-allow');
        let target;
        await until(async () => (target = await doorhanger(decision)), 'permission doorhanger', 6000).catch(() => {});
        if (!target) return { ...(await readOptions()), method: 'no browser permission prompt appeared' };
        await sleep(600);
        nativeClick(env, target.x, target.y);
        let method = `native X click on the browser doorhanger button "${target.label}"`;
        const answered = await until(async () => (await readOptions()).message !== 'Waiting for your browser…', 'prompt answered', 4000).catch(() => false);
        if (!answered) {
          // Disclosed fallback: the prompt's own button, activated from browser chrome.
          await chrome(`const n = [...Services.wm.getMostRecentWindow('navigator:browser').PopupNotifications.panel.children].find(c => c.getAttribute('popupid') === 'addon-webext-permissions');
            (arguments[0] === 'allow' ? n.button : n.secondaryButton).click();`, decision);
          method = `FALLBACK chrome-DOM click on the doorhanger button "${target.label}" (native click missed)`;
          await until(async () => (await readOptions()).message !== 'Waiting for your browser…', 'prompt answered', 4000).catch(() => {});
        }
        await sleep(300);
        return { ...(await readOptions()), method };
      },
      async revoke() {
        await closing.focus(OPT);
        await clickOptions('#content-access-revoke');
        await sleep(900);
        nativeKeys(env, ['Return']);
        let method = 'native X Return on the tab-modal confirm()';
        const done = await until(async () => /removed/.test((await readOptions()).message), 'revoked', 4000).catch(() => false);
        if (!done) method = 'confirm() not accepted by native Return';
        await sleep(300);
        return { ...(await readOptions()), method };
      },
      discard: url => chrome(`${FIXTURE} const f = findTab(arguments[0]); f.w.__tvSleeping = f.t; (f.w.__tvSleepingTabs ??= {})[arguments[0]] = f.t; f.w.gBrowser.discardBrowser(f.t, true);`, url),
      isDiscarded: url => chrome(`const ws = [...Services.wm.getEnumerator('navigator:browser')];
        const t = ws.map(w => w.__tvSleepingTabs?.[arguments[0]]).find(Boolean) ?? ws.map(w => w.__tvSleeping).find(Boolean);
        return Boolean(t) && !t.closing && !t.linkedPanel && !t.selected;`, url),
      async navigate(url, to) {
        await chrome(`${FIXTURE} const f = findTab(arguments[0]); f.t.linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: sp });`, url, to);
        await loaded([to]);
      },
      // A real private window from OpenBrowserWindow; the shared adapter already
      // addresses tabs and extension frames in every window, private ones included.
      async privateWindow(urls, title) {
        await chromeAsync(`const [urls] = arguments;
          const w = OpenBrowserWindow({ private: true });
          await new Promise(r => w.addEventListener('load', r, { once: true }));
          await new Promise(r => setTimeout(r, 500));
          w.moveTo(0, 0); w.resizeTo(1280, 900); w.__tvPrivate = true;
          const sp = Services.scriptSecurityManager.getSystemPrincipal();
          w.gBrowser.loadURI(Services.io.newURI(urls[0]), { triggeringPrincipal: sp });
          for (const url of urls.slice(1)) w.gBrowser.addTab(url, { triggeringPrincipal: sp, inBackground: true });
          return true;`, urls);
        await loaded(urls);
        const isPrivate = await chrome(`${FIXTURE} return arguments[0].every(url => PrivateBrowsingUtils.isWindowPrivate(findTab(url).w));`, urls);
        check(isPrivate, 'private: fixture tabs are in a real private window');
        await chromeAsync(`${FIXTURE} const [url, title] = arguments;
          return actor(findTab(url).t.linkedBrowser.browsingContext).sendQuery('MarionetteCommandsParent:executeScript', { script: 'document.title = arguments[0]', args: [title], opts: {} });`, urls[0], title);
        await until(async () => (await chrome(`${FIXTURE} return findTab(arguments[0]).t.linkedBrowser.contentTitle;`, urls[0])) === title, 'private title', 5000);
        return {
          ...closing,
          originUrl: urls[0],
          async close() {
            await chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) if (w.__tvPrivate) w.close();`);
            await sleep(500);
            await closing.focus(ORIGIN);
          },
        };
      },
    };
    if (!EXPANDED_ONLY) await runSearchClosing(closing);
    await allowPrivate();
    await runExpandedSearch(closing);
  }

  await writeFile(path.join(directory, 'screenshots.json'), JSON.stringify(shots, null, 2));
  finish({ browser: `Firefox ${version}`, output: directory, screenshots: shots.map(s => s.file) });
} finally {
  await video.stop();
  if (driver) await driver.quit();
  display.stop();
  await site.close();
}
