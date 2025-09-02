import { wsConnect, api } from '/lib/dashboard-sdk.js';

const $ = (id) => document.getElementById(id);
const wsStatus = $('wsStatus');
const startFacBtn = $('startFac');
const stopFacBtn = $('stopFac');
const headsetIdInput = $('headsetId');

// Eye chart elements
const eyeSvg = $('eyeSvg');
const eyeWinSecEl = $('eyeWinSec');
const eyeNowEl = $('eyeNow');

// EOG canvas elements
const eogCanvas = $('eogCanvas');
const arefEl = $('aref');
const fsEl = $('fs');
const tNowEl = $('tNow');
const leadOffEl = $('leadOff');
const nSamplesEl = $('nSamples');
const serialConnectBtn = $('serialConnect');
const serialDisconnectBtn = $('serialDisconnect');
const serialStatusEl = $('serialStatus');
const serialHintEl = $('serialHint');

// ---------------- Eye Actions (look L/R unified) ----------------
const EYE_WINDOW_SEC = 60;
eyeWinSecEl.textContent = String(EYE_WINDOW_SEC);
const EYE_ROWS = ['neutral', 'blink', 'wink', 'look'];
const EYE_COLORS = { neutral: '#9ca3af', blink: '#fbbf24', wink: '#34d399', look: '#3b82f6' };
let eyeBins = []; // [{ sec, active: { neutral, blink, wink, look } }]

function initEyeBins(nowSec) {
  const base = Math.floor(nowSec);
  eyeBins = Array.from({ length: EYE_WINDOW_SEC }, (_, i) => ({
    sec: base - (EYE_WINDOW_SEC - 1 - i),
    active: { neutral: 0, blink: 0, wink: 0, look: 0 },
  }));
}
function advanceEyeBins(nowSec) {
  const now = Math.floor(nowSec);
  if (!eyeBins.length) { initEyeBins(now); return; }
  let last = eyeBins[eyeBins.length - 1].sec;
  if (now <= last) return;
  for (let s = last + 1; s <= now; s++) {
    eyeBins.push({ sec: s, active: { neutral: 0, blink: 0, wink: 0, look: 0 } });
    if (eyeBins.length > EYE_WINDOW_SEC) eyeBins.shift();
  }
}

function canonEye(s) {
  if (!s || typeof s !== 'string') return null;
  const x = s.trim().toLowerCase();
  if (x === 'neutral') return 'neutral';
  if (x === 'blink') return 'blink';
  if (x === 'winkl' || x === 'winkr' || x === 'wink') return 'wink';
  if (x === 'lookl' || x === 'lookr' || x === 'horieye' || x === 'hori_eye' || x === 'hori' || x === 'look') return 'look';
  return null;
}

function renderEyeChart() {
  if (!eyeSvg || !eyeBins.length) return;
  while (eyeSvg.firstChild) eyeSvg.removeChild(eyeSvg.firstChild);
  const rect = eyeSvg.getBoundingClientRect();
  const W = Math.max(200, Math.floor(rect.width || 800));
  const H = Math.max(80, Math.floor(rect.height || 140));
  const ML = 70, MR = 8, MT = 6, MB = 18;
  const IW = Math.max(1, W - ML - MR);
  const IH = Math.max(1, H - MT - MB);
  const barW = IW / EYE_WINDOW_SEC;
  const rows = EYE_ROWS.length;
  const rowH = IH / rows;
  // Separators + labels
  for (let i = 0; i <= rows; i++) {
    const y = MT + i * rowH;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(ML));
    line.setAttribute('x2', String(ML + IW));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#9993');
    line.setAttribute('stroke-width', '1');
    eyeSvg.appendChild(line);
    if (i < rows) {
      const cy = MT + (i + 0.5) * rowH;
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(ML - 6));
      lbl.setAttribute('y', String(cy + 3));
      lbl.setAttribute('fill', 'var(--muted)');
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('text-anchor', 'end');
      lbl.textContent = EYE_ROWS[i];
      eyeSvg.appendChild(lbl);
    }
  }
  // X ticks
  for (let i = 0; i < EYE_WINDOW_SEC; i += 5) {
    const x = ML + i * barW;
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', String(x));
    tick.setAttribute('x2', String(x));
    tick.setAttribute('y1', String(MT + IH));
    tick.setAttribute('y2', String(MT + IH + 4));
    tick.setAttribute('stroke', '#9997');
    eyeSvg.appendChild(tick);
    const tlbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tlbl.setAttribute('x', String(x + 2));
    tlbl.setAttribute('y', String(MT + IH + 14));
    tlbl.setAttribute('fill', 'var(--muted)');
    tlbl.setAttribute('font-size', '10');
    const secsAgo = EYE_WINDOW_SEC - i - 1;
    tlbl.textContent = secsAgo === 0 ? '0s' : `-${secsAgo}s`;
    eyeSvg.appendChild(tlbl);
  }
  // Bars (on/off per second)
  for (let ri = 0; ri < rows; ri++) {
    const key = EYE_ROWS[ri];
    const cy = MT + (ri + 0.5) * rowH;
    const lineH = Math.max(2, Math.floor(rowH * 0.55));
    for (let i = 0; i < EYE_WINDOW_SEC; i++) {
      const b = eyeBins[i];
      if (!b || !b.active || !b.active[key]) continue;
      const x = ML + i * barW;
      const y = Math.floor(cy - lineH / 2);
      const rw = Math.max(1, barW - 1);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(rw));
      rect.setAttribute('height', String(lineH));
      rect.setAttribute('fill', EYE_COLORS[key] || '#888');
      rect.setAttribute('opacity', '0.95');
      eyeSvg.appendChild(rect);
    }
  }
}

