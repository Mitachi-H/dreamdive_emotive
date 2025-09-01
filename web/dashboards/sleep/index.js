import { wsConnect, api } from '/lib/dashboard-sdk.js';

const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const wsStatus = $('wsstatus');
const stateEl = $('state');
const ratioEl = $('ratio');

let powLabels = [];

function calcState(pow) {
  const bandSums = { theta:0, alpha:0, betaL:0, betaH:0, gamma:0 };
  const counts = { theta:0, alpha:0, betaL:0, betaH:0, gamma:0 };
  powLabels.forEach((lab, i) => {
    const v = pow[i] || 0;
    const parts = lab.split('/');
    if (parts.length === 2) {
      const band = parts[1];
      if (bandSums[band] !== undefined) {
        bandSums[band] += v;
        counts[band]++;
      }
    }
  });
  const avg = (band, def=0) => counts[band] ? bandSums[band]/counts[band] : def;
  const theta = avg('theta');
  const alpha = avg('alpha');
  const beta = (avg('betaL') + avg('betaH')) / 2;
  const ratio = theta / (alpha + beta + 1e-6);
  let state = 'Awake';
  if (ratio > 1.5) state = 'Sleep';
  else if (ratio > 1.0) state = 'Drowsy';
  return { ratio, state };
}

const ws = wsConnect({
  onOpen: () => { wsStatus.textContent = 'WS: connected'; },
  onClose: () => { wsStatus.textContent = 'WS: disconnected (retrying)'; },
  onError: () => { wsStatus.textContent = 'WS: error'; },
  onType: {
    labels: (p) => {
      if (p.streamName === 'pow' && Array.isArray(p.labels)) {
        powLabels = p.labels;
      }
    },
    pow: (payload) => {
      const arr = payload.pow || [];
      if (!arr.length || !powLabels.length) return;
      const { ratio, state } = calcState(arr);
      stateEl.textContent = state;
      ratioEl.textContent = `theta/(alpha+beta): ${ratio.toFixed(2)}`;
    }
  }
});

startBtn.addEventListener('click', async () => {
  try {
    await api.stream.start('pow');
  } catch (e) {
    alert('start error: ' + e.message);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await api.stream.stop('pow');
  } catch (e) {
    alert('stop error: ' + e.message);
  }
});
