// popup.js — TabVacuum popup UI

const status = document.getElementById('status');
const btnDupes = document.getElementById('btn-dupes');
const btnMerge = document.getElementById('btn-merge');
const btnSort = document.getElementById('btn-sort');
const sortCriteria = document.getElementById('sort-criteria');
const sortDirection = document.getElementById('sort-direction');
const btnStale = document.getElementById('btn-stale');

let direction = 'asc';

function showStatus(message) {
  status.textContent = message;
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 3000);
}

async function sendCommand(command, params = {}) {
  try {
    const result = await browser.runtime.sendMessage({ command, ...params });
    showStatus(result.message);
  } catch (err) {
    showStatus('Error: ' + err.message);
  }
}

// Load last sort settings
browser.runtime.sendMessage({ command: 'getSettings' }).then((settings) => {
  if (settings.lastSortCriteria) sortCriteria.value = settings.lastSortCriteria;
  if (settings.lastSortDirection === 'desc') {
    direction = 'desc';
    sortDirection.textContent = '\u2193';
  }
});

btnDupes.addEventListener('click', () => sendCommand('closeDuplicates'));
btnMerge.addEventListener('click', () => sendCommand('mergeWindows'));
btnSort.addEventListener('click', () => {
  sendCommand('sortTabs', { criteria: sortCriteria.value, direction });
});
sortDirection.addEventListener('click', () => {
  direction = direction === 'asc' ? 'desc' : 'asc';
  sortDirection.textContent = direction === 'asc' ? '\u2191' : '\u2193';
});
btnStale.addEventListener('click', () => sendCommand('closeStaleTabs'));
