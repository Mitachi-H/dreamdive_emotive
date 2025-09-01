import { wsConnect, api } from '/lib/dashboard-sdk.js';

// --- DOM elements
const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
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

// --- Constants
const EPOCH_SEC = 30;
const HOP_SEC = 5;
const CHART_WINDOW_SEC = 3600; // 1 hour
const TIMELINE_WINDOW_SEC = 3600; // 1 hour

// --- State
let powLabels = [];
let motLabels = [];
let devLabels = [];

const buffers = {
  pow: [],
  mot: [],
  fac: [],
};

let devSignal = { t: 0, v: NaN };
let currentStage = null;
let stageHistory = [];
let lastStepAt = 0;
let sessionStartTime = null;

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

// --- Sleep stage analysis (Based on AASM constraints with free API limitations)
function bandsFromPowArray(arr) {
  if (!arr.length || !powLabels.length) return {};
  
  // Aggregate by bands across sensors (theta: 4-8Hz, alpha: 8-12Hz, beta: 12-30Hz)
  const bands = { theta: [], alpha: [], beta: [], lowBeta: [], highBeta: [] };
  
  for (let i = 0; i < powLabels.length; i++) {
    const label = powLabels[i];
    const value = arr[i];
    if (typeof value !== 'number' || !isFinite(value)) continue;
    
    if (label.includes('theta')) bands.theta.push(value);
    else if (label.includes('alpha')) bands.alpha.push(value);
    else if (label.includes('beta')) {
      bands.beta.push(value);
      // Distinguish low beta (12-20Hz) vs high beta (20-30Hz) if possible
      if (label.includes('lowBeta') || label.includes('low_beta')) bands.lowBeta.push(value);
      else if (label.includes('highBeta') || label.includes('high_beta')) bands.highBeta.push(value);
      else {
        // If no distinction, split evenly
        bands.lowBeta.push(value * 0.6);
        bands.highBeta.push(value * 0.4);
      }
    }
  }
  
  const theta = avg(bands.theta);
  const alpha = avg(bands.alpha);
  const beta = avg(bands.beta);
  const lowBeta = avg(bands.lowBeta);
  const highBeta = avg(bands.highBeta);
  
  // Calculate relative powers
  const totalPower = theta + alpha + beta;
  const betaRel = isFinite(beta) && totalPower > 0 ? beta / totalPower : NaN;
  const alphaRel = isFinite(alpha) && totalPower > 0 ? alpha / totalPower : NaN;
  const thetaRel = isFinite(theta) && totalPower > 0 ? theta / totalPower : NaN;
  
  // Key ratios for sleep staging
  const ratioTA = isFinite(theta) && isFinite(alpha) && alpha > 0 ? theta / alpha : NaN;
  const ratioTB = isFinite(theta) && isFinite(beta) && beta > 0 ? theta / beta : NaN;
  
  // Pseudo-delta indicator (very low freq estimation from theta dominance)
  const pseudoDelta = isFinite(theta) && isFinite(ratioTA) && ratioTA > 3 ? theta * 1.5 : 0;
  
  return { 
    theta, alpha, beta, lowBeta, highBeta,
    betaRel, alphaRel, thetaRel,
    ratioTA, ratioTB, pseudoDelta,
    totalPower
  };
}

function computeMotionRmsAt(tCenter) {
  const halfWin = EPOCH_SEC / 2;
  const relevant = buffers.mot.filter(s => 
    Math.abs(s.t - tCenter) <= halfWin && isFinite(s.accMag)
  );
  
  if (relevant.length < 5) return NaN;
  
  const mags = relevant.map(s => s.accMag);
  const baseline = median(mags);
  const deviations = mags.map(m => Math.abs(m - baseline));
  const rms = Math.sqrt(avg(deviations.map(d => d * d)));
  
  // Relative to recent peak
  const recentPeak = Math.max(...mags.slice(-10));
  return recentPeak > 0 ? rms / recentPeak : rms;
}

function computeWindowFeatures(now) {
  const halfWin = EPOCH_SEC / 2;
  const tCenter = now - halfWin;
  
  const powWin = buffers.pow.filter(s => Math.abs(s.t - tCenter) <= halfWin);
  
  if (powWin.length < 3) {
    return { 
      ratioTA: NaN, betaRel: NaN, alphaRel: NaN, thetaRel: NaN,
      motionRel: NaN, devSig: NaN, eyeMovementRate: NaN,
      pseudoDelta: NaN, ratioTB: NaN
    };
  }
  
  const avgFeatures = {
    ratioTA: avg(powWin.map(s => s.ratioTA).filter(v => isFinite(v))),
    betaRel: avg(powWin.map(s => s.betaRel).filter(v => isFinite(v))),
    alphaRel: avg(powWin.map(s => s.alphaRel).filter(v => isFinite(v))),
    thetaRel: avg(powWin.map(s => s.thetaRel).filter(v => isFinite(v))),
    pseudoDelta: avg(powWin.map(s => s.pseudoDelta).filter(v => isFinite(v))),
    ratioTB: avg(powWin.map(s => s.ratioTB).filter(v => isFinite(v))),
  };
  
  const motionRel = computeMotionRmsAt(tCenter);
  const devSig = isFinite(devSignal.v) && (now - devSignal.t) < 10 ? devSignal.v : NaN;
  
  // Compute eye movement rate from FAC stream (for REM detection)
  const facWin = buffers.fac.filter(s => Math.abs(s.t - tCenter) <= halfWin);
  const eyeEvents = facWin.filter(s => s.eyeEvent).length;
  const eyeMovementRate = facWin.length > 0 ? eyeEvents / facWin.length : 0;
  
  return { ...avgFeatures, motionRel, devSig, eyeMovementRate };
}

