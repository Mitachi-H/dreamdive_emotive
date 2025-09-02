import { wsConnect, api } from '/lib/dashboard-sdk.js';

// --- DOM elements
const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const headsetIdInput = $('headsetId');
const saveHeadsetBtn = $('saveHeadset');
const wsStatus = $('wsstatus');
const currentStageEl = $('currentStage');
const confidenceEl = $('confidence');
const durationEl = $('duration');
const qualityEl = $('quality');
const timestampEl = $('timestamp');
const thetaAlphaRatioEl = $('thetaAlphaRatio');
const betaRelEl = $('betaRel');
const motionLevelEl = $('motionLevel');
const signalQualityEl = $('signalQuality');
const totalSleepTimeEl = $('totalSleepTime');
const sleepEfficiencyEl = $('sleepEfficiency');
const timelineEl = $('timeline');
const timelineRangeEl = $('timelineRange');
const chartCanvas = $('chart');

// --- Timers
let renewTimer = null;
let renewEqTimer = null;

function startRenewEq() {
  if (renewEqTimer) clearInterval(renewEqTimer);
  renewEqTimer = setInterval(async () => {
    try {
      await api.post('/api/stream/eq/renew', { ttlMs: 90_000 });
    } catch (_) {}
  }, 30_000);
}

function stopRenewEq() {
  if (renewEqTimer) {
    clearInterval(renewEqTimer);
    renewEqTimer = null;
  }
}

// --- Constants
const EPOCH_SEC = 30;
const HOP_SEC = 10; // Increased from 5 to reduce classification frequency
const CHART_WINDOW_SEC = 120; // 2 minutes for detailed view
const TIMELINE_WINDOW_SEC = 3600; // 1 hour

// --- State
let powLabels = [];
let motLabels = [];
let devLabels = [];
let eqLabels = [];

const buffers = {
  pow: [],
  mot: [],
  eq: []
};

let devSignal = { t: 0, v: NaN };
let eqOverall = NaN, srq = NaN, devOverall = NaN;
let currentStage = null;
let stageHistory = [];
let lastStepAt = 0;
let sessionStartTime = null;

// --- Quality gate functions
function isPoorQuality() {
  if (isFinite(eqOverall) && eqOverall < 30) return true;
  if (srq === -1 || (isFinite(srq) && srq < 0.7)) return true;
  if (isFinite(devOverall) && devOverall < 25) return true; // 補助
  return false;
}

