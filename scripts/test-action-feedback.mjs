// Native extension popup regression checks. Real APIs for success/no-op paths;
// only fault/visibility cases replace sendMessage, explicitly labelled below.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDisplay } from './test-display.mjs';
import { startSite, outputDir, until, sleep, nativeKeys, captureDisplay, recorder } from './test-browser-fixtures.mjs';
import { SEARCH_KEYS } from './test-popup-fixture.mjs';

const name = process.argv[2] || 'chromium';
assert.ok(['chromium', 'firefox'].includes(name));
const { scratch, directory } = await outputDir(`feedback-${name}`);
const display = await startDisplay(scratch);
const site = await startSite();
const env = display.env;
const originUrl = `${site.base}/current`;
const passed = [];
const check = (ok, label) => { assert.ok(ok, label); passed.push(label); console.log(`PASS ${label}`); };
let shutdown = async () => {};
let video = { stop: async () => {} };
let api, popup, open, isOpen, focus, pageEval, scheme, reducedMotion;
const shot = label => captureDisplay(env, path.join(directory, `${label}.png`));

try {
  if (name === 'chromium') {
    const profile = await mkdtemp(path.join(directory, 'profile-'));
    const extension = path.resolve('dist/chrome');
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM_BINARY || chromium.executablePath(),
      headless: false, env, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--window-position=0,0', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'],
    });
    shutdown = async () => { await context.close(); await rm(profile, { recursive: true, force: true }); };
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const ext = worker.url().replace(/\/background\.js$/, '');
    api = body => worker.evaluate(`(async()=>{const api=browser; ${body}})()`);
    const page = context.pages()[0];
    await page.goto(originUrl);
    focus = () => page.bringToFront();
    pageEval = body => page.evaluate(`(()=>{${body}})()`);
    const cdp = await context.browser().newBrowserCDPSession();
    const target = async () => (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `${ext}/popup.html`);
    isOpen = async () => Boolean(await target());
    let session, nextId = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error('Popup CDP timeout')); }, 8000);
      function receive(event) {
        if (event.sessionId !== session) return;
        const value = JSON.parse(event.message);
        if (value.id !== id) return;
        clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive);
        if (value.error || value.result?.exceptionDetails) reject(new Error(JSON.stringify(value.error || value.result.exceptionDetails)));
        else resolve(value.result);
      }
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method, params }) })
        .catch(error => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); reject(error); });
    });
    popup = async body => (await call('Runtime.evaluate', { expression: `(()=>{${body}})()`, returnByValue: true })).result.value;
    open = async () => {
      await focus(); await api('await api.action.openPopup();');
      await until(isOpen, 'popup open');
      ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId: (await target()).targetId, flatten: false }));
      await until(async () => await popup('return document.body.classList.contains("ready")'), 'popup ready');
    };
    let currentScheme = 'light';
    scheme = value => { currentScheme = value; return call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }); };
    reducedMotion = (enabled = true) => call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: currentScheme }, { name: 'prefers-reduced-motion', value: enabled ? 'reduce' : 'no-preference' }] });
  } else {
    process.env.TMPDIR = directory;
    process.env.DISPLAY = env.DISPLAY;
    const uuid = 'a3906219-0180-4fa2-a2d8-a90270e6e501';
    const ext = `moz-extension://${uuid}`;
    const driverPath = process.env.GECKODRIVER || path.join(scratch, 'browsers/geckodriver');
    const service = new firefox.ServiceBuilder(driverPath).addArguments('--host', '127.0.0.1');
    const options = new firefox.Options()
      .setBinary(process.env.FIREFOX_BINARY || path.join(scratch, 'browsers/firefox/firefox'))
      .setPreference('browser.startup.homepage_override.mstone', 'ignore')
      .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'tabvacuum@adlio': uuid }));
    // New geckodriver versions require the privileged test opt-in on the driver,
    // not as a Firefox capability. This applies only to our disposable profile.
    if (execFileSync(driverPath, ['--help'], { encoding: 'utf8' }).includes('--allow-system-access')) service.addArguments('--allow-system-access');
    else options.addArguments('-remote-allow-system-access');
    const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
    shutdown = () => driver.quit();
    await driver.manage().window().setRect({ x: 0, y: 0, width: 1280, height: 900 });
    await driver.installAddon(path.resolve('dist/firefox'), true);
    await driver.get(originUrl);
    await driver.setContext('chrome');
    const execute = (body, ...args) => driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      (async()=>{${body}})().then(done,e=>done({testError:String(e)}));`, ...args).then(value => {
        if (value?.testError) throw new Error(value.testError); return value;
      });
    await execute(`window.__feedbackOptions=gBrowser.addTab(arguments[0], {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),inBackground:true}); return true;`, `${ext}/options.html`);
    api = body => execute(`const bc=window.__feedbackOptions.linkedBrowser.browsingContext;
      return bc.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',
        {script:arguments[0],args:[],opts:{}});`, `return (async()=>{const api=browser;${body}})()`);
    await until(async () => (await api('return !!api.runtime.id;')) === true, 'extension evaluator');
    pageEval = async body => {
      await driver.setContext('content');
      try { return await driver.executeScript(body); } finally { await driver.setContext('chrome'); }
    };
    focus = () => driver.executeScript('window.focus(); gBrowser.selectedBrowser.focus();');
    isOpen = () => driver.executeScript(`return [...document.querySelectorAll('browser.webextension-popup-browser')].some(b=>b.getClientRects().length>0);`);
    popup = body => execute(`const view=[...document.querySelectorAll('browser.webextension-popup-browser')].find(b=>b.getClientRects().length>0);
      if(!view) throw new Error('No visible popup');
      return view.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').sendQuery('MarionetteCommandsParent:executeScript',
        {script:arguments[0],args:[],opts:{}});`, body);
    open = async () => {
      await focus();
      await driver.executeScript('CustomizableUI.addWidgetToArea("tabvacuum_adlio-browser-action", "nav-bar");');
      await driver.findElement(By.id('tabvacuum_adlio-BAP')).click();
      await until(isOpen, 'popup open');
      await until(async () => await popup('return document.body.classList.contains("ready")'), 'popup ready');
    };
    scheme = value => execute(`const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await (await AddonManager.getAddonByID(arguments[0])).enable(); return true;`, `firefox-compact-${value}@mozilla.org`);
    reducedMotion = (enabled = true) => driver.executeScript('Services.prefs.setIntPref("ui.prefersReducedMotion",arguments[0]);', enabled ? 1 : 0);
  }

  check((await api('return (await api.commands.getAll()).find(c=>c.name==="search-tabs").shortcut;')) === 'Ctrl+Shift+Period', 'period command registered');
  await focus();
  for (const inField of [false, true]) {
    await pageEval(inField ? 'document.getElementById("page-input").focus();' : 'document.activeElement?.blur();');
    await sleep(200);
    nativeKeys(env, SEARCH_KEYS, 'Project roadmap');
    await until(() => pageEval('return !!document.querySelector("tabvacuum-search")'), 'native period opens search');
    check(true, `native period chord opens search ${inField ? 'from input' : 'from page'}`);
    nativeKeys(env, ['Escape']);
    await until(() => pageEval('return !document.querySelector("tabvacuum-search")'), 'search closed');
  }

  // Generic disposable URLs only; no user tabs/profile/history are touched.
  await api(`for(const slug of ['zeta','beta','alpha']) await api.tabs.create({url:${JSON.stringify(site.base)}+'/disposable/'+slug,active:false});`);
  const criteria = [['url','asc'],['url','desc'],['title','asc'],['title','desc'],['lastAccessed','desc'],['visitCount','desc'],['frecency','desc']];
  async function observeResult() {
    await api('await api.storage.session.remove("feedback.test.result");');
    await popup(`const send=browser.runtime.sendMessage.bind(browser.runtime); browser.runtime.sendMessage=async msg=>{
      const result=await send(msg); await browser.storage.session.set({'feedback.test.result':result}); return result;};`);
  }
  const readResult = () => api('return (await api.storage.session.get("feedback.test.result"))["feedback.test.result"];');
  async function action(selector) {
    await open(); await observeResult();
    const busy = await popup(`const selector=${JSON.stringify(selector)};
      if(selector.includes('data-criteria')) document.getElementById('btn-sort').click();
      document.querySelector(selector).click();
      return {busy:document.querySelector('main').getAttribute('aria-busy'),text:document.getElementById('status-title').textContent,spinner:!document.getElementById('status-spinner').hidden};`);
    check(busy.busy === 'true' && busy.spinner && busy.text.length > 0, `${selector}: immediate busy state`);
    await until(readResult, 'real action result');
    const result = await readResult();
    check(!result.error, `${selector}: real operation succeeds`);
    if (result.notificationError) {
      check(await isOpen(), `${selector}: unavailable notification preserves popup`);
      console.log(`NOTICE native notification API rejected: ${result.notificationError}`);
      await popup('document.getElementById("status-close").click();');
    } else {
      await until(async () => !await isOpen(), 'completion closes popup');
      check(true, `${selector}: notification accepted and popup closed (${result.message})`);
    }
    return result;
  }
  for (const [key, direction] of criteria) await action(`[data-criteria="${key}"][data-direction="${direction}"]`);
  await api(`await api.tabs.create({url:${JSON.stringify(site.base + '/disposable/alpha')},active:false});`);
  await action('#btn-dupes');
  await action('#btn-dupes'); // no-op stays informational
  await action('#btn-stale'); // protected/recent tabs => no-op
  await api('await api.tabs.create({url:"about:blank",active:false});');
  await action('#btn-blank');
  await action('#btn-merge'); // single window => no-op

  // Deterministic visibility/fault tests. Real popup code, test-owned transport
  // rejection/delay only; these screenshots are NOT evidence of OS notification display.
  for (const theme of ['light','dark']) {
    await open(); await scheme(theme);
    await popup(`browser.runtime.sendMessage=()=>new Promise((resolve,reject)=>{window.__feedbackReject=reject;});
      document.getElementById('btn-sort').click(); document.querySelector('[data-criteria="frecency"]').click();`);
    await sleep(300);
    const state = await popup(`const box=document.getElementById('status').getBoundingClientRect();
      return {visible:box.top>=0&&box.bottom<=innerHeight, width:document.documentElement.scrollWidth<=innerWidth,
        text:document.getElementById('status-title').textContent, color:getComputedStyle(document.body).backgroundColor,
        disabled:[...document.querySelectorAll('main button')].every(b=>b.getAttribute('aria-disabled')==='true')};`);
    shot(`busy-${theme}`);
    check(state.visible && state.width && state.disabled, `${theme}: busy state fits native popup viewport (${JSON.stringify(state)})`);
    await reducedMotion();
    check(await popup('return getComputedStyle(document.getElementById("status-spinner")).animationName') === 'none', `${theme}: reduced motion stops spinner`);
    await popup('window.__feedbackReject(new Error("Test operation unavailable"));');
    await until(async () => await popup('return document.getElementById("status").dataset.tone') === 'error', 'error rendered');
    await sleep(3100);
    check(await isOpen() && await popup('return !document.getElementById("status-close").hidden'), `${theme}: failure persists and is dismissible`);
    shot(`error-${theme}`);
    await popup('document.getElementById("status-close").click();');
    await until(async () => !await isOpen(), 'error dismissed');
  }

  await open();
  await popup(`browser.runtime.sendMessage=async()=>({message:'Closed 6 duplicate tabs',notificationError:'Test notification unavailable'});
    document.getElementById('btn-dupes').click();`);
  await until(async () => await popup('return document.getElementById("status").dataset.tone') === 'done', 'notification fallback');
  check(await popup('return document.getElementById("status-title").textContent') === 'Closed 6 duplicate tabs', 'notification-only failure preserves completed count');
  shot('notification-unavailable');
  await popup('document.getElementById("status-close").click();');
  await until(async () => !await isOpen(), 'fallback dismissed');

  // Real action after caller disappears. A batch of blank tabs makes completion
  // asynchronous; the popup closes itself immediately after submitting the command.
  await api('for(let i=0;i<20;i++) await api.tabs.create({url:"about:blank",active:false});');
  await open();
  await popup('document.getElementById("btn-blank").click(); window.close();');
  await until(async () => (await api('return (await api.tabs.query({})).filter(t=>t.url==="about:blank").length')) === 0, 'dismissed popup background completion');
  check(!await isOpen(), 'dismissed popup stays closed while background finishes');

  // Real API, no artificial delays or fake responses in this recording.
  await api('for(let i=0;i<80;i++) await api.tabs.create({url:"about:blank#feedback-"+i,active:false});');
  await open();
  await scheme('light');
  await reducedMotion(false);
  await observeResult();
  await popup('document.getElementById("btn-sort").click();');
  video = recorder(env, path.join(directory, 'real-sort.mp4'));
  await sleep(500);
  await popup('document.querySelector("[data-criteria=frecency]").click();');
  await until(readResult, 'recorded real sort result');
  const recordedResult = await readResult();
  check(!recordedResult.error && /^Sorted \d+ tabs by frecency$/.test(recordedResult.message), 'recording: real frecency sort succeeded');
  await until(async () => !await isOpen() || await popup('return document.getElementById("status").dataset.tone') === 'done', 'recorded real sort');
  await sleep(800);
  shot('real-sort-complete');
  await video.stop();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({browser:name,passed:passed.length,checks:passed,notes:'Success paths use real APIs. Visibility/errors deliberately inject transport failure. OS notification display is not proven by API acceptance.'}, null, 2));
  console.log(JSON.stringify({browser:name,passed:passed.length,directory}));
} finally {
  await video.stop();
  await shutdown();
  await site.close();
  display.stop();
}
