import { wsConnect, api } from '/lib/dashboard-sdk.js';

// --- DOM helpers
const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const wsStatus = $('wsstatus');
const stateEl = $('state');
const ratioEl = $('ratio');
const confEl = $('confidence');
const qualEl = $('quality');
const chartCanvas = $('chart');

// --- Constants
const EPOCH_SEC = 30; // window size
const HOP_SEC = 5;    // update cadence
const CHART_WINDOW_SEC = 300; // 5 minutes

// --- State
let powLabels = [];
let motLabels = [];
let devLabels = [];

const buffers = {
  pow: [],      // { t, theta, alpha, beta, betaRel, ratioTA }
  mot: [],      // { t, accMag }
  fac: [],      // { t, eyeAct }
};
let devSignal = { t: 0, v: NaN }; // 0..1

let lastStage = null; // { label, conf, t }
const stageHistory = []; // [{ t, label, conf }]
let lastStepAt = 0; // timestamp of last classification

// --- Utilities
function nowSec() { return Date.now() / 1000; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pruneBuffer(arr, minT) { while (arr.length && arr[0].t < minT) arr.shift(); }
function avg(nums) { const a = nums; if (!a.length) return NaN; let s=0; for (const v of a) s+=v; return s/a.length; }
function median(nums) { if (!nums.length) return NaN; const a=[...nums].sort((a,b)=>a-b); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }

// Convert pow array into band averages across sensors
function bandsFromPowArray(arr) {
  const sums = { theta:0, alpha:0, betaL:0, betaH:0, gamma:0 };
  const counts = { theta:0, alpha:0, betaL:0, betaH:0, gamma:0 };
  for (let i = 0; i < powLabels.length; i++) {
    const lab = powLabels[i];
    const v = arr[i];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    const parts = String(lab).split('/');
    if (parts.length !== 2) continue;
    const band = parts[1];
    if (sums[band] === undefined) continue;
    sums[band] += v; counts[band]++;
  }
  const get = (band) => counts[band] ? sums[band]/counts[band] : NaN;
  const theta = get('theta');
  const alpha = get('alpha');
  const beta = (get('betaL') + get('betaH')) / 2;
  const total = ['theta','alpha','betaL','betaH','gamma'].map(b => get(b)).filter(x => isFinite(x)).reduce((a,b)=>a+b,0);
  const betaRel = total > 0 ? ((get('betaL')||0) + (get('betaH')||0)) / total : NaN;
  const ratioTA = isFinite(theta) && isFinite(alpha) ? theta / (alpha + 1e-6) : NaN;
  return { theta, alpha, beta, betaRel, ratioTA };
}

// Compute motion RMS (centered) over the window and return relative to recent peak
function computeMotionRmsAt(tCenter) {
  const t0 = tCenter - EPOCH_SEC;
  const windowSamples = buffers.mot.filter(s => s.t >= t0 && s.t <= tCenter);
  const vals = windowSamples.map(s => s.accMag);
  if (!vals.length) return { rms: NaN, rel: NaN };
  const m0 = median(vals);
  let s2 = 0; for (const v of vals) { const d = v - m0; s2 += d*d; }
  const rms = Math.sqrt(s2 / vals.length);
  // Relative scaling based on last 5 minutes of RMS values
  const since = tCenter - CHART_WINDOW_SEC;
  const recentVals = buffers.mot.filter(s => s.t >= since && s.t <= tCenter).map(s => Math.abs(s.accMag - m0));
  const peak = recentVals.length ? Math.max(...recentVals) : rms || 1;
  const rel = peak > 0 ? clamp(rms / (peak + 1e-6), 0, 1) : 0;
  return { rms, rel };
}

// Compute window features from pow/mot/fac
function computeWindowFeatures(now) {
  const t0 = now - EPOCH_SEC;
  pruneBuffer(buffers.pow, t0);
  pruneBuffer(buffers.mot, t0);
  pruneBuffer(buffers.fac, t0);

  // Pow window averages
  const ths = []; const als = []; const bes = []; const brs = []; const ras = [];
  for (const s of buffers.pow) {
    if (!isFinite(s.theta) || !isFinite(s.alpha)) continue;
    ths.push(s.theta); als.push(s.alpha);
    if (isFinite(s.beta)) bes.push(s.beta);
    if (isFinite(s.betaRel)) brs.push(s.betaRel);
    if (isFinite(s.ratioTA)) ras.push(s.ratioTA);
  }
  const theta = avg(ths); const alpha = avg(als); const beta = avg(bes);
  const betaRel = avg(brs); const ratioTA = avg(ras);

  // Motion
  const mot = computeMotionRmsAt(now);

  // Facial eye movement rate (events/second within window)
  let eyeEvents = 0;
  for (const s of buffers.fac) { if (s.t >= t0) eyeEvents += s.eyeEvent ? 1 : 0; }
  const facRate = eyeEvents / EPOCH_SEC; // ~events per sec

  // Device signal
  const devSig = devSignal && devSignal.t > 0 ? devSignal.v : NaN;

  return { theta, alpha, beta, betaRel, ratioTA, motionRms: mot.rms, motionRel: mot.rel, facRate, devSig };
}

function classify(features, now) {
  const { ratioTA, motionRel, betaRel, facRate, devSig } = features;
  if (!isFinite(ratioTA) || !isFinite(motionRel) || !isFinite(betaRel)) return { label: 'unknown', conf: 0.0 };

  // Poor signal gate
  if (isFinite(devSig) && devSig < 0.30) return { label: 'poor_quality', conf: 0.0 };

  const scores = { Wake: 0, Light: 0, REM: 0, Deep: 0 };

  // Primary sleep/wake
  if (ratioTA >= 1.20 && motionRel <= 0.15) scores.Light += 0.6;
  if (ratioTA < 1.00 || motionRel > 0.25) scores.Wake += 0.7;

  // Deep sleep candidate
  if (motionRel <= 0.10 && betaRel <= 0.22) scores.Deep += 0.4;

  // REM candidate (no EOG): quiet body + higher beta_rel + eye movement events
  if (motionRel <= 0.15 && betaRel >= 0.35 && (facRate || 0) > 0.02) scores.REM += 0.3;

  // Fallback
  if (scores.Wake === 0 && scores.Light === 0 && scores.REM === 0 && scores.Deep === 0) scores.Light += 0.5;

  let label = 'Wake';
  let conf = scores.Wake;
  for (const k of Object.keys(scores)) { if (scores[k] > conf) { label = k; conf = scores[k]; } }

  // Hysteresis smoothing
  if (lastStage && lastStage.label && lastStage.label !== 'poor_quality' && label !== lastStage.label) {
    const dt = now - (lastStage.t || 0);
    if (dt < 20 && conf < 0.80) { label = lastStage.label; conf = lastStage.conf; }
    if (lastStage.label === 'Wake' && label === 'REM' && conf < 0.90) { label = lastStage.label; conf = lastStage.conf; }
    if (label === 'Deep' && conf < 0.70) { label = lastStage.label; conf = lastStage.conf; }
  }

  return { label, conf };
}

// --- Chart rendering
const chart = (() => {
  const ctx = chartCanvas?.getContext('2d');
  const pad = { l: 40, r: 54, t: 14, b: 28 };
  const colors = { grid: '#e5e7eb', axis: '#9ca3af', text: '#666' };
  function mapX(t, now) {
    const x0 = now - CHART_WINDOW_SEC; const x1 = now;
    const w = chartCanvas.width - pad.l - pad.r;
    return pad.l + (w * (t - x0)) / (x1 - x0);
  }
  function drawLine(points, color, yscale) {
    if (!points.length) return;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    let first = true;
    for (const [x, y] of points) { if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  function drawAxesAndGrid(now, ranges) {
    const w = chartCanvas.width, h = chartCanvas.height; const H = h - pad.t - pad.b;
    // Outer axes
    ctx.strokeStyle = colors.axis; ctx.lineWidth = 1; ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();

    // Y-left ticks (theta/alpha)
    const { yTAmin, yTAmax } = ranges; const stepTA = 0.5;
    ctx.fillStyle = colors.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '11px system-ui, -apple-system, sans-serif';
    for (let v = yTAmin; v <= yTAmax + 1e-6; v += stepTA) {
      const y = pad.t + (1 - (v - yTAmin) / (yTAmax - yTAmin)) * H;
      // grid
      ctx.strokeStyle = colors.grid; ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      // tick
      ctx.strokeStyle = colors.axis; ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(pad.l - 4, y); ctx.lineTo(pad.l, y); ctx.stroke();
      // label
      ctx.fillText(v.toFixed(1), pad.l - 6, y);
    }

    // Y-right ticks (0..1 for beta_rel & motion)
    const yRmin = 0, yRmax = 1, stepR = 0.25;
    ctx.textAlign = 'left';
    for (let v = yRmin; v <= yRmax + 1e-6; v += stepR) {
      const y = pad.t + (1 - (v - yRmin) / (yRmax - yRmin)) * H;
      ctx.strokeStyle = colors.axis; ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(w - pad.r, y); ctx.lineTo(w - pad.r + 4, y); ctx.stroke();
      ctx.fillText(v.toFixed(2), w - pad.r + 6, y);
    }

    // X ticks: every 60s
    const stepS = 60; const x0s = now - CHART_WINDOW_SEC; const first = Math.ceil(x0s / stepS) * stepS;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = first; t <= now + 1e-6; t += stepS) {
      const x = mapX(t, now);
      ctx.strokeStyle = colors.axis; ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(x, h - pad.b); ctx.lineTo(x, h - pad.b + 4); ctx.stroke();
      const d = new Date(t * 1000); const lab = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      ctx.textBaseline = 'bottom';
      ctx.fillText(lab, x, h - pad.b - 2);
    }
    ctx.globalAlpha = 1;
  }

  function draw(now) {
    if (!ctx || !chartCanvas) return;
    const w = chartCanvas.width, h = chartCanvas.height; ctx.clearRect(0,0,w,h);
    const ranges = { yTAmin: 0, yTAmax: 3 };
    drawAxesAndGrid(now, ranges);

    // Prepare series from buffers
    const x0 = now - CHART_WINDOW_SEC;
    const seriesTA = buffers.pow.filter(s => s.t >= x0).map(s => [s.t, s.ratioTA]).filter(([,v]) => isFinite(v));
    const seriesBR = buffers.pow.filter(s => s.t >= x0).map(s => [s.t, s.betaRel]).filter(([,v]) => isFinite(v));
    // Motion: sample a smoothed value every ~2s for chart
    const seriesMR = [];
    const step = Math.max(2, Math.floor(CHART_WINDOW_SEC / 120));
    for (let t = x0; t <= now; t += step) {
      const { rel } = computeMotionRmsAt(t);
      if (isFinite(rel)) seriesMR.push([t, rel]);
    }

    // Y scales
    const yTAmin = 0, yTAmax = 3; // theta/alpha expected 0..~3
    const yBRmin = 0, yBRmax = 1; // beta_rel 0..1 (right axis)
    const yMRmin = 0, yMRmax = 1; // motionRel 0..1 (right axis)

    const H = h - pad.t - pad.b; const Y = (v, vmin, vmax) => pad.t + (1 - clamp((v - vmin) / (vmax - vmin), 0, 1)) * H;
    const ptsTA = seriesTA.map(([t, v]) => [mapX(t, now), Y(v, yTAmin, yTAmax)]);
    const ptsBR = seriesBR.map(([t, v]) => [mapX(t, now), Y(v, yBRmin, yBRmax)]);
    const ptsMR = seriesMR.map(([t, v]) => [mapX(t, now), Y(v, yMRmin, yMRmax)]);

    drawLine(ptsTA, '#1d4ed8', 1);
    drawLine(ptsBR, '#059669', 1);
    drawLine(ptsMR, '#d97706', 1);

    // Stage band at bottom (draw after grid so it sits on top)
    const bandTop = h - pad.b + 4; const bandH = pad.b - 8;
    // Draw background band
    ctx.fillStyle = '#8881'; ctx.fillRect(pad.l, bandTop, w - pad.l - pad.r, bandH);
    // Draw segments
    const colorFor = (label) => label === 'Wake' ? '#ef4444' : label === 'Light' ? '#22c55e' : label === 'REM' ? '#06b6d4' : label === 'Deep' ? '#3b82f6' : '#999';
    const hist = stageHistory.filter(s => s.t >= x0);
    for (let i = 0; i < hist.length; i++) {
      const a = hist[i]; const b = hist[i+1] || { t: now };
      const xA = mapX(a.t, now); const xB = mapX(b.t, now);
      ctx.fillStyle = colorFor(a.label); ctx.fillRect(xA, bandTop, Math.max(1, xB - xA), bandH);
    }

    // Labels
    ctx.fillStyle = '#666'; ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillText('theta/alpha', pad.l + 6, pad.t + 14);
    ctx.fillText('beta_rel', pad.l + 110, pad.t + 14);
    ctx.fillText('motion', pad.l + 180, pad.t + 14);
  }
  return { draw };
})();

// --- WebSocket wiring
const ws = wsConnect({
  onOpen: () => { wsStatus.textContent = 'WS: connected'; },
  onClose: () => { wsStatus.textContent = 'WS: disconnected (retrying)'; },
  onError: () => { wsStatus.textContent = 'WS: error'; },
  onType: {
    labels: (p) => {
      if (p.streamName === 'pow' && Array.isArray(p.labels)) powLabels = p.labels;
      if (p.streamName === 'mot' && Array.isArray(p.labels)) motLabels = p.labels;
      if (p.streamName === 'dev' && Array.isArray(p.labels)) devLabels = p.labels;
    },
    pow: (payload) => {
      const arr = payload?.pow || [];
      if (!arr.length || !powLabels.length) return;
      const t = payload.time || nowSec();
      const b = bandsFromPowArray(arr);
      buffers.pow.push({ t, ...b });
      // Keep chart horizon
      pruneBuffer(buffers.pow, nowSec() - CHART_WINDOW_SEC);
    },
    mot: (payload) => {
      const arr = payload?.mot || [];
      if (!arr.length || !motLabels.length) return;
      const t = payload.time || nowSec();
      const idxX = motLabels.indexOf('ACCX');
      const idxY = motLabels.indexOf('ACCY');
      const idxZ = motLabels.indexOf('ACCZ');
      const ax = Number(arr[idxX]); const ay = Number(arr[idxY]); const az = Number(arr[idxZ]);
      if ([ax, ay, az].every(v => typeof v === 'number' && isFinite(v))) {
        const accMag = Math.hypot(ax, ay, az);
        buffers.mot.push({ t, accMag });
        pruneBuffer(buffers.mot, nowSec() - CHART_WINDOW_SEC);
      }
    },
    dev: (payload) => {
      const arr = payload?.dev || [];
      const t = payload.time || nowSec();
      const signal = typeof arr[1] === 'number' ? clamp(arr[1], 0, 1) : NaN; // 0..1
      if (isFinite(signal)) devSignal = { t, v: signal };
    },
    fac: (payload) => {
      const arr = payload?.fac || [];
      const t = payload.time || nowSec();
      const eyeAct = arr[0]; // string
      const eyeEvent = typeof eyeAct === 'string' && /look|left|right/i.test(eyeAct);
      buffers.fac.push({ t, eyeEvent });
      pruneBuffer(buffers.fac, nowSec() - CHART_WINDOW_SEC);
    },
  }
});

// --- Periodic step: classify + render
function tick() {
  const now = nowSec();
  try {
    // Classification hop
    if (now - lastStepAt >= HOP_SEC) {
      const f = computeWindowFeatures(now);
      const { label, conf } = classify(f, now);
      lastStepAt = now;
      if (label === 'poor_quality') {
        stateEl.textContent = 'Poor signal';
        confEl.textContent = '';
      } else if (label === 'unknown') {
        stateEl.textContent = 'Analyzing…';
        confEl.textContent = '';
      } else {
        stateEl.textContent = label;
        confEl.textContent = `(conf ${conf.toFixed(2)})`;
        if (!lastStage || lastStage.label !== label || Math.abs(conf - lastStage.conf) > 1e-3) {
          lastStage = { label, conf, t: now };
          stageHistory.push({ t: now, label, conf });
        } else {
          lastStage.t = now;
        }
      }
      // Update info lines
      qualEl.textContent = isFinite(f.devSig) ? `signal ${f.devSig.toFixed(2)}` : '';
      ratioEl.textContent = isFinite(f.ratioTA)
        ? `theta/alpha ${f.ratioTA.toFixed(2)} | beta_rel ${isFinite(f.betaRel) ? f.betaRel.toFixed(2) : '-' } | motion ${isFinite(f.motionRel) ? f.motionRel.toFixed(2) : '-'}`
        : '';
    }
  } catch (_) {}
  // Prune stage history to chart window
  while (stageHistory.length && stageHistory[0].t < now - CHART_WINDOW_SEC) stageHistory.shift();
  // Redraw chart
  chart.draw(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- Start/Stop
let renewTimer = null;
function startRenewPow() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(async () => {
    try { await api.post('/api/stream/pow/renew', { ttlMs: 90_000 }); } catch (_) {}
  }, 30_000);
}
function stopRenewPow() { if (renewTimer) clearInterval(renewTimer); renewTimer = null; }

startBtn.addEventListener('click', async () => {
  try {
    await Promise.all([
      api.stream.start('pow'),
      api.stream.start('mot'),
      api.stream.start('dev'),
      api.stream.start('fac'),
    ]);
    startRenewPow();
  } catch (e) {
    alert('start error: ' + (e?.message || String(e)));
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    stopRenewPow();
    await Promise.allSettled([
      api.stream.stop('pow'),
      api.stream.stop('mot'),
      api.stream.stop('dev'),
      api.stream.stop('fac'),
    ]);
  } catch (e) {
    alert('stop error: ' + (e?.message || String(e)));
  }
});
