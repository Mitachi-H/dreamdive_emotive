import { createViz3D } from './motion/viz3d.js';

(() => {
  const motTimeEl = document.getElementById('motTime');
  const motLenEl = document.getElementById('motLen');
  const motSidEl = document.getElementById('motSid');
  const motRawEl = document.getElementById('motRaw');
  const labelsEl = document.getElementById('labels');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');
  const accBox = document.getElementById('accBox');
  const rotBox = document.getElementById('rotBox');
  const magBox = document.getElementById('magBox');
  const counterBox = document.getElementById('counterBox');

  // 3D viz + controls
  const canvas = document.getElementById('viz3d');
  const yawEl = document.getElementById('yaw');
  const pitchEl = document.getElementById('pitch');
  const rollEl = document.getElementById('roll');
  const calibrateBtn = document.getElementById('calibrate');
  const resetCalibBtn = document.getElementById('resetCalib');
  const mirrorChk = document.getElementById('mirror');
  const scaleModeSel = document.getElementById('scaleMode');
  const gainAccInput = document.getElementById('gainAcc');
  const gainMagInput = document.getElementById('gainMag');
  const accLenEl = document.getElementById('accLen');
  const magLenEl = document.getElementById('magLen');

  const viz = createViz3D({ canvas, yawEl, pitchEl, rollEl, accLenEl, magLenEl });

  const state = { labels: [], index: new Map(), hasQuat: false };

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
        if (msg.type === 'labels' && msg.payload && msg.payload.streamName === 'mot') {
          const labs = Array.isArray(msg.payload.labels) ? msg.payload.labels : [];
          state.labels = labs; state.index = new Map(labs.map((l, i) => [l, i]));
          if (labelsEl) labelsEl.textContent = JSON.stringify(labs, null, 2);
          state.hasQuat = state.index.has('Q0') && state.index.has('Q1') && state.index.has('Q2') && state.index.has('Q3');
          viz.setHasQuaternion(state.hasQuat);
          return;
        }
        if (msg.type === 'mot') {
          const p = msg.payload || {}; const arr = Array.isArray(p.mot) ? p.mot : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          motTimeEl.textContent = t; motLenEl.textContent = String(arr.length);
          if (motSidEl) motSidEl.textContent = p.sid || '-';
          if (motRawEl) motRawEl.textContent = JSON.stringify(arr, null, 2);

          renderCounters(arr); renderRotationOrGyro(arr); renderAcc(arr); renderMag(arr);

          if (state.hasQuat) {
            viz.setQuaternion(num(arrAt('Q0', arr)), num(arrAt('Q1', arr)), num(arrAt('Q2', arr)), num(arrAt('Q3', arr)));
          }
          const accDev = [num(arrAt('ACCX', arr)), num(arrAt('ACCY', arr)), num(arrAt('ACCZ', arr))];
          const magDev = [num(arrAt('MAGX', arr)), num(arrAt('MAGY', arr)), num(arrAt('MAGZ', arr))];
          viz.updateVectors({ accDev, magDev });
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function val(arr, key, digits = 6) {
    const i = state.index.get(key); if (i == null) return '-';
    const v = arr[i]; if (typeof v !== 'number') return String(v ?? '-');
    return Number.isInteger(v) ? String(v) : v.toFixed(digits);
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }
  function arrAt(key, arr) { const i = state.index.get(key); return i != null ? arr[i] : NaN; }

  function renderCounters(arr) {
    const a = val(arr, 'COUNTER_MEMS', 0); const b = val(arr, 'INTERPOLATED_MEMS', 0);
    counterBox.textContent = `COUNTER_MEMS: ${a}\nINTERPOLATED_MEMS: ${b}`;
  }
  function renderRotationOrGyro(arr) {
    const hasQuat = state.index.has('Q0') && state.index.has('Q3');
    if (hasQuat) rotBox.textContent = `Q0: ${val(arr,'Q0')}\nQ1: ${val(arr,'Q1')}\nQ2: ${val(arr,'Q2')}\nQ3: ${val(arr,'Q3')}`;
    else rotBox.textContent = `GYROX: ${val(arr,'GYROX',0)}\nGYROY: ${val(arr,'GYROY',0)}\nGYROZ: ${val(arr,'GYROZ',0)}`;
  }
  function renderAcc(arr) { accBox.textContent = `ACCX: ${val(arr,'ACCX')}\nACCY: ${val(arr,'ACCY')}\nACCZ: ${val(arr,'ACCZ')}`; }
  function renderMag(arr) { magBox.textContent = `MAGX: ${val(arr,'MAGX')}\nMAGY: ${val(arr,'MAGY')}\nMAGZ: ${val(arr,'MAGZ')}`; }

  calibrateBtn?.addEventListener('click', () => viz.calibrate());
  resetCalibBtn?.addEventListener('click', () => viz.resetCalibration());
  mirrorChk?.addEventListener('change', () => viz.setMirror(!!mirrorChk.checked));
  scaleModeSel?.addEventListener('change', () => viz.setScaleMode(scaleModeSel.value || 'auto'));
  gainAccInput?.addEventListener('input', () => viz.setGains(Number(gainAccInput.value) || 1, undefined));
  gainMagInput?.addEventListener('input', () => viz.setGains(undefined, Number(gainMagInput.value) || 0.02));

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/mot/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/mot/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  // Persist and preload headsetId
  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
  viz.start();
})();

