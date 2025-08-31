(() => {
  const metTimeEl = document.getElementById('metTime');
  const metSidEl = document.getElementById('metSid');
  const metRawEl = document.getElementById('metRaw');
  const labelsEl = document.getElementById('labels');
  const metricsGrid = document.getElementById('metricsGrid');

  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');

  const METRICS = [
    { key: 'eng', title: 'Engagement', activeKey: 'eng.isActive' },
    { key: 'exc', title: 'Excitement', activeKey: 'exc.isActive' },
    { key: 'lex', title: 'Long-term excitement', activeKey: null },
    { key: 'str', title: 'Stress / Frustration', activeKey: 'str.isActive' },
    { key: 'rel', title: 'Relaxation', activeKey: 'rel.isActive' },
    { key: 'int', title: 'Interest / Affinity', activeKey: 'int.isActive' },
    { key: 'attention', title: 'Attention', activeKey: 'attention.isActive' },
  ];

  const state = { labels: [], index: new Map() };

  const getHeaders = () => { const h = {}; const t = localStorage.getItem('dashboard_token'); if (t) h['Authorization'] = `Bearer ${t}`; return h; };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'labels' && msg.payload && msg.payload.streamName === 'met') {
          const labs = Array.isArray(msg.payload.labels) ? msg.payload.labels : [];
          state.labels = labs; state.index = new Map(labs.map((l, i) => [l, i]));
          if (labelsEl) labelsEl.textContent = JSON.stringify(labs, null, 2);
          buildMetricsGrid();
          return;
        }
        if (msg.type === 'met') {
          const p = msg.payload || {}; const arr = Array.isArray(p.met) ? p.met : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          metTimeEl.textContent = t; if (metSidEl) metSidEl.textContent = p.sid || '-';
          if (metRawEl) metRawEl.textContent = JSON.stringify(arr, null, 2);
          updateMetrics(arr);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function buildMetricsGrid() {
    metricsGrid.innerHTML = '';
    for (const m of METRICS) {
      const card = document.createElement('div');
      card.style.display = 'flex'; card.style.flexDirection = 'column'; card.style.gap = '6px';
      card.style.borderRadius = '8px'; card.style.padding = '10px'; card.style.background = '#8881'; card.style.color = 'var(--fg)';
      const title = document.createElement('div'); title.textContent = `${m.title} (${m.key})`; title.style.fontWeight = '600'; title.style.fontSize = '12px';
      const status = document.createElement('div'); status.dataset.key = `${m.key}.status`; status.className = 'small'; status.textContent = 'Status: -';
      const valWrap = document.createElement('div'); valWrap.style.display = 'flex'; valWrap.style.justifyContent = 'space-between'; valWrap.style.alignItems = 'center';
      const valText = document.createElement('div'); valText.dataset.key = `${m.key}.val`; valText.textContent = '-'; valText.style.fontVariantNumeric = 'tabular-nums';
      const barBg = document.createElement('div'); barBg.style.height = '10px'; barBg.style.flex = '1'; barBg.style.marginLeft = '12px'; barBg.style.background = '#0001'; barBg.style.borderRadius = '999px'; barBg.style.overflow = 'hidden';
      const bar = document.createElement('div'); bar.dataset.key = `${m.key}.bar`; bar.style.height = '100%'; bar.style.width = '0%'; bar.style.background = 'linear-gradient(90deg, #dbeafe, #60a5fa, #2563eb)';
      barBg.appendChild(bar); valWrap.appendChild(valText); valWrap.appendChild(barBg);
      card.appendChild(title); card.appendChild(status); card.appendChild(valWrap);
      metricsGrid.appendChild(card);
    }
  }

  function updateMetrics(arr) {
    for (const m of METRICS) {
      const vi = state.index.get(m.key);
      const ai = m.activeKey ? state.index.get(m.activeKey) : undefined;
      const v = vi != null ? arr[vi] : undefined;
      const a = ai != null ? arr[ai] : undefined;

      const statusEl = metricsGrid.querySelector(`[data-key="${CSS.escape(m.key + '.status')}"]`);
      const valEl = metricsGrid.querySelector(`[data-key="${CSS.escape(m.key + '.val')}"]`);
      const barEl = metricsGrid.querySelector(`[data-key="${CSS.escape(m.key + '.bar')}"]`);
      if (statusEl) statusEl.textContent = `Status: ${a === true ? 'Active' : a === false ? 'Inactive' : '-'}`;
      if (typeof v === 'number') {
        const pct = clamp(v * 100, 0, 100);
        if (valEl) valEl.textContent = `${v.toFixed(3)} (${Math.round(pct)})`;
        if (barEl) barEl.style.width = `${pct}%`;
      } else {
        if (valEl) valEl.textContent = v == null ? 'null' : String(v);
        if (barEl) barEl.style.width = '0%';
      }
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/met/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/met/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
})();

