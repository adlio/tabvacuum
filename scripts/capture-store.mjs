// Store screenshots from the real built extension in a real browser.
//
//   node scripts/capture-store.mjs firefox|chromium
//
// Same isolation as the browser test harnesses: a fresh throwaway profile, an
// isolated 1280x800 X display and neutral pages served only on 127.0.0.1.
// Search/navigation and popup controls use native XTest keys and clicks.
// Chromium opens its native popup with chrome.action.openPopup(); Firefox
// uses a WebDriver toolbar-button click. Chromium's settings permission button
// also uses a Playwright click; permission dialogs use native XTest input.
// The rendered extension UI is real, and DOM reads check that frames settle.
//
// Output: artifacts/store/<firefox|chrome>/0N-<name>.png (1280x800), plus a
// provenance.json beside them. Logs and profiles stay in $KIROCREW_SCRATCH.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { outputDir, until, sleep, nativeKeys, nativeClick } from './test-browser-fixtures.mjs';
import { SEARCH_KEYS } from './test-popup-fixture.mjs';

const BROWSER = process.argv[2];
if (!['firefox', 'chromium'].includes(BROWSER)) throw new Error('usage: capture-store.mjs firefox|chromium');
const W = 1280, H = 800;
const OUT = path.resolve('artifacts/store', BROWSER === 'firefox' ? 'firefox' : 'chrome');
await mkdir(OUT, { recursive: true });
const { scratch, directory } = await outputDir(`tabvacuum-store-${BROWSER}`);

