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
const probabilityInfoEl = $('probabilityInfo');
const thetaAlphaRatioEl = $('thetaAlphaRatio');
const betaRelEl = $('betaRel');
const motionLevelEl = $('motionLevel');
const signalQualityEl = $('signalQuality');
const totalSleepTimeEl = $('totalSleepTime');

// Debug DOM element availability
console.log('[sleepstage] DOM Elements Check:', {
  startBtn: !!startBtn,
  stopBtn: !!stopBtn,
  headsetIdInput: !!headsetIdInput,
  wsStatus: !!wsStatus,
  currentStageEl: !!currentStageEl,
  startBtnId: startBtn?.id,
  stopBtnId: stopBtn?.id
});
const sleepEfficiencyEl = $('sleepEfficiency');
const timelineEl = $('timeline');
const timelineRangeEl = $('timelineRange');
const chartCanvas = $('chart');

// --- Timers
let renewTimer = null;
let renewEqTimer = null;

function startRenewEq() {
  // EQ stream doesn't need renewal - it's designed to run continuously
  console.log('[sleepstage] EQ stream renewal not needed - running continuously');
}

function stopRenewEq() {
  // EQ stream doesn't use renewal timer
  console.log('[sleepstage] EQ stream stopped - no renewal timer to clear');
}

// --- Constants
const EPOCH_SEC = 30;
const HOP_SEC = 10; // Increased from 5 to reduce classification frequency
const CHART_WINDOW_SEC = 120; // 2 minutes for detailed view
const TIMELINE_WINDOW_SEC = 3600; // 1 hour

// --- State
let powLabels = [];
let motLabels = [];
let motIndex = new Map(); // Index map like motion.js
let devLabels = [];
let eqLabels = [];

const buffers = {
  pow: [],
  mot: [],
  eq: [],
  fac: []
};

let devSignal = { t: 0, v: NaN };
let eqOverall = NaN, srq = NaN, devOverall = NaN;
let currentStage = null;
let stageHistory = [];
let lastStepAt = 0;
let sessionStartTime = null;

