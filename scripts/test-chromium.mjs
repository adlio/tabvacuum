// Real Chromium + the built extension in a throwaway profile on an isolated X
// display. The search shortcut is a native X key; the dialog is the real
// injected closed-shadow modal and its extension iframe, reached through
// Playwright's frame tree (the page's own DOM APIs cannot pierce it).
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// --acceptance-only runs setup plus the privacy/lifecycle checks, skipping the main flow.
// --closing-only runs setup plus the selection/closing flows (scripts/test-search-closing.mjs).
const ACCEPTANCE_ONLY = process.argv.includes('--acceptance-only');
const EXPANDED_ONLY = process.argv.includes('--expanded-only');
// --expanded-only runs setup plus the History/Contents flows (scripts/test-expanded-search.mjs).
const CLOSING_ONLY = EXPANDED_ONLY || process.argv.includes('--closing-only');
import { runExpandedSearch } from './test-expanded-search.mjs';
const { scratch, directory } = await outputDir('tabvacuum-chromium');
const profile = await mkdtemp(path.join(directory, 'profile-'));
const site = await startSite();
const { base } = site;
const display = await startDisplay(scratch);
const env = display.env;
const { check, finish } = checker();
const video = recorder(env, path.join(directory, 'search-flow.mp4'));
const shots = [];
let context;

