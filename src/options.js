// options.js — TabVacuum settings page

const staleValue = document.getElementById('stale-value');
const staleUnit = document.getElementById('stale-unit');
const ignoreFragments = document.getElementById('ignore-fragments');
const ignoreQuery = document.getElementById('ignore-query');
const skipPinned = document.getElementById('skip-pinned');
const skipAudible = document.getElementById('skip-audible');
const status = document.getElementById('status');

function msToValueUnit(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours % 24 === 0 && hours >= 24) {
    return { value: hours / 24, unit: 'days' };
  }
  return { value: hours, unit: 'hours' };
}

function valueUnitToMs(value, unit) {
  const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return value * multiplier;
}

function showStatus(message) {
  status.textContent = message;
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 2000);
}

// Load settings
browser.runtime.sendMessage({ command: 'getSettings' }).then((settings) => {
  const { value, unit } = msToValueUnit(settings.staleThresholdMs);
  staleValue.value = value;
  staleUnit.value = unit;
  ignoreFragments.checked = settings.ignoreFragments;
  ignoreQuery.checked = settings.ignoreQueryParams;
  skipPinned.checked = settings.skipPinned;
  skipAudible.checked = settings.skipAudible;
});

// Save on change
function saveSettings() {
  const settings = {
    staleThresholdMs: valueUnitToMs(Number(staleValue.value), staleUnit.value),
    ignoreFragments: ignoreFragments.checked,
    ignoreQueryParams: ignoreQuery.checked,
    skipPinned: skipPinned.checked,
    skipAudible: skipAudible.checked,
  };
  browser.runtime.sendMessage({ command: 'saveSettings', settings }).then(() => {
    showStatus('Settings saved');
  });
}

staleValue.addEventListener('change', saveSettings);
staleUnit.addEventListener('change', saveSettings);
ignoreFragments.addEventListener('change', saveSettings);
ignoreQuery.addEventListener('change', saveSettings);
skipPinned.addEventListener('change', saveSettings);
skipAudible.addEventListener('change', saveSettings);
