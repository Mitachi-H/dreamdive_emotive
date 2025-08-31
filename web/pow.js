(() => {
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

  const getHeaders = () => {
    const h = {};
    const t = localStorage.getItem('dashboard_token');
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  const state = {
    labels: [],        // e.g., ["AF3/theta", ...]
    sensors: [],       // e.g., ["AF3","F7",...]
    bands: [],         // e.g., ["theta","alpha","betaL","betaH","gamma"]
    indexByLabel: {},  // { "AF3/theta": 0, ... }
    rollingMax: [],    // per-label rolling max for color scaling
  };

  function deriveFromLabels(labels) {
    const idx = {};
    labels.forEach((l, i) => { idx[l] = i; });
    const seenSensors = new Set();
    const sensors = [];
    let firstSensor = null;
    let bands = [];
    for (const lab of labels) {
      const [sensor, band] = String(lab).split('/');
      if (!sensor || !band) continue;
      if (!firstSensor) firstSensor = sensor;
      if (!seenSensors.has(sensor)) {
        seenSensors.add(sensor);
        sensors.push(sensor);
      }
      if (sensor === firstSensor && !bands.includes(band)) bands.push(band);
    }
    if (bands.length === 0) bands = ['theta','alpha','betaL','betaH','gamma'];
    return { sensors, bands, indexByLabel: idx };
  }

  function buildGrid() {
    if (!gridEl) return;
    gridEl.innerHTML = '';
    gridEl.style.setProperty('--band-count', String(state.bands.length || 5));
    // Header row
    const headBlank = document.createElement('div');
    headBlank.className = 'pow-head';
    headBlank.textContent = '';
    gridEl.appendChild(headBlank);
    for (const band of state.bands) {
      const d = document.createElement('div');
      d.className = 'pow-head';
      d.textContent = band;
      gridEl.appendChild(d);
    }
    // Sensor rows
    for (const sensor of state.sensors) {
      const s = document.createElement('div');
      s.className = 'pow-sensor';
      s.textContent = sensor;
      gridEl.appendChild(s);
      for (const band of state.bands) {
        const cell = document.createElement('div');
        cell.className = 'pow-cell';
        const key = `${sensor}/${band}`;
        cell.dataset.key = key;
        cell.title = key;
        cell.textContent = '-';
        gridEl.appendChild(cell);
      }
    }
  }

  function colorFor(norm) {
    // norm: 0..1 -> light blue to deep blue
    const l = 95 - Math.round(60 * Math.max(0, Math.min(1, norm)));
    const color = `hsl(220, 85%, ${l}%)`;
    const text = l < 60 ? '#fff' : '#000';
    return { bg: color, fg: text };
  }

  function updateGrid(values) {
    if (!gridEl || !Array.isArray(values) || values.length === 0) return;
    // Ensure rollingMax length
    if (!Array.isArray(state.rollingMax) || state.rollingMax.length !== values.length) {
      state.rollingMax = Array(values.length).fill(1);
    }
    // update each cell
    for (const sensor of state.sensors) {
      for (const band of state.bands) {
        const key = `${sensor}/${band}`;
        const i = state.indexByLabel[key];
        if (typeof i !== 'number') continue;
        const v = values[i] ?? 0;
        // rolling max with gentle decay
        const prev = state.rollingMax[i] || 1;
        const updatedMax = Math.max(v, prev * 0.98, 1e-6);
        state.rollingMax[i] = updatedMax;
        const norm = Math.log10(1 + Math.max(0, v)) / Math.log10(1 + updatedMax);
        const { bg, fg } = colorFor(norm);
        const cell = gridEl.querySelector(`.pow-cell[data-key="${CSS.escape(key)}"]`);
        if (cell) {
          cell.style.backgroundColor = bg;
          cell.style.color = fg;
          cell.textContent = (Math.round((v + Number.EPSILON) * 1000) / 1000).toString();
        }
      }
    }
  }

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
            buildGrid();
          }
          return;
        }
        if (msg.type === 'pow') {
          const p = msg.payload || {};
          const arr = p.pow || [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          powTimeEl.textContent = t;
          powLenEl.textContent = String(arr.length);
          if (powSidEl) powSidEl.textContent = p.sid || '-';
          // If we don't have labels yet but got a payload with labels key order (rare), keep raw
          if (state.labels.length && state.sensors.length && state.bands.length) {
            updateGrid(arr);
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
    if (showRaw) {
      powEl.classList.remove('hidden');
    } else {
      powEl.classList.add('hidden');
    }
  });
})();
