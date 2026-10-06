import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// The icon exports are non-interlaced eight-bit RGBA PNGs. Decode their
// scanlines here so a changed generator cannot hide stale committed pixels.
function opaqueColors(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  expect([png[24], png[25], png[28]]).toEqual([8, 6, 0]);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  const colors = new Set();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const corner = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0;
      const prediction = left + up - corner;
      const dl = Math.abs(prediction - left), du = Math.abs(prediction - up), dc = Math.abs(prediction - corner);
      const paeth = dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      const adjustment = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[index] = (raw[y * (stride + 1) + x + 1] + adjustment) & 255;
    }
  }
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 255) colors.add(`#${pixels.subarray(i, i + 3).toString('hex')}`);
  }
  return [...colors].sort();
}

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root));
const json = name => JSON.parse(read(name));
const manifests = ['firefox', 'chrome'].map(browser => [browser, json(`src/manifest.${browser}.json`)]);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkIcon(file, size) {
  const bytes = read(`src/${file}`);
  expect(bytes.subarray(0, 8)).toEqual(signature);
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
  expect(bytes.readUInt32BE(16)).toBe(Number(size));
  expect(bytes.readUInt32BE(20)).toBe(Number(size));
  expect(bytes[24]).toBe(8); // Eight-bit channels.
  expect(bytes[25]).toBe(6); // RGBA: transparent toolbar and store-icon padding.
  expect(bytes.length).toBeGreaterThan(100);
}

