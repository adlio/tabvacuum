#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const FIREFOX_DIST = path.join(DIST, 'firefox');
const CHROME_DIST = path.join(DIST, 'chrome');

function cleanDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

// Clean and create dist directories
cleanDirectory(FIREFOX_DIST);
cleanDirectory(CHROME_DIST);

// Copy all src/ files except manifest.*.json into both directories
const manifestFiles = ['manifest.firefox.json', 'manifest.chrome.json'];

for (const entry of fs.readdirSync(SRC)) {
  if (manifestFiles.includes(entry)) continue;

  const srcPath = path.join(SRC, entry);
  const stat = fs.statSync(srcPath);

  if (stat.isDirectory()) {
    copyDirectory(srcPath, path.join(FIREFOX_DIST, entry));
    copyDirectory(srcPath, path.join(CHROME_DIST, entry));
  } else {
    copyFile(srcPath, path.join(FIREFOX_DIST, entry));
    copyFile(srcPath, path.join(CHROME_DIST, entry));
  }
}

// Copy browser-specific manifests
copyFile(
  path.join(SRC, 'manifest.firefox.json'),
  path.join(FIREFOX_DIST, 'manifest.json')
);
copyFile(
  path.join(SRC, 'manifest.chrome.json'),
  path.join(CHROME_DIST, 'manifest.json')
);

// Copy webextension-polyfill
const polyfillPath = path.join(
  ROOT,
  'node_modules',
  'webextension-polyfill',
  'dist',
  'browser-polyfill.js'
);

if (fs.existsSync(polyfillPath)) {
  copyFile(polyfillPath, path.join(FIREFOX_DIST, 'browser-polyfill.js'));
  copyFile(polyfillPath, path.join(CHROME_DIST, 'browser-polyfill.js'));
  console.log('Copied browser-polyfill.js to both dist directories.');
} else {
  console.warn('WARNING: webextension-polyfill not found. Run "npm install" first.');
}

console.log('Build complete.');
console.log(`  Firefox: ${FIREFOX_DIST}`);
console.log(`  Chrome:  ${CHROME_DIST}`);
