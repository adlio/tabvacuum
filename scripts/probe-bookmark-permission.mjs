// Probe: can Search's own frame or window call permissions.request({permissions:['bookmarks']})
// from a real click, in each context Search runs in? Builds patched copies of dist/ with a probe
// button, then clicks it with real input in Firefox (framed overlay, standalone window, private
// window) and Chromium headful (the same three). Usage: node scripts/probe-bookmark-permission.mjs firefox|chromium
import { cp, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDisplay } from './test-display.mjs';
import { SEARCH_KEYS } from './test-popup-fixture.mjs';
import { startSite, outputDir, until, sleep, nativeKeys, nativeClick, captureDisplay } from './test-browser-fixtures.mjs';

const target = process.argv[2];
if (!['firefox', 'chromium'].includes(target)) throw new Error('usage: probe-bookmark-permission.mjs firefox|chromium');
const { scratch, directory } = await outputDir(`tabvacuum-permprobe-${target}`);
const ext = path.join(directory, 'ext');
await cp(path.resolve(target === 'firefox' ? 'dist/firefox' : 'dist/chrome'), ext, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8'));
manifest.optional_permissions = [...(manifest.optional_permissions || []), 'bookmarks'];
await writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
const html = await readFile(path.join(ext, 'search.html'), 'utf8');
await writeFile(path.join(ext, 'search.html'), html.replace('</body>',
  '<button id="probe-bm" style="position:fixed;top:4px;left:4px;z-index:2147483647;width:140px;height:44px">probe</button><script src="probe.js"></script></body>'));
await writeFile(path.join(ext, 'probe.js'), `document.getElementById('probe-bm').addEventListener('click', () => {
  const api = globalThis.browser || globalThis.chrome;
  document.body.dataset.probe = 'pending';
  let p;
  try { p = api.permissions.request({ permissions: ['bookmarks'] }); } catch (e) { document.body.dataset.probe = 'threw: ' + e.message; return; }
  p.then(v => { document.body.dataset.probe = 'resolved: ' + v; }, e => { document.body.dataset.probe = 'rejected: ' + e.message; });
});`);

const site = await startSite();
const display = await startDisplay(scratch);
const env = display.env;
process.env.DISPLAY = env.DISPLAY;
const results = [];
const record = (context, outcome) => { results.push({ context, ...outcome }); console.log(JSON.stringify({ context, ...outcome })); };

try {
  if (target === 'firefox') await probeFirefox(); else await probeChromium();
} finally {
  console.log(JSON.stringify({ browser: target, results, directory }));
  display.stop(); site.server?.close?.();
  process.exit(0);
}

async function probeFirefox() {
  const { Builder } = await import('selenium-webdriver');
  const firefox = (await import('selenium-webdriver/firefox.js')).default;
  process.env.TMPDIR = directory;
  const UUID = 'b3906219-0180-4fa2-a2d8-a90270e6e502';
  const SEARCH = `moz-extension://${UUID}/search.html`;
  const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
  const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
  const options = new firefox.Options().setBinary(process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox'))
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'tabvacuum@adlio': UUID }));
  if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) service.addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  try {
    await driver.manage().window().setRect({ x: 0, y: 0, width: 1280, height: 900 });
    await driver.installAddon(ext, true);
    console.log('firefox', (await driver.getCapabilities()).get('browserVersion'));
    await driver.get(`${site.base}/current`);
    await driver.setContext('chrome');
    const LOCATE = `function locate(kind, url) { const found = [];
      for (const win of Services.wm.getEnumerator('navigator:browser')) for (const b of win.gBrowser.browsers) { const top = b.browsingContext; if (!top) continue;
        if (kind === 'window') { if (top.currentURI?.spec.startsWith(url + '?')) found.push(top); continue; }
        for (const c of top.getAllBrowsingContextsInSubtree()) if (c !== top && c.currentURI?.spec === url && !c.name) found.push(c); }
      return found; }
      function actor(bc) { return bc.currentWindowGlobal.getActor('MarionetteCommands'); }`;
    const chrome = (s, ...a) => driver.executeScript(s, ...a);
    const chromeAsync = (body, ...a) => driver.executeAsyncScript(`${LOCATE} const done = arguments[arguments.length - 1]; (async () => { ${body} })().then(done, e => done({ error: String(e) }));`, ...a);
    const inSearch = (kind, script) => chromeAsync(`const [kind, url, script] = arguments; const [bc] = locate(kind, url); if (!bc) return { error: 'no ' + kind };
      return actor(bc).sendQuery('MarionetteCommandsParent:executeScript', { script, args: [], opts: {} });`, kind, SEARCH, script);
    const count = kind => chromeAsync('return locate(arguments[0], arguments[1]).length;', kind, SEARCH);
    const title = () => chrome('const w = Services.wm.getMostRecentWindow("navigator:browser"); return w.document.title;');
    const doorhanger = decision => chrome(`const w = Services.wm.getMostRecentWindow('navigator:browser'); const panel = w.PopupNotifications.panel;
      const n = panel.state === 'open' && [...panel.children].find(c => c.getAttribute('popupid') === 'addon-webext-permissions');
      if (!n) return null; const b = arguments[0] === 'allow' ? n.button : n.secondaryButton; const r = b.getBoundingClientRect();
      return { x: w.mozInnerScreenX + r.left + r.width / 2, y: w.mozInnerScreenY + r.top + r.height / 2, label: b.label, text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) };`, decision);
    async function shortcut() {
      await chrome('const w = Services.wm.getMostRecentWindow("navigator:browser"); w.focus(); w.gBrowser.selectedBrowser.focus();');
      const t = await title();
      for (let i = 0; ; i++) { try { nativeKeys(env, SEARCH_KEYS, t); return; } catch (e) { if (i > 10) throw e; await sleep(200); } }
    }
    async function probe(context, kind, decision) {
      await shortcut();
      await until(async () => (await count(kind)) > 0, `${context} ${kind}`, 9000);
      await sleep(800);
      const p = await inSearch(kind, 'const r = document.getElementById("probe-bm").getBoundingClientRect(); return { x: mozInnerScreenX + r.left + r.width / 2, y: mozInnerScreenY + r.top + r.height / 2 };');
      nativeClick(env, p.x, p.y);
      let prompt = null;
      await until(async () => (prompt = await doorhanger(decision)), 'doorhanger', 5000).catch(() => {});
      const before = await inSearch(kind, 'return document.body.dataset.probe || "not clicked"');
      captureDisplay(env, path.join(directory, `${context}.png`));
      if (prompt) { await sleep(500); nativeClick(env, prompt.x, prompt.y); await sleep(1000); }
      const after = await inSearch(kind, 'return document.body.dataset.probe || "not clicked"').catch(e => String(e));
      record(context, { promptShown: Boolean(prompt), promptText: prompt?.text, answered: prompt ? prompt.label : null, stateWhilePrompt: before, result: after, searchStillOpen: (await count(kind)) > 0 });
      // Close the UI for the next step.
      await inSearch(kind, 'window.close?.(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));').catch(() => {});
      await sleep(800);
    }
    await probe('firefox-overlay', 'overlay', 'deny');
    await driver.setContext('content'); await driver.get('about:blank'); await driver.setContext('chrome');
    await probe('firefox-window', 'window', 'deny');
    // Private window: allowed in this throwaway profile only, as test-firefox.mjs does.
    await chromeAsync(`const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await ExtensionPermissions.add('tabvacuum@adlio', { permissions: ['internal:privateBrowsingAllowed'], origins: [] });
      await (await AddonManager.getAddonByID('tabvacuum@adlio')).reload(); return true;`);
    await sleep(1500);
    await chromeAsync(`const w = OpenBrowserWindow({ private: true }); await new Promise(r => w.addEventListener('load', r, { once: true }));
      await new Promise(r => setTimeout(r, 500)); w.moveTo(0, 0); w.resizeTo(1280, 900);
      w.gBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await new Promise(r => setTimeout(r, 1500)); return true;`, `${site.base}/current`);
    await probe('firefox-private-overlay', 'overlay', 'allow');
    const granted = await chromeAsync(`const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      return (await ExtensionPermissions.get('tabvacuum@adlio')).permissions;`);
    record('firefox-granted-permissions', { result: JSON.stringify(granted) });
  } finally { await driver.quit().catch(() => {}); }
}