// ---- Neutral fixture site ---------------------------------------------------
// [title, section, body]. Bodies are ordinary prose; a few mention "budget" so
// Page contents has something honest to find.
const PAGES = {
  '/docs/q4-roadmap': ['Product roadmap — Q4 planning', 'Docs', 'Themes for the quarter, owners for each milestone, and the dates we committed to in September.'],
  '/docs/budget-2027': ['Budget planning — 2027', 'Docs', 'Draft allocations by team. Numbers are placeholders until finance signs off.'],
  '/docs/standup': ['Team standup notes', 'Docs', 'Monday: finalize the budget numbers before the review. Tuesday: pair on the onboarding flow.'],
  '/docs/design-review': ['Design review notes', 'Docs', 'Feedback on the settings page layout, spacing and empty states.'],
  '/docs/release-notes': ['Release notes — version 2.4', 'Docs', 'Faster search, a new export option and several fixes.'],
  '/docs/offsite': ['Offsite planning notes', 'Docs', 'Venue shortlist, agenda draft and travel logistics.'],
  '/travel/lisbon': ['Lisbon trip itinerary', 'Travel', 'Three days in Alfama and Belém, with tram passes and a dinner booking.'],
  '/kitchen/soup': ['Roasted tomato soup recipe', 'Kitchen', 'Roast tomatoes, garlic and onion, then blend with stock and basil.'],
  '/news/weather': ['Weekend weather forecast', 'News', 'Sunny on Saturday, light rain on Sunday afternoon.'],
  '/docs/launch': ['Launch planning checklist', 'Docs', 'Announcement copy, support handoff and rollout stages.'],
  '/calendar/week': ['Team calendar — this week', 'Calendar', 'Planning on Monday, demos on Thursday, nothing booked on Friday.'],
  '/garden/spring': ['Garden planting plan', 'Garden', 'Tomatoes along the fence, herbs by the kitchen door.'],
  // Visited earlier, then closed: these exist only in the throwaway profile's history.
  '/docs/budget-review': ['Budget review — August', 'Docs', 'What we spent, what we expected, and what moved.'],
  '/home/budget-template': ['Household budget template', 'Home', 'Monthly categories with a simple running total.'],
};
const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --ink:#1f2937; --soft:#6b7280; --accent:#2563eb; --line:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --ink:#e2e8f0; --soft:#94a3b8; --accent:#93c5fd; --line:#334155; } }
  body { margin:0; font:16px/1.55 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:12px; padding:16px 40px; background:var(--card); border-bottom:1px solid var(--line); }
  header b { color:var(--accent); font-size:19px; } nav a { margin-left:20px; color:var(--soft); text-decoration:none; }
  main { max-width:920px; margin:36px auto; padding:0 24px; }
  h1 { margin:0 0 8px; font-size:32px; } p.lead { margin:0 0 24px; color:var(--soft); font-size:18px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; min-height:110px; }
  .card h2 { margin:0 0 6px; font-size:16px; } .card p { margin:0; color:var(--soft); font-size:14px; }`;
const CARDS = { Docs: ['Summary', 'Owners', 'Next steps'], Travel: ['Day one', 'Day two', 'Day three'], Kitchen: ['Ingredients', 'Method', 'To serve'],
  News: ['Saturday', 'Sunday', 'Next week'], Calendar: ['Monday', 'Thursday', 'Friday'], Garden: ['Fence bed', 'Kitchen door', 'Watering'], Home: ['Income', 'Bills', 'Savings'] };
function page(url) {
  const [title, section, body] = PAGES[url] || ['Start page', 'Docs', 'A blank starting point.'];
  const cards = (CARDS[section] || CARDS.Docs).map(name => `<section class="card"><h2>${name}</h2><p>Notes for ${name.toLowerCase()}.</p></section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>
    <header><b>${section}</b></header>
    <main><h1>${title}</h1><p class="lead">${body}</p><div class="grid">${cards}</div></main></body></html>`;
}
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page(req.url.split('?')[0])); });
// A fixed port keeps URLs in result rows identical between browsers and runs.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.STORE_PORT || 4310), '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const url = p => base + p;

// ---- Isolated 1280x800 display --------------------------------------------
const xvfb = spawn(process.env.XVFB_BINARY || path.join(scratch, 'browsers/usr/bin/Xvfb'),
  ['-displayfd', '3', '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, LD_LIBRARY_PATH: [path.join(scratch, 'browsers/usr/lib64'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
const cleanupDisplay = () => {
  if (xvfb.exitCode === null && !xvfb.killed) xvfb.kill();
};
process.once('exit', cleanupDisplay);
const displayNumber = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Xvfb timeout')), 10000);
  xvfb.once('exit', code => { clearTimeout(t); reject(new Error(`Xvfb exited ${code}`)); });
  xvfb.stdio[3].once('data', d => { clearTimeout(t); resolve(String(d).trim()); });
});
const env = { ...process.env, DISPLAY: `:${displayNumber}` };
process.env.DISPLAY = env.DISPLAY;
const keys = (list, title) => { for (let i = 0; ; i++) { try { return nativeKeys(env, list, title); } catch (e) { if (i > 10) throw e; execFileSync('sleep', ['0.2']); } } };
const KEYSYM = { ' ': 'space', '-': 'minus', '.': 'period' };
const typeText = (text, title) => keys([...text].map(c => KEYSYM[c] || c), title);
function grab(file) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${W}x${H}`, '-i', env.DISPLAY, '-frames:v', '1', file], { env });
}
// Park the pointer over plain page area so no hover state is captured.
const PARK = 'import ctypes; x=ctypes.CDLL("libX11.so.6"); t=ctypes.CDLL("libXtst.so.6"); x.XOpenDisplay.restype=ctypes.c_void_p; x.XOpenDisplay.argtypes=[ctypes.c_char_p]; x.XFlush.argtypes=[ctypes.c_void_p]; t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong]; d=x.XOpenDisplay(None); t.XTestFakeMotionEvent(d,-1,40,760,0); x.XFlush(d)';
const park = () => execFileSync('python3', ['-c', PARK], { env });
const shots = [];
async function shot(name, what, settle) {
  park();
  if (b.hideAutomation) await b.hideAutomation();
  await sleep(500);
  if (settle) await until(settle, `${name} settled`, 5000);
  // Two grabs 300 ms apart must match, so no frame is taken mid-transition.
  const file = path.join(OUT, `${name}.png`);
  const probe = path.join(directory, `${name}-probe.png`);
  for (let attempt = 0; ; attempt++) {
    grab(probe); await sleep(300); grab(file);
    const digest = f => createHash('sha256').update(execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 })).digest('hex');
    if (digest(probe) === digest(file)) break;
    if (attempt > 8) throw new Error(`${name}: screen never settled`);
  }
  shots.push({ file, what });
  console.log(`SHOT ${file} -- ${what}`);
}

