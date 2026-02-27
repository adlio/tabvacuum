// TabVacuum popup UI

const elements = {
  status: document.getElementById('status'),
  btnDupes: document.getElementById('btn-dupes'),
  btnMerge: document.getElementById('btn-merge'),
  btnSort: document.getElementById('btn-sort'),
  sortCriteria: document.getElementById('sort-criteria'),
  sortDirection: document.getElementById('sort-direction'),
  btnStale: document.getElementById('btn-stale')
};

let sortState = {
  direction: 'asc'
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

function updateSortDirectionButton() {
  const arrow = sortState.direction === 'asc' ? '\u2191' : '\u2193';
  elements.sortDirection.textContent = arrow;
}

function toggleSortDirection() {
  sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
  updateSortDirectionButton();
}

// Initialize UI with saved settings
async function initializeUI() {
  const settings = await browser.runtime.sendMessage({ command: 'getSettings' });

  if (settings.lastSortCriteria) {
    elements.sortCriteria.value = settings.lastSortCriteria;
  }

  if (settings.lastSortDirection) {
    sortState.direction = settings.lastSortDirection;
    updateSortDirectionButton();
  }
}

// Set up event listeners
elements.btnDupes.addEventListener('click', () => sendCommand('closeDuplicates'));
elements.btnMerge.addEventListener('click', () => sendCommand('mergeWindows'));
elements.btnStale.addEventListener('click', () => sendCommand('closeStaleTabs'));

elements.btnSort.addEventListener('click', () => {
  sendCommand('sortTabs', {
    criteria: elements.sortCriteria.value,
    direction: sortState.direction
  });
});

elements.sortDirection.addEventListener('click', toggleSortDirection);

// Initialize on load
initializeUI();
