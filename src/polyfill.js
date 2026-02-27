// ESM wrapper for webextension-polyfill
// The UMD polyfill can't be imported directly as a module.
// For Chrome: load browser-polyfill.js via importScripts before modules.
// For Firefox: browser.* is native, no polyfill needed.
if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}