// Rendered-state probes, run inside the real search frame. Only read, never drive.
const STATE = `const $ = id => document.getElementById(id); const shown = el => el && !el.hidden && el.getClientRects().length > 0;
  return { focus: document.activeElement?.id || null, mode: $('palette').dataset.mode, query: $('query').value, busy: $('results').getAttribute('aria-busy'),
    rows: [...document.querySelectorAll('.result')].map(r => ({ title: r.querySelector('.title')?.textContent, history: r.classList.contains('result-history'),
      snippet: r.querySelector('.snippet')?.textContent || null, badges: [...r.querySelectorAll('.badge')].map(b => b.textContent), checked: r.dataset.checked === 'true', active: r.dataset.active === 'true' })),
    menu: shown($('source-menu')), history: $('source-history').checked, content: $('source-content').checked, historyDisabled: $('source-history').disabled,
    contentDisabled: $('source-content').disabled, status: $('source-status').textContent, summary: $('source-summary').textContent,
    selection: $('selection-status').textContent, closeLabel: shown($('close-tabs')) ? $('close-tabs').textContent : null, count: $('result-count').textContent };`;
const rectOf = id => `const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`;

const provenance = { browser: BROWSER, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  treeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  extension: path.resolve(BROWSER === 'firefox' ? 'dist/firefox' : 'dist/chrome'), fixtures: base, display: `${W}x${H}`,
  notes: [BROWSER === 'firefox'
    ? "Firefox: native toolbar popup opened by WebDriver click on the toolbar button; palette/menu controls use XTest input."
    : "Chromium: native toolbar popup opened with chrome.action.openPopup(); the website-access button uses a Playwright click and the permission dialog uses XTest input."] };

