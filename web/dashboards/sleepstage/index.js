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

// CSV解析用の要素（動的作成）
let csvFileInput = null;
let csvAnalyzeBtn = null;
let csvStatusEl = null;
let csvResultsEl = null;

// 設定パネル用の要素
let settingsPanel = null;
let settingsToggleBtn = null;

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

// --- Constants (now configurable)
let EPOCH_SEC = 30;
let HOP_SEC = 10; // Increased from 5 to reduce classification frequency
const CHART_WINDOW_SEC = 120; // 2 minutes for detailed view
const TIMELINE_WINDOW_SEC = 3600; // 1 hour

// Configurable thresholds
let thresholds = {
  // Quality thresholds
  eqOverall: 40,
  eqSampleRate: 0.8,
  devSig: 0.35,
  
  // Sleep classification thresholds
  sleepThreshold: 0.70,
  wakeThreshold: 0.30,
  
  // Time constraints
  minStageSec: 30,
  warmupSec: 60,
  
  // Probability limits
  minProbability: 0.1,
  maxProbability: 0.9,
  ratioTALimit: 2.5,
  
  // EMA parameters
  probHalfLife: 20,
  featureHalfLife: 12,
  
  // Confidence factors
  minConfidence: 0.05,
  qualityFactorMin: 0.6,
  qualityFactorMax: 1.0,
  freshnessPenalty: 0.5
};

// Sleep probability coefficients (configurable)
let COEF = {
  bias:   -0.25,  // ベースライン（わずかに覚醒寄り）
  theta:   1.2,   // + θ相対が高いほど眠い（係数を下げて誤判定抑制）
  ratioTA: 0.5,   // + θ/αが高いほど眠い（係数を下げて誤判定抑制）
  alpha:  -0.8,   // - α相対が高いほど覚醒寄り（係数を下げて誤判定抑制）
  beta:   -1.0,   // - β相対が高いほど覚醒寄り（係数を下げて誤判定抑制）
  motion: -0.1,   // - 動きが大きいと覚醒（ほぼ無効化、実験設計に合わせる）
};

// --- State
let powLabels = [];
let motLabels = [];
let motIndex = new Map(); // Index map like motion.js
let devLabels = [];
let eqLabels = [];

// 動的鮮度しきい値のための到着間隔追跡
let powIntervalEma = null, eqIntervalEma = null;
let lastPowT = null, lastEqT = null;

function emaInterval(prev, x, halfLife = 4) {
  if (!isFinite(x)) return prev;
  if (prev == null) return x;
  const k = Math.exp(-Math.log(2) / halfLife);
  return k * prev + (1 - k) * x;
}

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

// CSV解析モードの状態
let csvAnalysisMode = false;
let csvData = null;
let csvAnalysisResults = null;

// --- Quality gate functions
function isPoorQuality(features = null) {
  // 特徴量が渡された場合はそちらを優先使用
  const eqOverallToCheck = features?.eqOverall || eqOverall;
  const eqSampleRateToCheck = features?.eqSampleRate || srq;
  const devSigToCheck = features?.devSig || devOverall;
  
  // 誤判定対策：品質閾値を厳格化
  if (isFinite(eqOverallToCheck) && eqOverallToCheck < thresholds.eqOverall) return true;
  if (eqSampleRateToCheck === -1 || (isFinite(eqSampleRateToCheck) && eqSampleRateToCheck < thresholds.eqSampleRate)) return true;
  if (isFinite(devSigToCheck) && devSigToCheck < thresholds.devSig) return true;
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
function emaUpdate(obj, t, halfLifeSec = null) {
  const halfLife = halfLifeSec || thresholds.featureHalfLife;
  const dt = Math.max(0.001, t - (emaState.lastT || t)); // 秒
  const k  = Math.exp(-Math.log(2) * dt / halfLife);  // 残存率
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
    totalPowBuffer: buffers.pow.length,
    totalEqBuffer: buffers.eq.length,
    recentPowSamples: buffers.pow.slice(-3).map(s => ({
      t: s.t,
      thetaRel: isFinite(s.thetaRel) ? s.thetaRel.toFixed(3) : 'NaN',
      alphaRel: isFinite(s.alphaRel) ? s.alphaRel.toFixed(3) : 'NaN',
      betaRel: isFinite(s.betaRel) ? s.betaRel.toFixed(3) : 'NaN'
    }))
  });
  
  // Get latest power features (フォールバック戦略を強化)
  let lastPow = powWin[powWin.length - 1];
  
  // フォールバック1: 時間窓内にデータがない場合、最新データを使用（鮮度チェック付き）
  if (!lastPow && buffers.pow.length > 0) {
    const cand = buffers.pow[buffers.pow.length - 1];
    const age = now - cand.t;
    if (age <= 5) {  // 5秒より古いpowデータは使わない
      lastPow = cand;
      console.log('[sleepstage] No pow data in window, using latest pow data:', {
        age: age.toFixed(1) + 's',
        thetaRel: isFinite(lastPow.thetaRel) ? lastPow.thetaRel.toFixed(3) : 'NaN'
      });
    } else {
      console.log('[sleepstage] Latest pow data too stale:', age.toFixed(1) + 's');
    }
  }
  
  // フォールバック2: powバッファが空でも動作するように最小値セット
  if (!lastPow) {
    console.log('[sleepstage] No pow data available, creating placeholder with available data');
    lastPow = {
      thetaRel: emaState.thetaRel || NaN,
      alphaRel: emaState.alphaRel || NaN,
      betaRel: emaState.betaRel || NaN,
      ratioTA: emaState.ratioTA || NaN
    };
  }
  
  // Get latest EQ features with similar fallback strategy (鮮度チェック付き)
  let lastEq = eqWin[eqWin.length - 1];
  if (!lastEq && buffers.eq.length > 0) {
    const candEq = buffers.eq[buffers.eq.length - 1];
    const ageEq = now - candEq.t;
    if (ageEq <= 5) {  // 5秒より古いeqデータは使わない
      lastEq = candEq;
      console.log('[sleepstage] No eq data in window, using latest eq data:', {
        age: ageEq.toFixed(1) + 's',
        overall: isFinite(lastEq.overall) ? lastEq.overall.toFixed(1) : 'NaN'
      });
    } else {
      console.log('[sleepstage] Latest eq data too stale:', ageEq.toFixed(1) + 's');
    }
  }
  
  // Compute motion for this time window
  const motionRel = motionAt(tCenter, EPOCH_SEC);
  
  // Get current quality indicators
  const devSig = devSignal?.v || NaN;
  const eqOverall = lastEq?.overall || NaN;
  const eqSampleRate = lastEq?.sampleRateQuality || NaN;
  
  const result = { 
    thetaRel: lastPow.thetaRel || NaN,
    alphaRel: lastPow.alphaRel || NaN, 
    betaRel: lastPow.betaRel || NaN,
    ratioTA: lastPow.ratioTA || NaN,
    motionRel, 
    devSig,
    eqOverall,
    eqSampleRate
  };
  
  // フレッシュネス判定を添える（判定側でunknownに使う）
  result.powFresh = lastPow && isFinite(lastPow.t) ? (now - lastPow.t) : Infinity;
  result.eqFresh = lastEq && isFinite(lastEq.t) ? (now - lastEq.t) : Infinity;
  
  console.log('[sleepstage] computeWindowFeatures result:', {
    hasValidPow: !!(lastPow && (isFinite(lastPow.thetaRel) || isFinite(lastPow.alphaRel) || isFinite(lastPow.betaRel))),
    hasValidEq: !!(lastEq && isFinite(lastEq.overall)),
    thetaRel: isFinite(result.thetaRel) ? result.thetaRel.toFixed(3) : 'NaN',
    alphaRel: isFinite(result.alphaRel) ? result.alphaRel.toFixed(3) : 'NaN',
    betaRel: isFinite(result.betaRel) ? result.betaRel.toFixed(3) : 'NaN',
    ratioTA: isFinite(result.ratioTA) ? result.ratioTA.toFixed(3) : 'NaN',
    motionRel: isFinite(result.motionRel) ? result.motionRel.toFixed(3) : 'NaN',
    eqOverall: isFinite(result.eqOverall) ? result.eqOverall.toFixed(1) : 'NaN',
    powBufferSize: buffers.pow.length,
    eqBufferSize: buffers.eq.length,
    powFresh: isFinite(result.powFresh) ? result.powFresh.toFixed(1) + 's' : 'Inf',
    eqFresh: isFinite(result.eqFresh) ? result.eqFresh.toFixed(1) + 's' : 'Inf'
  });
  
  return result;
}

