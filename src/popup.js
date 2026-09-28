// TabVacuum popup UI
import { renderShortcuts } from './shortcuts.js';

const elements = {
  status: document.getElementById('status'),
  btnDupes: document.getElementById('btn-dupes'),
  btnMerge: document.getElementById('btn-merge'),
  btnSort: document.getElementById('btn-sort'),
  sortOptions: document.querySelector('.sort-options'),
  btnStale: document.getElementById('btn-stale'),
  btnBlank: document.getElementById('btn-blank')
};

function showStatus(message) {
  elements.status.textContent = message;
  elements.status.classList.add('visible');
  setTimeout(() => elements.status.classList.remove('visible'), 3000);
}

async function sendCommand(command, params = {}) {
  try {
    const result = await browser.runtime.sendMessage({ command, ...params });
    showStatus(result.message);
  } catch (error) {
    showStatus(`Error: ${error.message}`);
  }
}

function toggleSortOptions() {
  const isHidden = elements.sortOptions.hidden;
  elements.sortOptions.hidden = !isHidden;
  elements.btnSort.setAttribute('aria-expanded', String(isHidden));
}

// Action buttons
elements.btnDupes.addEventListener('click', () => sendCommand('closeDuplicates'));
elements.btnMerge.addEventListener('click', () => sendCommand('mergeWindows'));
elements.btnStale.addEventListener('click', () => sendCommand('closeStaleTabs'));
elements.btnBlank.addEventListener('click', () => sendCommand('closeBlankTabs'));

// Sort Tabs toggle
elements.btnSort.addEventListener('click', toggleSortOptions);

// Sort option buttons — each fires immediately
elements.sortOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-criteria]');
  if (!btn) return;
  sendCommand('sortTabs', {
    criteria: btn.dataset.criteria,
    direction: btn.dataset.direction
  });
});

// Opening the menu granted activeTab for this window's page; the background
// shows search over it (or in a separate window) and this menu gets out of the way.
document.getElementById('btn-search').addEventListener('click', async () => {
  try {
    const result = await browser.runtime.sendMessage({ command: 'launchSearch' });
    if (result?.error) throw new Error(result.error);
    window.close();
  } catch (error) {
    showStatus(`Error: ${error.message}`);
  }
});
renderShortcuts(document, browser);
document.body.classList.add('ready');
