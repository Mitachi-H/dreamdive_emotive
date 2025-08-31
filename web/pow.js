import { state, deriveFromLabels } from './pow/state.js';
import { buildGrid, updateGrid } from './pow/grid.js';
import { TOPO_SENSORS, drawHeadOverlay, updateTopomapsFromPowArray } from './pow/topomap.js';

(function main() {
  const powEl = document.getElementById('pow');
  const powLenEl = document.getElementById('powLen');
  const powTimeEl = document.getElementById('powTime');
  const powSidEl = document.getElementById('powSid');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');
  const gridEl = document.getElementById('grid');
  const toggleRaw = document.getElementById('toggleRaw');
  const toggleLabels = document.getElementById('toggleLabels');
  const topoCanvases = {
    theta: document.getElementById('topo-theta'),
    alpha: document.getElementById('topo-alpha'),
    betaL: document.getElementById('topo-betaL'),
    betaH: document.getElementById('topo-betaH'),
    gamma: document.getElementById('topo-gamma'),
  };

  const getHeaders = () => {
    const h = {};
    const t = localStorage.getItem('dashboard_token');
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'labels' && msg.payload && msg.payload.streamName === 'pow') {
          const labs = Array.isArray(msg.payload.labels) ? msg.payload.labels : [];
          if (labs.length) {
            state.labels = labs;
            const derived = deriveFromLabels(labs);
            state.sensors = derived.sensors;
            state.bands = derived.bands;
            state.indexByLabel = derived.indexByLabel;
            state.rollingMax = Array(labs.length).fill(1);
            buildGrid(gridEl, state);
          }
          return;
        }
        if (msg.type === 'pow') {
          const p = msg.payload || {};
          const arr = p.pow || [];
          state.lastPow = arr;
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          powTimeEl.textContent = t;
          powLenEl.textContent = String(arr.length);
          if (powSidEl) powSidEl.textContent = p.sid || '-';
          if (state.labels.length && state.sensors.length && state.bands.length) {
            updateGrid(gridEl, state, arr);
            const haveAll = TOPO_SENSORS.every(s => state.labels.some(l => l.startsWith(s + '/')));
            if (haveAll) updateTopomapsFromPowArray(arr, topoCanvases, state);
          }
          powEl.textContent = JSON.stringify(arr, null, 2);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
    ws.addEventListener('error', () => {});
  }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/pow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ headsetId: hid })
      });
      const j = await res.json();
      if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/pow/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json();
      if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  connect();

  // Persist and preload headsetId
  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => {
    const v = headsetIdInput.value.trim();
    if (v) localStorage.setItem('headset_id', v);
  });

  // Raw toggle
  toggleRaw?.addEventListener('change', () => {
    const showRaw = !!toggleRaw.checked;
    if (showRaw) powEl.classList.remove('hidden');
    else powEl.classList.add('hidden');
  });

  // Label toggle
  toggleLabels?.addEventListener('change', () => {
    state.showLabels = !!toggleLabels.checked;
    if (state.lastPow && state.labels.length) {
      updateTopomapsFromPowArray(state.lastPow, topoCanvases, state, true);
    } else {
      for (const key of Object.keys(topoCanvases)) {
        const c = topoCanvases[key];
        if (!c) continue;
        const ctx = c.getContext('2d');
        drawHeadOverlay(ctx, c.width, c.height, { showLabels: state.showLabels });
      }
    }
  });
})();