// ---- Browser adapters -------------------------------------------------------
// Each adapter exposes: open(paths per window), seedHistory(paths), title(), ui(script),
// grantContent(), popup(scheme) -> { inPopup(script), screen(): {x,y} }, closePopup(), theme(scheme), quit().
async function chromiumAdapter() {
  const { chromium } = await import('playwright');
  const extension = path.resolve('dist/chrome');
  const id = [...createHash('sha256').update(extension).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  let context, worker, profile;
  async function launch(dark) {
    profile = await mkdtemp(path.join(directory, 'profile-'));
    // Pin the action to the toolbar the way the puzzle menu's pin does: the profile's own preference.
    await mkdir(path.join(profile, 'Default'), { recursive: true });
    await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ extensions: { pinned_extensions: [id] }, browser: { has_seen_welcome_page: true } }));
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM_BINARY || chromium.executablePath(), headless: false, env, viewport: null,
      // No "controlled by automated test software" infobar, and no forced light
      // page scheme: pages follow the browser's own (light or forced-dark) mode.
      ignoreDefaultArgs: ['--enable-automation'], colorScheme: dark ? 'dark' : 'light',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-position=0,0', `--window-size=${W},${H}`,
        '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', ...(dark ? ['--force-dark-mode'] : [])],
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    provenance.browserVersion = context.browser()?.version() || (await worker.evaluate(() => navigator.userAgent));
  }
  const api = (fn, arg) => worker.evaluate(fn, arg);
  const extOrigin = () => worker.url().replace(/\/background\.js$/, '');
  const searchUrl = () => `${extOrigin()}/search.html`;
  const front = () => context.pages().find(p => p.url() === activeUrl) || context.pages()[0];
  let activeUrl;
  const frame = () => { for (const p of context.pages()) { const f = p.frames().find(f => f.url() === searchUrl() && !f.name()); if (f) return f; } };
  const cdp = async () => context.newCDPSession(front());
  return {
    async start(dark = false) { await launch(dark); },
    // This host cannot run Chromium's sandbox, so Playwright's --no-sandbox
    // warning infobar appears; dismiss it with a real click on its close button.
    async dismissInfobar() {
      await front().bringToFront(); await sleep(500);
      const top = await front().evaluate(() => window.screenY + window.outerHeight - window.innerHeight);
      if (top > 100) { nativeClick(env, 1252, top - 28); await sleep(600); provenance.notes.push('Chromium: dismissed the --no-sandbox warning infobar with a native click on its close button (this host has no usable Chromium sandbox).'); }
    },
    async open(windows) {
      const [first, ...rest] = windows;
      const page = context.pages()[0];
      await page.goto(url(first[0]));
      for (const p of first.slice(1)) { const t = await context.newPage(); await t.goto(url(p)); }
      for (const set of rest) {
        await api(async ({ urls }) => { await chrome.windows.create({ url: urls, focused: false, left: 0, top: 0, width: 1280, height: 800 }); }, { urls: set.map(url) });
      }
      await until(async () => api(urls => chrome.tabs.query({}).then(t => urls.every(u => t.some(x => x.url === u && x.status === 'complete'))), windows.flat().map(url)), 'tabs loaded', 15000);
    },
    async focus(p) {
      activeUrl = url(p);
      await api(async u => { const t = (await chrome.tabs.query({})).find(t => t.url === u); await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(t.id, { active: true }); }, activeUrl);
      await front().bringToFront(); await sleep(400);
    },
    async seedHistory(paths) {
      const t = await context.newPage();
      for (const p of paths) { await t.goto(url(p)); await sleep(300); }
      await t.close();
      await until(() => api(us => Promise.all(us.map(u => chrome.history.getVisits({ url: u }))).then(v => v.every(x => x.length)), paths.map(url)), 'history seeded');
    },
    title: () => front().title(),
    windowTitle: async () => front().title(),
    async ui(script) { const f = frame(); if (!f) throw new Error('no search frame'); return f.evaluate(new Function(script)); },
    hasUi: () => Boolean(frame()),
    async grantContent() {
      const opt = await context.newPage();
      await opt.goto(`${extOrigin()}/options.html`);
      await opt.bringToFront();
      const read = () => opt.evaluate(() => ({ state: document.getElementById('content-access-state').textContent, message: document.getElementById('content-access-message').textContent }));
      await until(async () => (await read()).state !== 'Checking…', 'settings ready');
      for (const k of [['Return'], ['Tab', 'Return'], ['Shift_L', 'Tab', 'Return']]) {
        await opt.click('#content-access-allow');
        await sleep(1500); // The dialog's accept button is briefly disabled.
        keys(k);
        await until(async () => (await read()).message !== 'Waiting for your browser…', 'prompt answered', 5000).catch(() => {});
        if ((await read()).state === 'Allowed') break;
      }
      const granted = await api(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }));
      provenance.notes.push(`website access granted through Chromium's own permission dialog (native X keys): ${granted}`);
      await opt.close();
      return granted;
    },
    async popup() {
      await api(() => chrome.action.openPopup());
      const c = await cdp();
      let target;
      await until(async () => (target = (await c.send('Target.getTargets')).targetInfos.find(t => t.url === `${extOrigin()}/popup.html`)), 'action popup');
      // The popup is a separate target; evaluate in it over CDP Target.sendMessageToTarget.
      const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      let id = 0;
      const waiters = new Map();
      c.on('Target.receivedMessageFromTarget', e => { if (e.sessionId !== sid) return; const m = JSON.parse(e.message); waiters.get(m.id)?.(m); waiters.delete(m.id); });
      const call = (method, params) => new Promise((resolve, reject) => { const mid = ++id; waiters.set(mid, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        c.send('Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: mid, method, params }) }).catch(reject); });
      const inPopup = async script => (await call('Runtime.evaluate', { expression: `(() => { ${script} })()`, returnByValue: true })).result.value;
      await until(async () => (await inPopup('return document.querySelectorAll("#search-shortcut kbd").length')) === 3, 'popup shortcuts');
      return { inPopup, screen: () => inPopup('return { x: screenX, y: screenY }'), close: () => keys(['Escape']) };
    },
    async quit() { await context?.close(); },
  };
}

async function firefoxAdapter() {
  const { Builder, By } = await import('selenium-webdriver');
  const firefox = (await import('selenium-webdriver/firefox.js')).default;
  const UUID = 'a3906219-0180-4fa2-a2d8-a90270e6e501';
  const EXT = `moz-extension://${UUID}`;
  const SEARCH = `${EXT}/search.html`;
  process.env.TMPDIR = directory;
  const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
  const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
  const options = new firefox.Options().setBinary(process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox'))
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'tabvacuum@adlio': UUID }))
    .setPreference('browser.aboutwelcome.enabled', false)
    .setPreference('datareporting.policy.dataSubmissionPolicyBypassNotification', true)
    .setPreference('browser.tabs.firefox-view', false);
  if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) service.addArguments('--allow-system-access');
  else options.addArguments('-remote-allow-system-access');
  const LOCATE = `function locate(url) { const found = [];
    for (const win of Services.wm.getEnumerator('navigator:browser')) for (const b of win.gBrowser.browsers) { const top = b.browsingContext; if (!top) continue;
      for (const c of top.getAllBrowsingContextsInSubtree()) if (c !== top && c.currentURI?.spec === url && !c.name) found.push(c); }
    return found; }
    function actor(bc) { return bc.currentWindowGlobal.getActor('MarionetteCommands'); }
    function findTab(url) { for (const w of Services.wm.getEnumerator('navigator:browser')) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.currentURI.spec === url) return { w, t }; }
    const sp = Services.scriptSecurityManager.getSystemPrincipal();`;
  let driver;
  let focused = 'Mozilla Firefox';
  let mainHandle;
  const chrome = (s, ...a) => driver.executeScript(s, ...a);
  const chromeAsync = (body, ...a) => driver.executeAsyncScript(`${LOCATE} const done = arguments[arguments.length - 1]; (async () => { ${body} })().then(done, e => done({ error: String(e) }));`, ...a);
  const inBC = (finder, script) => chromeAsync(`const bc = (${finder})(...arguments); if (!bc) return { error: 'missing' };
    return actor(bc).sendQuery('MarionetteCommandsParent:executeScript', { script: arguments[arguments.length - 2], args: [], opts: {} });`, script);
  const loaded = urls => until(() => chrome(`${LOCATE} return arguments[0].every(u => { const f = findTab(u); return f && !f.t.hasAttribute('busy') && f.t.linkedBrowser.contentTitle; });`, urls), 'tabs loaded', 15000);
  return {
    async start() {
      driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
      await driver.manage().window().setRect({ x: 0, y: 0, width: W, height: H });
      await driver.installAddon(path.resolve('dist/firefox'), true);
      provenance.browserVersion = `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`;
      mainHandle = await driver.getWindowHandle();
      await driver.setContext('chrome');
      // Keep the action on the toolbar where users see it.
      await chrome('CustomizableUI.addWidgetToArea("tabvacuum_adlio-browser-action", "nav-bar");');
    },
    async open(windows) {
      // Same window setup as scripts/test-firefox.mjs: WebDriver opens the other
      // window first, then switches back, which leaves the main window active.
      const [first, ...rest] = windows;
      await driver.setContext('content');
      for (const set of rest) {
        await driver.switchTo().newWindow('window');
        await driver.get(url(set[0]));
        for (const p of set.slice(1)) { await driver.switchTo().newWindow('tab'); await driver.get(url(p)); }
      }
      await driver.switchTo().window(mainHandle);
      for (const p of first.slice(1)) { await driver.switchTo().newWindow('tab'); await driver.get(url(p)); }
      await driver.switchTo().window(mainHandle);
      await driver.get(url(first[0]));
      await driver.setContext('chrome');
      await loaded(windows.flat().map(url));
    },
    async focus(p) {
      // WebDriver's window switch is what makes Firefox treat the main window as
      // active; w.focus() alone does not without a window manager.
      await driver.switchTo().window(mainHandle);
      await chrome(`${LOCATE} const f = findTab(arguments[0]); f.w.focus(); f.w.gBrowser.selectedTab = f.t; f.w.gBrowser.selectedBrowser.focus();`, url(p));
      await sleep(400);
      // Raise that window on the X server too, by its own title: with no window
      // manager, Firefox's "most recent window" does not follow w.focus().
      focused = PAGES[p][0];
      keys(['Shift_L'], focused);
      await sleep(300);
    },
    async seedHistory(paths) {
      const urls = paths.map(url);
      await chromeAsync(`const w = Services.wm.getMostRecentWindow('navigator:browser');
        for (const u of arguments[0]) { const t = w.gBrowser.addTab(u, { triggeringPrincipal: sp, inBackground: true });
          await new Promise(r => { const check = () => (!t.hasAttribute('busy') && t.linkedBrowser.contentTitle ? r() : setTimeout(check, 100)); setTimeout(check, 200); });
          await new Promise(r => setTimeout(r, 300)); w.gBrowser.removeTab(t); }
        return true;`, urls);
      await until(async () => (await chromeAsync('for (const u of arguments[0]) if (!(await PlacesUtils.history.fetch(u))) return false; return true;', urls)) === true, 'history seeded');
    },
    title: async () => focused,
    async ui(script) { const r = await inBC(`() => locate(${JSON.stringify(SEARCH)})[0]`, script); if (r?.error) throw new Error(r.error); return r; },
    async hasUi() { return (await chromeAsync('return locate(arguments[0]).length;', SEARCH)) > 0; },
    async grantContent() {
      const OPT = `${EXT}/options.html`;
      // Settings opens in the main window, beside the fixture tabs.
      await chromeAsync(`const w = findTab(arguments[1]).w; w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: sp }); return true;`, OPT, url(MAIN[0]));
      await loaded([OPT]);
      const inOpt = s => inBC(`() => findTab(${JSON.stringify(OPT)})?.t.linkedBrowser.browsingContext`, s);
      const read = () => inOpt('const $ = id => document.getElementById(id); return { state: $("content-access-state").textContent, message: $("content-access-message").textContent };');
      await until(async () => (await read()).state !== 'Checking…', 'settings ready');
      keys(['Shift_L'], "Aaron's Tab Vacuum Settings");
      await sleep(300);
      const p = await inOpt(`const b = document.getElementById('content-access-allow'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
        return { x: mozInnerScreenX + r.left + r.width / 2, y: mozInnerScreenY + r.top + r.height / 2 };`);
      nativeClick(env, p.x, p.y);
      let target;
      await until(async () => (target = await chrome(`${LOCATE} const w = findTab(arguments[0]).w; const panel = w.PopupNotifications.panel;
        const n = panel.state === 'open' && [...panel.children].find(c => c.getAttribute('popupid') === 'addon-webext-permissions'); if (!n) return null;
        const r = n.button.getBoundingClientRect(); return { x: w.mozInnerScreenX + r.left + r.width / 2, y: w.mozInnerScreenY + r.top + r.height / 2 };`, OPT)), 'permission doorhanger', 6000);
      await sleep(600);
      nativeClick(env, target.x, target.y);
      await until(async () => (await read()).state === 'Allowed', 'allowed', 5000).catch(() => {});
      const granted = (await read()).state === 'Allowed';
      provenance.notes.push(`website access granted through Firefox's own permission doorhanger (native X click): ${granted}`);
      await chrome(`${LOCATE} const f = findTab(arguments[0]); f.w.gBrowser.removeTab(f.t);`, OPT);
      return granted;
    },
    async theme(scheme) {
      await chromeAsync(`const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await (await AddonManager.getAddonByID(arguments[0])).enable(); return true;`, `firefox-compact-${scheme}@mozilla.org`);
      await chrome('Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", arguments[0]);', scheme === 'dark' ? 0 : 1);
      await sleep(800);
    },
    // Which theme_icons image Firefox actually chose for the toolbar button.
    toolbarIcon: () => chrome(`const b = document.getElementById('tabvacuum_adlio-BAP'); const icon = b.icon || b.querySelector('.toolbarbutton-icon');
      const cs = getComputedStyle(icon); const r = icon.getBoundingClientRect();
      return { image: cs.listStyleImage, light: b.style.getPropertyValue('--webextension-toolbar-image-light'), dark: b.style.getPropertyValue('--webextension-toolbar-image-dark'),
        brighttext: document.documentElement.hasAttribute('lwt-toolbar-field-brighttext') || document.documentElement.hasAttribute('lwtheme-brighttext'),
        rect: { x: mozInnerScreenX + r.left, y: mozInnerScreenY + r.top, w: r.width, h: r.height } };`),
    async popup() {
      await chrome('gBrowser.selectedBrowser.focus();');
      await driver.findElement(By.id('tabvacuum_adlio-BAP')).click();
      const view = "() => document.querySelector('browser.webextension-popup-browser')?.browsingContext";
      const inPopup = s => inBC(`() => [...Services.wm.getEnumerator('navigator:browser')].map(w => w.document.querySelector('browser.webextension-popup-browser')).find(Boolean)?.browsingContext`, s);
      void view;
      await until(async () => (await inPopup('return document.querySelectorAll("#search-shortcut kbd").length')) === 3, 'popup');
      return { inPopup, screen: () => inPopup('return { x: mozInnerScreenX, y: mozInnerScreenY }'), close: () => keys(['Escape']) };
    },
    // WebDriver sessions stripe the address bar and show a robot icon. Hide that
    // automation-only indicator in browser chrome; extension UI is untouched.
    hideAutomation: () => chrome(`for (const w of Services.wm.getEnumerator('navigator:browser')) w.document.documentElement.removeAttribute('remotecontrol'); return true;`),
    async quit() { await driver?.quit(); },
  };
}

