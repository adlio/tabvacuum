// TabVacuum popup UI

const elements = {
  status: document.getElementById('status'),
  btnDupes: document.getElementById('btn-dupes'),
  btnMerge: document.getElementById('btn-merge'),
  btnSort: document.getElementById('btn-sort'),
  sortOptions: document.querySelector('.sort-options'),
  btnStale: document.getElementById('btn-stale')
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
}

// Action buttons
elements.btnDupes.addEventListener('click', () => sendCommand('closeDuplicates'));
elements.btnMerge.addEventListener('click', () => sendCommand('mergeWindows'));
elements.btnStale.addEventListener('click', () => sendCommand('closeStaleTabs'));

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
