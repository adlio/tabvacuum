// Shared pieces of the real-browser harnesses: an ordinary-looking local site to
// search from, native X key input, full-display captures, and check helpers.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export const TITLES = {
  '/current': 'Project roadmap',
  '/previous': 'Project notes',
  '/remote': 'Release checklist',
  '/fuzzy': 'Readmap discussion',
  '/hostile-css': 'Loud stylesheet',
  '/csp': 'Locked down page',
  '/embed': 'Embedding page',
};

// A pleasant generic page, so screenshots show the dialog over a real site.
const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --ink:#1f2937; --soft:#6b7280; --accent:#4f46e5; --line:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --ink:#e2e8f0; --soft:#94a3b8; --accent:#818cf8; --line:#334155; } }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:12px; padding:18px 40px; background:var(--card); border-bottom:1px solid var(--line); }
  header b { color:var(--accent); font-size:20px; } nav a { margin-left:20px; color:var(--soft); text-decoration:none; }
  main { max-width:960px; margin:32px auto; padding:0 24px; display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
  h1 { grid-column:1/-1; margin:0; font-size:32px; } p.lead { grid-column:1/-1; margin:0; color:var(--soft); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; min-height:120px; }
  .card h2 { margin:0 0 8px; font-size:17px; } .card p { margin:0; color:var(--soft); font-size:14px; }
  input { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); }`;

// Ordinary page-author CSS that must not reach into the dialog.
const HOSTILE_CSS = `
  * { color:#ff00ff !important; font-size:40px !important; letter-spacing:6px !important; box-sizing:content-box !important; }
  iframe, dialog { border:30px solid red !important; transform:scale(0.2) !important; opacity:0.1 !important; }
  dialog::backdrop { background:lime !important; }`;

// Disposable tabs for closing tests: /disposable/<slug> and /keep/<slug> pages
// get titles from their (restricted) slugs, so each run can use a unique token.
const SLUG_PAGE = /^\/(disposable|keep)\/([a-z0-9-]{1,64})$/;
export const disposableTitle = slug => `Disposable ${slug.replaceAll('-', ' ')}`;
export const keepTitle = slug => `Keep open ${slug.replaceAll('-', ' ')}`;

function titleFor(url) {
  const [, kind, slug] = url.match(SLUG_PAGE) || [];
  if (kind) return kind === 'disposable' ? disposableTitle(slug) : keepTitle(slug);
  return TITLES[url] || 'Test tab';
}

function page(url) {
  const special = expandedPage(url);
  if (special) return special;
  const title = titleFor(url);
  const extra = url === '/hostile-css' ? `<style>${HOSTILE_CSS}</style>` : '';
  const cards = ['Milestones', 'Owners', 'Risks', 'Launch plan', 'Metrics', 'Open questions']
    .map(name => `<section class="card"><h2>${name}</h2><p>Placeholder content for ${name.toLowerCase()} on this page.</p></section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
    <style>${STYLE}</style>${extra}</head><body>
    <header><b>Acme Docs</b><nav><a href="#">Home</a><a href="#">Projects</a><a href="#">Team</a></nav>
    <input id="page-input" aria-label="Page search" placeholder="Page field"></header>
    <main><h1>${title}</h1><p class="lead">A local fixture page served only to this isolated browser profile.</p>${cards}</main>
    </body></html>`;
}

export async function startSite() {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.set(url, (hits.get(url) || 0) + 1);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Restrictive but ordinary policy: no frames and no inline style or script.
    if (url === '/csp') res.setHeader('Content-Security-Policy', "default-src 'none'; frame-src 'none'; child-src 'none'; style-src 'none'; script-src 'none'");
    res.end(page(url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function outputDir(name) {
  const scratch = process.env.KIROCREW_SCRATCH || process.env.TMPDIR;
  if (!scratch) throw new Error('Set KIROCREW_SCRATCH or TMPDIR to an isolated test directory');
  const directory = path.join(scratch, name);
  await mkdir(directory, { recursive: true });
  return { scratch, directory };
}

export function checker() {
  const results = { passed: [], failed: [] };
  // Soft checks: record every failure so one run reports all of them.
  function check(condition, label, detail) {
    if (condition) { results.passed.push(label); console.log(`PASS ${label}`); return true; }
    results.failed.push(detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    console.log(`FAIL ${label}${detail === undefined ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return false;
  }
  function finish(summary) {
    console.log(JSON.stringify({ ...summary, passed: results.passed.length, failed: results.failed }));
    assert.equal(results.failed.length, 0, `${results.failed.length} browser check(s) failed`);
  }
  return { check, finish, results };
}