// ---- The five frames ---------------------------------------------------------
const MAIN = ['/docs/q4-roadmap', '/docs/budget-2027', '/docs/standup', '/docs/design-review', '/docs/release-notes', '/travel/lisbon', '/kitchen/soup', '/news/weather'];
const SECOND = ['/docs/launch', '/calendar/week', '/garden/spring', '/docs/offsite'];
const b = BROWSER === 'firefox' ? await firefoxAdapter() : await chromiumAdapter();
const report = [];
if (b.hideAutomation) provenance.notes.push('Firefox: the WebDriver remote-control address-bar stripes/robot were removed from browser chrome (documentElement remotecontrol attribute) before each grab; no extension UI was altered.');
const state = () => b.ui(STATE);
// until(), but a timeout records what the UI showed, for diagnosis.
async function need(fn, label, ms) {
  try { return await until(fn, label, ms); } catch (error) {
    grab(path.join(directory, `fail-${label.replace(/\W+/g, '-')}.png`));
    console.log('STATE', JSON.stringify(await state().catch(e => String(e))));
    throw error;
  }
}
async function openSearch(on) {
  await b.focus(on);
  keys(SEARCH_KEYS, await b.title());
  await until(() => b.hasUi(), 'search frame', 9000);
  await until(async () => (await state()).busy === 'false' && (await state()).focus === 'query', 'search ready');
}
async function closeSearch() {
  for (let i = 0; i < 4 && await b.hasUi(); i++) { keys(['Escape'], await b.title()); await sleep(400); }
}
async function clickInFrame(id) {
  // The frame's own screen offset plus the element's rect gives the real pixel to click.
  const p = await b.ui(`${rectOf(id).replace('return ', 'const c = ')}; return { x: (typeof mozInnerScreenX === 'number' ? mozInnerScreenX : screenX + (outerWidth - innerWidth)) + c.x, y: (typeof mozInnerScreenY === 'number' ? mozInnerScreenY : 0) + c.y };`);
  return p;
}
void clickInFrame;

