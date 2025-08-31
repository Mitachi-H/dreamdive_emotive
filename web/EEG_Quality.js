(() => {
  const eqTimeEl = document.getElementById('eqTime');
  const eqSidEl = document.getElementById('eqSid');
  const eqRawEl = document.getElementById('eqRaw');
  const labelsEl = document.getElementById('labels');

  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');

  const batteryText = document.getElementById('batteryText');
  const batteryBar = document.getElementById('batteryBar');
  const overallText = document.getElementById('overallText');
  const overallBar = document.getElementById('overallBar');
  const srqText = document.getElementById('srqText');
  const srqBar = document.getElementById('srqBar');
  const eqGrid = document.getElementById('eqGrid');

  const state = { sensorLabels: [], indexByLabel: new Map() };

  const getHeaders = () => { const h = {}; const t = localStorage.getItem('dashboard_token'); if (t) h['Authorization'] = `Bearer ${t}`; return h; };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'labels' && msg.payload && msg.payload.streamName === 'eq') {
          const labs = Array.isArray(msg.payload.labels) ? msg.payload.labels : [];
          state.sensorLabels = labs; state.indexByLabel = new Map(labs.map((l, i) => [l, i]));
          if (labelsEl) labelsEl.textContent = JSON.stringify(labs, null, 2);
          buildEqGrid();
          return;
        }
        if (msg.type === 'eq') {
          const p = msg.payload || {}; const arr = Array.isArray(p.eq) ? p.eq : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          eqTimeEl.textContent = t; if (eqSidEl) eqSidEl.textContent = p.sid || '-';
          if (eqRawEl) eqRawEl.textContent = JSON.stringify(arr, null, 2);

          const batteryPercent = num(arr[0]);
          const overall = num(arr[1]);
          const srq = num(arr[2]);
          const sensors = arr.slice(3);

          if (!Number.isNaN(batteryPercent)) {
            const pct = clamp(batteryPercent, 0, 100);
            batteryBar.style.width = `${pct}%`;
            batteryText.textContent = `${Math.round(pct)}%`;
          }
          if (!Number.isNaN(overall)) {
            const pct = clamp(overall, 0, 100);
            overallBar.style.width = `${pct}%`;
            overallText.textContent = `${Math.round(pct)} / 100`;
          }
          if (!Number.isNaN(srq)) {
            if (srq === -1) {
              srqBar.style.width = `0%`;
              srqText.textContent = `-1 (lost > 300 ms)`;
            } else {
              const pct = clamp(srq * 100, 0, 100);
              srqBar.style.width = `${pct}%`;
              srqText.textContent = `${srq.toFixed(3)} (0–1)`;
            }
          }

          updateEqGrid(sensors);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }

  function buildEqGrid() {
    eqGrid.innerHTML = '';
    for (const label of state.sensorLabels) {
      const item = document.createElement('div');
      item.style.display = 'flex'; item.style.alignItems = 'center'; item.style.justifyContent = 'space-between';
      item.style.gap = '8px'; item.style.padding = '8px 10px'; item.style.borderRadius = '8px'; item.style.background = '#8881';
      item.style.color = 'var(--fg)';
      const name = document.createElement('div'); name.textContent = label; name.style.fontWeight = '600'; name.style.fontSize = '12px';
      const val = document.createElement('div'); val.dataset.sensor = label; val.textContent = '-';
      val.style.minWidth = '2.5em'; val.style.textAlign = 'right'; val.style.fontVariantNumeric = 'tabular-nums';
      item.appendChild(name); item.appendChild(val); eqGrid.appendChild(item);
    }
  }

  function updateEqGrid(sensorValues) {
    const labs = state.sensorLabels;
    for (let i = 0; i < labs.length; i++) {
      const label = labs[i];
      const v = sensorValues[i];
      const el = eqGrid.querySelector(`[data-sensor="${CSS.escape(label)}"]`);
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
    const c = clamp(v, 0, 4) / 4; // 0..4
    const g = Math.round(160 + 80 * c);
    const r = Math.round(180 - 120 * c);
    return `rgba(${r}, ${g}, 120, 0.6)`;
  }
  function qualityFg(v) { return v >= 3 ? '#000' : 'var(--fg)'; }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/eq/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/eq/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
})();