// --------------- EOG waveform (canvas) ---------------
const EOG_WINDOW_SEC = 12;
const eogState = {
  aref: 3.3,
  buf: [], // [{ t, v, raw, lop, lon }]
  n: 0,
};
$('eogWinSec').textContent = String(EOG_WINDOW_SEC);

function pushEogSamples(samples, aref) {
  if (!Array.isArray(samples) || !samples.length) return;
  eogState.aref = Number(aref || eogState.aref || 3.3);
  const tNow = samples[samples.length - 1].t;
  const tMin = tNow - EOG_WINDOW_SEC;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.v)) continue;
    eogState.buf.push(s);
  }
  // Drop old
  while (eogState.buf.length && eogState.buf[0].t < tMin) eogState.buf.shift();
  eogState.n += samples.length;
}

function estimateFs(buf) {
  if (!buf || buf.length < 4) return null;
  const n = Math.min(buf.length, 1000);
  const a = buf.slice(buf.length - n);
  const dt = (a[a.length - 1].t - a[0].t) / (a.length - 1);
  if (!Number.isFinite(dt) || dt <= 0) return null;
  return 1 / dt;
}

function drawEog() {
  const canvas = eogCanvas;
  if (!canvas) return;
  // Handle high-DPI
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 220;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Background grid
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const y = Math.round((H * i) / 6) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  for (let i = 0; i <= 10; i++) {
    const x = Math.round((W * i) / 10) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  const buf = eogState.buf;
  if (!buf.length) return;
  const tMax = buf[buf.length - 1].t;
  const tMin = tMax - EOG_WINDOW_SEC;
  const vMin = Math.min(...buf.map((s) => s.v));
  const vMax = Math.max(...buf.map((s) => s.v));
  const pad = Math.max(0.01, 0.1 * (vMax - vMin));
  const yMin = vMin - pad, yMax = vMax + pad;

  const X = (t) => ((t - tMin) / (tMax - tMin)) * W;
  const Y = (v) => H - ((v - yMin) / (yMax - yMin)) * H;

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = Math.max(1, Math.floor((window.devicePixelRatio || 1)));
  ctx.beginPath();
  let started = false;
  for (const s of buf) {
    if (s.t < tMin) continue;
    const x = X(s.t), y = Y(s.v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// -------- WS wiring --------
let lastFacTime = null;
const ws = wsConnect({
  onOpen: () => { wsStatus.textContent = 'WS: connected'; },
  onClose: () => { wsStatus.textContent = 'WS: disconnected (retrying)'; },
  onError: () => { wsStatus.textContent = 'WS: error'; },
  onType: {
    fac: (p) => {
      // p: { fac: [eyeAct, uAct, uPow, lAct, lPow], time }
      try {
        const t = (p && p.time) ? Number(p.time) : (Date.now() / 1000);
        lastFacTime = t;
        eyeNowEl.textContent = new Date(t * 1000).toLocaleTimeString();
        advanceEyeBins(t);
        const arr = Array.isArray(p.fac) ? p.fac : [];
        const eyeCanon = canonEye(typeof arr[0] === 'string' ? arr[0] : '');
        const bin = eyeBins[eyeBins.length - 1];
        if (bin && eyeCanon && bin.active && (eyeCanon in bin.active)) bin.active[eyeCanon] = 1;
        renderEyeChart();
      } catch (_) {}
    },
    eog: (payload) => {
      try {
        const aref = Number(payload?.aref) || eogState.aref;
        const samples = Array.isArray(payload?.samples) ? payload.samples : [];
        pushEogSamples(samples, aref);
        arefEl.textContent = String(eogState.aref.toFixed ? eogState.aref.toFixed(2) : eogState.aref);
        const fs = estimateFs(eogState.buf);
        fsEl.textContent = fs ? fs.toFixed(1) : '-';
        if (eogState.buf.length) {
          const t = eogState.buf[eogState.buf.length - 1].t;
          tNowEl.textContent = new Date(t * 1000).toLocaleTimeString();
          const last = eogState.buf[eogState.buf.length - 1];
          const lo = ((last.lop|0) || (last.lon|0)) ? 'LO' : 'OK';
          leadOffEl.textContent = lo;
        }
        nSamplesEl.textContent = String(eogState.n);
        drawEog();
      } catch (_) {}
    },
  }
});

// Initial state
initEyeBins(Date.now() / 1000);
renderEyeChart();
drawEog();
window.addEventListener('resize', () => { renderEyeChart(); drawEog(); });

// fac control buttons
startFacBtn.addEventListener('click', async () => {
  try {
    const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
    const r = await api.stream.start('fac', { headsetId: hid });
    console.log('start fac ok', r);
  } catch (e) { alert('start fac error: ' + (e.message || e)); }
});
stopFacBtn.addEventListener('click', async () => {
  try {
    const r = await api.stream.stop('fac');
    console.log('stop fac ok', r);
  } catch (e) { alert('stop fac error: ' + (e.message || e)); }
});

// Restore headsetId if saved
try { const saved = localStorage.getItem('headset_id'); if (saved && !headsetIdInput.value) headsetIdInput.value = saved; } catch (_) {}

// -------- Optional: Web Serial (browser-side serial -> POST /api/eog/push) --------
let serialPort = null;
let reader = null;
let serialRun = false;
let epoch0 = null, ms0 = null;
let txBuf = [];
let lastTxAt = 0;
const AREFF = 3.3; // same default as server

function setSerialStatus(s) { if (serialStatusEl) serialStatusEl.textContent = s; }

function canUseWebSerial() {
  const ok = 'serial' in navigator && window.isSecureContext;
  if (!ok) {
    const why = !('serial' in navigator) ? 'ブラウザが Web Serial 未対応' : '安全なコンテキスト(https/localhost)でないため無効';
    serialHintEl.textContent = `Web Serial不可: ${why}`;
  } else {
    serialHintEl.textContent = '';
  }
  return ok;
}

async function serialTickSend(force = false) {
  if (!txBuf.length) return;
  const now = performance.now();
  if (!force && (now - lastTxAt) < 250 && txBuf.length < 48) return; // batch
  const batch = txBuf.splice(0, txBuf.length);
  lastTxAt = now;
  try {
    await api.post('/api/eog/push', { aref: AREFF, samples: batch });
  } catch (_) { /* ignore to keep reading */ }
}

async function startSerial() {
  if (!canUseWebSerial()) return;
  try {
    serialPort = await navigator.serial.requestPort({});
    await serialPort.open({ baudRate: 115200 });
    setSerialStatus('Serial: connecting...');
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable).catch(() => {});
    const readerLocal = textDecoder.readable.getReader();
    reader = readerLocal;
    serialRun = true;
    let buf = '';
    let posted = 0;
    epoch0 = Date.now();
    ms0 = null;
    setSerialStatus('Serial: connected');
    while (serialRun) {
      const { value, done } = await readerLocal.read();
      if (done) break;
      if (value) {
        buf += value;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          // Parse CSV: ms,raw,lop,lon
          const parts = line.split(',');
          if (parts.length < 2) continue;
          const ms = Number(parts[0]);
          const raw = Number(parts[1]);
          const lop = parts.length >= 3 ? Number(parts[2]) : 0;
          const lon = parts.length >= 4 ? Number(parts[3]) : 0;
          if (!Number.isFinite(ms) || !Number.isFinite(raw)) continue;
          if (ms0 == null) { ms0 = ms; epoch0 = Date.now(); }
          const epoch_ms = Math.round(epoch0 + (ms - ms0));
          txBuf.push({ epoch_ms, raw, lop, lon });
          posted++;
          if ((posted % 40) === 0) await serialTickSend(false);
        }
      }
    }
  } catch (e) {
    setSerialStatus('Serial: error ' + (e.message || e));
  }
}

async function stopSerial() {
  try { serialRun = false; } catch (_) {}
  try { await serialTickSend(true); } catch (_) {}
  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch (_) {}
  try { if (serialPort && serialPort.readable) await serialPort.readable.cancel(); } catch (_) {}
  try { if (serialPort) await serialPort.close(); } catch (_) {}
  reader = null; serialPort = null; setSerialStatus('Serial: disconnected');
}

serialConnectBtn?.addEventListener('click', () => startSerial());
serialDisconnectBtn?.addEventListener('click', () => stopSerial());

// Indicate availability on load
canUseWebSerial();