try {
  await b.start();
  await b.open([MAIN, SECOND]);
  if (b.dismissInfobar) await b.dismissInfobar();
  await b.seedHistory(['/docs/budget-review', '/home/budget-template']);

  // 1. Cross-window query.
  await openSearch('/docs/q4-roadmap');
  typeText('plan', await b.title());
  await need(async () => { const s = await state(); return s.query === 'plan' && s.busy === 'false' && s.rows.some(r => r.badges.includes('Other window')); }, 'cross-window results');
  const s1 = await state();
  report.push({ shot: 1, rows: s1.rows.map(r => `${r.title} [${r.badges.join(', ')}]`) });
  await shot('01-search-across-windows', 'Search: "plan" finds tabs in this window and another window');
  await closeSearch();

  // 2. Toolbar menu with Sort expanded (light).
  if (b.theme) await b.theme('light');
  await b.focus('/docs/q4-roadmap');
  let pop = await b.popup();
  // A real pointer click on Sort tabs.
  const origin = await pop.screen();
  const sortAt = await pop.inPopup(rectOf('btn-sort'));
  nativeClick(env, origin.x + sortAt.x, origin.y + sortAt.y);
  await until(async () => (await pop.inPopup('return !document.getElementById("sort-options").hidden && document.querySelectorAll("#sort-options button").length')) === 7, 'sort expanded');
  // Move the pointer off the buttons so no hover state is captured.
  report.push({ shot: 2, popup: await pop.inPopup(`return { title: document.querySelector('.logo').textContent, sort: [...document.querySelectorAll('#sort-options button')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
    overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('button')].some(b => b.getClientRects().length && b.scrollWidth > b.clientWidth),
    bg: getComputedStyle(document.body).backgroundColor, size: [innerWidth, innerHeight] };`) });
  if (b.toolbarIcon) report.push({ shot: 2, toolbarIcon: await b.toolbarIcon() });
  await shot('02-toolbar-menu-sort', 'Toolbar menu with Sort tabs expanded to all seven orders');
  pop.close(); await sleep(800);
  // Toolbar evidence with the menu closed: the action icon at rest on the light toolbar.
  park(); if (b.hideAutomation) await b.hideAutomation(); await sleep(400);
  grab(path.join(directory, 'toolbar-light.png'));

  // 3. Multi-select with checks and a count.
  await openSearch('/docs/q4-roadmap');
  const title3 = await b.title();
  typeText('notes', title3);
  await need(async () => { const s = await state(); return s.query === 'notes' && s.busy === 'false' && s.rows.length >= 4; }, 'notes results');
  keys(['Tab'], title3); await sleep(300);
  keys(['m'], title3); await until(async () => (await state()).mode === 'select', 'select mode');
  for (const k of ['space', 'j', 'space', 'j', 'j', 'space', 'k']) { keys([k], title3); await sleep(250); }
  await until(async () => (await state()).rows.filter(r => r.checked).length === 3, 'three checked');
  const s3 = await state();
  report.push({ shot: 3, mode: s3.mode, selection: s3.selection, close: s3.closeLabel, rows: s3.rows.map(r => `${r.checked ? '[x]' : '[ ]'} ${r.title}`) });
  await shot('03-select-multiple', 'Select multiple: three tabs checked, ready to close together');
  await closeSearch();

  // 4. History + Page contents, with website access granted inside this throwaway profile.
  const granted = await b.grantContent();
  if (!granted) throw new Error('website access was not granted');
  await openSearch('/docs/q4-roadmap');
  const title4 = await b.title();
  keys(['Shift_L', 'Tab'], title4);
  await until(async () => (await b.ui('return document.activeElement?.id')) === 'search-in', 'search-in focus');
  keys(['Return'], title4);
  await until(async () => (await state()).menu && !(await state()).contentDisabled, 'source menu');
  // Space toggles the focused checkbox; Tab walks the menu in order: History, then Page contents.
  keys(['Tab'], title4); await sleep(200);
  keys(['space'], title4); await sleep(200);
  keys(['Tab'], title4); await sleep(200);
  keys(['space'], title4);
  await need(async () => { const s = await state(); return s.history && s.content; }, 'both sources on');
  // Close the menu (Escape steps back once) and return to the query.
  keys(['Escape'], title4);
  await until(async () => !(await state()).menu, 'menu closed');
  if ((await b.ui('return document.activeElement?.id')) !== 'query') keys(['Tab'], title4);
  await until(async () => (await b.ui('return document.activeElement?.id')) === 'query', 'query focus');
  typeText('budget', title4);
  await need(async () => { const s = await state(); return s.query === 'budget' && s.busy === 'false' && s.rows.some(r => r.history) && s.rows.some(r => r.snippet); }, 'history and contents results', 15000);
  // Highlight the first history row so the list scrolls History into view
  // without clipping the open-tab rows above it.
  const firstHistory = (await state()).rows.findIndex(r => r.history);
  for (let i = 0; i < firstHistory; i++) { keys(['Down'], title4); await sleep(200); }
  await need(async () => (await state()).rows[firstHistory]?.active, 'history row highlighted');
  const s4 = await state();
  report.push({ shot: 4, summary: s4.summary, status: s4.status, rows: s4.rows.map(r => `${r.history ? 'H ' : ''}${r.title}${r.snippet ? ` -- "${r.snippet}"` : ''}`) });
  await shot('04-history-and-page-contents', 'Search in History and Page contents: past pages and text matches with snippets');
  await closeSearch();

  // 5. Cleanup/merge menu in the alternate (dark) theme.
  if (b.theme) {
    await b.theme('dark');
  } else {
    // Chromium: relaunch with the browser's own dark mode.
    await b.quit();
    await b.start(true);
    await b.open([MAIN, SECOND]);
    await b.dismissInfobar();
  }
  await b.focus('/news/weather');
  pop = await b.popup();
  await pop.inPopup('document.activeElement?.blur(); return true;');
  report.push({ shot: 5, popup: await pop.inPopup(`return { bg: getComputedStyle(document.body).backgroundColor, buttons: [...document.querySelectorAll('main button')].filter(b => b.getClientRects().length).map(b => b.textContent.replace(/\\s+/g, ' ').trim()) };`) });
  if (b.toolbarIcon) report.push({ shot: 5, toolbarIcon: await b.toolbarIcon() });
  await shot('05-cleanup-dark', 'Toolbar menu in dark theme: merge windows and clean up duplicates, stale and blank tabs');
  pop.close(); await sleep(800);
  park(); if (b.hideAutomation) await b.hideAutomation(); await sleep(400);
  grab(path.join(directory, 'toolbar-dark.png'));
  if (b.toolbarIcon) report.push({ shot: 'toolbar-dark-rest', toolbarIcon: await b.toolbarIcon() });

  provenance.shots = shots.map(s => ({ file: path.relative(process.cwd(), s.file), what: s.what }));
  provenance.observed = report;
  await writeFile(path.join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await b.quit().catch(() => {});
  cleanupDisplay();
  process.removeListener('exit', cleanupDisplay);
  server.close();
}
