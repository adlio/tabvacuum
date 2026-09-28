import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { startContentPermissions, CONTENT_ORIGINS } from '../src/content-permissions.js';

const ORIGINS = { origins: ['http://*/*', 'https://*/*'] };
const IDS = ['content-permissions', 'content-access-state', 'content-access-allow',
  'content-access-revoke', 'content-access-message'];

function element() {
  const handlers = {};
  return {
    textContent: '', disabled: false, dataset: {}, handlers,
    addEventListener: vi.fn((type, fn) => { (handlers[type] ||= []).push(fn); }),
  };
}

function setup({ granted = false, permissions = {}, confirm = () => true } = {}) {
  const els = Object.fromEntries(IDS.map(id => [id, element()]));
  const document = { getElementById: id => els[id] ?? null, defaultView: { confirm: vi.fn(confirm) } };
  const event = () => ({ addListener: vi.fn() });
  const browser = {
    permissions: {
      contains: vi.fn(async () => granted),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      onAdded: event(), onRemoved: event(),
      ...permissions,
    },
  };
  const controller = startContentPermissions({ document, browser });
  const click = id => Promise.all(els[id].handlers.click.map(fn => fn()));
  return { els, document, browser, controller, click,
    state: () => els['content-access-state'].textContent,
    message: () => els['content-access-message'].textContent };
}

describe('content permission settings', () => {
  it('uses only the http and https origins', () => {
    expect([...CONTENT_ORIGINS]).toEqual(ORIGINS.origins);
  });

  it('shows current status without prompting', async () => {
    const env = setup({ granted: true });
    await env.controller.ready;
    expect(env.browser.permissions.contains).toHaveBeenCalledWith(ORIGINS);
    expect(env.browser.permissions.request).not.toHaveBeenCalled();
    expect(env.state()).toBe('Allowed');
    expect(env.els['content-access-allow'].disabled).toBe(true);
    expect(env.els['content-access-revoke'].disabled).toBe(false);
  });

  it('requests synchronously inside the click, before any await', () => {
    const env = setup({ permissions: { contains: vi.fn(() => new Promise(() => {})), request: vi.fn(() => new Promise(() => {})) } });
    const [handler] = env.els['content-access-allow'].handlers.click;
    handler();
    expect(env.browser.permissions.request).toHaveBeenCalledTimes(1);
    expect(env.browser.permissions.request).toHaveBeenCalledWith(ORIGINS);
  });

  it('reports an accepted request and refreshes status', async () => {
    let granted = false;
    const env = setup({ permissions: {
      contains: vi.fn(async () => granted),
      request: vi.fn(async () => { granted = true; return true; }),
    } });
    await env.controller.ready;
    expect(env.state()).toBe('Not allowed');
    await env.click('content-access-allow');
    expect(env.message()).toMatch(/allowed/i);
    expect(env.state()).toBe('Allowed');
  });

  it('reports a denied request', async () => {
    const env = setup({ permissions: { request: vi.fn(async () => false) } });
    await env.click('content-access-allow');
    expect(env.message()).toBe('Website access was not allowed.');
    expect(env.state()).toBe('Not allowed');
  });

  it('reports a rejected or throwing request', async () => {
    const rejected = setup({ permissions: { request: vi.fn(async () => { throw new Error('no'); }) } });
    await rejected.click('content-access-allow');
    expect(rejected.message()).toBe('Could not request website access.');
    const thrown = setup({ permissions: { request: vi.fn(() => { throw new Error('sync'); }) } });
    await thrown.click('content-access-allow');
    expect(thrown.message()).toBe('Could not request website access.');
  });

  it('revokes only after confirmation', async () => {
    const env = setup({ granted: true });
    await env.click('content-access-revoke');
    expect(env.document.defaultView.confirm).toHaveBeenCalledTimes(1);
    expect(env.browser.permissions.remove).toHaveBeenCalledWith(ORIGINS);
    expect(env.message()).toBe('Website access removed.');

    const cancelled = setup({ granted: true, confirm: () => false });
    await cancelled.click('content-access-revoke');
    expect(cancelled.browser.permissions.remove).not.toHaveBeenCalled();
  });

  it('reports a failed revocation', async () => {
    const env = setup({ granted: true, permissions: { remove: vi.fn(async () => { throw new Error('x'); }) } });
    await env.click('content-access-revoke');
    expect(env.message()).toBe('Could not remove website access.');
  });

  it('handles a missing permissions API gracefully', () => {
    const els = Object.fromEntries(IDS.map(id => [id, element()]));
    const document = { getElementById: id => els[id] };
    expect(startContentPermissions({ document, browser: {} })).toBeNull();
    expect(els['content-access-state'].textContent).toBe('Not available in this browser');
    expect(els['content-access-allow'].disabled).toBe(true);
    expect(els['content-access-allow'].addEventListener).not.toHaveBeenCalled();
  });

  it('handles missing permission events and a failed status check', async () => {
    const env = setup({ permissions: { onAdded: undefined, onRemoved: undefined,
      contains: vi.fn(async () => { throw new Error('x'); }) } });
    await env.controller.ready;
    expect(env.state()).toBe('Could not check');
  });

  it('does nothing without its section', () => {
    const browser = { permissions: { contains: vi.fn(), request: vi.fn() } };
    expect(startContentPermissions({ document: { getElementById: () => null }, browser })).toBeNull();
    expect(browser.permissions.contains).not.toHaveBeenCalled();
  });

  it('registers listeners once and refreshes on permission changes', async () => {
    const env = setup();
    expect(startContentPermissions({ document: env.document, browser: env.browser })).toBeNull();
    const { onAdded, onRemoved } = env.browser.permissions;
    expect(onAdded.addListener).toHaveBeenCalledTimes(1);
    expect(onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(env.els['content-access-allow'].addEventListener).toHaveBeenCalledTimes(1);
    expect(env.els['content-access-revoke'].addEventListener).toHaveBeenCalledTimes(1);
    env.browser.permissions.contains.mockResolvedValue(true);
    await onAdded.addListener.mock.calls[0][0]();
    expect(env.state()).toBe('Allowed');
  });

  it('is loaded as a module after the polyfill, outside the settings form', () => {
    const html = readFileSync(new URL('../src/options.html', import.meta.url), 'utf8');
    const polyfill = html.indexOf('<script src="browser-polyfill.js">');
    const module = html.indexOf('<script type="module" src="content-permissions.js">');
    expect(polyfill).toBeGreaterThan(-1);
    expect(module).toBeGreaterThan(polyfill);
    expect(html.indexOf('id="content-permissions"')).toBeGreaterThan(html.indexOf('</form>'));
    expect(html).toContain('<html lang="en">');
    for (const id of IDS) expect(html).toContain(`id="${id}"`);
  });
});