try {
  const extension = path.resolve('dist/chrome');
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_BINARY || chromium.executablePath(),
    headless: false, env, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--window-position=0,0', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'],
  });
  // Reassigned when the acceptance checks reload or stop the service worker.
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extOrigin = worker.url().replace(/\/background\.js$/, '');
  const searchUrl = `${extOrigin}/search.html`;
  const page = context.pages()[0];
  await page.goto(`${base}/current`);
  const ids = await worker.evaluate(async base => {
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    const other = await chrome.windows.create({ url: base + '/remote', focused: false, left: 900, top: 600, width: 500, height: 400 });
    const previous = await chrome.tabs.create({ url: base + '/previous', windowId: current.windowId, active: false });
    const fuzzy = await chrome.tabs.create({ url: base + '/fuzzy', windowId: current.windowId, active: false });
    await chrome.windows.update(current.windowId, { focused: true });
    return { current: current.id, windowId: current.windowId, remote: other.tabs[0].id, remoteWindow: other.id, previous: previous.id, fuzzy: fuzzy.id };
  }, base);
  const tab = id => worker.evaluate(id => chrome.tabs.get(id), id);
  const win = id => worker.evaluate(id => chrome.windows.get(id), id);
  await until(async () => (await tab(ids.remote)).status === 'complete', 'remote loaded');

  const commands = await worker.evaluate(() => chrome.commands.getAll());
  check(commands.find(c => c.name === 'search-tabs')?.shortcut === 'Ctrl+Shift+Period', 'search default registered by Chromium');

  // --- helpers over the real frame tree -------------------------------------
  const overlayFrame = p => p.frames().find(f => f.url() === searchUrl);
  const hosts = p => p.evaluate(() => document.querySelectorAll('tabvacuum-search').length);
  const fallbackPage = () => context.pages().find(p => p.url().startsWith(`${searchUrl}?`));
  const ready = f => until(() => f.evaluate(() => document.getElementById('results')?.getAttribute('aria-busy') === 'false'), 'search results');
  const rows = f => f.evaluate(() => [...document.querySelectorAll('.result .title')].map(t => t.textContent));
  const selected = f => f.evaluate(() => document.querySelector('.result[data-active="true"] .title')?.textContent);
  const windowTitle = async p => `${(await p.title()) || p.url()} - Chromium`;
  async function shortcut(p) {
    await p.bringToFront();
    await native(p, SEARCH_KEYS);
  }
  // The X window title trails document.title slightly; retry the lookup briefly.
  async function native(p, keys) {
    for (let attempt = 0; ; attempt++) {
      try { return nativeKeys(env, keys, await windowTitle(p)); } catch (error) { if (attempt > 10) throw error; await sleep(200); }
    }
  }
  async function openOverlay(p) {
    await shortcut(p);
    let frame;
    await until(() => (frame = overlayFrame(p)), 'overlay frame');
    await ready(frame);
    return frame;
  }
  // Keys go to whatever frame the browser has focused, as a user's would.
  async function type(p, text) {
    await p.keyboard.press('Control+a');
    await p.keyboard.press('Backspace');
    if (text) await p.keyboard.type(text);
    await sleep(80);
  }
  const closed = p => until(async () => (await hosts(p)) === 0 && !overlayFrame(p), 'overlay removed');
  // Incognito tabs are outside Playwright's context; evaluate there over raw CDP.
  const cdp = await context.browser().newBrowserCDPSession();
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  let seq = 0;
  async function evalIn(targetId, expression) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
    const id = ++seq;
    try {
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', on); reject(new Error('CDP evaluate timeout')); }, 5000);
        function on(event) {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== id) return;
          clearTimeout(timer);
          cdp.off('Target.receivedMessageFromTarget', on);
          resolve(message);
        }
        cdp.on('Target.receivedMessageFromTarget', on);
      });
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
      const message = await reply;
      if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text);
      return message.result?.result?.value;
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }
  // Incognito access is granted only in this throwaway profile, through
  // chrome://extensions' own settings API (developer mode is required there to
  // keep a command-line unpacked extension enabled on reload). The settings
  // page's own message wakes the reloaded worker; the returned extension page
  // stays open as a privileged evaluator.
  async function allowIncognito() {
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    const previousWorker = worker;
    await manager.evaluate(async id => {
      const call = (name, arg) => new Promise(resolve => chrome.developerPrivate[name](arg, resolve));
      await call('updateProfileConfiguration', { inDeveloperMode: true });
      await call('updateExtensionConfiguration', { extensionId: id, incognitoAccess: true });
    }, new URL(extOrigin).host);
    await sleep(1500);
    const extPage = await context.newPage();
    await extPage.goto(`${extOrigin}/options.html`).catch(() => {});
    await until(() => (worker = context.serviceWorkers().find(w => w !== previousWorker && w.url().startsWith(extOrigin))), 'reloaded worker', 15000);
    if (!extPage.url().startsWith(extOrigin)) await extPage.goto(`${extOrigin}/options.html`);
    await manager.close();
    return extPage;
  }
  async function shot(name, what) {
    if (name === 'light-two-results' || name === 'dark-two-results') {
      // Buttons transition their background (0.15 s) after a theme switch.
      await until(() => overlayFrame(page).evaluate(() => {
        const body = getComputedStyle(document.body).backgroundColor;
        return [...document.querySelectorAll('.action')].every(b => getComputedStyle(b).backgroundColor === body);
      }), 'action backgrounds settled', 3000).catch(() => {});
      const contrast = await overlayFrame(page).evaluate(paletteContrast);
      check(contrast.passes, `${name}: text contrast meets 4.5:1`, contrast);
    }
    const file = path.join(directory, `${name}.png`);
    await sleep(400);
    captureDisplay(env, file);
    shots.push({ file, what });
  }
  async function frameBox(p, f) {
    const box = await (await f.frameElement()).boundingBox();
    // The visible viewport, excluding page scrollbars.
    const view = await p.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    return { box, view, dx: Math.abs(box.x + box.width / 2 - view.w / 2), dy: Math.abs(box.y + box.height / 2 - view.h / 2) };
  }
  // Tokens live only in the extension's session storage; compare there, never print.
  async function hostLeaks(p, words) {
    const dump = await p.evaluate(() => {
      const parts = [document.documentElement.outerHTML, location.href, document.title, document.cookie];
      for (const el of document.querySelectorAll('*')) for (const a of el.attributes) parts.push(a.value);
      try { parts.push(JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })); } catch { /* opaque */ }
      parts.push(Object.keys(window).join(' '));
      return parts.join('\n');
    });
    const tokens = await worker.evaluate(async dump => {
      const sessions = (await chrome.storage.session.get('search.sessions'))['search.sessions'] || {};
      const keys = Object.keys(sessions);
      return { count: keys.length, leaked: keys.some(t => dump.includes(t)) };
    }, dump);
    return { tokens, words: words.filter(w => dump.includes(w)) };
  }

  // Adapter for the shared selection/closing flows. Disposable tabs and windows
  // are made with chrome.tabs/chrome.windows in this throwaway profile only;
  // the removal log is chrome.tabs.onRemoved, in order.
  const ORIGIN = `${base}/current`;
  // Privileged chrome.* evaluator; the closing suite swaps in a dedicated extension page.
  let api = (fn, arg) => worker.evaluate(fn, arg);
  const ui = { kind: 'overlay', page };
  const searchFrame = () => {
    for (const p of context.pages()) {
      const f = p.frames().find(f => f.url() === searchUrl && !f.name());
      if (f) return f;
    }
  };
  const uiTarget = () => (ui.kind === 'window' ? fallbackPage() : searchFrame());
  const uiPage = () => (ui.kind === 'window' ? fallbackPage() : ui.page);
  const windowIds = new Map([['origin', ids.windowId]]);
  async function nativeTo(keys, title) {
    title ??= ui.kind === 'window' ? 'Search tabs' : await ui.page.title();
    for (let attempt = 0; ; attempt++) {
      try { return nativeKeys(env, keys, title); } catch (error) { if (attempt > 10) throw error; await sleep(200); }
    }
  }
  const loaded = urls => until(() => api(urls => chrome.tabs.query({}).then(tabs =>
    urls.every(url => tabs.some(t => t.url === url && t.status === 'complete' && t.title))), urls), 'fixture tabs loaded', 15000);
  function viewportLayout(name, width, height, shotName) {
    let host;
    return {
      name, shot: shotName,
      async enter() {
        host = await context.newPage();
        await host.setViewportSize({ width, height });
        const url = `${base}/keep/layout-${width}x${height}`;
        await host.goto(url);
        await closing.focus(url);
      },
      async exit() { await host?.close(); await closing.focus(ORIGIN); },
    };
  }
  const closing = {
    check, base, originUrl: ORIGIN,
    ui: (body, arg) => uiTarget().evaluate(`(async arg => { ${body} })(${JSON.stringify(arg ?? null)})`),
    keys: keys => nativeTo(keys),
    burst: async keys => nativeSequence(env, keys, ui.kind === 'window' ? 'Search tabs' : await ui.page.title()),
    async hold(keysym, ms) {
      const title = ui.kind === 'window' ? 'Search tabs' : await ui.page.title();
      for (let attempt = 0; ; attempt++) {
        try { return nativeHold(env, keysym, ms, title); } catch (error) { if (attempt > 10) throw new Error(redact(error.stderr?.toString() || error.message)); await sleep(200); }
      }
    },
    async type(text) {
      const focus = await uiTarget().evaluate(() => document.activeElement?.id);
      if (focus !== 'query') throw new Error(`type() needs the query focused, not ${focus}`);
      const { keyboard } = uiPage();
      await keyboard.press('Control+a');
      await keyboard.press('Backspace');
      if (text) await keyboard.type(text);
      await sleep(150);
    },
    // Playwright's real pointer input at the element's position.
    click: selector => uiTarget().click(selector),
    async open() {
      await ui.page.bringToFront();
      await nativeTo(SEARCH_KEYS, await ui.page.title());
      let kind;
      await until(() => {
        if (ui.page.frames().some(f => f.url() === searchUrl && !f.name())) return (kind = 'overlay');
        if (fallbackPage()) return (kind = 'window');
      }, 'search UI', 9000).catch(() => {});
      if (kind) {
        ui.kind = kind;
        await ready(uiTarget());
      }
      return kind;
    },
    uiCount: async () => ({
      overlays: context.pages().filter(p => p.frames().some(f => f.url() === searchUrl && !f.name())).length,
      windows: context.pages().filter(p => p.url().startsWith(`${searchUrl}?`)).length,
    }),
    // Each search UI with its host tab: the page holding the overlay frame, or the window itself.
    async searchUIs() {
      const out = [];
      for (const p of context.pages()) {
        if (p.url().startsWith(`${searchUrl}?`)) { out.push({ kind: 'window', url: null, window: null, page: p }); continue; }
        if (!p.frames().some(f => f.url() === searchUrl && !f.name())) continue;
        const windowId = await api(url => chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === url)?.windowId), p.url());
        const key = [...windowIds].find(([, id]) => id === windowId)?.[0] ?? null;
        out.push({ kind: 'overlay', url: p.url(), window: key, page: p });
      }
      // The Playwright page stays non-enumerable so check details can serialize the list.
      return out.map(({ page: p, ...ui }) => Object.defineProperty(ui, 'page', { value: p }));
    },
    retarget(target) { ui.kind = target.kind; if (target.kind === 'overlay') ui.page = target.page; },
    sessions: () => api(async () => Object.keys((await chrome.storage.session.get('search.sessions'))['search.sessions'] || {}).length),
    async createWindow(key, urls) {
      windowIds.set(key, await api(urls => chrome.windows.create({ url: urls, left: 0, top: 0, width: 1280, height: 900, focused: true })
        .then(w => w.id), urls));
      await loaded(urls);
    },
    async addTab(key, url, { pinned = false } = {}) {
      await api(({ windowId, url, pinned }) => chrome.tabs.create({ windowId, url, pinned, active: false }).then(() => true),
        { windowId: windowIds.get(key), url, pinned });
      await loaded([url]);
    },
    exists: url => api(url => chrome.tabs.query({}).then(tabs => tabs.some(t => t.url === url)), url),
    windowAlive: key => api(id => chrome.windows.get(id).then(() => true, () => false), windowIds.get(key)),
    async focus(url) {
      await api(async url => {
        const tab = (await chrome.tabs.query({})).find(t => t.url === url);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }, url);
      await until(() => (ui.page = context.pages().find(p => p.url() === url)), `page for ${url.slice(0, 40)}`, 5000);
      await ui.page.bringToFront();
      await sleep(300);
    },
    activeUrl: () => api(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.url)),
    startRemovals: () => api(() => { globalThis.tvRemoved.length = 0; }),
    // Extension pages (the fallback search window's own tab) are not browsing tabs.
    removed: async () => (await api(() => globalThis.tvRemoved)).filter(url => !url.startsWith(extOrigin)),
    multiSelected: () => api(() => chrome.tabs.query({ highlighted: true }).then(tabs => tabs.length)),
    tabCount: () => api(() => chrome.tabs.query({ windowType: 'normal' }).then(tabs => tabs.length)),
    scheme: async value => uiPage()?.emulateMedia({ colorScheme: value }),
    async shot(name, what) {
      const file = path.join(directory, `${name}.png`);
      await sleep(400);
      captureDisplay(env, file);
      shots.push({ file, what: `Chromium: ${what}` });
    },
    modalFocus: async () => (await searchFrame().evaluate(() => document.hasFocus())) &&
      (await page.evaluate(() => document.activeElement?.localName)) === 'tabvacuum-search',
    layouts: [
      viewportLayout('Chromium narrow 320x640', 320, 640, 'selection-narrow'),
      viewportLayout('Chromium low height 1280x300', 1280, 300, 'selection-low'),
      viewportLayout('Chromium narrow low height 320x300', 320, 300),
    ],
    record: file => recorder(env, path.join(directory, file)),
    async cleanup(urls, keys) {
      await api(async ({ urls, windows }) => {
        for (const id of windows) await chrome.windows.remove(id).catch(() => {});
        const doomed = (await chrome.tabs.query({})).filter(t => urls.includes(t.url)).map(t => t.id);
        if (doomed.length) await chrome.tabs.remove(doomed).catch(() => {});
      }, { urls, windows: keys.map(k => windowIds.get(k)).filter(Number.isInteger) });
      await sleep(500);
    },
  };

  if (!ACCEPTANCE_ONLY && !CLOSING_ONLY) {
    // --- shortcut → centered modal over the real page --------------------------
    await page.bringToFront();
    await page.focus('#page-input');
    let frame = await openOverlay(page);
    check(await hosts(page) === 1, 'shortcut injects one dialog host');
    check(!frame.url().includes('?') && !frame.url().includes('#'), 'overlay iframe URL carries no token', frame.url());
    check(await frame.evaluate(() => document.activeElement?.id === 'query' && document.hasFocus()), 'query focused inside frame');
    const shownRows = await rows(frame);
    check(shownRows.at(-1) === TITLES['/current'], 'empty query current-last', shownRows);
    check(shownRows.includes(TITLES['/remote']), 'all-windows results by default', shownRows);
    const geometry = await frameBox(page, frame);
    check(geometry.dx <= 2 && geometry.dy <= 2, 'dialog centered in viewport', geometry);
    check(Math.round(geometry.box.width) === Math.min(640, geometry.view.w - 48), 'dialog uses 640px width on desktop', geometry);
    const isolation = await page.evaluate(() => {
      const host = document.querySelector('tabvacuum-search');
      // Shadow-tree frames are not exposed through window.frames at all.
      let doc = window.frames.length ? undefined : 'no-window-reference';
      for (let i = 0; i < window.frames.length; i++) {
        try { doc = window.frames[i].document.body.innerText; } catch (e) { doc = e.name; }
      }
      return { shadow: host?.shadowRoot, text: host?.textContent, children: host?.children.length, doc };
    });
    check(isolation.shadow === null && isolation.text === '' && isolation.children === 0, 'page sees only an empty closed host', isolation);
    check(['SecurityError', 'no-window-reference'].includes(isolation.doc), 'page cannot read cross-origin result document', isolation.doc);

    await page.keyboard.press('ArrowDown');
    check(await selected(frame) === shownRows[1], 'ArrowDown moves highlight in frame');
    check((await tab(ids.current)).active && page.url() === `${base}/current`, 'arrow does not switch tabs');

    await type(page, 'roadmap');
    check(await selected(frame) === TITLES['/current'], 'typed exact: current tab can be first');
    check((await rows(frame)).includes(TITLES['/fuzzy']), 'fuzzy match listed below exact', await rows(frame));
    await type(page, 'checklist');
    check(await selected(frame) === TITLES['/remote'], 'query reaches frame for leak check');
    const leaks = await hostLeaks(page, ['checklist', TITLES['/remote'], TITLES['/fuzzy'], TITLES['/previous']]);
    check(leaks.tokens.count === 1 && !leaks.tokens.leaked, 'launch token absent from host DOM/URL/storage', leaks.tokens);
    check(leaks.words.length === 0, 'query and other tab titles absent from host DOM', leaks.words);
    await type(page, 'raodmap');
    check(await selected(frame) === TITLES['/current'], 'typo tolerance');

    // Native Tab / Shift+Tab walk query -> results -> buttons -> query inside the modal.
    ui.kind = 'overlay';
    ui.page = page;
    await runTabCycle(closing, 'overlay');

    await type(page, 'project');
    await until(async () => (await rows(frame)).length === 2, 'two project matches', 3000).catch(() => {});
    check((await rows(frame)).length === 2, 'two results for screenshot query', await rows(frame));
    await page.emulateMedia({ colorScheme: 'light' });
    check(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)', 'light theme in frame');
    await shot('light-two-results', 'Chromium full 1280x900 X display: real page + native-shortcut overlay, light, query "project"');
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(() => frame.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'dark in frame', 3000).catch(() => {});
    check(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(28, 28, 31)', 'dark theme in frame',
      await frame.evaluate(() => getComputedStyle(document.body).backgroundColor));
    await shot('dark-two-results', 'Chromium full 1280x900 X display: same overlay with prefers-color-scheme dark emulated on the tab');
    await page.emulateMedia({ colorScheme: null });

    // Reopen while open: still one dialog, now a fresh session.
    await shortcut(page);
    await sleep(1200);
    frame = overlayFrame(page);
    check(await hosts(page) === 1 && page.frames().filter(f => f.url() === searchUrl).length === 1, 'reopen does not duplicate dialog');
    if (frame) await ready(frame);

    await type(page, 'zzzzzzzz');
    check((await rows(frame)).length === 0, 'empty-result state');
    await page.keyboard.press('Enter');
    await sleep(200);
    check((await tab(ids.current)).active && await hosts(page) === 1, 'Enter without results does nothing');
    await page.keyboard.press('Escape');
    await closed(page);
    check(page.url() === `${base}/current` && (await tab(ids.current)).active, 'Escape keeps same page and tab');
    check(await page.evaluate(() => document.hasFocus() && document.activeElement?.id === 'page-input'), 'Escape restores page focus',
      await page.evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement?.id })));

    // Backdrop click dismisses.
    frame = await openOverlay(page);
    await page.mouse.click(8, 8);
    await closed(page).then(() => check(true, 'backdrop click dismisses'), e => check(false, 'backdrop click dismisses', e.message));

    // Enter switches to another window's tab and closes the overlay.
    frame = await openOverlay(page);
    await type(page, 'release');
    check(await selected(frame) === TITLES['/remote'], 'other-window match selected');
    await page.keyboard.press('Enter');
    await until(async () => (await win(ids.remoteWindow)).focused && (await tab(ids.remote)).active, 'remote focus')
      .then(() => check(true, 'Enter focuses target tab and its window'), e => check(false, 'Enter focuses target tab and its window', e.message));
    await closed(page).then(() => check(true, 'overlay closes after activation'), e => check(false, 'overlay closes after activation', e.message));
    await worker.evaluate(ids => Promise.all([chrome.tabs.update(ids.current, { active: true }), chrome.windows.update(ids.windowId, { focused: true })]), ids);

    // Narrow viewport (320 CSS px, emulated on a separate tab).
    const narrow = await context.newPage();
    await narrow.setViewportSize({ width: 320, height: 640 });
    await narrow.goto(`${base}/previous`);
    const narrowFrame = await openOverlay(narrow);
    const small = await frameBox(narrow, narrowFrame);
    check(Math.round(small.box.width) === 272 && small.dx <= 2 && small.dy <= 2, 'narrow 320px: dialog fits and is centered', small);
    check(await narrowFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow 320px: no horizontal overflow');
    await narrow.keyboard.type('release');
    check(await narrowFrame.evaluate(() => {
      // The visible (search-mode) group's last hint is Esc Close; other groups are hidden.
      const close = [...document.querySelectorAll('#help .hint-group:not([hidden]) .hint')].at(-1).getBoundingClientRect();
      const footer = document.querySelector('footer').getBoundingClientRect();
      const badge = document.querySelector('.badge:not(.badge-match)');
      return close.right <= footer.right && close.width > 0 && badge?.textContent === 'Other window' && getComputedStyle(badge).display !== 'none';
    }), 'narrow 320px: close hint and other-window context remain visible');
    await shot('narrow', 'Chromium actual extension palette at a 320 CSS px emulated tab viewport');
    await narrow.keyboard.press('Escape');
    await closed(narrow);
    await narrow.close();

    // Page CSS cannot restyle or hide the dialog.
    const loud = await context.newPage();
    await loud.goto(`${base}/hostile-css`);
    const loudFrame = await openOverlay(loud);
    const loudBox = await frameBox(loud, loudFrame);
    const loudStyle = await loudFrame.evaluate(() => getComputedStyle(document.querySelector('.title')).fontSize);
    check(loudBox.dx <= 2 && Math.round(loudBox.box.width) === 640 && loudStyle === '14px', 'page CSS does not reach dialog', { loudBox, loudStyle });
    await loud.keyboard.press('Escape');
    await closed(loud);

    // An iframe the page adds itself gets nothing without a valid launch.
    const rogueHost = await context.newPage();
    await rogueHost.goto(`${base}/embed`);
    await rogueHost.evaluate(url => new Promise(resolve => {
      const f = document.createElement('iframe');
      f.id = 'page-made';
      f.src = url;
      f.addEventListener('load', () => { f.contentWindow.postMessage({ type: 'tabvacuum:init', token: 'A'.repeat(43) }, '*'); resolve(); });
      document.body.append(f);
    }), searchUrl);
    await sleep(5600); // Past the frame's 5 s init timeout.
    const rogue = rogueHost.frames().find(f => f.url() === searchUrl);
    const rogueState = rogue && await rogue.evaluate(() => ({
      rows: document.querySelectorAll('.result').length, state: document.getElementById('message').dataset.state,
    }));
    check(rogue && rogueState.rows === 0 && rogueState.state === 'error', 'page-made iframe without launch gets no tabs', rogueState);
    await rogueHost.close();
    await loud.close();

    // Restrictive page CSP: usable search (overlay or fallback window), never a blank modal.
    const locked = await context.newPage();
    await locked.goto(`${base}/csp`);
    await shortcut(locked);
    let cspMode;
    await until(async () => {
      const f = overlayFrame(locked);
      if (f && await f.evaluate(() => document.querySelectorAll('.result').length > 0).catch(() => false)) return (cspMode = 'overlay');
      const fb = fallbackPage();
      if (fb && await fb.evaluate(() => document.querySelectorAll('.result').length > 0).catch(() => false)) return (cspMode = 'window');
    }, 'CSP page search', 9000).catch(() => {});
    check(Boolean(cspMode), 'restrictive CSP page still gets working search', cspMode);
    if (cspMode === 'window') check(await hosts(locked) === 0, 'CSP fallback leaves no blank modal on page');
    console.log(`INFO CSP page search mode: ${cspMode}`);
    if (cspMode === 'overlay') { await locked.keyboard.press('Escape'); await closed(locked); }
    else if (cspMode === 'window') { await fallbackPage().keyboard.press('Escape'); await until(() => !fallbackPage(), 'CSP fallback closed'); }
    await locked.close();

    // Browser-internal pages get the separate extension window.
    for (const internal of ['chrome://settings/', 'about:blank']) {
      const inner = await context.newPage();
      await inner.goto(internal);
      const innerId = (await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true })))[0].id;
      await shortcut(inner);
      let fb;
      try {
        await until(() => (fb = fallbackPage()), `${internal} fallback window`, 8000);
        await ready(fb);
        const url = fb.url();
        const info = await worker.evaluate(async url => {
          const [t] = await chrome.tabs.query({ url });
          const w = await chrome.windows.get(t.windowId);
          return { type: w.type, width: w.width, focused: w.focused };
        }, url);
        check(/\?token=[A-Za-z0-9_-]{43}$/.test(url) && info.type === 'popup', `${internal}: separate popup search window`, info);
        check(await fb.evaluate(() => document.activeElement?.id) === 'query' && (await rows(fb)).length > 0, `${internal}: window search usable`);
        await fb.keyboard.press('Escape');
        await until(() => !fallbackPage(), 'fallback closed');
        check((await tab(innerId)).active && (await win((await tab(innerId)).windowId)).focused, `${internal}: Escape returns to origin tab`);
      } catch (error) {
        check(false, `${internal}: fallback window`, error.message);
      }
      await inner.close();
    }

    // Toolbar menu → Search tabs, through the real action popup page.
    await page.bringToFront();
    const cdp = await context.browser().newBrowserCDPSession();
    await worker.evaluate(id => chrome.action.openPopup({ windowId: id }), ids.windowId);
    let popupTarget;
    await until(async () => (popupTarget = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `${extOrigin}/popup.html`)), 'action popup');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: false });
    let popupRequest = 0;
    const popupCall = (method, params) => new Promise((resolve, reject) => {
      const id = ++popupRequest;
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error('Popup CDP timeout')); }, 5000);
      function receive(event) {
        if (event.sessionId !== sessionId) return;
        const response = JSON.parse(event.message);
        if (response.id !== id) return;
        clearTimeout(timer);
        cdp.off('Target.receivedMessageFromTarget', receive);
        if (response.error || response.result?.exceptionDetails) reject(new Error('Popup evaluation failed'));
        else resolve(response.result);
      }
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(error => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); reject(error); });
    });
    const popupEval = async expression => (await popupCall('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    await until(async () => await popupEval('document.querySelectorAll("#search-shortcut kbd").length') === 3, 'menu shortcuts loaded');
    for (const scheme of ['light', 'dark']) {
      await popupCall('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(200); // Let the hovered button's background transition finish after a theme switch.
      const menu = await popupEval(`(${inspectPopup.toString()})()`);
      check(menu.scheme === (scheme === 'dark' ? 'rgb(28, 28, 31)' : 'rgb(255, 255, 255)'), `${scheme}: native menu follows browser theme`, menu.scheme);
      check(menu.visible && menu.noOverflow && menu.sort && menu.status, `${scheme}: native menu layout, sort expansion and status semantics`, menu);
      check(JSON.stringify(menu.shortcut) === JSON.stringify(['Ctrl', 'Shift', '.']) && menu.shortcutLabel === 'Control + Shift + .', `${scheme}: native menu shows actual shortcut as accessible keycaps`, menu);
      check(menu.contrast >= 4.5, `${scheme}: native menu text contrast meets 4.5:1`, menu.contrast);
      await shot(`menu-${scheme}`, 'Native toolbar menu with actual browser shortcuts');
    }
    // Clicking Search closes the popup target, so do not require a CDP reply.
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++popupRequest, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("btn-search").click()' } }) });
    let menuMode;
    await until(async () => {
      const f = overlayFrame(page);
      if (f && await f.evaluate(() => document.getElementById('results')?.getAttribute('aria-busy') === 'false').catch(() => false)) return (menuMode = 'overlay');
      if (fallbackPage()) return (menuMode = 'window');
    }, 'menu search', 8000).catch(() => {});
    console.log(`INFO toolbar menu search mode: ${menuMode} (popup opened with chrome.action.openPopup, not a pointer click)`);
    check(Boolean(menuMode), 'toolbar menu launches search', menuMode);
    if (menuMode === 'overlay') { await page.keyboard.press('Escape'); await closed(page); }
    else if (menuMode === 'window') { await fallbackPage().keyboard.press('Escape'); await until(() => !fallbackPage(), 'menu fallback closed'); }
    await video.stop();

    // Settings page only: current-window scope persists.
    const settings = await context.newPage();
    await settings.goto(`${extOrigin}/options.html`);
    await settings.locator('#search-scope').selectOption('current');
    await until(async () => (await worker.evaluate(() => chrome.storage.local.get('searchScope'))).searchScope === 'current', 'scope saved');
    await settings.reload();
    check(await settings.locator('#search-scope').inputValue() === 'current', 'scope setting survives reload');
    await settings.close();
    await page.bringToFront();
    frame = await openOverlay(page);
    check(!(await rows(frame)).includes(TITLES['/remote']), 'current-window scope excludes other window', await rows(frame));
    check(await frame.evaluate(() => [...document.querySelectorAll('select,input[type=checkbox],input[type=range]')].every(el => ['source-history', 'source-content'].includes(el.id))), 'no persistent settings controls in search (only explicit source choices)');

    // Many tabs: every match reachable, highlight scrolls.
    const bulk = await worker.evaluate(async windowId => {
      const out = [];
      for (let i = 0; i < 150; i++) out.push((await chrome.tabs.create({ windowId, active: false, url: 'about:blank#search-scale-' + i })).id);
      return out;
    }, ids.windowId);
    await type(page, 'search-scale');
    await until(async () => (await rows(frame)).length === 150, '150 results').catch(() => {});
    check((await rows(frame)).length === 150, 'many150: all matches listed', (await rows(frame)).length);
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    check(await frame.evaluate(() => document.getElementById('scroll').scrollTop > 0), 'many150: keyboard highlight scrolls list');
    await worker.evaluate(id => chrome.tabs.remove(id), bulk[0]);
    await until(async () => (await rows(frame)).length === 149, 'live refresh').then(() => check(true, 'results refresh when a tab closes'), e => check(false, 'results refresh when a tab closes', e.message));
    await page.keyboard.press('Escape');
    await closed(page);
    await worker.evaluate(ids => chrome.tabs.remove(ids), bulk.slice(1));

    // Two tabs, then one tab (current-window scope, origin window only).
    const extra = (await worker.evaluate(wid => chrome.tabs.query({ windowId: wid }), ids.windowId)).map(t => t.id).filter(id => ![ids.current, ids.previous].includes(id));
    if (extra.length) await worker.evaluate(ids => chrome.tabs.remove(ids), extra);
    frame = await openOverlay(page);
    check(JSON.stringify(await rows(frame)) === JSON.stringify([TITLES['/previous'], TITLES['/current']]), 'two tabs: previous first, current last', await rows(frame));
    await type(page, 'roadmap');
    check(await selected(frame) === TITLES['/current'], 'two tabs: current wins typed search');
    await type(page, '');
    await worker.evaluate(id => chrome.tabs.remove(id), ids.previous);
    await until(async () => (await rows(frame)).length === 1, 'one tab').catch(() => {});
    check(JSON.stringify(await rows(frame)) === JSON.stringify([TITLES['/current']]), 'one tab: current listed', await rows(frame));
    await page.keyboard.press('Enter');
    await sleep(300);
    check((await tab(ids.current)).active, 'one tab: Enter keeps that tab');
    if (await hosts(page)) { await page.keyboard.press('Escape'); await closed(page).catch(() => {}); }

    // Hostile title renders literally.
    const hostile = await context.newPage();
    await hostile.goto(`${base}/previous`);
    await hostile.evaluate(() => { document.title = '<img src=x onerror=alert(1)> hostile title'; });
    await sleep(500);
    const hostileFrame = await openOverlay(hostile);
    await type(hostile, 'hostile');
    check(await hostileFrame.evaluate(() => document.querySelector('.result .title')?.textContent) === '<img src=x onerror=alert(1)> hostile title', 'hostile title rendered literally');
    check(await hostileFrame.evaluate(() => document.querySelectorAll('#results img').length) === 0, 'title markup creates no elements');

  }

  if (!CLOSING_ONLY) {
    // ===== Privacy and lifecycle acceptance ====================================
    // Runs after the main flow (or alone with --acceptance-only) from a known state.
    let frame;
    for (const p of context.pages()) if (p !== page && p.url() !== `${base}/remote`) await p.close().catch(() => {});
    await worker.evaluate(() => chrome.storage.local.set({ searchScope: 'all' }));
    if (page.url() !== `${base}/current`) await page.goto(`${base}/current`);
    const focusCurrent = () => worker.evaluate(ids => Promise.all([chrome.tabs.update(ids.current, { active: true }), chrome.windows.update(ids.windowId, { focused: true })]), ids);
    await focusCurrent();
    async function keysTo(title, keys) {
      for (let attempt = 0; ; attempt++) {
        try { return nativeKeys(env, keys, title); } catch (error) { if (attempt > 10) throw error; await sleep(200); }
      }
    }
    const SEARCH_STATE = `({ busy: document.getElementById('results')?.getAttribute('aria-busy'),
      urls: [...document.querySelectorAll('.result .url')].map(e => e.textContent), state: document.getElementById('message').dataset.state })`;
    const sessionCount = () => worker.evaluate(async () => Object.keys((await chrome.storage.session.get('search.sessions'))['search.sessions'] || {}).length);
    const windowCount = () => worker.evaluate(() => chrome.windows.getAll().then(w => w.length));
    const urlsOf = f => f.evaluate(() => [...document.querySelectorAll('.result .url')].map(e => e.textContent));

    // (1) Private windows, allowed through allowIncognito() above.
    const extPage = await allowIncognito();
    check(await worker.evaluate(() => chrome.extension.isAllowedIncognitoAccess()), 'private: incognito allowed in throwaway profile only');

    // The manifest uses incognito "split": the private window gets its own
    // extension worker and storage, invisible to the normal worker (which gets
    // null back from windows.create). Find the private browser context through
    // raw CDP and run private chrome.* calls from an extension page in that
    // same context.
    const privUrl = `${base}/private-only`, privTwo = `${base}/private-two`;
    // CDP cannot open a tab in this context (Target.createTarget rejects its id),
    // so the normal worker opens the private extension page as a third tab.
    const privExtUrl = `${extOrigin}/options.html`;
    const normalCreate = await worker.evaluate(urls => chrome.windows.create({ incognito: true, url: urls, left: 0, top: 0, width: 1280, height: 900, focused: true }), [privUrl, privTwo, privExtUrl]);
    let privTarget, privExtTarget;
    await until(async () => (privTarget = (await targets()).find(t => t.type === 'page' && t.url === privUrl)), 'private page target');
    const privContext = privTarget.browserContextId;
    await until(async () => (privExtTarget = (await targets()).find(t => t.type === 'page' && t.url === privExtUrl && t.browserContextId === privContext)), 'private extension page target');
    const privExt = privExtTarget.targetId;
    const privEval = (fn, arg) => evalIn(privExt, `(${fn})(${JSON.stringify(arg ?? null)})`);
    await until(() => privEval(() => document.readyState === 'complete' && typeof chrome.tabs?.query === 'function').catch(() => false), 'private extension page');
    const privSide = await privEval(async url => {
      const [t] = await chrome.tabs.query({ url });
      return { inIncognito: chrome.extension.inIncognitoContext, windowId: t.windowId, tab: t.id, incognito: t.incognito };
    }, privUrl);
    const normalSide = await worker.evaluate(() => chrome.windows.getAll({ populate: true })
      .then(ws => ({ inIncognito: chrome.extension.inIncognitoContext, incognito: ws.filter(w => w.incognito).length })));
    const normalContext = (await targets()).find(t => t.type === 'page' && t.url === `${base}/current`)?.browserContextId;
    check(Boolean(privContext && normalContext) && privContext !== normalContext, 'split: private window is a separate browser context');
    check(privSide.inIncognito === true && privSide.incognito === true && normalSide.inIncognito === false && normalSide.incognito === 0 && !normalCreate,
      'split: private tabs visible only to the private extension context', { privSide: { ...privSide, windowId: undefined, tab: undefined }, normalSide, normalCreateReturned: Boolean(normalCreate) });
    const priv = { windowId: privSide.windowId, tab: privSide.tab };
    await privEval(async ({ windowId, tab }) => { await chrome.tabs.update(tab, { active: true }); await chrome.windows.update(windowId, { focused: true }); }, priv);
    await until(async () => (await privEval(id => chrome.tabs.query({ windowId: id }), priv.windowId)).every(t => t.status === 'complete'), 'private tabs loaded');
    await evalIn(privTarget.targetId, 'document.title = "Private sentinel"');
    await sleep(400);
    await keysTo('Private sentinel', SEARCH_KEYS);
    let privMode, privFrame;
    await until(async () => {
      const all = (await targets()).filter(t => t.browserContextId === privContext);
      const frameTarget = all.find(t => t.type === 'iframe' && t.url === searchUrl);
      if (frameTarget && (privFrame = await evalIn(frameTarget.targetId, SEARCH_STATE).catch(() => undefined))?.busy === 'false') return (privMode = 'overlay');
      const windowTarget = all.find(t => t.type === 'page' && t.url.startsWith(`${searchUrl}?`));
      if (windowTarget && (privFrame = await evalIn(windowTarget.targetId, SEARCH_STATE).catch(() => undefined))?.busy === 'false') return (privMode = 'window');
    }, 'private search', 10000).catch(() => {});
    console.log(`INFO private page search mode: ${privMode}`);
    check(privMode === 'overlay', 'private: shortcut opens overlay over private page', { privMode, state: privFrame?.state });
    // The private extension page used for chrome.* calls is itself a private tab.
    const privateUrls = [privUrl, privTwo, privExtUrl];
    check([privUrl, privTwo].every(u => privFrame?.urls?.includes(u)) && privFrame.urls.every(u => privateUrls.includes(u)), 'private: overlay lists only private tabs', privFrame?.urls);
    await keysTo('Private sentinel', ['Escape']);
    await until(async () => !(await targets()).some(t => t.url === searchUrl && t.browserContextId === privContext), 'private overlay closed', 5000)
      .then(() => check(true, 'private: Escape closes overlay'), e => check(false, 'private: Escape closes overlay', e.message));

    // Normal search after the extension reload: excludes private tabs, and the
    // pre-existing page's overlay still closes after activation.
    await focusCurrent();
    await page.bringToFront();
    frame = await openOverlay(page);
    const normalUrls = await urlsOf(frame);
    // (The normal context has its own options page open, at the same URL.)
    check(normalUrls.length > 0 && !normalUrls.some(u => u === privUrl || u === privTwo), 'normal: search excludes private tabs', normalUrls);
    await type(page, 'release');
    await page.keyboard.press('Enter');
    await until(async () => (await tab(ids.remote)).active && (await win(ids.remoteWindow)).focused, 'remote after reload', 5000)
      .then(() => check(true, 'normal after reload: Enter activates target'), e => check(false, 'normal after reload: Enter activates target', e.message));
    await closed(page).then(() => check(true, 'normal after reload: overlay closes after activation'), e => check(false, 'normal after reload: overlay closes after activation', e.message));
    await focusCurrent();

    // Private protected page: the separate search window must itself be private.
    const blank = await privEval(id => chrome.tabs.create({ windowId: id, url: 'about:blank', active: true }).then(t => t.id), priv.windowId);
    await privEval(id => chrome.windows.update(id, { focused: true }), priv.windowId);
    await until(async () => (await targets()).some(t => t.browserContextId === privContext && t.type === 'page' && t.url === 'about:blank'), 'private blank');
    const blankTarget = (await targets()).find(t => t.browserContextId === privContext && t.type === 'page' && t.url === 'about:blank');
    await evalIn(blankTarget.targetId, 'document.title = "Private blank"');
    await sleep(400);
    const windowsBefore = { normal: await windowCount(), private: await privEval(() => chrome.windows.getAll().then(w => w.length)) };
    await keysTo('Private blank', SEARCH_KEYS);
    const findSearchWindow = url => chrome.windows.getAll({ populate: true }).then(ws => {
      for (const w of ws) {
        const t = w.tabs.find(t => (t.url || t.pendingUrl || '').startsWith(url + '?'));
        if (t) return { type: w.type, incognito: w.incognito, status: t.status };
      }
      return null;
    });
    let fallbackInfo;
    await until(async () => (fallbackInfo = await privEval(findSearchWindow, searchUrl))?.status === 'complete', 'private fallback window', 9000).catch(() => {});
    const fallbackTarget = (await targets()).find(t => t.type === 'page' && t.url.startsWith(`${searchUrl}?`));
    const fallbackState = fallbackTarget && await until(async () => (await evalIn(fallbackTarget.targetId, SEARCH_STATE)).busy === 'false', 'fallback ready', 5000)
      .then(() => evalIn(fallbackTarget.targetId, SEARCH_STATE), () => evalIn(fallbackTarget.targetId, SEARCH_STATE).catch(e => ({ error: e.message })));
    const windowsAfter = { normal: await windowCount(), private: await privEval(() => chrome.windows.getAll().then(w => w.length)) };
    check(fallbackInfo?.type === 'popup' && fallbackInfo.incognito === true && fallbackTarget?.browserContextId === privContext,
      'private protected page: separate private popup window', { fallbackInfo, windowsBefore, windowsAfter });
    const normalSees = await worker.evaluate(findSearchWindow, searchUrl);
    check(normalSees === null && windowsAfter.normal === windowsBefore.normal, 'private fallback: invisible to normal extension context', { normalSees, windowsBefore, windowsAfter });
    let shown;
    if (fallbackTarget && !fallbackState?.urls) {
      // Record what the private window actually shows, without its token.
      shown = await evalIn(fallbackTarget.targetId, `({ href: location.href.split('?')[0], title: document.title.includes('token=') ? '<url>' : document.title,
        text: document.body?.innerText.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(0, 200) })`).catch(e => ({ error: e.message }));
    }
    check([privUrl, privTwo].every(u => fallbackState?.urls?.includes(u)) && fallbackState.urls.every(u => [...privateUrls, 'about:blank'].includes(u)),
      'private fallback: search page loads and lists only private tabs', shown ? redact(JSON.stringify(shown)) : fallbackState);
    // Chromium shares storage.session between split contexts, so the private
    // launch session is visible to the normal worker too. Prove the sharing with
    // a sentinel, and require the entry to stay bound to the private window.
    const sentinel = 'tabvacuum-split-probe';
    await privEval(key => chrome.storage.session.set({ [key]: 1 }), sentinel);
    const shared = await worker.evaluate(key => chrome.storage.session.get(key).then(r => r[key] === 1), sentinel);
    await privEval(key => chrome.storage.session.remove(key), sentinel);
    const privSessions = await privEval(async () => Object.values((await chrome.storage.session.get('search.sessions.private'))['search.sessions.private'] || {})
      .map(s => ({ incognito: s.incognito, origin: s.originUrl })));
    console.log(`INFO split mode: storage.session shared between normal and private workers: ${shared}`);
    const privLaunch = privSessions.filter(s => s.origin === 'about:blank');
    check(privLaunch.length === 1 && privLaunch[0].incognito === true, 'private fallback: launch session bound to private window', privSessions.map(s => s.incognito));
    await focusCurrent();
    const concurrentNormal = await openOverlay(page);
    const simultaneous = await worker.evaluate(async () => {
      const s = await chrome.storage.session.get(['search.sessions', 'search.sessions.private']);
      return [Object.keys(s['search.sessions'] || {}).length, Object.keys(s['search.sessions.private'] || {}).length];
    });
    check(simultaneous[0] === 1 && simultaneous[1] === 1, 'normal and private launch sessions coexist without overwriting', simultaneous);
    check((await urlsOf(concurrentNormal)).every(u => ![privUrl, privTwo].includes(u)), 'concurrent normal search still excludes private tabs');
    await page.keyboard.press('Escape');
    await closed(page);
    const privateStillLive = await privEval(async () => Object.keys((await chrome.storage.session.get('search.sessions.private'))['search.sessions.private'] || {}).length);
    check(privateStillLive === 1, 'normal dismissal does not revoke private fallback');
    await privEval(url => chrome.windows.getAll({ populate: true }).then(async ws => {
      const w = ws.find(w => w.tabs.some(t => (t.url || '').startsWith(url + '?')));
      if (w) await chrome.windows.update(w.id, { focused: true });
    }), searchUrl);
    if (shown) {
      await privEval(url => chrome.windows.getAll({ populate: true }).then(ws => Promise.all(ws
        .filter(w => w.tabs.some(t => (t.url || '').startsWith(url + '?'))).map(w => chrome.windows.remove(w.id)))), searchUrl);
    } else if (fallbackTarget) {
      await keysTo('Search tabs', ['Escape']);
      await until(async () => !(await targets()).some(t => t.url.startsWith(`${searchUrl}?`)), 'private fallback closed', 5000).catch(() => {});
      const back = await privEval(async ({ blank, windowId }) => ({ tab: await chrome.tabs.get(blank), win: await chrome.windows.get(windowId) }), { blank, windowId: priv.windowId });
      check(back.tab.active && back.win.focused && !(await targets()).some(t => t.url.startsWith(`${searchUrl}?`)), 'private fallback: Escape returns to private origin tab');
    }
    // Removing the window destroys the evaluating page, so its reply may never arrive.
    await privEval(id => chrome.windows.remove(id), priv.windowId).catch(() => {});
    await until(async () => !(await targets()).some(t => t.browserContextId === privContext && t.type === 'page'), 'private window closed', 5000)
      .then(() => check(true, 'private window closed'), e => check(false, 'private window closed', e.message));
    await focusCurrent();

    // (2) A native navigation right after the shortcut ends that launch: no
    // fallback window appears after the claim timeout, and the next launch works.
    for (const variant of ['immediately', 'after the dialog mounts']) {
      await page.goto(`${base}/current`);
      await page.bringToFront();
      const before = await windowCount();
      await shortcut(page);
      const mounted = variant === 'immediately' || await until(() => overlayFrame(page), 'mounted', 5000).then(() => true, () => false);
      await page.goto(`${base}/previous`);
      await sleep(5500); // Past the 4 s claim timeout.
      const after = { windows: await windowCount(), before, fallback: Boolean(fallbackPage()), hosts: await hosts(page), sessions: await sessionCount() };
      check(mounted && after.windows === before && !after.fallback && after.hosts === 0, `navigation ${variant} after shortcut: no fallback window or stray dialog`, { mounted, ...after });
    }
    await page.goto(`${base}/current`);
    frame = await openOverlay(page);
    check((await rows(frame)).length > 0, 'after navigation cases: next shortcut opens overlay normally');
    await page.keyboard.press('Escape');
    await closed(page);

    // (3) Service worker stopped while the overlay is open (this test browser only).
    frame = await openOverlay(page);
    const pageCdp = await context.newCDPSession(page);
    const versions = new Map();
    pageCdp.on('ServiceWorker.workerVersionUpdated', e => { for (const v of e.versions) versions.set(v.versionId, v); });
    await pageCdp.send('ServiceWorker.enable');
    const isOurs = v => v.scriptURL === `${extOrigin}/background.js`;
    await until(() => [...versions.values()].some(v => isOurs(v) && v.runningStatus === 'running'), 'extension worker version', 5000).catch(() => {});
    const running = [...versions.values()].find(v => isOurs(v) && v.runningStatus === 'running');
    const status = () => [...versions.values()].find(isOurs)?.runningStatus;
    const stoppedWorker = worker;
    const workerClosed = new Promise(resolve => stoppedWorker.once('close', () => resolve(true)));
    if (running) await pageCdp.send('ServiceWorker.stopWorker', { versionId: running.versionId });
    const stopped = await until(() => status() === 'stopped', 'worker stopped', 5000).then(() => true, () => false);
    const playwrightSawClose = await Promise.race([workerClosed, sleep(2000).then(() => false)]);
    check(Boolean(running) && stopped, 'service worker stopped while overlay open', { found: Boolean(running), status: status(), playwrightSawClose });
    await type(page, 'release');
    check(await selected(frame) === TITLES['/remote'], 'after worker stop: typing still filters in frame');
    await page.keyboard.press('Enter');
    const restarted = await until(() => status() === 'running', 'worker running again', 8000).then(() => true, () => false);
    check(restarted, 'Enter restarts the stopped service worker', { status: status() });
    // Playwright does not re-attach to a restarted extension worker, so later
    // privileged reads run from an extension page with the same chrome.* APIs.
    worker = { evaluate: (fn, arg) => extPage.evaluate(fn, arg) };
    await until(async () => (await tab(ids.remote)).active && (await win(ids.remoteWindow)).focused, 'remote after restart', 5000)
      .then(() => check(true, 'after worker restart: Enter activates target tab'), e => check(false, 'after worker restart: Enter activates target tab', e.message));
    await closed(page).then(() => check(true, 'after worker restart: overlay closes'), e => check(false, 'after worker restart: overlay closes', e.message));
    await pageCdp.detach().catch(() => {});
    await focusCurrent();

    // (4) Page-visible resource timing, and page-made frames around a real launch.
    const secretsIn = text => worker.evaluate(async text => {
      const keys = Object.keys((await chrome.storage.session.get('search.sessions'))['search.sessions'] || {});
      return { count: keys.length, leaked: keys.some(t => text.includes(t)) };
    }, text);
    const embed = await context.newPage();
    await embed.goto(`${base}/embed`);
    const realFrame = p => p.frames().find(f => f.url() === searchUrl && !f.name());
    const pageMade = (p, name) => p.frames().find(f => f.name() === name);
    const addFrame = (p, name) => p.evaluate(([url, name]) => new Promise(resolve => {
      const f = document.createElement('iframe');
      f.name = name;
      f.src = url;
      f.addEventListener('load', () => {
        for (const token of ['A'.repeat(43), 'B'.repeat(43), 'not-a-token']) f.contentWindow.postMessage({ type: 'tabvacuum:init', token }, '*');
        resolve();
      });
      document.body.append(f);
    }), [searchUrl, name]);
    const frameState = f => f.evaluate(() => ({ rows: document.querySelectorAll('.result').length, state: document.getElementById('message').dataset.state }));
    await shortcut(embed);
    await until(() => realFrame(embed), 'embed overlay');
    await ready(realFrame(embed));
    await type(embed, 'checklist');
    check(await selected(realFrame(embed)) === TITLES['/remote'], 'embed page: query reaches overlay');
    const timing = await embed.evaluate(() => performance.getEntries().map(e => e.name).join('\n'));
    const timingSecrets = await secretsIn(timing);
    check(timingSecrets.count === 1 && !timingSecrets.leaked, 'page resource timing: no launch token', timingSecrets);
    const timingWords = ['checklist', TITLES['/remote'], TITLES['/current'], 'token='].filter(w => timing.includes(w));
    check(timingWords.length === 0, 'page resource timing: no query, tab titles, or token parameter', timingWords);
    console.log(`INFO page resource timing shows the extension frame URL: ${timing.includes(searchUrl)} (stable per-install extension ID fingerprint; not a secret)`);
    await addFrame(embed, 'page-made-after');
    await sleep(5600); // Past the frame's 5 s init timeout.
    const after = pageMade(embed, 'page-made-after') && await frameState(pageMade(embed, 'page-made-after'));
    check(after?.rows === 0 && after.state === 'error', 'page-made frame after a valid launch gets no tabs', after);
    check(await selected(realFrame(embed)) === TITLES['/remote'] && (await sessionCount()) === 1, 'real overlay unaffected by page-made frame');
    await embed.keyboard.press('Escape');
    await closed(embed).catch(() => {});

    await embed.goto(`${base}/embed`);
    const created = Date.now();
    await addFrame(embed, 'page-made-before');
    await shortcut(embed);
    await until(() => realFrame(embed), 'embed overlay after page frame');
    await ready(realFrame(embed));
    await sleep(Math.max(0, 5600 - (Date.now() - created)));
    const before = pageMade(embed, 'page-made-before') && await frameState(pageMade(embed, 'page-made-before'));
    check(before?.rows === 0 && before.state === 'error', 'page-made frame before a valid launch gets no tabs', before);
    check((await rows(realFrame(embed))).length > 0, 'real overlay still lists tabs beside page-made frame');
    await embed.keyboard.press('Escape');
    await closed(embed).catch(() => {});
    await embed.close();
  }

  if (!ACCEPTANCE_ONLY) {
    // ===== Selection and closing, on disposable tabs only =====================
    // A dedicated extension page keeps the removal listener alive across worker restarts.
    if (!(await worker.evaluate(() => chrome.extension.isAllowedIncognitoAccess()))) await (await allowIncognito()).close();
    const extTab = await context.newPage();
    await extTab.goto(`${extOrigin}/options.html`);
    api = (fn, arg) => extTab.evaluate(fn, arg);
    await api(async () => {
      // tabs.onRemoved reports only an ID, so remember every tab's last URL.
      const urls = new Map((await chrome.tabs.query({})).map(t => [t.id, t.url || t.pendingUrl]));
      chrome.tabs.onCreated.addListener(t => urls.set(t.id, t.url || t.pendingUrl));
      chrome.tabs.onUpdated.addListener((id, changes, t) => { if (t.url || t.pendingUrl) urls.set(id, t.url || t.pendingUrl); });
      globalThis.tvRemoved = [];
      chrome.tabs.onRemoved.addListener(id => globalThis.tvRemoved.push(urls.get(id) ?? `unknown-tab:${id}`));
      await chrome.storage.local.set({ searchScope: 'all' });
    });
    // Expanded-search adapter: chrome.history/chrome.permissions from extension pages,
    // and the browser's own permission dialog answered with native X keys.
    const ORIGINS = ['http://*/*', 'https://*/*'];
    let opt;
    let optionsBaseline = new Set();
    const optionPages = () => context.pages().filter(p => p !== extTab && p !== opt &&
      (p.url().startsWith(`${extOrigin}/options.html`) || p.url().startsWith('chrome://extensions')));
    const readOptions = () => opt.evaluate(() => ({ state: document.getElementById('content-access-state').textContent,
      message: document.getElementById('content-access-message').textContent }));
    const byUrl = url => api(url => chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === url) || null), url);
    closing.expanded = {
      historyHas: url => api(url => chrome.history.getVisits({ url }).then(v => v.length > 0), url),
      permitted: () => api(origins => chrome.permissions.contains({ origins }), ORIGINS),
      markOptions: async () => { optionsBaseline = new Set(optionPages()); },
      optionsOpened: async () => optionPages().some(p => !optionsBaseline.has(p)),
      closeOptions: async () => { for (const p of optionPages()) if (!optionsBaseline.has(p)) await p.close(); },
      async settingsOpen() {
        opt = await context.newPage();
        await opt.goto(`${extOrigin}/options.html?tv=settings`);
        await opt.bringToFront();
        await until(async () => (await readOptions()).state !== 'Checking…', 'settings ready', 5000);
      },
      async settingsClose() { await opt?.close(); opt = undefined; await closing.focus(ORIGIN); },
      async request(decision) {
        const variants = decision === 'allow' ? [['Return'], ['Tab', 'Return'], ['Shift_L', 'Tab', 'Return']] : [['Escape']];
        for (const keys of variants) {
          await opt.bringToFront();
          await opt.click('#content-access-allow');
          // The dialog's accept button is briefly disabled after it appears.
          await sleep(1500);
          nativeKeys(env, keys);
          await until(async () => (await readOptions()).message !== 'Waiting for your browser…', 'prompt answered', 5000).catch(() => {});
          const r = await readOptions();
          const method = `native X keys ${keys.join('+')} to the browser's own permission dialog`;
          if (decision === 'deny' || r.state === 'Allowed' || r.message === 'Waiting for your browser…') return { ...r, method };
          console.log(`INFO chromium allow attempt ${keys.join('+')} -> ${r.message}`);
        }
        return { ...(await readOptions()), method: 'no native key variant accepted the dialog' };
      },
      async revoke() {
        await opt.bringToFront();
        opt.once('dialog', d => d.accept());
        await opt.click('#content-access-revoke');
        await until(async () => /removed/.test((await readOptions()).message), 'revoked', 5000).catch(() => {});
        return { ...(await readOptions()), method: 'Playwright (CDP) accept of the page confirm() dialog' };
      },
      discard: url => api(async url => { const t = (await chrome.tabs.query({})).find(t => t.url === url); await chrome.tabs.discard(t.id); return true; }, url),
      isDiscarded: async url => (await byUrl(url))?.discarded === true,
      async navigate(url, to) {
        await api(async ({ url, to }) => { const t = (await chrome.tabs.query({})).find(t => t.url === url); await chrome.tabs.update(t.id, { url: to }); }, { url, to });
        await loaded([to]);
      },
      // A real incognito window opened by the normal extension context (split mode
      // hides the window from it). Its tabs and the extension frame over them are
      // outside Playwright's context, so the UI is read over raw CDP targets in that
      // browser context and driven only with native X keys to the window by title.
      async privateWindow(urls, title) {
        const returned = await api(urls => chrome.windows.create({ incognito: true, url: urls, left: 0, top: 0, width: 1280, height: 900, focused: true })
          .then(w => Boolean(w)), urls);
        let top;
        await until(async () => (top = (await targets()).find(t => t.type === 'page' && t.url === urls[0])), 'private page target');
        const privContext = top.browserContextId;
        const normalContext = (await targets()).find(t => t.type === 'page' && t.url === ORIGIN)?.browserContextId;
        check(privContext && privContext !== normalContext && !returned, 'private: fixture tabs are in a separate incognito browser context', { returned });
        const pages = async () => (await targets()).filter(t => t.browserContextId === privContext && t.type === 'page');
        await until(async () => {
          const all = await pages();
          const states = await Promise.all(urls.map(u => all.find(t => t.url === u)).map(t => t && evalIn(t.targetId, 'document.readyState').catch(() => null)));
          return states.every(s => s === 'complete');
        }, 'private tabs loaded', 15000);
        await evalIn(top.targetId, `document.title = ${JSON.stringify(title)}`);
        await sleep(400);
        const frame = async () => (await targets()).find(t => t.browserContextId === privContext && t.type === 'iframe' && t.url === searchUrl);
        const inFrame = async expression => {
          const f = await frame();
          if (!f) throw new Error('no private search frame');
          return evalIn(f.targetId, expression);
        };
        const keys = keys => nativeTo(keys, title);
        return {
          check, base, originUrl: urls[0],
          ui: (body, arg) => inFrame(`(async arg => { ${body} })(${JSON.stringify(arg ?? null)})`),
          keys,
          async type(text) {
            const focus = await inFrame('document.activeElement?.id');
            if (focus !== 'query') throw new Error(`type() needs the query focused, not ${focus}`);
            await keys(['Control_L', 'a']);
            await keys(['BackSpace']);
            for (const character of text) await keys([character]);
            await sleep(150);
          },
          async focus(url) {
            const t = (await pages()).find(t => t.url === url);
            await cdp.send('Target.activateTarget', { targetId: t.targetId });
            await sleep(300);
          },
          async open() {
            await keys(SEARCH_KEYS);
            let kind;
            await until(async () => {
              if (await frame()) return (kind = 'overlay');
              if ((await pages()).some(t => t.url.startsWith(`${searchUrl}?`))) return (kind = 'window');
            }, 'private search UI', 9000).catch(() => {});
            if (kind === 'overlay') await until(async () => (await inFrame("document.getElementById('results')?.getAttribute('aria-busy')")) === 'false', 'private results', 8000);
            return kind;
          },
          uiCount: async () => ({ overlays: (await frame()) ? 1 : 0, windows: (await pages()).filter(t => t.url.startsWith(`${searchUrl}?`)).length }),
          shot: closing.shot,
          async close() {
            for (const t of await pages()) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
            await until(async () => !(await pages()).length, 'private window closed', 5000);
            await closing.focus(ORIGIN);
          },
        };
      },
    };
    if (!EXPANDED_ONLY) await runSearchClosing(closing);
    await runExpandedSearch(closing);
  }

  await writeFile(path.join(directory, 'screenshots.json'), JSON.stringify(shots, null, 2));
  finish({ browser: `Chromium ${context.browser().version()}`, output: directory, screenshots: shots.map(s => s.file) });
} finally {
  await video.stop();
  await context?.close();
  display.stop();
  await site.close();
  await rm(profile, { recursive: true, force: true });
}