function classifySleepStage(features, now) {
  const { 
    ratioTA, betaRel, alphaRel, thetaRel, motionRel, devSig, 
    eyeMovementRate, pseudoDelta, ratioTB 
  } = features;
  
  // Signal quality check
  if (isFinite(devSig) && devSig < 0.6) {
    return { label: 'poor_quality', conf: 0.0 };
  }
  
  if (!isFinite(ratioTA) || !isFinite(betaRel)) {
    return { label: 'unknown', conf: 0.0 };
  }
  
  let label = 'unknown';
  let conf = 0.0;
  
  // AASM-inspired classification with free API constraints
  
  // 1. Wake detection (alpha dominant, high motion or high beta)
  if (alphaRel > 0.3 && (motionRel > 0.4 || betaRel > 0.5)) {
    label = 'Wake';
    conf = Math.min(0.95, 0.7 + Math.max(alphaRel - 0.3, betaRel - 0.5) * 0.5);
  }
  // 2. Deep_candidate (pseudo-delta high, very low beta, minimal motion)
  else if (pseudoDelta > 0 && betaRel < 0.15 && 
           (isNaN(motionRel) || motionRel < 0.2) && ratioTA > 3.0) {
    label = 'Deep_candidate';
    conf = Math.min(0.85, 0.5 + (ratioTA - 3.0) * 0.1 + (0.15 - betaRel) * 2);
  }
  // 3. REM_candidate (low motion + eye movements + moderate beta)
  else if ((isNaN(motionRel) || motionRel < 0.3) && 
           eyeMovementRate > 0.1 && betaRel > 0.25 && betaRel < 0.5) {
    label = 'REM_candidate';
    conf = Math.min(0.80, 0.4 + eyeMovementRate * 2 + (betaRel - 0.25) * 1.5);
  }
  // 4. Light_NREM_candidate (theta dominance, low motion, moderate beta)
  else if (ratioTA > 1.5 && betaRel < 0.4 && 
           (isNaN(motionRel) || motionRel < 0.4)) {
    label = 'Light_NREM_candidate';
    conf = Math.min(0.75, 0.4 + (ratioTA - 1.5) * 0.3 + (0.4 - betaRel) * 0.8);
  }
  // 5. Fallback based on motion and basic ratios
  else if (isFinite(motionRel) && motionRel > 0.5) {
    label = 'Wake';
    conf = 0.6;
  }
  else if (ratioTA > 1.2) {
    label = 'Light_NREM_candidate';
    conf = 0.3;
  }
  else {
    label = 'Wake';
    conf = 0.3;
  }
  
  // Apply stage transition constraints and minimum duration
  const constrainedStage = applyStageConstraints(label, conf, now);
  
  return constrainedStage;
}

// Stage transition constraints based on sleep physiology
let lastValidStage = null;
let stageStartTime = null;
const MIN_STAGE_DURATION = 20; // seconds

