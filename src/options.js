// TabVacuum settings page

const elements = {
  staleValue: document.getElementById('stale-value'),
  staleUnit: document.getElementById('stale-unit'),
  ignoreFragments: document.getElementById('ignore-fragments'),
  ignoreQuery: document.getElementById('ignore-query'),
  skipPinned: document.getElementById('skip-pinned'),
  skipAudible: document.getElementById('skip-audible'),
  status: document.getElementById('status')
};

const TIME_UNITS = {
  HOUR_MS: 60 * 60 * 1000,
  DAY_MS: 24 * 60 * 60 * 1000
};

function millisecondsToTimeValue(ms) {
  const hours = ms / TIME_UNITS.HOUR_MS;
  const days = ms / TIME_UNITS.DAY_MS;

  if (Number.isInteger(days) && days >= 1) {
    return { value: days, unit: 'days' };
  }
  return { value: hours, unit: 'hours' };
}

function timeValueToMilliseconds(value, unit) {
  const multiplier = unit === 'days' ? TIME_UNITS.DAY_MS : TIME_UNITS.HOUR_MS;
  return value * multiplier;
}

function showStatus(message) {
  elements.status.textContent = message;
  elements.status.classList.add('visible');
  setTimeout(() => elements.status.classList.remove('visible'), 2000);
}

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ command: 'getSettings' });
  const { value, unit } = millisecondsToTimeValue(settings.staleThresholdMs);

  elements.staleValue.value = value;
  elements.staleUnit.value = unit;
  elements.ignoreFragments.checked = settings.ignoreFragments;
  elements.ignoreQuery.checked = settings.ignoreQueryParams;
  elements.skipPinned.checked = settings.skipPinned;
  elements.skipAudible.checked = settings.skipAudible;
}

async function saveSettings() {
  const settings = {
    staleThresholdMs: timeValueToMilliseconds(
      Number(elements.staleValue.value),
      elements.staleUnit.value
    ),
    ignoreFragments: elements.ignoreFragments.checked,
    ignoreQueryParams: elements.ignoreQuery.checked,
    skipPinned: elements.skipPinned.checked,
    skipAudible: elements.skipAudible.checked,
  };

  await browser.runtime.sendMessage({ command: 'saveSettings', settings });
  showStatus('Settings saved');
}

// Set up event listeners
Object.values(elements).forEach(element => {
  if (element.id !== 'status') {
    element.addEventListener('change', saveSettings);
  }
});

// Load settings on startup
loadSettings();