export async function until(fn, label, ms = 10000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (error) { last = error; }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Real X keyboard events on the test display, optionally focusing a window by title first. */
export function nativeKeys(env, keys, focusTitle) {
  const args = ['scripts/test-native-key.py'];
  if (focusTitle) args.push('--focus-title', focusTitle);
  execFileSync('python3', [...args, ...keys], { env });
}

// Holds one key down for `ms`, so the X server's own autorepeat fires.
const HOLD_KEY = `
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6"); xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]; x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XFlush.argtypes = [ctypes.c_void_p]; x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d: raise SystemExit("Cannot open test display")
if sys.argv[1] == '--sequence':
    for key in sys.argv[2:]:
        code = x11.XKeysymToKeycode(d, x11.XStringToKeysym(key.encode()))
        if not code: raise SystemExit('Unknown key')
        xtst.XTestFakeKeyEvent(d, code, 1, 0); x11.XFlush(d)
        time.sleep(0.01)
        xtst.XTestFakeKeyEvent(d, code, 0, 0); x11.XFlush(d)
        time.sleep(0.01)
else:
    code = x11.XKeysymToKeycode(d, x11.XStringToKeysym(sys.argv[1].encode()))
    if not code: raise SystemExit('Unknown key')
    xtst.XTestFakeKeyEvent(d, code, 1, 0); x11.XFlush(d)
    time.sleep(float(sys.argv[2]) / 1000)
    xtst.XTestFakeKeyEvent(d, code, 0, 0); x11.XFlush(d)
x11.XCloseDisplay(d)`;

/** Native key held down on the test display; focuses the window with a harmless Shift tap first. */
export function nativeHold(env, key, ms, focusTitle) {
  if (!env.DISPLAY?.startsWith(':')) throw new Error('An isolated local DISPLAY is required');
  nativeKeys(env, ['Shift_L'], focusTitle);
  execFileSync('python3', ['-c', HOLD_KEY, key, String(ms)], { env });
}

/** Whole 1280x900 test display, browser chrome included. */
export function captureDisplay(env, file) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x900',
    '-i', env.DISPLAY, '-frames:v', '1', file], { env });
}
/** A fast sequence of native key presses, with no browser/API waits between them. */
export function nativeSequence(env, keys, focusTitle) {
  if (!env.DISPLAY?.startsWith(':')) throw new Error('An isolated local DISPLAY is required');
  nativeKeys(env, ['Shift_L'], focusTitle);
  execFileSync('python3', ['-c', HOLD_KEY, '--sequence', ...keys], { env });
}

export function recorder(env, file) {
  if (process.env.RECORD_BROWSER !== '1') return { stop: async () => {} };
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x900',
    '-framerate', '12', '-i', env.DISPLAY, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { env });
  child.stderr.on('data', data => process.stderr.write(data));
  const done = new Promise(resolve => child.once('exit', resolve));
  let stopped = false;
  return { async stop() { if (stopped) return; stopped = true; child.stdin.write('q'); await done; } };
}