// --- Utilities
function nowSec() {
  return Date.now() / 1000;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pruneBuffer(arr, minT) {
  while (arr.length && arr[0].t < minT) arr.shift();
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
}

function median(nums) {
  if (!nums.length) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

// --- Sleep stage analysis (Wake/Sleep binary classification with Registered Developer streams only)
function featuresFromPow(arr, labels) {
  // センサ別に格納 (AF3/theta, AF3/alpha, AF3/betaL, AF3/betaH format)
  const perSensor = new Map(); // sensor -> {theta, alpha, betaL, betaH, gamma}
  for (let i = 0; i < labels.length; i++) {
    const m = labels[i].match(/^([^/]+)\/(theta|alpha|betaL|betaH|gamma)$/i);
    const v = Number(arr[i]);
    if (!m || !isFinite(v)) continue;
    const sensor = m[1], band = m[2];
    if (!perSensor.has(sensor)) perSensor.set(sensor, {theta:0, alpha:0, betaL:0, betaH:0, gamma:0});
    perSensor.get(sensor)[band] += v;
  }

  // 各センサで相対化（gammaは除外で安定判定）
  const rels = [];
  const ratios = [];
  perSensor.forEach(b => {
    const beta = b.betaL + b.betaH;
    const denom = b.theta + b.alpha + beta; // gamma除外
    if (denom <= 0) return;
    const thetaRel = b.theta / denom;
    const alphaRel = b.alpha / denom;
    const betaRel  = beta / denom;
    rels.push({thetaRel, alphaRel, betaRel});
    if (b.alpha > 0) ratios.push(b.theta / b.alpha);
  });

  const avg = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : NaN;
  const thetaRel = avg(rels, 'thetaRel');
  const alphaRel = avg(rels, 'alphaRel');
  const betaRel  = avg(rels, 'betaRel');
  const ratioTA  = ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : NaN;

  return { thetaRel, alphaRel, betaRel, ratioTA };
}

// --- EMA 平滑化（半減期 ~12s）
const emaState = { thetaRel: NaN, alphaRel: NaN, betaRel: NaN, ratioTA: NaN, lastT: 0 };
function emaUpdate(obj, t, halfLifeSec = 12) {
  const dt = Math.max(0.001, t - (emaState.lastT || t)); // 秒
  const k  = Math.exp(-Math.log(2) * dt / halfLifeSec);  // 残存率
  for (const kf of ['thetaRel', 'alphaRel', 'betaRel', 'ratioTA']) {
    const x = obj[kf];
    if (!isFinite(x)) continue;
    const prev = emaState[kf];
    emaState[kf] = isFinite(prev) ? (k * prev + (1 - k) * x) : x;
  }
  emaState.lastT = t;
  return { thetaRel: emaState.thetaRel, alphaRel: emaState.alphaRel, betaRel: emaState.betaRel, ratioTA: emaState.ratioTA };
}

function motionAt(tCenter, epochSec = 30) {
  const half = epochSec / 2;
  const win = buffers.mot.filter(s => Math.abs(s.t - tCenter) <= half && isFinite(s.accMag));
  if (win.length < 5) return NaN;
  
  const mags = win.map(s => s.accMag);
  const med = mags.slice().sort((a, b) => a - b)[Math.floor(mags.length / 2)];
  const rms = Math.sqrt(mags.reduce((s, m) => { const d = m - med; return s + d * d; }, 0) / mags.length);
  const recentPeak = Math.max(...mags.slice(-Math.min(10, mags.length)));
  
  return recentPeak > 0 ? rms / recentPeak : rms;
}

function computeWindowFeatures(now) {
  const halfWin = EPOCH_SEC / 2;
  const tCenter = now - halfWin;
  
  const powWin = buffers.pow.filter(s => Math.abs(s.t - tCenter) <= halfWin);
  const eqWin = buffers.eq.filter(s => Math.abs(s.t - tCenter) <= halfWin);
  
  console.log('[sleepstage] computeWindowFeatures:', {
    tCenter,
    powWindowSize: powWin.length,
    eqWindowSize: eqWin.length,
    recentPowSamples: buffers.pow.slice(-3).map(s => ({
      t: s.t,
      thetaRel: isFinite(s.thetaRel) ? s.thetaRel.toFixed(3) : 'NaN',
      alphaRel: isFinite(s.alphaRel) ? s.alphaRel.toFixed(3) : 'NaN',
      betaRel: isFinite(s.betaRel) ? s.betaRel.toFixed(3) : 'NaN'
    }))
  });
  
  // Get latest power features (already EMA smoothed)
  const lastPow = powWin[powWin.length - 1];
  
  // Get latest EQ features
  const lastEq = eqWin[eqWin.length - 1];
  
  // Compute motion for this time window
  const motionRel = motionAt(tCenter, EPOCH_SEC);
  
  // Get current quality indicators
  const devSig = devSignal?.v || NaN;
  const eqOverall = lastEq?.overall || NaN;
  const eqSampleRate = lastEq?.sampleRateQuality || NaN;
  
  return lastPow ? { 
    ...lastPow, 
    motionRel, 
    devSig,
    eqOverall,
    eqSampleRate
  } : { 
    thetaRel: NaN, 
    alphaRel: NaN, 
    betaRel: NaN, 
    motionRel: NaN, 
    devSig: NaN,
    eqOverall: NaN,
    eqSampleRate: NaN
  };
}

// --- Wake/Sleep Binary Classification
const HYST = {
  toSleep: { thetaRel: 0.35, ratioTA: 1.30, alphaRel: 0.28, betaRel: 0.28, motion: 0.35 },
  toWake:  { thetaRel: 0.30, ratioTA: 1.10, alphaRel: 0.33, betaRel: 0.33, motion: 0.45 },
};
let lastBinaryLabel = null, binaryStageStartTime = 0;
const MIN_STAGE_SEC = 20;

function classifyWakeSleep(feat, now) {
  if (isPoorQuality()) {
    console.log('[sleepstage] Classification: poor_quality (quality gate failed)');
    return { label: 'poor_quality', conf: 0 };
  }

  const { thetaRel, alphaRel, betaRel, ratioTA, motionRel } = feat;
  if (![thetaRel, alphaRel, betaRel, ratioTA].every(isFinite)) {
    console.log('[sleepstage] Classification: unknown (missing key features)');
    return { label: 'unknown', conf: 0 };
  }

  console.log('[sleepstage] Classification features:', {
    thetaRel: thetaRel.toFixed(3),
    alphaRel: alphaRel.toFixed(3),
    betaRel: betaRel.toFixed(3),
    ratioTA: ratioTA.toFixed(3),
    motionRel: isFinite(motionRel) ? motionRel.toFixed(3) : 'NaN',
    lastLabel: lastBinaryLabel
  });

  const TH = (lastBinaryLabel === 'Sleep') ? HYST.toWake : HYST.toSleep;

  const wakeScore =
    (alphaRel > TH.alphaRel ? 1 : 0) +
    (betaRel  > TH.betaRel  ? 1 : 0) +
    (isFinite(motionRel) && motionRel > TH.motion ? 1 : 0);

  const sleepScore =
    (thetaRel > TH.thetaRel ? 1 : 0) +
    (ratioTA  > TH.ratioTA  ? 1 : 0) +
    ((isNaN(motionRel) || motionRel < TH.motion) ? 1 : 0) +
    (alphaRel < TH.alphaRel ? 1 : 0) +
    (betaRel  < TH.betaRel  ? 1 : 0);

  console.log('[sleepstage] Scoring:', {
    wakeScore,
    sleepScore,
    thresholds: TH
  });

  let newLabel, conf = 0.4;
  if (sleepScore >= 3 && wakeScore <= 1) {
    newLabel = 'Sleep'; 
    conf = Math.min(0.95, 0.5 + 0.1 * (sleepScore - 3));
  } else if (wakeScore >= 2 && sleepScore <= 2) {
    newLabel = 'Wake';  
    conf = Math.min(0.95, 0.5 + 0.2 * (wakeScore - 2));
  } else {
    newLabel = lastBinaryLabel || 'Wake';
    console.log('[sleepstage] Ambiguous zone - maintaining previous state');
  }

  // 最小継続時間
  if (!lastBinaryLabel) {
    lastBinaryLabel = newLabel; 
    binaryStageStartTime = now;
    console.log('[sleepstage] First classification:', newLabel);
  } else {
    const elapsed = now - binaryStageStartTime;
    if (elapsed < MIN_STAGE_SEC && newLabel !== 'unknown' && newLabel !== 'poor_quality') {
      console.log('[sleepstage] Minimum duration enforcement:', {
        elapsed: elapsed.toFixed(1),
        minimum: MIN_STAGE_SEC,
        keeping: lastBinaryLabel
      });
      newLabel = lastBinaryLabel; // 固定
    } else if (newLabel !== lastBinaryLabel) {
      console.log('[sleepstage] Stage transition:', {
        from: lastBinaryLabel,
        to: newLabel,
        duration: elapsed.toFixed(1)
      });
      lastBinaryLabel = newLabel; 
      binaryStageStartTime = now;
    }
  }

  console.log('[sleepstage] Final result:', {
    label: newLabel,
    confidence: conf.toFixed(3)
  });

  return { label: newLabel, conf };
}

// Stage transition constraints based on sleep physiology
let lastValidStage = null;
let stageStartTime = null;
const MIN_STAGE_DURATION = 30; // Increased from 20 to 30 seconds for more stability

// --- Chart rendering
const chart = (() => {
  const ctx = chartCanvas?.getContext('2d');
  const pad = { l: 50, r: 60, t: 20, b: 40 };
  
  if (!ctx) return { draw: () => {} };
  
  function mapX(t, now) {
    const x0 = now - CHART_WINDOW_SEC;
    const w = chartCanvas.width - pad.l - pad.r;
    return pad.l + (w * (t - x0)) / CHART_WINDOW_SEC;
  }
  
  function mapY(value, min, max) {
    const h = chartCanvas.height - pad.t - pad.b;
    return pad.t + h * (1 - (value - min) / (max - min));
  }
  
  function draw(now) {
    if (!ctx) return;
    
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    
    // Clear canvas
    ctx.clearRect(0, 0, w, h);
    
    // Draw axes
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.lineTo(w - pad.r, h - pad.b);
    ctx.stroke();
    
    // Draw time grid lines for 2-minute window (every 30 seconds)
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    const x0 = now - CHART_WINDOW_SEC;
    for (let i = 0; i <= 4; i++) { // 4 intervals of 30 seconds each
      const timePoint = x0 + (i * 30);
      const x = mapX(timePoint, now);
      if (x >= pad.l && x <= w - pad.r) {
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, h - pad.b);
        ctx.stroke();
        
        // Add time labels
        ctx.fillStyle = '#666';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        const label = i === 0 ? '2m ago' : i === 4 ? 'now' : `-${2 - (i * 0.5)}m`;
        ctx.fillText(label, x, h - pad.b + 15);
      }
    }
    
    // Prepare data
    const powData = buffers.pow.filter(s => s.t >= x0);
    
    if (powData.length > 0) {
      // Draw Y-axis labels for theta/alpha ratio (0-4)
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const y = mapY(i, 0, 4);
        ctx.fillText(i.toString(), pad.l - 5, y + 3);
      }
      
      // Draw theta/alpha ratio
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let first = true;
      for (const point of powData) {
        if (isFinite(point.ratioTA)) {
          const x = mapX(point.t, now);
          const y = mapY(point.ratioTA, 0, 4);
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
      
      // Draw beta relative (scale 0-1 but map to 0-4 range for visibility)
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 2;
      ctx.beginPath();
      first = true;
      for (const point of powData) {
        if (isFinite(point.betaRel)) {
          const x = mapX(point.t, now);
          const y = mapY(point.betaRel * 4, 0, 4); // Scale up for visibility
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }
    
    // Draw stage timeline at bottom
    const timelineY = h - pad.b + 10;
    const timelineHeight = 20;
    
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(pad.l, timelineY, w - pad.l - pad.r, timelineHeight);
    
    const stageColors = {
      'Wake': '#ef4444',
      'Sleep': '#3b82f6',
      'unknown': '#9ca3af',
      'poor_quality': '#f59e0b'
    };
    
    for (let i = 0; i < stageHistory.length; i++) {
      const stage = stageHistory[i];
      const nextStage = stageHistory[i + 1];
      const endTime = nextStage ? nextStage.t : now;
      
      if (stage.t >= x0) {
        const x1 = mapX(stage.t, now);
        const x2 = mapX(endTime, now);
        const width = Math.max(1, x2 - x1);
        
        ctx.fillStyle = stageColors[stage.label] || '#9ca3af';
        ctx.fillRect(x1, timelineY, width, timelineHeight);
      }
    }
  }
  
  return { draw };
})();

// --- Sleep metrics calculation
function calculateSleepMetrics() {
  if (!sessionStartTime || stageHistory.length === 0) return;
  
  const now = nowSec();
  const totalTime = now - sessionStartTime;
  
  // Only count Sleep stages (exclude Wake, unknown, poor_quality)
  const sleepStages = stageHistory.filter(s => 
    s.label === 'Sleep'
  );
  
  let totalSleepTime = 0;
  for (let i = 0; i < sleepStages.length; i++) {
    const stage = sleepStages[i];
    const nextStage = sleepStages[i + 1];
    const duration = (nextStage ? nextStage.t : now) - stage.t;
    totalSleepTime += duration;
  }
  
  const sleepEfficiency = totalTime > 0 ? (totalSleepTime / totalTime) * 100 : 0;
  
  totalSleepTimeEl.textContent = formatDuration(totalSleepTime);
  sleepEfficiencyEl.textContent = `${sleepEfficiency.toFixed(1)}%`;
}

// --- Timeline rendering
function updateTimeline() {
  if (!timelineEl) return;
  
  const now = nowSec();
  const timeRange = TIMELINE_WINDOW_SEC;
  const startTime = now - timeRange;
  
  timelineEl.innerHTML = '';
  
  const relevantStages = stageHistory.filter(s => s.t >= startTime);
  if (relevantStages.length === 0) return;
  
  const stageColors = {
    'Wake': '#ef4444',
    'Sleep': '#3b82f6',
    'unknown': '#9ca3af',
    'poor_quality': '#f59e0b'
  };
  
  for (let i = 0; i < relevantStages.length; i++) {
    const stage = relevantStages[i];
    const nextStage = relevantStages[i + 1];
    const endTime = nextStage ? nextStage.t : now;
    const duration = endTime - stage.t;
    
    if (duration > 0) {
      const startPercent = ((stage.t - startTime) / timeRange) * 100;
      const widthPercent = (duration / timeRange) * 100;
      
      const bar = document.createElement('div');
      bar.className = 'stage-bar';
      bar.style.left = `${startPercent}%`;
      bar.style.width = `${widthPercent}%`;
      bar.style.backgroundColor = stageColors[stage.label] || '#9ca3af';
      bar.textContent = duration > 60 ? stage.label : '';
      
      timelineEl.appendChild(bar);
    }
  }
  
  // Update timeline range display
  const startDate = new Date(startTime * 1000);
  const endDate = new Date(now * 1000);
  timelineRangeEl.textContent = `${startDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`;
}

// --- Main analysis loop
function tick() {
  const now = nowSec();
  
  try {
    if (now - lastStepAt >= HOP_SEC) {
      const features = computeWindowFeatures(now);
      const { label, conf } = classifyWakeSleep(features, now);
      
      lastStepAt = now;
      
      // Update current stage display
      const stageClasses = {
        'Wake': 'stage-wake',
        'Sleep': 'stage-sleep',
        'unknown': 'stage-unknown',
        'poor_quality': 'stage-unknown'
      };
      
      currentStageEl.className = `stage-card ${stageClasses[label] || 'stage-unknown'}`;
      
      // Display stage with appropriate labeling
      const displayLabel = label === 'poor_quality' ? 'Poor Signal' :
                          label === 'Sleep' ? 'Sleep' :
                          label === 'Wake' ? 'Wake' : 'Unknown';
      currentStageEl.querySelector('.status').textContent = displayLabel;
      confidenceEl.textContent = conf > 0 ? `Confidence: ${(conf * 100).toFixed(0)}%` : '';
      
      // Update stage duration
      if (currentStage && currentStage.label === label) {
        const duration = now - currentStage.t;
        durationEl.textContent = `Duration: ${formatDuration(duration)}`;
        currentStage.t = now; // Update end time
      } else {
        currentStage = { label, conf, t: now };
        stageHistory.push(currentStage);
        durationEl.textContent = 'Duration: 0s';
      }
      
      // Update metrics display for binary classification
      thetaAlphaRatioEl.textContent = isFinite(features.thetaRel) ? features.thetaRel.toFixed(2) : '-';
      betaRelEl.textContent = isFinite(features.betaRel) ? features.betaRel.toFixed(2) : '-';
      motionLevelEl.textContent = isFinite(features.motionRel) ? features.motionRel.toFixed(2) : '-';
      console.log('[sleepstage] tick: motion level updated:', features.motionRel);
      signalQualityEl.textContent = isFinite(features.devSig) ? `${(features.devSig * 100).toFixed(0)}%` : '-';
      
      // Add eye movement rate display if available
      const eyeRateDisplay = isFinite(features.eyeMovementRate) ? 
        ` | Eye movements: ${(features.eyeMovementRate * 100).toFixed(0)}%` : '';
      
      timestampEl.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
      
      qualityEl.textContent = isFinite(features.devSig) ? 
        `Signal: ${(features.devSig * 100).toFixed(0)}%${eyeRateDisplay}` : 
        eyeRateDisplay.replace(' | ', '');
      
      calculateSleepMetrics();
    }
  } catch (e) {
    console.error('Analysis error:', e);
  }
  
  // Prune old data
  const minTime = now - CHART_WINDOW_SEC;
  pruneBuffer(buffers.pow, minTime);
  pruneBuffer(buffers.mot, minTime);
  pruneBuffer(buffers.fac, minTime);
  
  while (stageHistory.length && stageHistory[0].t < minTime) {
    stageHistory.shift();
  }
  
  // Update displays
  chart.draw(now);
  updateTimeline();
  
  requestAnimationFrame(tick);
}

// --- WebSocket connection
let wsConnected = false;
let wsConnectionPromise = null;

const ws = wsConnect({
  onOpen: () => {
    wsStatus.textContent = 'WS: connected';
    wsConnected = true;
    if (wsConnectionPromise) {
      wsConnectionPromise.resolve();
      wsConnectionPromise = null;
    }
  },
  onClose: () => {
    wsStatus.textContent = 'WS: disconnected (retrying)';
    wsConnected = false;
  },
  onError: () => {
    wsStatus.textContent = 'WS: error';
    wsConnected = false;
    if (wsConnectionPromise) {
      wsConnectionPromise.reject(new Error('WebSocket connection failed'));
      wsConnectionPromise = null;
    }
  },
  onType: {
    labels: (payload) => {
      if (payload.streamName === 'pow' && Array.isArray(payload.labels)) {
        powLabels = payload.labels;
        console.log('[sleepstage] pow labels received:', powLabels);
      }
      if (payload.streamName === 'mot' && Array.isArray(payload.labels)) {
        motLabels = payload.labels;
        console.log('[sleepstage] mot labels received:', motLabels);
      }
      if (payload.streamName === 'dev' && Array.isArray(payload.labels)) {
        devLabels = payload.labels;
        console.log('[sleepstage] dev labels received:', devLabels);
      }
      if (payload.streamName === 'eq' && Array.isArray(payload.labels)) {
        eqLabels = payload.labels;
        console.log('[sleepstage] eq labels received:', eqLabels);
      }
    },
    pow: (payload) => {
      const arr = payload?.pow || [];
      if (!arr.length || !powLabels.length) return;
      
      const t = payload.time || nowSec();
      
      // Extract power features using new featuresFromPow function
      const features = featuresFromPow(arr, powLabels);
      
      // Update EMA for features
      emaUpdate('thetaRel', features.thetaRel, t);
      emaUpdate('alphaRel', features.alphaRel, t);
      emaUpdate('betaRel', features.betaLRel + features.betaHRel, t); // Combined beta
      
      // Store both raw bands and relative features for backward compatibility
      buffers.pow.push({ 
        t, 
        theta: features.theta,
        alpha: features.alpha,
        betaL: features.betaL,
        betaH: features.betaH,
        gamma: features.gamma,
        // Relative power features
        thetaRel: features.thetaRel,
        alphaRel: features.alphaRel,
        betaLRel: features.betaLRel,
        betaHRel: features.betaHRel,
        betaRel: features.betaLRel + features.betaHRel
      });
      
      pruneBuffer(buffers.pow, nowSec() - CHART_WINDOW_SEC);
    },
    mot: (payload) => {
      const arr = payload?.mot || [];
      console.log('[sleepstage] mot payload received:', { arr, motLabels, payloadLength: arr.length, labelsLength: motLabels.length });
      
      if (!arr.length || !motLabels.length) {
        console.log('[sleepstage] mot: skipping - no data or labels');
        return;
      }
      
      const t = payload.time || nowSec();
      const idxX = motLabels.indexOf('ACCX');
      const idxY = motLabels.indexOf('ACCY');
      const idxZ = motLabels.indexOf('ACCZ');
      
      console.log('[sleepstage] mot indices:', { idxX, idxY, idxZ });
      
      const ax = Number(arr[idxX]);
      const ay = Number(arr[idxY]);
      const az = Number(arr[idxZ]);
      
      console.log('[sleepstage] mot values:', { ax, ay, az });
      
      if ([ax, ay, az].every(v => typeof v === 'number' && isFinite(v))) {
        const accMag = Math.hypot(ax, ay, az);
        buffers.mot.push({ t, accMag });
        pruneBuffer(buffers.mot, nowSec() - CHART_WINDOW_SEC);
        console.log('[sleepstage] mot: added to buffer, accMag:', accMag, 'buffer size:', buffers.mot.length);
      } else {
        console.log('[sleepstage] mot: invalid values, skipping');
      }
    },
    dev: (payload) => {
      const arr = payload?.dev || [];
      const t = payload.time || nowSec();
      const signal = typeof arr[1] === 'number' ? clamp(arr[1], 0, 1) : NaN;
      if (isFinite(signal)) {
        devSignal = { t, v: signal };
      }
    },
    eq: (payload) => {
      const arr = payload?.eq || [];
      if (!arr.length || !eqLabels.length) return;
      
      const t = payload.time || nowSec();
      
      // Parse EQ values based on labels
      const overallIdx = eqLabels.indexOf('OVERALL');
      const sampleRateIdx = eqLabels.indexOf('SAMPLE_RATE_QUALITY');
      
      const overall = overallIdx >= 0 ? Number(arr[overallIdx]) : NaN;
      const sampleRateQuality = sampleRateIdx >= 0 ? Number(arr[sampleRateIdx]) : NaN;
      
      if (isFinite(overall)) {
        buffers.eq.push({ 
          t, 
          overall: clamp(overall, 0, 1),
          sampleRateQuality: isFinite(sampleRateQuality) ? clamp(sampleRateQuality, 0, 1) : overall
        });
        pruneBuffer(buffers.eq, nowSec() - CHART_WINDOW_SEC);
      }
    },
    fac: (payload) => {
      const arr = payload?.fac || [];
      const t = payload.time || nowSec();
      const eyeAct = arr[0];
      const eyeEvent = typeof eyeAct === 'string' && /look|left|right/i.test(eyeAct);
      buffers.fac.push({ t, eyeEvent });
      pruneBuffer(buffers.fac, nowSec() - CHART_WINDOW_SEC);
    },
  }
});

// --- WebSocket connection utility
function waitForWebSocketConnection() {
  if (wsConnected) {
    return Promise.resolve();
  }
  
  if (!wsConnectionPromise) {
    wsConnectionPromise = {};
    wsConnectionPromise.promise = new Promise((resolve, reject) => {
      wsConnectionPromise.resolve = resolve;
      wsConnectionPromise.reject = reject;
    });
  }
  
  return wsConnectionPromise.promise;
}

// --- Stream management
function startRenewPow() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(async () => {
    try {
      await api.post('/api/stream/pow/renew', { ttlMs: 90_000 });
    } catch (_) {}
  }, 30_000);
}

function stopRenewPow() {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
}

// --- Event handlers
startBtn.addEventListener('click', async () => {
  try {
    // Wait for WebSocket connection before starting streams
    wsStatus.textContent = 'WS: waiting for connection...';
    await waitForWebSocketConnection();
    
    const headsetId = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
    
    await Promise.all([
      api.stream.start('pow', { headsetId }),
      api.stream.start('mot', { headsetId }),
      api.stream.start('dev', { headsetId }),
      api.stream.start('eq', { headsetId }),
      api.stream.start('fac', { headsetId }),
    ]);
    
    startRenewPow();
    startRenewEq();
    sessionStartTime = nowSec();
    stageHistory = [];
    currentStage = null;
    
    // Clear metrics
    totalSleepTimeEl.textContent = '0m';
    sleepEfficiencyEl.textContent = '-%';
    
    console.log('Sleep stage analysis started');
  } catch (e) {
    alert('Start error: ' + (e?.message || String(e)));
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    stopRenewPow();
    stopRenewEq();
    
    await Promise.allSettled([
      api.stream.stop('pow'),
      api.stream.stop('mot'),
      api.stream.stop('dev'),
      api.stream.stop('eq'),
      api.stream.stop('fac'),
    ]);
    
    sessionStartTime = null;
    console.log('Sleep stage analysis stopped');
  } catch (e) {
    alert('Stop error: ' + (e?.message || String(e)));
  }
});

// --- Headset ID save/restore functionality
const savedHeadsetId = localStorage.getItem('headset_id');
if (savedHeadsetId && !headsetIdInput.value) {
  headsetIdInput.value = savedHeadsetId;
}

saveHeadsetBtn.addEventListener('click', () => {
  const headsetId = headsetIdInput.value.trim();
  if (headsetId) {
    localStorage.setItem('headset_id', headsetId);
    console.log('Headset ID saved:', headsetId);
  }
});

// Start the analysis loop
requestAnimationFrame(tick);
