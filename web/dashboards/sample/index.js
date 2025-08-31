import { wsConnect, api } from '/lib/dashboard-sdk.js';

const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const wsStatus = $('wsstatus');
const logEl = $('log');
const latestEl = $('latest');
const labelsEl = $('labels');

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}

let lastPowLabels = [];
const ws = wsConnect({
  onOpen: () => { wsStatus.textContent = 'WS: connected'; },
  onClose: () => { wsStatus.textContent = 'WS: disconnected (retrying)'; },
  onError: () => { wsStatus.textContent = 'WS: error'; },
  onType: {
    hello: (p) => log(`server: ${p.message}`),
    labels: (p) => {
      if (p.streamName === 'pow') {
        lastPowLabels = Array.isArray(p.labels) ? p.labels : [];
        labelsEl.textContent = `labels: ${lastPowLabels.join(', ')}`;
      }
    },
    pow: (payload) => {
      const { pow, time } = payload || {};
      if (!Array.isArray(pow)) return;
      latestEl.textContent = `t=${time} pow[0..4]=${pow.slice(0,5).map((x) => x.toFixed(3)).join(', ')}`;
    },
  }
});

startBtn.addEventListener('click', async () => {
  try {
    const res = await api.stream.start('pow');
    log('start pow ok');
  } catch (e) {
    log('start pow error: ' + e.message);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await api.stream.stop('pow');
    log('stop pow ok');
  } catch (e) {
    log('stop pow error: ' + e.message);
  }
});