// --- Quality gate functions
function isPoorQuality(features = null) {
  // 特徴量が渡された場合はそちらを優先使用
  const eqOverallToCheck = features?.eqOverall || eqOverall;
  const eqSampleRateToCheck = features?.eqSampleRate || srq;
  const devSigToCheck = features?.devSig || devOverall;
  
  // 誤判定対策：品質閾値を厳格化
  if (isFinite(eqOverallToCheck) && eqOverallToCheck < 40) return true; // 30→40に変更
  if (eqSampleRateToCheck === -1 || (isFinite(eqSampleRateToCheck) && eqSampleRateToCheck < 0.8)) return true; // 0.7→0.8に変更
  if (isFinite(devSigToCheck) && devSigToCheck < 0.35) return true; // 0.25→0.35に変更
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

// Helper functions like motion.js
function arrAt(key, arr) { 
  const i = motIndex.get(key); 
  return i != null ? arr[i] : NaN; 
}

function num(v) { 
  return typeof v === 'number' && isFinite(v) ? v : NaN; 
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
// ---- Continuous wake/sleep scoring ----------------------------------------
// 連続確率EMA状態（20秒半減期）
let scoreEma = { initialized: false, value: null, lastTime: null };

// 基本関数
function logistic(x) { return 1 / (1 + Math.exp(-x)); }

// 係数は経験則（Virtual Device対策を含む）
// 誤判定対策：より保守的な係数設定
const COEF = {
  bias:   -0.2,   // ベースライン（覚醒寄りに調整）
  theta:   1.2,   // + θ相対が高いほど眠い（係数を下げて誤判定抑制）
  ratioTA: 0.5,   // + θ/αが高いほど眠い（係数を下げて誤判定抑制）
  alpha:  -0.8,   // - α相対が高いほど覚醒寄り（係数を下げて誤判定抑制）
  beta:   -1.0,   // - β相対が高いほど覚醒寄り（係数を下げて誤判定抑制）
  motion: -1.5,   // - 動きが大きいと覚醒（動きをより重視）
};

function computeSleepProbability(feat) {
  const { thetaRel, alphaRel, betaRel, ratioTA, motionRel, devSig, eqOverall } = feat;

  // 欠損は直前値維持（なければ0.5）
  if (![thetaRel, alphaRel, betaRel, ratioTA].every(isFinite)) {
    return scoreEma.initialized ? scoreEma.value : 0.5;
  }
  
  // 異常値検出：特徴量が現実的でない場合
  if (thetaRel < 0 || thetaRel > 1 || alphaRel < 0 || alphaRel > 1 || betaRel < 0 || betaRel > 1) {
    console.log('[sleepstage] Abnormal feature values detected - using previous value');
    return scoreEma.initialized ? scoreEma.value : 0.5;
  }
  
  // 信号品質による追加制約
  if (isFinite(devSig) && devSig < 0.4) {
    console.log('[sleepstage] Low device signal quality:', devSig.toFixed(3), '- conservative estimate');
    return scoreEma.initialized ? Math.max(0.3, Math.min(0.7, scoreEma.value)) : 0.5;
  }

  // motionRel は NaN を 0 と解釈（"動きなし"）
  const m = isFinite(motionRel) ? motionRel : 0;
  
  // 誤判定対策：高い動きがある場合は強制的に覚醒寄りに
  if (m > 0.5) {
    console.log('[sleepstage] High motion detected:', m.toFixed(3), '- forcing wake bias');
    return Math.min(0.4, scoreEma.initialized ? scoreEma.value : 0.4); // 覚醒寄りに強制
  }

  // 線形結合 → ロジスティック
  const z =
    COEF.bias +
    COEF.theta   * thetaRel +
    COEF.ratioTA * Math.min(ratioTA, 2.5) + // 外れ値抑制を強化（3.0→2.5）
    COEF.alpha   * alphaRel +
    COEF.beta    * betaRel +
    COEF.motion  * m;

  const probability = logistic(z);
  
  // 誤判定対策：極端な確率を制限
  return Math.max(0.1, Math.min(0.9, probability));
}

// 時間平滑（半減期 ~20s）
function emaProb(p, t, halfLifeSec = 20) {
  const dt = Math.max(0.001, t - (scoreEma.lastTime || t));
  const k  = Math.exp(-Math.log(2) * dt / halfLifeSec);
  
  if (!scoreEma.initialized) {
    scoreEma.value = p;
    scoreEma.initialized = true;
  } else {
    scoreEma.value = k * scoreEma.value + (1 - k) * p;
  }
  
  scoreEma.lastTime = t;
  return scoreEma.value;
}

let lastBinaryLabel = 'Wake', binaryStageStartTime = 0; // ★ デフォルトは覚醒
const MIN_STAGE_SEC = 30; // 誤判定対策：最小継続時間を30秒に延長

function classifyWakeSleep(feat, now) {
  // 初期ウォームアップ期間（EMA安定化のため）
  const warmupSec = 60; // 30秒→60秒に延長
  if (sessionStartTime && now - sessionStartTime < warmupSec) {
    console.log('[sleepstage] Warmup period - staying Wake for EMA stabilization');
    return { label: 'Wake', conf: 0.3, pSleep: 0.3, pWake: 0.7 };
  }

  if (isPoorQuality(feat)) {
    console.log('[sleepstage] Classification: poor_quality (quality gate failed)');
    return { label: 'poor_quality', conf: 0, pSleep: NaN, pWake: NaN };
  }

  // 連続スコア計算
  const pRaw   = computeSleepProbability(feat);
  const pSleep = emaProb(pRaw, now);
  const pWake  = 1 - pSleep;

  console.log('[sleepstage] Continuous scores:', {
    pRaw: pRaw.toFixed(3),
    pSleep: pSleep.toFixed(3),
    pWake: pWake.toFixed(3),
    thresholds: { up: 0.70, down: 0.30 },
    currentLabel: lastBinaryLabel,
    features: {
      thetaRel: feat.thetaRel?.toFixed(3),
      alphaRel: feat.alphaRel?.toFixed(3),
      betaRel: feat.betaRel?.toFixed(3),
      ratioTA: feat.ratioTA?.toFixed(3),
      motionRel: isFinite(feat.motionRel) ? feat.motionRel.toFixed(3) : 'NaN'
    }
  });

  // 必要なら最終ラベル（ヒステリシス）
  // 誤判定対策：より厳格な閾値設定
  // p>=0.70でSleep、p<=0.30でWake、それ以外は現状維持
  const up = 0.70, down = 0.30;
  let label = lastBinaryLabel || 'Wake';
  if (pSleep >= up) label = 'Sleep';
  else if (pSleep <= down) label = 'Wake';

  // 最小継続時間の制約
  if (lastBinaryLabel === 'Wake' && binaryStageStartTime === 0) {
    // 初回判定の場合
    lastBinaryLabel = label; 
    binaryStageStartTime = now;
    console.log('[sleepstage] First classification (continuous):', label, 'pSleep:', pSleep.toFixed(3));
  } else {
    const elapsed = now - binaryStageStartTime;
    if (elapsed < MIN_STAGE_SEC && label !== 'unknown' && label !== 'poor_quality') {
      if (label !== lastBinaryLabel) {
        console.log('[sleepstage] Minimum duration enforcement (continuous):', {
          elapsed: elapsed.toFixed(1),
          minimum: MIN_STAGE_SEC,
          keeping: lastBinaryLabel,
          pSleep: pSleep.toFixed(3)
        });
        label = lastBinaryLabel; // 固定
      }
    } else if (label !== lastBinaryLabel) {
      console.log('[sleepstage] Stage transition (continuous):', {
        from: lastBinaryLabel,
        to: label,
        duration: elapsed.toFixed(1),
        pSleep: pSleep.toFixed(3)
      });
      lastBinaryLabel = label; 
      binaryStageStartTime = now;
    }
  }

  // 信頼度は「閾値からの距離」を擬似的に
  const conf = label === 'Sleep'
    ? Math.min(0.95, (pSleep - 0.5) * 1.6) // 0.5→0, 0.8→0.48
    : Math.min(0.95, (pWake  - 0.5) * 1.6);

  console.log('[sleepstage] Final result (continuous):', {
    label,
    confidence: Math.max(0, conf).toFixed(3),
    pSleep: pSleep.toFixed(3),
    pWake: pWake.toFixed(3)
  });

  return { label, conf: Math.max(0, conf), pSleep, pWake };
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
      
      // Show stages that overlap with the chart window
      if (endTime >= x0 && stage.t <= now) {
        const x1 = Math.max(pad.l, mapX(stage.t, now));
        const x2 = Math.min(w - pad.r, mapX(endTime, now));
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
  console.log('[sleepstage] calculateSleepMetrics called:', {
    sessionStartTime,
    stageHistoryLength: stageHistory.length,
    hasElements: {
      totalSleepTime: !!totalSleepTimeEl,
      sleepEfficiency: !!sleepEfficiencyEl
    }
  });
  
  if (!sessionStartTime) {
    console.log('[sleepstage] No session start time, skipping metrics');
    return;
  }
  
  if (stageHistory.length === 0) {
    console.log('[sleepstage] No stage history, resetting metrics to zero');
    if (totalSleepTimeEl) totalSleepTimeEl.textContent = '0m 0s';
    if (sleepEfficiencyEl) sleepEfficiencyEl.textContent = '0.0%';
    return;
  }
  
  const now = nowSec();
  const totalTime = now - sessionStartTime;
  
  console.log('[sleepstage] Session time info:', {
    now,
    sessionStartTime,
    totalTime: totalTime.toFixed(1),
    stageCount: stageHistory.length
  });
  
  // Calculate total sleep time by iterating through all stages chronologically
  let totalSleepTime = 0;
  const sleepStages = [];
  
  for (let i = 0; i < stageHistory.length; i++) {
    const stage = stageHistory[i];
    const nextStage = stageHistory[i + 1];
    const endTime = nextStage ? nextStage.t : now;
    const duration = endTime - stage.t;
    
    console.log('[sleepstage] Stage analysis:', {
      index: i,
      label: stage.label,
      startTime: new Date(stage.t * 1000).toLocaleTimeString(),
      endTime: new Date(endTime * 1000).toLocaleTimeString(),
      duration: duration.toFixed(1),
      isSleep: stage.label === 'Sleep'
    });
    
    // Only count Sleep stages (exclude Wake, unknown, poor_quality)
    if (stage.label === 'Sleep' && duration > 0) {
      totalSleepTime += duration;
      sleepStages.push({ start: stage.t, end: endTime, duration });
    }
  }
  
  const sleepEfficiency = totalTime > 0 ? (totalSleepTime / totalTime) * 100 : 0;
  
  console.log('[sleepstage] Metrics calculated:', {
    totalSleepTime: totalSleepTime.toFixed(1),
    sleepEfficiency: sleepEfficiency.toFixed(1),
    sleepStageCount: sleepStages.length,
    totalTime: totalTime.toFixed(1)
  });
  
  if (totalSleepTimeEl) {
    totalSleepTimeEl.textContent = formatDuration(totalSleepTime);
    console.log('[sleepstage] Updated totalSleepTime display:', totalSleepTimeEl.textContent);
  }
  
  if (sleepEfficiencyEl) {
    sleepEfficiencyEl.textContent = `${sleepEfficiency.toFixed(1)}%`;
    console.log('[sleepstage] Updated sleepEfficiency display:', sleepEfficiencyEl.textContent);
  }
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
      const result = classifyWakeSleep(features, now);
      const { label, conf, pSleep, pWake } = result;
      
      lastStepAt = now;
      
      // Update current stage display with probability-based styling
      const stageClasses = {
        'Wake': 'stage-wake',
        'Sleep': 'stage-sleep',
        'unknown': 'stage-unknown',
        'poor_quality': 'stage-unknown'
      };
      
      // Special styling for low confidence (判定中)
      let cssClass = stageClasses[label] || 'stage-unknown';
      if (conf > 0 && conf <= 0.5 && label !== 'poor_quality' && label !== 'unknown') {
        cssClass = 'stage-analyzing'; // Use analyzing styling for 判定中
      }
      
      currentStageEl.className = `stage-card ${cssClass}`;
      
      // Apply gradient background based on sleep probability
      if (isFinite(pSleep)) {
        const intensity = Math.abs(pSleep - 0.5) * 2; // 0.5=中立で0、0または1で最大
        const color = pSleep > 0.5 ? 'rgba(59, 130, 246, ' + intensity * 0.3 + ')' // blue for sleep
                                   : 'rgba(239, 68, 68, ' + intensity * 0.3 + ')';  // red for wake
        currentStageEl.style.background = color;
      } else {
        currentStageEl.style.background = ''; // デフォルト
      }
      
      // Display stage with probability information
      let displayLabel = label === 'poor_quality' ? 'Poor Signal' :
                         label === 'Sleep' ? 'Sleep' :
                         label === 'Wake' ? 'Wake' : 'Unknown';
      
      // Show "判定中" if confidence is 40% or lower
      if (conf > 0 && conf <= 0.4 && label !== 'poor_quality' && label !== 'unknown') {
        displayLabel = '判定中';
      }
      
      let statusText = displayLabel;
      if (isFinite(pSleep) && label !== 'poor_quality') {
        const sleepPercent = Math.round(pSleep * 100);
        const wakePercent = Math.round(pWake * 100);
        statusText += ` (S:${sleepPercent}% W:${wakePercent}%)`;
      }
      
      currentStageEl.querySelector('.status').textContent = statusText;
      
      // Update confidence display - show "判定中" for low confidence
      if (conf > 0) {
        if (conf <= 0.4) {
          confidenceEl.textContent = '判定中...';
        } else {
          confidenceEl.textContent = `Confidence: ${(conf * 100).toFixed(0)}%`;
        }
      } else {
        confidenceEl.textContent = '';
      }
      
      // Update probability information for debugging
      if (probabilityInfoEl && isFinite(pSleep)) {
        const sleepPercent = (pSleep * 100).toFixed(1);
        const wakePercent = (pWake * 100).toFixed(1);
        const thresholdStatus = pSleep >= 0.70 ? '→Sleep' : pSleep <= 0.30 ? '→Wake' : '維持';
        probabilityInfoEl.textContent = `確率: S:${sleepPercent}% W:${wakePercent}% | 判定: ${thresholdStatus} | 閾値: Sleep≥70%, Wake≤30%`;
        
        // Color coding based on probability
        if (pSleep >= 0.70) {
          probabilityInfoEl.style.background = '#dbeafe'; // blue for sleep
          probabilityInfoEl.style.color = '#1e40af';
        } else if (pSleep <= 0.30) {
          probabilityInfoEl.style.background = '#fee2e2'; // red for wake
          probabilityInfoEl.style.color = '#dc2626';
        } else {
          probabilityInfoEl.style.background = '#f3f4f6'; // gray for uncertain
          probabilityInfoEl.style.color = '#6b7280';
        }
      }
      
      // Update stage duration
      if (currentStage && currentStage.label === label) {
        // Same stage continues - just update duration display
        const duration = now - currentStage.t;
        durationEl.textContent = `Duration: ${formatDuration(duration)}`;
        // Don't modify currentStage.t - it should remain the start time!
      } else {
        // New stage detected - add to history and create new current stage
        console.log('[sleepstage] Stage change detected:', {
          from: currentStage?.label || 'none',
          to: label,
          previousDuration: currentStage ? (now - currentStage.t).toFixed(1) + 's' : 'none',
          stageHistoryLength: stageHistory.length,
          time: new Date(now * 1000).toLocaleTimeString()
        });
        currentStage = { label, conf, t: now };
        stageHistory.push(currentStage);
        durationEl.textContent = 'Duration: 0s';
        
        console.log('[sleepstage] Stage history updated:', {
          totalStages: stageHistory.length,
          recentStages: stageHistory.slice(-5).map(s => ({ 
            label: s.label, 
            time: new Date(s.t * 1000).toLocaleTimeString()
          }))
        });
      }
      
      // Update metrics display for binary classification
      thetaAlphaRatioEl.textContent = isFinite(features.ratioTA) ? features.ratioTA.toFixed(3) : '-';
      betaRelEl.textContent = isFinite(features.betaRel) ? features.betaRel.toFixed(3) : '-';
      motionLevelEl.textContent = isFinite(features.motionRel) ? features.motionRel.toFixed(3) : '-';
      console.log('[sleepstage] tick: motion level updated:', features.motionRel);
      
      // Display Overall EEG Quality (0-100) instead of Device Signal Quality
      if (isFinite(features.eqOverall)) {
        signalQualityEl.textContent = `${features.eqOverall.toFixed(0)}`;
      } else {
        signalQualityEl.textContent = '-';
      }
      
      console.log('[sleepstage] Metrics updated:', {
        ratioTA: isFinite(features.ratioTA) ? features.ratioTA.toFixed(3) : 'NaN',
        betaRel: isFinite(features.betaRel) ? features.betaRel.toFixed(3) : 'NaN',
        motionRel: isFinite(features.motionRel) ? features.motionRel.toFixed(3) : 'NaN',
        eqOverall: isFinite(features.eqOverall) ? features.eqOverall.toFixed(1) : 'NaN'
      });
      
      // Add eye movement rate display if available
      const eyeRateDisplay = isFinite(features.eyeMovementRate) ? 
        ` | Eye movements: ${(features.eyeMovementRate * 100).toFixed(0)}%` : '';
      
      timestampEl.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
      
      // Display EEG Overall Quality instead of Device Signal Quality
      qualityEl.textContent = isFinite(features.eqOverall) ? 
        `EEG Quality: ${features.eqOverall.toFixed(0)}${eyeRateDisplay}` : 
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
  
  // Keep stage history for timeline (1 hour), not just chart window (2 minutes)
  const timelineMinTime = now - TIMELINE_WINDOW_SEC;
  const stageHistoryBefore = stageHistory.length;
  while (stageHistory.length && stageHistory[0].t < timelineMinTime) {
    stageHistory.shift();
  }
  const stageHistoryAfter = stageHistory.length;
  
  // Debug stage history management
  if (stageHistoryBefore !== stageHistoryAfter) {
    console.log('[sleepstage] Stage history pruned:', {
      before: stageHistoryBefore,
      after: stageHistoryAfter,
      removed: stageHistoryBefore - stageHistoryAfter,
      timelineMinTime: new Date(timelineMinTime * 1000).toLocaleTimeString()
    });
  }
  
  // Update displays
  chart.draw(now);
  updateTimeline();
  
  requestAnimationFrame(tick);
}

// --- WebSocket connection
let wsConnected = false;
let wsConnectionPromise = null;

// Set initial status
wsStatus.textContent = 'WS: connecting...';
console.log('[sleepstage] Initializing WebSocket connection... (Version: 2025-09-02-v2)');

const ws = wsConnect({
  onOpen: () => {
    console.log('[sleepstage] WebSocket connected');
    wsStatus.textContent = 'WS: connected';
    wsConnected = true;
    if (wsConnectionPromise) {
      wsConnectionPromise.resolve();
      wsConnectionPromise = null;
    }
  },
  onClose: () => {
    console.log('[sleepstage] WebSocket closed');
    wsStatus.textContent = 'WS: disconnected (retrying)';
    wsConnected = false;
  },
  onError: (error) => {
    console.error('[sleepstage] WebSocket error:', error);
    wsStatus.textContent = 'WS: error';
    wsConnected = false;
    if (wsConnectionPromise) {
      wsConnectionPromise.reject(new Error('WebSocket connection failed'));
      wsConnectionPromise = null;
    }
  },
  onMessage: (ev, payload) => {
    // Handle labels event directly from message (fallback)
    if (payload && payload.type === 'labels') {
      console.log('[sleepstage] Direct labels event received:', payload);
      if (payload.payload && payload.payload.streamName === 'mot' && Array.isArray(payload.payload.labels)) {
        motLabels = payload.payload.labels;
        motIndex = new Map(motLabels.map((l, i) => [l, i]));
        console.log('[sleepstage] mot labels received via onMessage:', motLabels);
      }
      if (payload.payload && payload.payload.streamName === 'pow' && Array.isArray(payload.payload.labels)) {
        powLabels = payload.payload.labels;
        console.log('[sleepstage] pow labels received via onMessage:', powLabels);
      }
    }
  },
  onType: {
    labels: (payload) => {
      console.log('[sleepstage] labels event received:', payload);
      if (payload.streamName === 'pow' && Array.isArray(payload.labels)) {
        powLabels = payload.labels;
        console.log('[sleepstage] pow labels received:', powLabels);
      }
      if (payload.streamName === 'mot' && Array.isArray(payload.labels)) {
        motLabels = payload.labels;
        motIndex = new Map(motLabels.map((l, i) => [l, i]));
        console.log('[sleepstage] mot labels received:', motLabels, 'index:', motIndex);
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
      if (!arr.length || !powLabels.length) {
        console.log('[sleepstage] pow: skipping - no data or labels', {
          arrLength: arr.length,
          labelsLength: powLabels.length
        });
        return;
      }
      
      const t = payload.time || nowSec();
      
      // Extract power features using new featuresFromPow function
      const features = featuresFromPow(arr, powLabels);
      console.log('[sleepstage] pow: extracted features:', {
        thetaRel: isFinite(features.thetaRel) ? features.thetaRel.toFixed(3) : 'NaN',
        alphaRel: isFinite(features.alphaRel) ? features.alphaRel.toFixed(3) : 'NaN',
        betaRel: isFinite(features.betaRel) ? features.betaRel.toFixed(3) : 'NaN',
        ratioTA: isFinite(features.ratioTA) ? features.ratioTA.toFixed(3) : 'NaN'
      });
      
      // Update EMA for features with correct function signature
      const emaFeatures = emaUpdate(features, t);
      console.log('[sleepstage] pow: EMA features:', {
        thetaRel: isFinite(emaFeatures.thetaRel) ? emaFeatures.thetaRel.toFixed(3) : 'NaN',
        alphaRel: isFinite(emaFeatures.alphaRel) ? emaFeatures.alphaRel.toFixed(3) : 'NaN',
        betaRel: isFinite(emaFeatures.betaRel) ? emaFeatures.betaRel.toFixed(3) : 'NaN',
        ratioTA: isFinite(emaFeatures.ratioTA) ? emaFeatures.ratioTA.toFixed(3) : 'NaN'
      });
      
      // Store both raw bands and relative features for backward compatibility
      buffers.pow.push({ 
        t, 
        // Store EMA-smoothed relative features
        thetaRel: emaFeatures.thetaRel,
        alphaRel: emaFeatures.alphaRel,
        betaRel: emaFeatures.betaRel,
        ratioTA: emaFeatures.ratioTA
      });
      
      console.log('[sleepstage] pow: buffer updated, size:', buffers.pow.length);
      pruneBuffer(buffers.pow, nowSec() - CHART_WINDOW_SEC);
    },
    mot: (payload) => {
      const arr = payload?.mot || [];
      console.log('[sleepstage] mot payload received (v3):', { 
        arr, 
        motLabels, 
        payloadLength: arr.length, 
        labelsLength: motLabels.length,
        hasIndex: motIndex.size > 0
      });
      
      if (!arr.length) {
        console.log('[sleepstage] mot: skipping - no data');
        return;
      }
      
      const t = payload.time || nowSec();
      
      // Use motion.js style approach
      const ax = num(arrAt('ACCX', arr));
      const ay = num(arrAt('ACCY', arr));
      const az = num(arrAt('ACCZ', arr));
      
      console.log('[sleepstage] mot values (motion.js style):', { ax, ay, az });
      
      // Fallback to fixed indices if arrAt fails
      if (!isFinite(ax) || !isFinite(ay) || !isFinite(az)) {
        console.log('[sleepstage] mot: arrAt failed, trying fallback indices');
        const axFb = Number(arr[3]);
        const ayFb = Number(arr[4]);
        const azFb = Number(arr[5]);
        
        console.log('[sleepstage] mot fallback values:', { axFb, ayFb, azFb });
        
        if ([axFb, ayFb, azFb].every(v => typeof v === 'number' && isFinite(v))) {
          const accMag = Math.hypot(axFb, ayFb, azFb);
          console.log('[sleepstage] mot: computed accMag (fallback) =', accMag);
          buffers.mot.push({ t, accMag });
          pruneBuffer(buffers.mot, nowSec() - CHART_WINDOW_SEC);
        } else {
          console.log('[sleepstage] mot: fallback failed, skipping');
        }
        return;
      }
      
      if ([ax, ay, az].every(v => typeof v === 'number' && isFinite(v))) {
        const accMag = Math.hypot(ax, ay, az);
        console.log('[sleepstage] mot: computed accMag =', accMag);
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
          overall: overall, // 0-100スケールを保持
          sampleRateQuality: isFinite(sampleRateQuality) ? sampleRateQuality : overall / 100
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
function waitForWebSocketConnection(timeoutMs = 5000) {
  console.log('[sleepstage] waitForWebSocketConnection called:', { wsConnected, hasPromise: !!wsConnectionPromise });
  
  if (wsConnected) {
    console.log('[sleepstage] WebSocket already connected');
    return Promise.resolve();
  }
  
  if (!wsConnectionPromise) {
    console.log('[sleepstage] Creating new WebSocket connection promise');
    wsConnectionPromise = {};
    wsConnectionPromise.promise = new Promise((resolve, reject) => {
      wsConnectionPromise.resolve = resolve;
      wsConnectionPromise.reject = reject;
      
      // Add timeout to avoid infinite waiting
      setTimeout(() => {
        if (wsConnectionPromise) {
          console.log('[sleepstage] WebSocket connection timeout');
          wsConnectionPromise.reject(new Error('WebSocket connection timeout'));
          wsConnectionPromise = null;
        }
      }, timeoutMs);
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
  console.log('[sleepstage] Start button clicked!', {
    wsConnected,
    startBtnExists: !!startBtn,
    apiExists: !!api,
    wsStatusText: wsStatus?.textContent
  });
  
  try {
    // Wait for WebSocket connection before starting streams
    wsStatus.textContent = 'WS: waiting for connection...';
    console.log('[sleepstage] Waiting for WebSocket connection...');
    await waitForWebSocketConnection();
    
    const headsetId = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
    console.log('[sleepstage] Using headset ID:', headsetId);
    
    // Start streams one by one to ensure proper label reception
    console.log('[sleepstage] Starting streams...');
    await api.stream.start('pow', { headsetId });
    console.log('[sleepstage] pow stream started');
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for labels
    
    await api.stream.start('mot', { headsetId });
    console.log('[sleepstage] mot stream started');
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for labels
    
    await api.stream.start('dev', { headsetId });
    console.log('[sleepstage] dev stream started');
    await api.stream.start('eq', { headsetId });
    console.log('[sleepstage] eq stream started');
    await api.stream.start('fac', { headsetId });
    console.log('[sleepstage] fac stream started');
    
    startRenewPow();
    startRenewEq();
    sessionStartTime = nowSec();
    
    // Reset stage tracking
    stageHistory = [];
    currentStage = null;
    lastBinaryLabel = 'Wake';
    binaryStageStartTime = 0;
    
    // Reset EMA state
    emaState.thetaRel = NaN;
    emaState.alphaRel = NaN;
    emaState.betaRel = NaN;
    emaState.ratioTA = NaN;
    emaState.lastT = 0;
    
    // 連続スコア用EMAリセット
    scoreEma = { initialized: false, value: null, lastTime: null };
    
    console.log('[sleepstage] Session reset - all history and state cleared');
    
    // Clear metrics
    if (totalSleepTimeEl) totalSleepTimeEl.textContent = '0m 0s';
    if (sleepEfficiencyEl) sleepEfficiencyEl.textContent = '0.0%';
    if (thetaAlphaRatioEl) thetaAlphaRatioEl.textContent = '-';
    if (betaRelEl) betaRelEl.textContent = '-';
    if (motionLevelEl) motionLevelEl.textContent = '-';
    if (signalQualityEl) signalQualityEl.textContent = '-';
    if (probabilityInfoEl) {
      probabilityInfoEl.textContent = '確率: - | 閾値: Sleep≥70%, Wake≤30%';
      probabilityInfoEl.style.background = '#f8f9fa';
      probabilityInfoEl.style.color = '#6c757d';
    }
    
    console.log('[sleepstage] All metric displays reset');
    
    // Start periodic status reporting
    const statusInterval = setInterval(() => {
      console.log('[sleepstage] Status:', {
        motLabels: motLabels.length,
        powLabels: powLabels.length,
        motBufferSize: buffers.mot.length,
        powBufferSize: buffers.pow.length,
        wsConnected
      });
    }, 10000); // Every 10 seconds
    
    console.log('Sleep stage analysis started');
  } catch (e) {
    console.error('Start error:', e);
    if (e.message.includes('timeout')) {
      wsStatus.textContent = 'WS: connection timeout - try refreshing page';
    }
    alert('Start error: ' + (e?.message || String(e)));
  }
});

stopBtn.addEventListener('click', async () => {
  console.log('[sleepstage] Stop button clicked!', {
    stopBtnExists: !!stopBtn,
    sessionStartTime,
    hasRenewTimer: !!renewTimer
  });
  
  try {
    stopRenewPow();
    stopRenewEq();
    
    console.log('[sleepstage] Stopping all streams...');
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
    console.error('Stop error:', e);
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

// --- Final initialization check
console.log('[sleepstage] Final initialization check:', {
  DOMContentLoaded: document.readyState,
  hasStartBtn: !!startBtn,
  hasStopBtn: !!stopBtn,
  hasAPI: !!api,
  hasWSConnect: !!wsConnect,
  wsConnected,
  moduleLoaded: true
});

// Additional check when DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[sleepstage] DOM Content Loaded - rechecking elements:', {
      startBtn: !!document.getElementById('start'),
      stopBtn: !!document.getElementById('stop'),
      wsStatus: !!document.getElementById('wsstatus')
    });
  });
}

// Debug function for manual testing
window.debugSleepStage = function() {
  console.log('[sleepstage] Debug info:', {
    wsConnected,
    sessionStartTime,
    wsStatus: wsStatus?.textContent,
    powLabels: powLabels.length,
    motLabels: motLabels.length,
    bufferSizes: {
      pow: buffers.pow.length,
      mot: buffers.mot.length,
      eq: buffers.eq.length,
      fac: buffers.fac.length
    },
    stageHistory: stageHistory.length,
    currentStage: currentStage?.label,
    lastStepAt: new Date(lastStepAt * 1000).toLocaleTimeString()
  });
  return { wsConnected, sessionStartTime, buffers, stageHistory };
};