async function probeChromium() {
  const { chromium } = await import('playwright');
  const profile = await mkdtemp(path.join(directory, 'profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_BINARY || chromium.executablePath(), headless: false, env, viewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-position=0,0', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extOrigin = worker.url().replace(/\/background\.js$/, '');
    const searchUrl = `${extOrigin}/search.html`;
    console.log('chromium', context.browser()?.version());
    const page = context.pages()[0];
    await page.goto(`${site.base}/current`);
    const windowTitle = async p => `${(await p.title()) || p.url()} - Chromium`;
    async function shortcut(p) { await p.bringToFront(); for (let i = 0; ; i++) { try { return nativeKeys(env, SEARCH_KEYS, await windowTitle(p)); } catch (e) { if (i > 10) throw e; await sleep(200); } } }
    async function probe(name, p, find, answer) {
      await shortcut(p);
      let frame;
      await until(() => (frame = find()), `${name} search UI`, 9000);
      await sleep(800);
      // CDP mouse input: trusted, and a user gesture for the frame it lands in.
      await frame.click('#probe-bm');
      await sleep(1500);
      const before = await frame.evaluate(() => document.body.dataset.probe || 'not clicked');
      captureDisplay(env, path.join(directory, `${name}.png`));
      // The permission dialog is browser UI; answer it with a native key.
      nativeKeys(env, [answer]);
      await sleep(1200);
      const after = await frame.evaluate(() => document.body.dataset.probe || 'not clicked').catch(e => `frame gone: ${e.message}`);
      record(name, { stateWhilePrompt: before, answeredWith: answer, result: after });
      await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
      await sleep(800);
    }
    await probe('chromium-overlay', page, () => page.frames().find(f => f.url() === searchUrl), 'Escape');
    await page.goto('about:blank');
    await probe('chromium-window', page, () => context.pages().find(p => p.url().startsWith(`${searchUrl}?`))?.mainFrame(), 'Escape');
    // Incognito: allowed in this throwaway profile only, as test-chromium.mjs does.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    await manager.evaluate(async id => {
      const call = (n, a) => new Promise(r => chrome.developerPrivate[n](a, r));
      await call('updateProfileConfiguration', { inDeveloperMode: true });
      await call('updateExtensionConfiguration', { extensionId: id, incognitoAccess: true });
    }, new URL(extOrigin).host);
    await sleep(2000);
    await manager.close();
    worker = context.serviceWorkers().find(w => w.url().startsWith(extOrigin)) || await context.waitForEvent('serviceworker');
    await worker.evaluate(url => chrome.windows.create({ incognito: true, url, left: 0, top: 0, width: 1280, height: 900, focused: true }), `${site.base}/current`);
    await sleep(2500);
    // Incognito pages are outside Playwright's context: click and read over raw CDP.
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    const tabTitle = (await targets()).find(t => t.type === 'page' && t.url === `${site.base}/current` && t.browserContextId !== undefined && t.attached === false)?.title;
    nativeKeys(env, SEARCH_KEYS, `${tabTitle || 'Current'} - Chromium`);
    await sleep(2500);
    const frameTarget = (await targets()).find(t => t.url === searchUrl || t.url.startsWith(`${searchUrl}?`));
    if (!frameTarget) { record('chromium-incognito-overlay', { result: 'search UI not found over CDP', targets: (await targets()).map(t => `${t.type} ${t.url.slice(0, 60)}`) }); return; }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: frameTarget.targetId, flatten: true });
    const send = (method, params) => cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: Math.floor(Math.random() * 1e9), method, params }) });
    // Read via a flattened session through Playwright's raw connection.
    const session = context._connection ? null : null;
    void session; void send;
    record('chromium-incognito-overlay', { result: `found ${frameTarget.type} ${frameTarget.url.split('?')[0]}; click not attempted over raw CDP` });
  } finally { await context.close().catch(() => {}); }
}