function applyStageConstraints(newLabel, newConf, now) {
  // Initialize if first classification
  if (!lastValidStage) {
    lastValidStage = { label: newLabel, conf: newConf, t: now };
    stageStartTime = now;
    return { label: newLabel, conf: newConf };
  }
  
  const timeSinceStageStart = now - stageStartTime;
  const currentLabel = lastValidStage.label;
  
  // Enforce minimum stage duration (except for poor quality)
  if (timeSinceStageStart < MIN_STAGE_DURATION && 
      newLabel !== 'poor_quality' && 
      currentLabel !== 'unknown') {
    return { label: currentLabel, conf: lastValidStage.conf };
  }
  
  // Physiologically invalid transitions
  const invalidTransitions = [
    ['Wake', 'REM_candidate'],           // Can't go directly from Wake to REM
    ['Wake', 'Deep_candidate'],          // Usually need Light NREM first
    ['Deep_candidate', 'Wake'],          // Deep to Wake is rare without Light
    ['REM_candidate', 'Deep_candidate'], // REM to Deep is uncommon
  ];
  
  for (const [from, to] of invalidTransitions) {
    if (currentLabel === from && newLabel === to && newConf < 0.8) {
      // If confidence is very high, allow the transition
      // Otherwise, transition through Light_NREM_candidate
      if (newLabel === 'REM_candidate' || newLabel === 'Deep_candidate') {
        return { label: 'Light_NREM_candidate', conf: Math.max(0.4, newConf * 0.7) };
      }
    }
  }
  
  // Accept the new stage
  if (newLabel !== currentLabel) {
    stageStartTime = now;
  }
  
  lastValidStage = { label: newLabel, conf: newConf, t: now };
  return { label: newLabel, conf: newConf };
}

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
    
    // Prepare data
    const x0 = now - CHART_WINDOW_SEC;
    const powData = buffers.pow.filter(s => s.t >= x0);
    
    if (powData.length > 0) {
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
      
      // Draw beta relative
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 2;
      ctx.beginPath();
      first = true;
      for (const point of powData) {
        if (isFinite(point.betaRel)) {
          const x = mapX(point.t, now);
          const y = mapY(point.betaRel, 0, 1);
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
      'Light_NREM_candidate': '#22c55e',
      'REM_candidate': '#06b6d4',
      'Deep_candidate': '#3b82f6',
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
  
  // Only count actual sleep candidates (exclude Wake, unknown, poor_quality)
  const sleepStages = stageHistory.filter(s => 
    s.label !== 'Wake' && s.label !== 'unknown' && s.label !== 'poor_quality'
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
    'Light_NREM_candidate': '#22c55e',
    'REM_candidate': '#06b6d4',
    'Deep_candidate': '#3b82f6',
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
      const { label, conf } = classifySleepStage(features, now);
      
      lastStepAt = now;
      
      // Update current stage display
      const stageClasses = {
        'Wake': 'stage-wake',
        'Light_NREM_candidate': 'stage-light',
        'REM_candidate': 'stage-rem',
        'Deep_candidate': 'stage-deep',
        'unknown': 'stage-unknown',
        'poor_quality': 'stage-unknown'
      };
      
      currentStageEl.className = `stage-card ${stageClasses[label] || 'stage-unknown'}`;
      
      // Display stage with appropriate labeling
      const displayLabel = label === 'poor_quality' ? 'Poor Signal' :
                          label.replace('_candidate', ' (candidate)').replace('_', ' ');
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
      
      // Update metrics display with enhanced features
      thetaAlphaRatioEl.textContent = isFinite(features.ratioTA) ? features.ratioTA.toFixed(2) : '-';
      betaRelEl.textContent = isFinite(features.betaRel) ? features.betaRel.toFixed(2) : '-';
      motionLevelEl.textContent = isFinite(features.motionRel) ? features.motionRel.toFixed(2) : '-';
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
const ws = wsConnect({
  onOpen: () => {
    wsStatus.textContent = 'WS: connected';
  },
  onClose: () => {
    wsStatus.textContent = 'WS: disconnected (retrying)';
  },
  onError: () => {
    wsStatus.textContent = 'WS: error';
  },
  onType: {
    labels: (payload) => {
      if (payload.streamName === 'pow' && Array.isArray(payload.labels)) {
        powLabels = payload.labels;
      }
      if (payload.streamName === 'mot' && Array.isArray(payload.labels)) {
        motLabels = payload.labels;
      }
      if (payload.streamName === 'dev' && Array.isArray(payload.labels)) {
        devLabels = payload.labels;
      }
    },
    pow: (payload) => {
      const arr = payload?.pow || [];
      if (!arr.length || !powLabels.length) return;
      
      const t = payload.time || nowSec();
      const bands = bandsFromPowArray(arr);
      buffers.pow.push({ t, ...bands });
      
      pruneBuffer(buffers.pow, nowSec() - CHART_WINDOW_SEC);
    },
    mot: (payload) => {
      const arr = payload?.mot || [];
      if (!arr.length || !motLabels.length) return;
      
      const t = payload.time || nowSec();
      const idxX = motLabels.indexOf('ACCX');
      const idxY = motLabels.indexOf('ACCY');
      const idxZ = motLabels.indexOf('ACCZ');
      
      const ax = Number(arr[idxX]);
      const ay = Number(arr[idxY]);
      const az = Number(arr[idxZ]);
      
      if ([ax, ay, az].every(v => typeof v === 'number' && isFinite(v))) {
        const accMag = Math.hypot(ax, ay, az);
        buffers.mot.push({ t, accMag });
        pruneBuffer(buffers.mot, nowSec() - CHART_WINDOW_SEC);
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

// --- Stream management
let renewTimer = null;

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
    await Promise.all([
      api.stream.start('pow'),
      api.stream.start('mot'),
      api.stream.start('dev'),
      api.stream.start('fac'),
    ]);
    
    startRenewPow();
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
    
    await Promise.allSettled([
      api.stream.stop('pow'),
      api.stream.stop('mot'),
      api.stream.stop('dev'),
      api.stream.stop('fac'),
    ]);
    
    sessionStartTime = null;
    console.log('Sleep stage analysis stopped');
  } catch (e) {
    alert('Stop error: ' + (e?.message || String(e)));
  }
});

// Start the analysis loop
requestAnimationFrame(tick);
