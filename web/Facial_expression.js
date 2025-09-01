(() => {
  const facTimeEl = document.getElementById('facTime');
  const facSidEl = document.getElementById('facSid');
  const facRawEl = document.getElementById('facRaw');
  const eyeActEl = document.getElementById('eyeAct');
  const uActEl = document.getElementById('uAct');
  const uPowText = document.getElementById('uPowText');
  const uPowBar = document.getElementById('uPowBar');
  const lActEl = document.getElementById('lAct');
  const lPowText = document.getElementById('lPowText');
  const lPowBar = document.getElementById('lPowBar');
  // Eye action time-series chart elements
  const eyeChartSvg = document.getElementById('eyeChart');
  const eyeWinSecEl = document.getElementById('eyeWinSec');
  const eyeLegendEl = document.getElementById('eyeLegend');

  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');
  // Threshold controls
  const thActionSel = document.getElementById('thAction');
  const thValueInput = document.getElementById('thValue');
  const thSlider = document.getElementById('thSlider');
  const thGetBtn = document.getElementById('thGet');
  const thSetBtn = document.getElementById('thSet');
  const thRefreshBtn = document.getElementById('thRefresh');
  const thStatus = document.getElementById('thStatus');
  const thProfileInput = document.getElementById('thProfile');
  const thList = document.getElementById('thList');

  const getHeaders = () => { const h = {}; const t = localStorage.getItem('dashboard_token'); if (t) h['Authorization'] = `Bearer ${t}`; return h; };

  // --- Eye action chart state ---
  const WINDOW_SEC = 60;
  const CHART_CATS = ['neutral', 'blink', 'winkL', 'winkR', 'lookL', 'lookR'];
  const CHART_COLORS = {
    neutral: '#9ca3af', // gray-400
    blink: '#fbbf24',   // amber-400
    winkL: '#34d399',   // emerald-400
    winkR: '#10b981',   // emerald-500
    lookL: '#60a5fa',   // blue-400
    lookR: '#3b82f6',   // blue-500
  };
  const visibleCats = Object.fromEntries(CHART_CATS.map(c => [c, true]));
  function canonEyeAct(s) {
    if (!s || typeof s !== 'string') return null;
    const x = s.trim().toLowerCase();
    if (!x) return null;
    if (x === 'neutral') return 'neutral';
    if (x === 'blink') return 'blink';
    if (x === 'winkl') return 'winkL';
    if (x === 'winkr') return 'winkR';
    if (x === 'lookl') return 'lookL';
    if (x === 'lookr') return 'lookR';
    return null;
  }
  if (eyeWinSecEl) eyeWinSecEl.textContent = String(WINDOW_SEC);
  let lastEyeAct = null;
  let bins = [];
  function initBins(nowSec) {
    const base = Math.floor(nowSec);
    bins = Array.from({ length: WINDOW_SEC }, (_, i) => ({
      sec: base - (WINDOW_SEC - 1 - i),
      active: { neutral: 0, blink: 0, winkL: 0, winkR: 0, lookL: 0, lookR: 0 },
    }));
  }
  function advanceBins(nowSec) {
    const now = Math.floor(nowSec);
    if (!bins.length) { initBins(now); return; }
    let last = bins[bins.length - 1].sec;
    if (now <= last) return; // same second or older
    // Append new seconds and drop oldest to keep window size
    for (let s = last + 1; s <= now; s++) {
      bins.push({ sec: s, active: { neutral: 0, blink: 0, winkL: 0, winkR: 0, lookL: 0, lookR: 0 } });
      if (bins.length > WINDOW_SEC) bins.shift();
    }
  }
  function currentBin() { return bins[bins.length - 1]; }
  function isMeaningfulEyeAction(act) { return !!canonEyeAct(act); }
  function renderEyeChart() {
    if (!eyeChartSvg || !bins.length) return;
    // Clear
    while (eyeChartSvg.firstChild) eyeChartSvg.removeChild(eyeChartSvg.firstChild);
    const rect = eyeChartSvg.getBoundingClientRect();
    const W = Math.max(100, Math.floor(rect.width || 600));
    const H = Math.max(80, Math.floor(rect.height || 180));
    const ML = 70, MR = 6, MT = 6, MB = 20;
    const IW = Math.max(1, W - ML - MR);
    const IH = Math.max(1, H - MT - MB);
    const barW = IW / WINDOW_SEC;
    const rows = CHART_CATS.length;
    const rowH = IH / rows;
    // Row separators and labels
    for (let i = 0; i <= rows; i++) {
      const y = MT + i * rowH;
      const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      sep.setAttribute('x1', String(ML));
      sep.setAttribute('x2', String(ML + IW));
      sep.setAttribute('y1', String(y));
      sep.setAttribute('y2', String(y));
      sep.setAttribute('stroke', '#9993');
      sep.setAttribute('stroke-width', '1');
      eyeChartSvg.appendChild(sep);
      if (i < rows) {
        const cy = MT + (i + 0.5) * rowH;
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', String(ML - 6));
        lbl.setAttribute('y', String(cy + 3));
        lbl.setAttribute('fill', 'var(--muted)');
        lbl.setAttribute('font-size', '11');
        lbl.setAttribute('text-anchor', 'end');
        lbl.textContent = CHART_CATS[i];
        eyeChartSvg.appendChild(lbl);
      }
    }

    // X ticks every 10s (labels as -Xs from now)
    for (let i = 0; i < WINDOW_SEC; i++) {
      const idx = i;
      const x = ML + idx * barW;
      const isTick = ((WINDOW_SEC - 1 - i) % 10 === 0);
      if (isTick) {
        const tline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tline.setAttribute('x1', String(x));
        tline.setAttribute('x2', String(x));
        tline.setAttribute('y1', String(MT + IH));
        tline.setAttribute('y2', String(MT + IH + 4));
        tline.setAttribute('stroke', '#999');
        tline.setAttribute('stroke-width', '1');
        eyeChartSvg.appendChild(tline);
        const secsAgo = WINDOW_SEC - 1 - i;
        const tlbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tlbl.setAttribute('x', String(x));
        tlbl.setAttribute('y', String(MT + IH + 14));
        tlbl.setAttribute('fill', 'var(--muted)');
        tlbl.setAttribute('font-size', '10');
        tlbl.setAttribute('text-anchor', 'middle');
        tlbl.textContent = secsAgo === 0 ? '0s' : `-${secsAgo}s`;
        eyeChartSvg.appendChild(tlbl);
      }
    }

    // Lines as on/off segments per category
    for (let ci = 0; ci < rows; ci++) {
      const cat = CHART_CATS[ci];
      if (!visibleCats[cat]) continue;
      const cy = MT + (ci + 0.5) * rowH;
      const lineH = Math.max(2, Math.floor(rowH * 0.55));
      for (let i = 0; i < WINDOW_SEC; i++) {
        const b = bins[i];
        if (!b || !b.active || !b.active[cat]) continue;
        const x = ML + i * barW;
        const rw = Math.max(1, barW - 1);
        const y = Math.floor(cy - lineH / 2);
        const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rectEl.setAttribute('x', String(x));
        rectEl.setAttribute('y', String(y));
        rectEl.setAttribute('width', String(rw));
        rectEl.setAttribute('height', String(lineH));
        rectEl.setAttribute('fill', CHART_COLORS[cat] || '#888');
        rectEl.setAttribute('opacity', '0.95');
        eyeChartSvg.appendChild(rectEl);
      }
    }
  }

  function renderEyeLegend() {
    if (!eyeLegendEl) return;
    eyeLegendEl.innerHTML = '';
    for (const key of CHART_CATS) {
      const item = document.createElement('label');
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '6px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!visibleCats[key];
      cb.addEventListener('change', () => { visibleCats[key] = !!cb.checked; renderEyeChart(); });
      const sw = document.createElement('span');
      sw.style.display = 'inline-block';
      sw.style.width = '14px';
      sw.style.height = '10px';
      sw.style.borderRadius = '2px';
      sw.style.background = CHART_COLORS[key] || '#888';
      const label = document.createElement('span');
      label.className = 'small';
      label.textContent = key;
      item.appendChild(cb);
      item.appendChild(sw);
      item.appendChild(label);
      eyeLegendEl.appendChild(item);
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
        if (msg.type === 'fac') {
          const p = msg.payload || {}; const arr = Array.isArray(p.fac) ? p.fac : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          facTimeEl.textContent = t; if (facSidEl) facSidEl.textContent = p.sid || '-';
          if (facRawEl) facRawEl.textContent = JSON.stringify(arr, null, 2);

          const eyeAct = arr[0];
          const uAct = arr[1];
          const uPow = typeof arr[2] === 'number' ? arr[2] : NaN;
          const lAct = arr[3];
          const lPow = typeof arr[4] === 'number' ? arr[4] : NaN;

          const eyeActStr = typeof eyeAct === 'string' ? eyeAct : '-';
          const eyeCanon = canonEyeAct(eyeActStr);
          eyeActEl.textContent = eyeCanon || eyeActStr || '-';
          uActEl.textContent = typeof uAct === 'string' ? uAct : '-';
          lActEl.textContent = typeof lAct === 'string' ? lAct : '-';

          if (!Number.isNaN(uPow)) {
            const pct = clamp(uPow * 100, 0, 100);
            uPowText.textContent = `${uPow.toFixed(3)} (${Math.round(pct)})`;
            uPowBar.style.width = `${pct}%`;
          } else { uPowText.textContent = '-'; uPowBar.style.width = '0%'; }

          if (!Number.isNaN(lPow)) {
            const pct = clamp(lPow * 100, 0, 100);
            lPowText.textContent = `${lPow.toFixed(3)} (${Math.round(pct)})`;
            lPowBar.style.width = `${pct}%`;
          } else { lPowText.textContent = '-'; lPowBar.style.width = '0%'; }

          // Update eye action time-series (categorical on/off per second)
          const nowSec = p.time ? Number(p.time) : Date.now() / 1000;
          advanceBins(nowSec);
          const cb = currentBin();
          if (cb && eyeCanon && cb.active && Object.prototype.hasOwnProperty.call(cb.active, eyeCanon)) {
            cb.active[eyeCanon] = 1;
          }
          lastEyeAct = eyeActStr;
          renderEyeChart();
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/fac/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/fac/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  // Initialize chart and handle resize
  initBins(Date.now() / 1000);
  renderEyeChart();
  renderEyeLegend();
  window.addEventListener('resize', () => { renderEyeChart(); });

  // ----- Threshold UI wiring -----
  function clamp01k(n) { n = Number(n); if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(1000, Math.round(n))); }
  function setThStatus(s) { if (thStatus) thStatus.textContent = s; }
  function syncSliderFromInput() { if (!thValueInput || !thSlider) return; thSlider.value = String(clamp01k(thValueInput.value)); }
  function syncInputFromSlider() { if (!thValueInput || !thSlider) return; thValueInput.value = String(clamp01k(thSlider.value)); }
  thValueInput?.addEventListener('input', () => { syncSliderFromInput(); });
  thSlider?.addEventListener('input', () => { syncInputFromSlider(); });

  function renderThresholdList(map) {
    if (!thList) return;
    thList.innerHTML = '';
    const view = [
      ['neutral', null],
      ['blink', map?.blink],
      ['winkL', map?.winkLeft],
      ['winkR', map?.winkRight],
      ['lookL', map?.horiEye],
      ['lookR', map?.horiEye],
    ];
    for (const [label, v] of view) {
      const pill = document.createElement('span');
      pill.style.display = 'inline-flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '6px';
      pill.style.padding = '4px 8px';
      pill.style.borderRadius = '999px';
      pill.style.background = '#0001';
      const name = document.createElement('span');
      name.className = 'small muted';
      name.textContent = label;
      const val = document.createElement('span');
      val.style.fontWeight = '600';
      val.textContent = (v == null || Number.isNaN(Number(v))) ? '—' : String(v);
      pill.appendChild(name);
      pill.appendChild(val);
      thList.appendChild(pill);
    }
  }

  async function refreshAllThresholds() {
    try {
      setThStatus('Refreshing...');
      const acts = ['blink', 'winkLeft', 'winkRight', 'horiEye'];
      const results = await Promise.all(acts.map(async (a) => {
        try { const v = await apiFacThreshold({ status: 'get', action: a }); return [a, v]; }
        catch (_) { return [a, null]; }
      }));
      const map = Object.fromEntries(results);
      renderThresholdList(map);
      setThStatus('OK');
    } catch (e) {
      setThStatus('Error: ' + String(e.message || e));
    }
  }

  function toThresholdToken(action) {
    const x = String(action || '').toLowerCase();
    if (x === 'blink') return 'blink';
    if (x === 'winkl' || x === 'wink_left' || x === 'winkleft') return 'winkLeft';
    if (x === 'winkr' || x === 'wink_right' || x === 'winkright') return 'winkRight';
    if (x === 'lookl' || x === 'lookleft' || x === 'lookr' || x === 'lookright' || x === 'horieye' || x === 'hori_eye' || x === 'hori') return 'horiEye';
    if (action === 'winkL' || action === 'winkR' || action === 'lookL' || action === 'lookR') return toThresholdToken(action.toLowerCase());
    if (action === 'winkLeft' || action === 'winkRight' || action === 'horiEye') return action;
    return null;
  }

  async function apiFacThreshold({ status, action, value }) {
    try {
      const act = toThresholdToken(action);
      if (!act) throw new Error('unsupported action: ' + action);
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const body = { status, action: act, headsetId: hid };
      const prof = thProfileInput?.value?.trim();
      if (prof) body.profile = prof;
      if (status === 'set') body.value = value;
      const res = await fetch('/api/fac/threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'request failed');
      return j.result;
    } catch (e) { throw e; }
  }

  thGetBtn?.addEventListener('click', async () => { await refreshAllThresholds(); });
  thSetBtn?.addEventListener('click', async () => {
    try {
      const action = thActionSel.value;
      const val = clamp01k(thValueInput.value || thSlider.value || 0);
      thValueInput.value = String(val);
      thSlider.value = String(val);
      setThStatus('Setting...');
      const r = await apiFacThreshold({ status: 'set', action, value: val });
      setThStatus(String(r || 'OK'));
      await refreshAllThresholds();
    } catch (e) { setThStatus('Error: ' + String(e.message || e)); }
  });

  thRefreshBtn?.addEventListener('click', async () => { await refreshAllThresholds(); });

  // Initial threshold fetch to show values always
  refreshAllThresholds();

  connect();
})();
