// The Ask first prompt page (R14.11): renders what the background says,
// sends only a choice, and never builds markup from page data.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { startAsk } from '../src/ask.js';
import { mountFixture } from './mocks/dom.js';

const html = readFileSync(new URL('../src/ask.html', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

function setup(info, choiceReply = { state: 'switched' }) {
  const { document, byId } = mountFixture(html);
  const sendMessage = vi.fn(async m => (m.command === 'dupeAskInfo' ? info : choiceReply));
  const location = { replace: vi.fn() };
  const { ready } = startAsk({ document, browser: { runtime: { sendMessage } }, location });
  return { $: id => byId.get(id), sendMessage, ready, location };
}

describe('Ask first prompt page', () => {
  it('shows the open tab title as text and focuses Switch, so Enter switches', async () => {
    const ui = setup({ state: 'ask', title: '<img src=x onerror=alert(1)> Roadmap', host: 'docs.example.com', otherWindow: true });
    await ui.ready;
    expect(ui.$('ask-title').textContent).toBe('<img src=x onerror=alert(1)> Roadmap');
    expect(ui.$('ask-title').childNodes.every(n => typeof n === 'string')).toBe(true);
    expect(ui.$('ask-detail').textContent).toBe('docs.example.com is already open in another window. Switch to it, or keep this tab too.');
    expect(ui.$('ask-form').hidden).toBe(false);
    expect(ui.$('ask-switch').type ?? 'submit').toBe('submit');
    ui.$('ask-form').dispatch('submit', { preventDefault: () => {} });
    await settle();
    expect(ui.sendMessage).toHaveBeenLastCalledWith({ command: 'dupeAskChoice', choice: 'switch' });
  });

  it('Keep both sends keep, and only one choice is sent', async () => {
    const ui = setup({ state: 'ask', title: 'Roadmap', host: 'docs.example.com', otherWindow: false });
    await ui.ready;
    ui.$('ask-keep').dispatch('click');
    ui.$('ask-keep').dispatch('click');
    await settle();
    expect(ui.sendMessage.mock.calls.filter(([m]) => m.command === 'dupeAskChoice')).toEqual([[{ command: 'dupeAskChoice', choice: 'keep' }]]);
  });

  it('Keep both replaces the prompt with the page (web URLs only), so the prompt leaves no history entry', async () => {
    const info = { state: 'ask', title: 'Roadmap', host: 'docs.example.com' };
    const ui = setup(info, { state: 'kept', url: 'https://docs.example.com/d/1' });
    await ui.ready;
    ui.$('ask-keep').dispatch('click');
    await settle();
    expect(ui.location.replace).toHaveBeenCalledWith('https://docs.example.com/d/1');
    const bad = setup(info, { state: 'kept', url: 'javascript:alert(1)' });
    await bad.ready;
    bad.$('ask-keep').dispatch('click');
    await settle();
    expect(bad.location.replace).not.toHaveBeenCalled();
  });

  it('a prompt with nothing to ask shows only a status line', async () => {
    const ui = setup({ state: 'restored' });
    await ui.ready;
    expect(ui.$('ask-form').hidden).toBe(true);
    expect(ui.$('ask-status').textContent).toBe('Opening the page…');
  });

  it('the page is not web-accessible and names no TabVacuum internals', () => {
    for (const file of ['src/manifest.chrome.json', 'src/manifest.firefox.json']) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).not.toContain('ask.html');
    }
    expect(html).toContain("<title>Already open — Aaron's Tab Vacuum</title>");
    expect(html).not.toMatch(/TabVacuum/);
  });
});
