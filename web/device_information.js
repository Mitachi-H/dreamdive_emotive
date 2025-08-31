(() => {
  const devTimeEl = document.getElementById('devTime');
  const devSidEl = document.getElementById('devSid');
  const devRawEl = document.getElementById('devRaw');
  const labelsEl = document.getElementById('labels');

  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');

  const batteryText = document.getElementById('batteryText');
  const batteryBar = document.getElementById('batteryBar');
  const signalText = document.getElementById('signalText');
  const signalBar = document.getElementById('signalBar');
  const overallText = document.getElementById('overallText');
  const overallBar = document.getElementById('overallBar');
  const cqGrid = document.getElementById('cqGrid');

  const state = { devSensorLabels: [], indexByLabel: new Map() };

  const getHeaders = () => {
    const h = {}; const t = localStorage.getItem('dashboard_token');
    if (t) h['Authorization'] = `Bearer ${t}`; return h;
  };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'labels' && msg.payload && msg.payload.streamName === 'dev') {
          const labs = Array.isArray(msg.payload.labels) ? msg.payload.labels : [];
          state.devSensorLabels = labs;
          state.indexByLabel = new Map(labs.map((l, i) => [l, i]));
          if (labelsEl) labelsEl.textContent = JSON.stringify(labs, null, 2);
          buildCqGrid();
          return;
        }
        if (msg.type === 'dev') {
          const p = msg.payload || {};
          const arr = Array.isArray(p.dev) ? p.dev : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          devTimeEl.textContent = t; if (devSidEl) devSidEl.textContent = p.sid || '-';
          if (devRawEl) devRawEl.textContent = JSON.stringify(arr, null, 2);

          // dev array layout: [Battery(0-4), Signal(0-1), [CQ... (0-4, last is OVERALL 0-100)], BatteryPercent(0-100)]
          const level = num(arr[0]);
          const signal = num(arr[1]);
          const cq = Array.isArray(arr[2]) ? arr[2] : [];
          const batPct = num(arr[3]);
          const overall = cq.length ? num(cq[cq.length - 1]) : NaN; // OVERALL

          // Battery
          if (!Number.isNaN(level) || !Number.isNaN(batPct)) {
            const pct = !Number.isNaN(batPct) ? clamp(batPct, 0, 100) : clamp((level / 4) * 100, 0, 100);
            batteryBar.style.width = `${pct}%`;
            const lvlTxt = Number.isFinite(level) ? `${level}/4` : '-';
            const pctTxt = Number.isFinite(batPct) ? `${batPct}%` : `${Math.round(pct)}%`;
            batteryText.textContent = `${lvlTxt} (${pctTxt})`;
          }

          // Signal
          if (!Number.isNaN(signal)) {
            const pct = clamp(signal * 100, 0, 100);
            signalBar.style.width = `${pct}%`;
            signalText.textContent = `${signal.toFixed(2)} (0–1)`;
          }

          // Overall
          if (!Number.isNaN(overall)) {
            const pct = clamp(overall, 0, 100);
            overallBar.style.width = `${pct}%`;
            overallText.textContent = `${Math.round(pct)} / 100`;
          }

          // CQ per sensor
          updateCqGrid(cq);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }

  function buildCqGrid() {
    cqGrid.innerHTML = '';
    for (const label of state.devSensorLabels) {
      // Skip OVERALL in the grid; shown separately
      if (label === 'OVERALL') continue;
      const item = document.createElement('div');
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.justifyContent = 'space-between';
      item.style.gap = '8px';
      item.style.padding = '8px 10px';
      item.style.borderRadius = '8px';
      item.style.background = '#8881';
      item.style.color = 'var(--fg)';
      const name = document.createElement('div');
      name.textContent = label;
      name.style.fontWeight = '600';
      name.style.fontSize = '12px';
      const val = document.createElement('div');
      val.dataset.sensor = label;
      val.textContent = '-';
      val.style.minWidth = '2.5em';
      val.style.textAlign = 'right';
      val.style.fontVariantNumeric = 'tabular-nums';
      item.appendChild(name); item.appendChild(val);
      cqGrid.appendChild(item);
    }
  }

  function updateCqGrid(cqArray) {
    const labs = state.devSensorLabels;
    for (let i = 0; i < labs.length; i++) {
      const label = labs[i];
      if (label === 'OVERALL') continue;
      const v = cqArray[i];
      const el = cqGrid.querySelector(`[data-sensor="${CSS.escape(label)}"]`);
      if (!el) continue;
      if (typeof v === 'number') {
        el.textContent = String(v);
        el.style.background = qualityBg(v);
        el.style.color = qualityFg(v);
      } else {
        el.textContent = '-';
        el.style.background = '#8881';
        el.style.color = 'var(--fg)';
      }
    }
  }

  function qualityBg(v) {
    // 0..4 -> gray -> green
    const c = clamp(v, 0, 4) / 4;
    const g = Math.round(160 + 80 * c);
    const r = Math.round(180 - 120 * c);
    return `rgba(${r}, ${g}, 120, 0.6)`;
  }
  function qualityFg(v) {
    return v >= 3 ? '#000' : 'var(--fg)';
  }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/dev/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/dev/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
})();