// --- Wake/Sleep Binary Classification
// ---- Continuous wake/sleep scoring ----------------------------------------
// 連続確率EMA状態（20秒半減期）
let scoreEma = { initialized: false, value: null, lastTime: null };

// 基本関数
function logistic(x) { return 1 / (1 + Math.exp(-x)); }

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
  
  // 線形結合 → ロジスティック
  const z =
    COEF.bias +
    COEF.theta   * thetaRel +
    COEF.ratioTA * Math.min(ratioTA, thresholds.ratioTALimit) + // 外れ値抑制
    COEF.alpha   * alphaRel +
    COEF.beta    * betaRel +
    COEF.motion  * m;

  const probability = logistic(z);
  
  // 誤判定対策：極端な確率を制限
  return Math.max(thresholds.minProbability, Math.min(thresholds.maxProbability, probability));
}

// 時間平滑（半減期 ~20s）
function emaProb(p, t, halfLifeSec = null) {
  const halfLife = halfLifeSec || thresholds.probHalfLife;
  const dt = Math.max(0.001, t - (scoreEma.lastTime || t));
  const k  = Math.exp(-Math.log(2) * dt / halfLife);
  
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

function classifyWakeSleep(feat, now) {
  // 鮮度しきい値を動的に（最低でもHOP_SEC）
  const powThr = Math.max(HOP_SEC, (powIntervalEma || HOP_SEC) * 2);
  const eqThr  = Math.max(HOP_SEC, (eqIntervalEma  || HOP_SEC) * 2);
  const staleness = Math.max(feat.powFresh, feat.eqFresh);
  const isStale = (feat.powFresh > powThr) || (feat.eqFresh > eqThr);
  
  // データが古い場合は信頼度を大幅に下げるが、unknownは出さない
  let confPenalty = 1.0;
  if (isStale) {
    // 古さに応じて信頼度を下げる（最低0.1まで）
    const maxStale = Math.max(60, powThr * 3); // 最大許容は60秒またはしきい値の3倍
    confPenalty = Math.max(0.1, 1 - (staleness - Math.max(powThr, eqThr)) / maxStale);
    console.log('[sleepstage] Stale data (low confidence):', {
      powFresh: feat.powFresh.toFixed(1) + 's',
      eqFresh: feat.eqFresh.toFixed(1) + 's',
      powThr: powThr.toFixed(1) + 's',
      eqThr: eqThr.toFixed(1) + 's',
      confPenalty: confPenalty.toFixed(3)
    });
  }

  // 初期ウォームアップ期間（EMA安定化のため）
  if (sessionStartTime && now - sessionStartTime < thresholds.warmupSec) {
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
    thresholds: { up: thresholds.sleepThreshold, down: thresholds.wakeThreshold },
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
  const up = thresholds.sleepThreshold, down = thresholds.wakeThreshold;
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
    if (elapsed < thresholds.minStageSec) {
      if (label !== lastBinaryLabel) {
        console.log('[sleepstage] Minimum duration enforcement (continuous):', {
          elapsed: elapsed.toFixed(1),
          minimum: thresholds.minStageSec,
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
  const confBase = label === 'Sleep'
    ? Math.min(0.95, (pSleep - 0.5) * 1.6) // 0.5→0, 0.8→0.48
    : Math.min(0.95, (pWake  - 0.5) * 1.6);

  // 品質係数（0.6〜1.0）
  const q = isFinite(feat.eqOverall) ? clamp(feat.eqOverall / 100, 0, 1) : 0.6;
  const qFactor = thresholds.qualityFactorMin + (thresholds.qualityFactorMax - thresholds.qualityFactorMin) * q;
  
  // 片側鮮度を別々に見る：新鮮な方が1.0、古い方は0.5まで低下
  const powThrLocal = Math.max(HOP_SEC, (powIntervalEma || HOP_SEC) * 2);
  const eqThrLocal  = Math.max(HOP_SEC, (eqIntervalEma  || HOP_SEC) * 2);
  const fPow = feat.powFresh <= powThrLocal ? 1 : thresholds.freshnessPenalty;
  const fEq  = feat.eqFresh  <= eqThrLocal  ? 1 : thresholds.freshnessPenalty;
  const fFactor = Math.min(1, Math.max(thresholds.freshnessPenalty, 0.5*fPow + 0.5*fEq));
  
  const conf = Math.max(thresholds.minConfidence, confBase * qFactor * fFactor * confPenalty);

  const dataFreshness = Math.max(feat.powFresh, feat.eqFresh);
  console.log('[sleepstage] Final result (continuous):', {
    label,
    confidence: conf.toFixed(3),
    pSleep: pSleep.toFixed(3),
    pWake: pWake.toFixed(3),
    confBase: confBase.toFixed(3),
    qFactor: qFactor.toFixed(3),
    fFactor: fFactor.toFixed(3),
    confPenalty: confPenalty.toFixed(3),
    freshness: dataFreshness.toFixed(1) + 's',
    powThr: powThrLocal.toFixed(1) + 's',
    eqThr: eqThrLocal.toFixed(1) + 's'
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
      'poor_quality': '#f59e0b', // オレンジ（判定中/品質不良）
      'analyzing': '#f59e0b' // 判定中状態用の色を追加
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
      isSleep: stage.label === 'Sleep',
      highConfidence: (stage.conf || 1) >= 0.3,
      willCount: stage.label === 'Sleep' && duration > 0 && (stage.conf || 1) >= 0.3
    });
    
    // Only count Sleep stages with reasonable confidence (exclude Wake, poor_quality, and low confidence)
    if (stage.label === 'Sleep' && duration > 0 && (stage.conf || 1) >= 0.3) {
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
    'poor_quality': '#f59e0b', // オレンジ（判定中/品質不良）
    'analyzing': '#f59e0b' // 判定中状態用の色を追加
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

// --- Settings Panel Functions
function createSettingsPanel() {
  // 設定トグルボタンを作成
  settingsToggleBtn = document.createElement('button');
  settingsToggleBtn.id = 'settingsToggleBtn';
  settingsToggleBtn.textContent = '⚙️ Settings';
  settingsToggleBtn.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    padding: 8px 12px;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    z-index: 1001;
    font-size: 14px;
  `;
  
  // 設定パネルを作成
  settingsPanel = document.createElement('div');
  settingsPanel.id = 'settingsPanel';
  settingsPanel.style.cssText = `
    position: fixed;
    top: 50px;
    right: 10px;
    width: 350px;
    max-height: 80vh;
    background: white;
    border: 2px solid #ccc;
    border-radius: 8px;
    padding: 15px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 1000;
    overflow-y: auto;
    display: none;
  `;
  
  settingsPanel.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #333;">Sleep Stage Settings</h3>
    
    <div class="settings-section">
      <h4 style="margin: 10px 0 5px 0; color: #555;">Quality Thresholds</h4>
      <label style="display: block; margin: 5px 0; color: #333;">
        EQ Overall: <input type="number" id="eqOverall" min="0" max="100" step="1" value="${thresholds.eqOverall}" style="margin-left: 5px; padding: 2px 4px;">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        EQ Sample Rate: <input type="number" id="eqSampleRate" min="0" max="1" step="0.01" value="${thresholds.eqSampleRate}" style="margin-left: 5px; padding: 2px 4px;">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Device Signal: <input type="number" id="devSig" min="0" max="1" step="0.01" value="${thresholds.devSig}" style="margin-left: 5px; padding: 2px 4px;">
      </label>
    </div>
    
    <div class="settings-section">
      <h4 style="margin: 10px 0 5px 0; color: #555;">Classification Thresholds</h4>
      <label style="display: block; margin: 5px 0; color: #333;">
        Sleep Threshold: <input type="number" id="sleepThreshold" min="0" max="1" step="0.01" value="${thresholds.sleepThreshold}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Wake Threshold: <input type="number" id="wakeThreshold" min="0" max="1" step="0.01" value="${thresholds.wakeThreshold}">
      </label>
    </div>
    
    <div class="settings-section">
      <h4 style="margin: 10px 0 5px 0; color: #555;">Time Parameters (seconds)</h4>
      <label style="display: block; margin: 5px 0; color: #333;">
        Epoch Size: <input type="number" id="epochSec" min="10" max="120" step="5" value="${EPOCH_SEC}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Hop Size: <input type="number" id="hopSec" min="1" max="30" step="1" value="${HOP_SEC}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Min Stage Duration: <input type="number" id="minStageSec" min="10" max="120" step="5" value="${thresholds.minStageSec}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Warmup Period: <input type="number" id="warmupSec" min="30" max="300" step="10" value="${thresholds.warmupSec}">
      </label>
    </div>
    
    <div class="settings-section">
      <h4 style="margin: 10px 0 5px 0; color: #555;">Sleep Probability Coefficients</h4>
      <label style="display: block; margin: 5px 0; color: #333;">
        Bias: <input type="number" id="coefBias" min="-2" max="2" step="0.01" value="${COEF.bias}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Theta: <input type="number" id="coefTheta" min="0" max="3" step="0.01" value="${COEF.theta}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Theta/Alpha Ratio: <input type="number" id="coefRatioTA" min="0" max="2" step="0.01" value="${COEF.ratioTA}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Alpha: <input type="number" id="coefAlpha" min="-3" max="0" step="0.01" value="${COEF.alpha}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Beta: <input type="number" id="coefBeta" min="-3" max="0" step="0.01" value="${COEF.beta}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Motion: <input type="number" id="coefMotion" min="-1" max="1" step="0.01" value="${COEF.motion}">
      </label>
    </div>
    
    <div class="settings-section">
      <h4 style="margin: 10px 0 5px 0; color: #555;">EMA Parameters</h4>
      <label style="display: block; margin: 5px 0; color: #333;">
        Probability Half-life: <input type="number" id="probHalfLife" min="5" max="60" step="1" value="${thresholds.probHalfLife}">
      </label>
      <label style="display: block; margin: 5px 0; color: #333;">
        Feature Half-life: <input type="number" id="featureHalfLife" min="5" max="30" step="1" value="${thresholds.featureHalfLife}">
      </label>
    </div>
    
    <div style="margin-top: 15px; text-align: center;">
      <button id="applySettings" style="padding: 8px 20px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">Apply</button>
      <button id="resetSettings" style="padding: 8px 20px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">Reset</button>
      <button id="exportSettings" style="padding: 8px 20px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer;">Export</button>
    </div>
    
    <div style="margin-top: 10px;">
      <input type="file" id="importSettings" accept=".json" style="display: none;">
      <button id="importSettingsBtn" style="padding: 6px 15px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Import Settings</button>
    </div>
  `;
  
  document.body.appendChild(settingsToggleBtn);
  document.body.appendChild(settingsPanel);
  
  // イベントリスナーを設定
  settingsToggleBtn.addEventListener('click', toggleSettingsPanel);
  document.getElementById('applySettings').addEventListener('click', applySettings);
  document.getElementById('resetSettings').addEventListener('click', resetSettings);
  document.getElementById('exportSettings').addEventListener('click', exportSettings);
  document.getElementById('importSettingsBtn').addEventListener('click', () => {
    document.getElementById('importSettings').click();
  });
  document.getElementById('importSettings').addEventListener('change', importSettings);
}

function toggleSettingsPanel() {
  if (settingsPanel.style.display === 'none') {
    settingsPanel.style.display = 'block';
    settingsToggleBtn.textContent = '⚙️ Close';
  } else {
    settingsPanel.style.display = 'none';
    settingsToggleBtn.textContent = '⚙️ Settings';
  }
}

function applySettings() {
  // 閾値を更新
  thresholds.eqOverall = parseFloat(document.getElementById('eqOverall').value);
  thresholds.eqSampleRate = parseFloat(document.getElementById('eqSampleRate').value);
  thresholds.devSig = parseFloat(document.getElementById('devSig').value);
  thresholds.sleepThreshold = parseFloat(document.getElementById('sleepThreshold').value);
  thresholds.wakeThreshold = parseFloat(document.getElementById('wakeThreshold').value);
  thresholds.minStageSec = parseFloat(document.getElementById('minStageSec').value);
  thresholds.warmupSec = parseFloat(document.getElementById('warmupSec').value);
  thresholds.probHalfLife = parseFloat(document.getElementById('probHalfLife').value);
  thresholds.featureHalfLife = parseFloat(document.getElementById('featureHalfLife').value);
  
  // 時間パラメータを更新
  EPOCH_SEC = parseFloat(document.getElementById('epochSec').value);
  HOP_SEC = parseFloat(document.getElementById('hopSec').value);
  
  // 係数を更新
  COEF.bias = parseFloat(document.getElementById('coefBias').value);
  COEF.theta = parseFloat(document.getElementById('coefTheta').value);
  COEF.ratioTA = parseFloat(document.getElementById('coefRatioTA').value);
  COEF.alpha = parseFloat(document.getElementById('coefAlpha').value);
  COEF.beta = parseFloat(document.getElementById('coefBeta').value);
  COEF.motion = parseFloat(document.getElementById('coefMotion').value);
  
  console.log('[sleepstage] Settings applied:', { thresholds, COEF, EPOCH_SEC, HOP_SEC });
  alert('Settings applied successfully!');
}

function resetSettings() {
  if (confirm('Reset all settings to default values?')) {
    // デフォルト値に戻す
    thresholds = {
      eqOverall: 40,
      eqSampleRate: 0.8,
      devSig: 0.35,
      sleepThreshold: 0.70,
      wakeThreshold: 0.30,
      minStageSec: 30,
      warmupSec: 60,
      minProbability: 0.1,
      maxProbability: 0.9,
      ratioTALimit: 2.5,
      probHalfLife: 20,
      featureHalfLife: 12,
      minConfidence: 0.05,
      qualityFactorMin: 0.6,
      qualityFactorMax: 1.0,
      freshnessPenalty: 0.5
    };
    
    COEF = {
      bias: -0.25,
      theta: 1.2,
      ratioTA: 0.5,
      alpha: -0.8,
      beta: -1.0,
      motion: -0.1
    };
    
    EPOCH_SEC = 30;
    HOP_SEC = 10;
    
    // UI更新
    updateSettingsUI();
    console.log('[sleepstage] Settings reset to defaults');
    alert('Settings reset to default values!');
  }
}

function updateSettingsUI() {
  document.getElementById('eqOverall').value = thresholds.eqOverall;
  document.getElementById('eqSampleRate').value = thresholds.eqSampleRate;
  document.getElementById('devSig').value = thresholds.devSig;
  document.getElementById('sleepThreshold').value = thresholds.sleepThreshold;
  document.getElementById('wakeThreshold').value = thresholds.wakeThreshold;
  document.getElementById('minStageSec').value = thresholds.minStageSec;
  document.getElementById('warmupSec').value = thresholds.warmupSec;
  document.getElementById('epochSec').value = EPOCH_SEC;
  document.getElementById('hopSec').value = HOP_SEC;
  document.getElementById('probHalfLife').value = thresholds.probHalfLife;
  document.getElementById('featureHalfLife').value = thresholds.featureHalfLife;
  document.getElementById('coefBias').value = COEF.bias;
  document.getElementById('coefTheta').value = COEF.theta;
  document.getElementById('coefRatioTA').value = COEF.ratioTA;
  document.getElementById('coefAlpha').value = COEF.alpha;
  document.getElementById('coefBeta').value = COEF.beta;
  document.getElementById('coefMotion').value = COEF.motion;
}

function exportSettings() {
  const settings = {
    thresholds,
    COEF,
    EPOCH_SEC,
    HOP_SEC,
    exportDate: new Date().toISOString()
  };
  
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sleepstage_settings_${new Date().toISOString().slice(0, 19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const settings = JSON.parse(e.target.result);
      
      if (settings.thresholds) Object.assign(thresholds, settings.thresholds);
      if (settings.COEF) Object.assign(COEF, settings.COEF);
      if (settings.EPOCH_SEC) EPOCH_SEC = settings.EPOCH_SEC;
      if (settings.HOP_SEC) HOP_SEC = settings.HOP_SEC;
      
      updateSettingsUI();
      console.log('[sleepstage] Settings imported:', settings);
      alert('Settings imported successfully!');
      
    } catch (error) {
      console.error('[sleepstage] Failed to import settings:', error);
      alert('Failed to import settings. Please check the file format.');
    }
  };
  
  reader.readAsText(file);
}

// --- CSV Analysis Functions
function createCSVAnalysisUI() {
  // CSV解析セクションを作成
  const csvSection = document.createElement('div');
  csvSection.id = 'csvAnalysisSection';
  csvSection.style.cssText = `
    margin: 20px 0;
    padding: 15px;
    border: 2px dashed #ccc;
    border-radius: 8px;
    background: #f9f9f9;
  `;
  
  csvSection.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #333;">CSV File Analysis</h3>
    <div style="margin-bottom: 10px;">
      <input type="file" id="csvFileInput" accept=".csv" style="margin-right: 10px;">
      <button id="csvAnalyzeBtn" disabled style="padding: 5px 15px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Analyze CSV</button>
      <button id="csvClearBtn" style="padding: 5px 15px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px;">Clear</button>
    </div>
    <div id="csvStatus" style="margin: 10px 0; font-size: 14px; color: #666;"></div>
    <div id="csvResults" style="margin-top: 15px; padding: 10px; background: white; border-radius: 4px; display: none;"></div>
  `;
  
  // startBtn の前に挿入
  if (startBtn && startBtn.parentNode) {
    startBtn.parentNode.insertBefore(csvSection, startBtn);
  }
  
  // 要素の参照を取得
  csvFileInput = $('csvFileInput');
  csvAnalyzeBtn = $('csvAnalyzeBtn');
  csvStatusEl = $('csvStatus');
  csvResultsEl = $('csvResults');
  const csvClearBtn = $('csvClearBtn');
  
  // イベントリスナーを設定
  csvFileInput.addEventListener('change', handleCSVFileSelect);
  csvAnalyzeBtn.addEventListener('click', analyzeCSVFile);
  csvClearBtn.addEventListener('click', clearCSVAnalysis);
}

function handleCSVFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    csvAnalyzeBtn.disabled = false;
    csvStatusEl.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  } else {
    csvAnalyzeBtn.disabled = true;
    csvStatusEl.textContent = '';
  }
}

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index]?.trim();
    });
    data.push(row);
  }
  
  return { headers, data };
}

function analyzeCSVFile() {
  const file = csvFileInput.files[0];
  if (!file) return;
  
  csvStatusEl.textContent = 'Reading file...';
  csvAnalyzeBtn.disabled = true;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const csvText = e.target.result;
      const { headers, data } = parseCSV(csvText);
      
      csvStatusEl.textContent = `Analyzing ${data.length} rows...`;
      
      // CSVデータを解析
      const results = processCSVData(headers, data);
      displayCSVResults(results);
      
      csvData = { headers, data };
      csvAnalysisResults = results;
      csvAnalysisMode = true;
      
      csvStatusEl.textContent = `Analysis complete. ${data.length} rows processed.`;
      
    } catch (error) {
      csvStatusEl.textContent = `Error: ${error.message}`;
      console.error('[sleepstage] CSV analysis error:', error);
    } finally {
      csvAnalyzeBtn.disabled = false;
    }
  };
  
  reader.readAsText(file);
}

function processCSVData(headers, data) {
  console.log('[sleepstage] Processing CSV data:', { headers, rowCount: data.length });
  
  // ヘッダーの分析
  const timeCol = headers.find(h => /time|timestamp/i.test(h));
  const powCols = headers.filter(h => /theta|alpha|beta/i.test(h));
  const motCols = headers.filter(h => /acc|gyro|motion/i.test(h));
  const eqCols = headers.filter(h => /quality|eq/i.test(h));
  
  console.log('[sleepstage] CSV columns detected:', { timeCol, powCols, motCols, eqCols });
  
  if (!timeCol) {
    throw new Error('No time column found. Expected column name containing "time" or "timestamp".');
  }
  
  // データポイントを処理
  const processedData = [];
  const stageResults = [];
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    try {
      // 時間の解析
      let time = parseFloat(row[timeCol]);
      if (!isFinite(time)) {
        // Unix timestampではない場合、Dateとして解析を試みる
        const date = new Date(row[timeCol]);
        if (isNaN(date.getTime())) continue;
        time = date.getTime() / 1000;
      }
      
      // パワーデータの抽出
      const powFeatures = extractPowerFeatures(row, powCols);
      
      // モーションデータの抽出
      const motionData = extractMotionData(row, motCols);
      
      // 品質データの抽出
      const qualityData = extractQualityData(row, eqCols);
      
      const features = {
        t: time,
        ...powFeatures,
        ...motionData,
        ...qualityData
      };
      
      // 睡眠段階を分類
      const classification = classifyFromFeatures(features, time);
      
      processedData.push({
        time,
        features,
        classification
      });
      
      stageResults.push({
        t: time,
        label: classification.label,
        conf: classification.conf,
        pSleep: classification.pSleep,
        pWake: classification.pWake
      });
      
    } catch (error) {
      console.warn('[sleepstage] Skipping row', i, ':', error.message);
    }
  }
  
  // 統計を計算
  const stats = calculateCSVStatistics(stageResults);
  
  return {
    processedData,
    stageResults,
    stats,
    totalRows: data.length,
    processedRows: processedData.length
  };
}

function extractPowerFeatures(row, powCols) {
  const features = {};
  
  // 基本的な脳波帯域を探す
  for (const col of powCols) {
    const value = parseFloat(row[col]);
    if (!isFinite(value)) continue;
    
    const colLower = col.toLowerCase();
    if (colLower.includes('theta')) {
      features.theta = (features.theta || 0) + value;
    } else if (colLower.includes('alpha')) {
      features.alpha = (features.alpha || 0) + value;
    } else if (colLower.includes('beta')) {
      features.beta = (features.beta || 0) + value;
    }
  }
  
  // 相対値を計算
  const total = (features.theta || 0) + (features.alpha || 0) + (features.beta || 0);
  if (total > 0) {
    features.thetaRel = (features.theta || 0) / total;
    features.alphaRel = (features.alpha || 0) / total;
    features.betaRel = (features.beta || 0) / total;
    features.ratioTA = features.alpha > 0 ? (features.theta || 0) / features.alpha : NaN;
  }
  
  return features;
}

function extractMotionData(row, motCols) {
  const motionData = {};
  
  for (const col of motCols) {
    const value = parseFloat(row[col]);
    if (!isFinite(value)) continue;
    
    const colLower = col.toLowerCase();
    if (colLower.includes('acc')) {
      motionData.accMag = (motionData.accMag || 0) + Math.abs(value);
    }
  }
  
  // モーション相対値を計算（簡易版）
  if (isFinite(motionData.accMag)) {
    motionData.motionRel = Math.min(1, motionData.accMag / 10); // 正規化
  }
  
  return motionData;
}

function extractQualityData(row, eqCols) {
  const qualityData = {};
  
  for (const col of eqCols) {
    const value = parseFloat(row[col]);
    if (!isFinite(value)) continue;
    
    const colLower = col.toLowerCase();
    if (colLower.includes('overall') || colLower.includes('quality')) {
      qualityData.eqOverall = value;
    }
  }
  
  return qualityData;
}

function classifyFromFeatures(features, time) {
  // 簡易版の分類（リアルタイム分類と同じロジックを使用）
  const feat = {
    thetaRel: features.thetaRel || NaN,
    alphaRel: features.alphaRel || NaN,
    betaRel: features.betaRel || NaN,
    ratioTA: features.ratioTA || NaN,
    motionRel: features.motionRel || NaN,
    eqOverall: features.eqOverall || NaN,
    powFresh: 0, // CSVデータは常に新鮮と仮定
    eqFresh: 0
  };
  
  // poor_quality チェック
  if (isPoorQuality(feat)) {
    return { label: 'poor_quality', conf: 0, pSleep: NaN, pWake: NaN };
  }
  
  // 睡眠確率を計算
  const pRaw = computeSleepProbability(feat);
  if (!isFinite(pRaw)) {
    return { label: 'Wake', conf: 0.3, pSleep: 0.3, pWake: 0.7 };
  }
  
  const pSleep = pRaw;
  const pWake = 1 - pSleep;
  
  // ラベルを決定
  let label = 'Wake';
  if (pSleep >= 0.70) label = 'Sleep';
  else if (pSleep <= 0.30) label = 'Wake';
  else label = 'Wake'; // 不確実な場合はWakeに
  
  // 信頼度を計算
  const confBase = label === 'Sleep' ? (pSleep - 0.5) * 1.6 : (pWake - 0.5) * 1.6;
  const qFactor = isFinite(feat.eqOverall) ? clamp(feat.eqOverall / 100, 0.6, 1) : 0.8;
  const conf = Math.max(0.1, confBase * qFactor);
  
  return { label, conf, pSleep, pWake };
}

function calculateCSVStatistics(stageResults) {
  if (!stageResults.length) return {};
  
  const totalTime = stageResults[stageResults.length - 1].t - stageResults[0].t;
  let sleepTime = 0;
  let wakeTime = 0;
  let poorQualityTime = 0;
  
  const stageTransitions = [];
  let currentStage = null;
  let stageStart = null;
  
  for (const result of stageResults) {
    if (currentStage !== result.label) {
      if (currentStage && stageStart) {
        const duration = result.t - stageStart;
        stageTransitions.push({
          stage: currentStage,
          start: stageStart,
          end: result.t,
          duration
        });
        
        if (currentStage === 'Sleep' && result.conf >= 0.3) sleepTime += duration;
        else if (currentStage === 'Wake') wakeTime += duration;
        else if (currentStage === 'poor_quality') poorQualityTime += duration;
      }
      currentStage = result.label;
      stageStart = result.t;
    }
  }
  
  // 最後のステージを処理
  if (currentStage && stageStart) {
    const duration = stageResults[stageResults.length - 1].t - stageStart;
    stageTransitions.push({
      stage: currentStage,
      start: stageStart,
      end: stageResults[stageResults.length - 1].t,
      duration
    });
    
    if (currentStage === 'Sleep') sleepTime += duration;
    else if (currentStage === 'Wake') wakeTime += duration;
    else if (currentStage === 'poor_quality') poorQualityTime += duration;
  }
  
  const sleepEfficiency = totalTime > 0 ? (sleepTime / totalTime) * 100 : 0;
  
  return {
    totalTime,
    sleepTime,
    wakeTime,
    poorQualityTime,
    sleepEfficiency,
    stageTransitions: stageTransitions.length,
    avgConfidence: stageResults.reduce((sum, r) => sum + (r.conf || 0), 0) / stageResults.length
  };
}

function displayCSVResults(results) {
  const { stats, totalRows, processedRows } = results;
  
  csvResultsEl.style.display = 'block';
  csvResultsEl.innerHTML = `
    <h4 style="margin: 0 0 10px 0; color: #333;">Analysis Results</h4>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
      <div>
        <strong>Data Processing:</strong><br>
        Total rows: ${totalRows}<br>
        Processed rows: ${processedRows}<br>
        Success rate: ${((processedRows / totalRows) * 100).toFixed(1)}%
      </div>
      <div>
        <strong>Sleep Metrics:</strong><br>
        Total time: ${formatDuration(stats.totalTime)}<br>
        Sleep time: ${formatDuration(stats.sleepTime)}<br>
        Sleep efficiency: ${stats.sleepEfficiency.toFixed(1)}%
      </div>
    </div>
    <div style="margin-top: 15px;">
      <strong>Stage Breakdown:</strong><br>
      Sleep: ${formatDuration(stats.sleepTime)} (${((stats.sleepTime / stats.totalTime) * 100).toFixed(1)}%)<br>
      Wake: ${formatDuration(stats.wakeTime)} (${((stats.wakeTime / stats.totalTime) * 100).toFixed(1)}%)<br>
      Poor Quality: ${formatDuration(stats.poorQualityTime)} (${((stats.poorQualityTime / stats.totalTime) * 100).toFixed(1)}%)<br>
      Stage transitions: ${stats.stageTransitions}<br>
      Average confidence: ${(stats.avgConfidence * 100).toFixed(1)}%
    </div>
    <div style="margin-top: 10px;">
      <button id="csvShowTimeline" style="padding: 5px 15px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Show Timeline</button>
      <button id="csvExportResults" style="padding: 5px 15px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px;">Export Results</button>
    </div>
  `;
  
  // タイムライン表示ボタン
  $('csvShowTimeline').addEventListener('click', () => {
    displayCSVTimeline(results.stageResults);
  });
  
  // 結果エクスポートボタン
  $('csvExportResults').addEventListener('click', () => {
    exportCSVResults(results);
  });
}

function displayCSVTimeline(stageResults) {
  // タイムライン表示（既存のタイムライン要素を使用）
  if (!timelineEl) return;
  
  const startTime = stageResults[0].t;
  const endTime = stageResults[stageResults.length - 1].t;
  const totalTime = endTime - startTime;
  
  timelineEl.innerHTML = '';
  
  const stageColors = {
    'Wake': '#ef4444',
    'Sleep': '#3b82f6',
    'poor_quality': '#f59e0b', // オレンジ（判定中/品質不良）
    'analyzing': '#f59e0b' // 判定中状態用の色を追加
  };
  
  let currentStage = null;
  let stageStart = null;
  
  for (const result of stageResults) {
    if (currentStage !== result.label) {
      if (currentStage && stageStart) {
        const duration = result.t - stageStart;
        const startPercent = ((stageStart - startTime) / totalTime) * 100;
        const widthPercent = (duration / totalTime) * 100;
        
        const bar = document.createElement('div');
        bar.className = 'stage-bar';
        bar.style.left = `${startPercent}%`;
        bar.style.width = `${widthPercent}%`;
        bar.style.backgroundColor = stageColors[currentStage] || '#9ca3af';
        bar.style.position = 'absolute';
        bar.style.height = '100%';
        bar.textContent = duration > 60 ? currentStage : '';
        
        timelineEl.appendChild(bar);
      }
      currentStage = result.label;
      stageStart = result.t;
    }
  }
  
  // 最後のステージを処理
  if (currentStage && stageStart) {
    const duration = endTime - stageStart;
    const startPercent = ((stageStart - startTime) / totalTime) * 100;
    const widthPercent = (duration / totalTime) * 100;
    
    const bar = document.createElement('div');
    bar.className = 'stage-bar';
    bar.style.left = `${startPercent}%`;
    bar.style.width = `${widthPercent}%`;
    bar.style.backgroundColor = stageColors[currentStage] || '#9ca3af';
    bar.style.position = 'absolute';
    bar.style.height = '100%';
    bar.textContent = duration > 60 ? currentStage : '';
    
    timelineEl.appendChild(bar);
  }
  
  // 時間範囲表示を更新
  if (timelineRangeEl) {
    const startDate = new Date(startTime * 1000);
    const endDate = new Date(endTime * 1000);
    timelineRangeEl.textContent = `CSV Analysis: ${startDate.toLocaleString()} - ${endDate.toLocaleString()}`;
  }
}

function exportCSVResults(results) {
  const { stageResults, stats } = results;
  
  // CSV形式でエクスポート
  const csvContent = [
    'timestamp,unixtime,stage,confidence,pSleep,pWake',
    ...stageResults.map(r => [
      new Date(r.t * 1000).toISOString(),
      r.t,
      r.label,
      (r.conf || 0).toFixed(3),
      isFinite(r.pSleep) ? r.pSleep.toFixed(3) : '',
      isFinite(r.pWake) ? r.pWake.toFixed(3) : ''
    ].join(','))
  ].join('\n');
  
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sleepstage_analysis_${new Date().toISOString().slice(0, 19)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearCSVAnalysis() {
  csvAnalysisMode = false;
  csvData = null;
  csvAnalysisResults = null;
  
  if (csvFileInput) csvFileInput.value = '';
  if (csvAnalyzeBtn) csvAnalyzeBtn.disabled = true;
  if (csvStatusEl) csvStatusEl.textContent = '';
  if (csvResultsEl) csvResultsEl.style.display = 'none';
  
  // タイムラインをリアルタイムモードに戻す
  updateTimeline();
}
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
        'poor_quality': 'stage-unknown'
      };
      
      // Special styling for low confidence (判定中)
      let cssClass = stageClasses[label] || 'stage-wake'; // デフォルトはwake
      if (conf > 0 && conf <= 0.5 && label !== 'poor_quality') {
        cssClass = 'stage-analyzing'; // Use analyzing styling for 判定中
      }
      
      currentStageEl.className = `stage-card ${cssClass}`;
      
      // 判定中の場合は背景色を明確に設定
      if (conf > 0 && conf <= 0.5 && label !== 'poor_quality') {
        currentStageEl.style.background = 'linear-gradient(135deg, #fbbf24, #f59e0b)'; // オレンジのグラデーション
        currentStageEl.style.color = '#1f2937'; // 濃いグレーのテキスト
        currentStageEl.style.border = '2px solid #d97706'; // オレンジの枠線
      } else {
        // Apply gradient background based on sleep probability
        if (isFinite(pSleep)) {
          const intensity = Math.abs(pSleep - 0.5) * 2; // 0.5=中立で0、0または1で最大
          const color = pSleep > 0.5 ? 'rgba(59, 130, 246, ' + intensity * 0.3 + ')' // blue for sleep
                                     : 'rgba(239, 68, 68, ' + intensity * 0.3 + ')';  // red for wake
          currentStageEl.style.background = color;
          currentStageEl.style.color = ''; // デフォルトの文字色
          currentStageEl.style.border = ''; // デフォルトの枠線
        } else {
          // For poor_quality states, use a neutral gray background for visibility
          if (label === 'poor_quality') {
            currentStageEl.style.background = 'rgba(156, 163, 175, 0.2)'; // light gray
            currentStageEl.style.color = '#374151'; // 濃いグレーのテキスト
            currentStageEl.style.border = '2px solid #9ca3af'; // グレーの枠線
          } else {
            currentStageEl.style.background = ''; // デフォルト
            currentStageEl.style.color = ''; // デフォルトの文字色
            currentStageEl.style.border = ''; // デフォルトの枠線
          }
        }
      }
      
      // Display stage with probability information
      let displayLabel = label === 'poor_quality' ? 'Poor Signal' :
                         label === 'Sleep' ? 'Sleep' :
                         label === 'Wake' ? 'Wake' : 'Wake'; // unknownの場合もWakeとして表示
      
      // Show "判定中" if confidence is 40% or lower
      if (conf > 0 && conf <= 0.4 && label !== 'poor_quality') {
        displayLabel = '判定中';
      }
      
      let statusText = displayLabel;
      if (isFinite(pSleep) && label !== 'poor_quality') {
        const sleepPercent = Math.round(pSleep * 100);
        const wakePercent = Math.round(pWake * 100);
        statusText += ` (S:${sleepPercent}% W:${wakePercent}%)`;
      }
      
      currentStageEl.querySelector('.status').textContent = statusText;
      
      // Update confidence display - always show confidence value
      if (conf > 0) {
        if (conf <= 0.4) {
          confidenceEl.textContent = `判定中... (${(conf * 100).toFixed(0)}%)`;
          confidenceEl.style.background = '#fef3cd'; // 薄いオレンジ背景
          confidenceEl.style.color = '#856404'; // 濃いオレンジテキスト
          confidenceEl.style.border = '1px solid #fdbf47'; // オレンジ枠線
          confidenceEl.style.padding = '4px 8px';
          confidenceEl.style.borderRadius = '4px';
        } else {
          confidenceEl.textContent = `Confidence: ${(conf * 100).toFixed(0)}%`;
          confidenceEl.style.background = ''; // デフォルト
          confidenceEl.style.color = ''; // デフォルト
          confidenceEl.style.border = ''; // デフォルト
          confidenceEl.style.padding = '';
          confidenceEl.style.borderRadius = '';
        }
      } else {
        confidenceEl.textContent = '判定中... (0%)'; // conf=0でも数値を表示
        confidenceEl.style.background = '#fee2e2'; // 薄い赤背景
        confidenceEl.style.color = '#991b1b'; // 濃い赤テキスト
        confidenceEl.style.border = '1px solid #fca5a5'; // 赤枠線
        confidenceEl.style.padding = '4px 8px';
        confidenceEl.style.borderRadius = '4px';
      }
      
      // Update probability information for debugging
      if (probabilityInfoEl && isFinite(pSleep)) {
        const sleepPercent = (pSleep * 100).toFixed(1);
        const wakePercent = (pWake * 100).toFixed(1);
        const thresholdStatus = pSleep >= 0.70 ? '→Sleep' : pSleep <= 0.30 ? '→Wake' : '判定中';
        const powThrDisplay = Math.max(HOP_SEC, (powIntervalEma || HOP_SEC) * 2);
        const eqThrDisplay = Math.max(HOP_SEC, (eqIntervalEma || HOP_SEC) * 2);
        const freshInfo = `fresh: pow=${isFinite(features.powFresh) ? features.powFresh.toFixed(1) + 's' : 'Inf'}(thr:${powThrDisplay.toFixed(1)}s), eq=${isFinite(features.eqFresh) ? features.eqFresh.toFixed(1) + 's' : 'Inf'}(thr:${eqThrDisplay.toFixed(1)}s)`;
        
        // 判定中の場合は、S-Wバー表示を作成
        if (pSleep > 0.30 && pSleep < 0.70) {
          // プログレスバー風の表示を作成
          const barContainer = document.createElement('div');
          barContainer.style.cssText = `
            display: flex;
            align-items: center;
            background: linear-gradient(to right, #3b82f6 0%, #3b82f6 ${sleepPercent}%, #ef4444 ${sleepPercent}%, #ef4444 100%);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
            color: white;
            font-weight: bold;
            position: relative;
            min-height: 20px;
          `;
          
          const leftLabel = document.createElement('span');
          leftLabel.textContent = 'S';
          leftLabel.style.cssText = `
            position: absolute;
            left: 8px;
            z-index: 2;
            text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
          `;
          
          const rightLabel = document.createElement('span');
          rightLabel.textContent = 'W';
          rightLabel.style.cssText = `
            position: absolute;
            right: 8px;
            z-index: 2;
            text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
          `;
          
          const centerText = document.createElement('span');
          centerText.textContent = `${sleepPercent}% | ${thresholdStatus}`;
          centerText.style.cssText = `
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            z-index: 2;
            text-shadow: 1px 1px 1px rgba(0,0,0,0.7);
            font-size: 11px;
          `;
          
          barContainer.appendChild(leftLabel);
          barContainer.appendChild(centerText);
          barContainer.appendChild(rightLabel);
          
          probabilityInfoEl.innerHTML = '';
          probabilityInfoEl.appendChild(barContainer);
          
          // 詳細情報を下に追加
          const detailInfo = document.createElement('div');
          detailInfo.textContent = `閾値: Sleep≥70%, Wake≤30% | ${freshInfo}`;
          detailInfo.style.cssText = `
            font-size: 10px;
            color: #666;
            margin-top: 2px;
            padding: 2px 4px;
            background: #f8f9fa;
            border-radius: 2px;
          `;
          probabilityInfoEl.appendChild(detailInfo);
          
          probabilityInfoEl.style.background = 'transparent';
          probabilityInfoEl.style.border = 'none';
          probabilityInfoEl.style.padding = '0';
        } else {
          // 確定判定の場合は従来通りの表示
          probabilityInfoEl.innerHTML = `確率: S:${sleepPercent}% W:${wakePercent}% | 判定: ${thresholdStatus} | 閾値: Sleep≥70%, Wake≤30% | ${freshInfo}`;
          
          // Color coding based on probability
          if (pSleep >= 0.70) {
            probabilityInfoEl.style.background = '#dbeafe'; // blue for sleep
            probabilityInfoEl.style.color = '#1e40af';
            probabilityInfoEl.style.border = '1px solid #93c5fd';
          } else if (pSleep <= 0.30) {
            probabilityInfoEl.style.background = '#fee2e2'; // red for wake
            probabilityInfoEl.style.color = '#dc2626';
            probabilityInfoEl.style.border = '1px solid #fca5a5';
          }
          probabilityInfoEl.style.padding = '4px 8px';
          probabilityInfoEl.style.borderRadius = '4px';
          probabilityInfoEl.style.fontSize = '12px';
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
        stageHistory.push(currentStage); // 全てのラベルを履歴に記録
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
      console.log('[sleepstage] Updating metrics with features:', {
        ratioTA: isFinite(features.ratioTA) ? features.ratioTA.toFixed(3) : 'NaN',
        betaRel: isFinite(features.betaRel) ? features.betaRel.toFixed(3) : 'NaN', 
        motionRel: isFinite(features.motionRel) ? features.motionRel.toFixed(3) : 'NaN',
        eqOverall: isFinite(features.eqOverall) ? features.eqOverall.toFixed(1) : 'NaN',
        hasLastPow: !!features.thetaRel || !!features.alphaRel || !!features.betaRel
      });
      
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
      
      // 到着間隔のEMA更新
      if (lastPowT) powIntervalEma = emaInterval(powIntervalEma, t - lastPowT);
      lastPowT = t;
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
      if (!arr.length) return;
      
      const t = payload.time || nowSec();
      
      let overall = NaN, sampleRateQuality = NaN;
      
      // ラベル優先でインデックス解決
      if (Array.isArray(eqLabels) && eqLabels.length) {
        const idxOverall = eqLabels.indexOf('OVERALL');
        const idxSRQ = eqLabels.indexOf('SAMPLE_RATE_QUALITY');
        
        if (idxOverall >= 0 && typeof arr[idxOverall] === 'number') {
          overall = clamp(arr[idxOverall] * 100, 0, 100);
        }
        if (idxSRQ >= 0 && typeof arr[idxSRQ] === 'number') {
          sampleRateQuality = clamp(arr[idxSRQ], 0, 1);
        }
        
        console.log('[sleepstage] eq: using label-based indices:', {
          idxOverall,
          idxSRQ,
          overall: isFinite(overall) ? overall.toFixed(1) : 'NaN'
        });
      } else {
        // フォールバック（既存の並び仮定）
        overall = typeof arr[1] === 'number' ? clamp(arr[1] * 100, 0, 100) : NaN;
        sampleRateQuality = typeof arr[2] === 'number' ? clamp(arr[2], 0, 1) : NaN;
        
        console.log('[sleepstage] eq: using fallback indices (arr[1], arr[2]):', {
          overall: isFinite(overall) ? overall.toFixed(1) : 'NaN'
        });
      }
      
      if (isFinite(overall)) {
        buffers.eq.push({ 
          t, 
          overall: overall, // 0-100スケール
          sampleRateQuality: isFinite(sampleRateQuality) ? sampleRateQuality : overall / 100
        });
        pruneBuffer(buffers.eq, nowSec() - CHART_WINDOW_SEC);
        
        // 到着間隔のEMA更新
        if (lastEqT) eqIntervalEma = emaInterval(eqIntervalEma, t - lastEqT);
        lastEqT = t;
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
    
    // 到着間隔EMAリセット
    powIntervalEma = null;
    eqIntervalEma = null;
    lastPowT = null;
    lastEqT = null;
    
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
    
    // CSV解析UIを作成
    createCSVAnalysisUI();
    
    // 設定パネルを作成
    createSettingsPanel();
  });
} else {
  // DOMが既に読み込まれている場合
  setTimeout(() => {
    createCSVAnalysisUI();
    createSettingsPanel();
  }, 100);
}

console.log('[sleepstage] Module initialization complete');

// Debug function for manual testing
window.debugSleepStage = function() {
  console.log('[sleepstage] Debug info (unknown-free mode):', {
    wsConnected,
    sessionStartTime,
    wsStatus: wsStatus?.textContent,
    powLabels: powLabels.length,
    motLabels: motLabels.length,
    powIntervalEma: powIntervalEma?.toFixed(2) + 's',
    eqIntervalEma: eqIntervalEma?.toFixed(2) + 's',
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