/** Runs inside the real extension frame, using computed styles rather than token guesses. */
export function paletteContrast() {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const ratios = [];
  // Enabled action labels, the selection count and inline hints are text too.
  // Disabled controls are exempt from the contrast minimum.
  const selectors = ['#query', '.list-heading', '#selection-status', '.action:not([aria-disabled="true"])',
    '.title', '.url', '.badge', 'footer', '.hint', 'kbd', '#message'];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      // Skip anything not rendered, including children of hidden hint groups.
      if (getComputedStyle(element).display === 'none' || !element.getClientRects().length || !element.textContent.trim()) continue;
      let surface = element;
      while (surface && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
      if (!surface) continue;
      const a = luminance(getComputedStyle(element).color);
      const b = luminance(getComputedStyle(surface).backgroundColor);
      ratios.push({ selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
    }
  }
  const low = ratios.filter(r => r.ratio < 4.5).map(r => `${r.selector} ${r.ratio.toFixed(2)}`);
  const checked = [...new Set(ratios.map(r => r.selector))];
  return { passes: ratios.length > 0 && !low.length, minimum: Math.min(...ratios.map(r => r.ratio)), low, checked };
}

// ---- Expanded-search fixtures (history + page contents) ---------------------
// Every request is counted by path, so a test can prove a sleeping tab was
// never reloaded and a content scan never re-fetched a page.
export const hits = new Map();
// Per-run page text, registered by the harness: path -> { kind, needle } or a title override.
export const contentPages = new Map();
export const pageTitles = new Map();
const ARCHIVE = /^\/archive\/([a-z0-9-]{1,80})$/;
const CONTENT = /^\/content\/([a-z]+)\/([a-z0-9-]{1,64})$/;
export const archiveTitle = slug => `Archive quasar ${slug.replaceAll('-', ' ')}`;

// Where the needle appears for each content kind. Only 'main' and 'titled'
// put it in rendered main-frame text; every other kind must never match.
function contentBody(kind, needle) {
  const [a, b] = needle ? [needle.slice(0, 4), needle.slice(4)] : ['', ''];
  switch (kind) {
    case 'main': case 'titled': case 'sleeping': return `<p>Quarterly figures mention ${needle} in passing.</p>`;
    case 'field': return `<input value="${needle}" aria-label="f"><textarea aria-label="t">${needle}</textarea>`;
    case 'hidden': return `<p hidden>${needle}</p><div style="display:none">${needle}</div><p aria-hidden="true">${needle}</p>`;
    case 'editable': return `<div contenteditable="true">${needle}</div>`;
    case 'script': return `<script>window.tvValue = "${needle}";</script><style>/* ${needle} */</style>`;
    case 'iframe': return `<iframe title="child" srcdoc="&lt;p&gt;${needle}&lt;/p&gt;"></iframe>`;
    // Built from halves so the needle is never in the light DOM, even inside the script.
    case 'shadow': return `<div id="host"></div><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>' + ['${a}', '${b}'].join('') + '</p>';</script>`;
    default: return '<p>Nothing to see here.</p>';
  }
}

function expandedPage(url) {
  const doc = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
    <style>${STYLE}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  if (pageTitles.has(url)) return doc(pageTitles.get(url), '<p>An archived page.</p>');
  const [, slug] = url.match(ARCHIVE) || [];
  if (slug) return doc(archiveTitle(slug), '<p>An archived page.</p>');
  const [, kind] = url.match(CONTENT) || [];
  if (kind) {
    const entry = contentPages.get(url);
    const title = kind === 'titled' && entry ? `Ledger ${entry.needle}` : 'Unrelated ledger';
    return doc(title, entry ? contentBody(entry.kind, entry.needle) : contentBody('plain'));
  }
  return null;
}

const CLICK = `
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6"); xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]; x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d: raise SystemExit("Cannot open test display")
xtst.XTestFakeMotionEvent(d, -1, int(sys.argv[1]), int(sys.argv[2]), 0); x11.XFlush(d); time.sleep(0.15)
xtst.XTestFakeButtonEvent(d, 1, 1, 0); x11.XFlush(d); time.sleep(0.05)
xtst.XTestFakeButtonEvent(d, 1, 0, 0); x11.XFlush(d)
x11.XCloseDisplay(d)`;

/** A real X pointer click at screen pixel (x, y) on the isolated test display. */
export function nativeClick(env, x, y) {
  if (!env.DISPLAY?.startsWith(':')) throw new Error('An isolated local DISPLAY is required');
  execFileSync('python3', ['-c', CLICK, String(Math.round(x)), String(Math.round(y))], { env });
}