for (const [browser, manifest] of manifests) {
  describe(`${browser} branding`, () => {
    it("uses Aaron's Tab Vacuum as the display brand and ATV as the short name", () => {
      expect(manifest.name).toBe("Aaron's Tab Vacuum");
      expect(manifest.short_name).toBe('ATV');
      expect(manifest.action.default_title).toBe("Aaron's Tab Vacuum — Search, Sort & Clean Up");
      expect(manifest.description).toBe('Find tabs fast, sort them your way, and clear duplicates, stale tabs and blank pages. Built for keyboard control.');
      expect(manifest.description).toBe(json('package.json').description);
      expect(manifest.description.length).toBeLessThanOrEqual(132);
      expect(manifest.name.length).toBeLessThanOrEqual(45);
      const listing = read('branding/listing.txt').toString();
      expect(listing).toContain(manifest.name);
      expect(listing).toContain(manifest.description);
    });

    it('adds only alarms while preserving released IDs, host access and shortcut bindings', () => {
      expect(manifest.permissions).toEqual(['tabs', 'history', 'notifications', 'storage', 'contextMenus', 'activeTab', 'scripting', 'alarms']);
      const hosts = browser === 'firefox' ? manifest.optional_permissions : manifest.optional_host_permissions;
      expect(hosts).toEqual(['http://*/*', 'https://*/*']);
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.web_accessible_resources).toEqual([{ resources: ['search.html'], matches: ['http://*/*', 'https://*/*'] }]);
      expect(manifest.key).toBeUndefined(); // Chrome's store-assigned ID is unaffected by display metadata.
      if (browser === 'firefox') expect(manifest.browser_specific_settings.gecko.id).toBe('tabvacuum@adlio');
      else expect(manifest.incognito).toBe('split');
      expect(manifest.commands).toEqual({
        'close-duplicates': { suggested_key: { default: 'Alt+Shift+D' }, description: 'Close duplicate tabs' },
        'merge-windows': { suggested_key: { default: 'Alt+Shift+M' }, description: 'Merge all windows' },
        'sort-tabs': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Sort tabs' },
        'search-tabs': { suggested_key: { default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period' }, description: 'Search tabs' },
        'close-stale': { description: 'Review stale tabs' },
        'close-blank': { description: 'Close blank tabs' },
      });
      expect(manifest.version).toBeUndefined(); // Build stamps the package version.
    });

    for (const [kind, icons] of [['product', manifest.icons], ['toolbar', manifest.action.default_icon]]) {
      it.each(Object.entries(icons))(`${kind} %s has a matching transparent PNG`, (size, file) => {
        checkIcon(file, size);
      });
    }

    it('provides dedicated toolbar sizes, not downscaled store tiles', () => {
      expect(Object.keys(manifest.action.default_icon)).toEqual(['16', '20', '24', '32', '48', '64']);
      for (const file of Object.values(manifest.action.default_icon)) expect(file).toMatch(/toolbar-/);
      expect(manifest.icons['128']).toBe('icons/icon-128.png');
    });
  });
}

describe('Little Vacuum artwork', () => {
  it('maps Firefox light ink to light-text themes only', () => {
    const firefox = manifests[0][1];
    for (const icon of firefox.action.theme_icons) {
      expect(icon.dark).toBe(`icons/toolbar-${icon.size}.png`);
      expect(icon.light).toBe(`icons/toolbar-light-${icon.size}.png`);
      checkIcon(icon.dark, icon.size);
      checkIcon(icon.light, icon.size);
      expect(read(`src/${icon.dark}`).equals(read(`src/${icon.light}`))).toBe(false);
    }
    expect(manifests[1][1].action.theme_icons).toBeUndefined();
  });

  it('keeps approved and optical SVG masters with stable shape IDs', () => {
    for (const file of ['branding/little-vacuum.svg', 'branding/toolbar.svg']) {
      const source = read(file).toString();
      for (const id of ['vacuum', 'hose', 'nozzle', 'canister', 'handle']) expect(source).toContain(`id="${id}"`);
      expect(source).toContain('viewBox=');
      expect(source).not.toMatch(/<script|<foreignObject|<image|href=/);
    }
    expect(read('branding/toolbar.svg').toString()).toContain('stroke-width="2"');
  });

  it('uses the optical master in the popup with a decorative accessible image', () => {
    const source = read('src/icons/brand.svg').toString();
    const optical = read('branding/toolbar.svg').toString().match(/<g id="vacuum"[\s\S]*<\/g>/)[0];
    expect(source).toContain(optical);
    expect(source).toContain('prefers-color-scheme: dark');
    expect(read('src/popup.html').toString()).toContain('src="icons/brand.svg" width="23" height="23" alt=""');
  });
});

describe('0.6.0 brand surfaces', () => {
  it('keeps the package identity and aligns package and lockfile root versions', () => {
    const pkg = json('package.json');
    const lock = json('package-lock.json');
    expect(pkg.name).toBe('tabvacuum');
    expect(pkg.version).toBe('0.6.0');
    expect([lock.name, lock.version]).toEqual(['tabvacuum', '0.6.0']);
    expect([lock.packages[''].name, lock.packages[''].version]).toEqual(['tabvacuum', '0.6.0']);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
  });

  it('shows the display brand on every extension page and notification', () => {
    const page = name => read(`src/${name}`).toString();
    expect(page('popup.html')).toContain("<title>Aaron's Tab Vacuum</title>");
    expect(page('popup.html')).toContain('<span class="logo">Aaron\'s Tab Vacuum</span>');
    expect(page('options.html')).toContain("<title>Aaron's Tab Vacuum Settings</title>");
    expect(page('options.html')).toContain("<h1>Aaron's Tab Vacuum Settings</h1>");
    expect(page('search.html')).toContain("<title>Search tabs — Aaron's Tab Vacuum</title>");
    expect(page('background.js')).toContain(`title: "Aaron's Tab Vacuum",`);
    for (const name of ['popup.html', 'options.html', 'search.html']) expect(page(name)).not.toMatch(/TabVacuum/);
  });

  it('carries no former-name or transition wording in public copy', () => {
    for (const file of ['branding/listing.txt', 'README.md', 'src/popup.html', 'src/options.html', 'src/search.html']) {
      expect(read(file).toString()).not.toMatch(/formerly|previously (called|known)|renamed|new name|rebrand/i);
    }
  });
});

describe('Chrome toolbar contrast', () => {
  it('uses dedicated coral exports that contrast with the measured light and dark toolbars', () => {
    const chrome = manifests.find(([name]) => name === 'chrome')[1];
    expect(chrome.icons['16']).toBe('icons/toolbar-chrome-16.png');
    for (const [size, file] of Object.entries(chrome.action.default_icon)) {
      expect(file).toBe(`icons/toolbar-chrome-${size}.png`);
      checkIcon(file, size);
    }
    const generator = read('scripts/gen-icons.js').toString();
    const color = generator.match(/const chromeToolbarColor = '(#[a-f0-9]{6})';/)?.[1];
    expect(color).toBeDefined();
    expect(opaqueColors(read('src/icons/toolbar-chrome-16.png'))).toEqual([color]);
    expect(opaqueColors(read('src/icons/toolbar-16.png'))).toEqual(['#c45140']);
    const luminance = hex => {
      const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const backdrop of ['#ffffff', '#3c3c3c']) {
      const [low, high] = [luminance(color), luminance(backdrop)].sort((a, b) => a - b);
      expect((high + 0.05) / (low + 0.05)).toBeGreaterThanOrEqual(3);
    }
    expect(generator).toContain("toolbar.replace('#c45140', chromeToolbarColor)");
  });
});
