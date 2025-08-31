// 14‑ch layout (EPOC/EPOC+ on 10–20-like positions)
export const TOPO_SENSORS = [
  'AF3','F7','F3','FC5','T7','P7','O1','O2','P8','T8','FC6','F4','F8','AF4'
];

export const SENSOR_POS = {
  AF3: [-0.28,  0.88],
  F7:  [-0.88,  0.58],
  F3:  [-0.48,  0.58],
  FC5: [-0.78,  0.28],
  T7:  [-0.98, -0.02],
  P7:  [-0.78, -0.42],
  O1:  [-0.42, -0.86],
  O2:  [ 0.42, -0.86],
  P8:  [ 0.78, -0.42],
  T8:  [ 0.98, -0.02],
  FC6: [ 0.78,  0.28],
  F4:  [ 0.48,  0.58],
  F8:  [ 0.88,  0.58],
  AF4: [ 0.28,  0.88],
};

export function viridis(t) {
  const stops = [
    [0.0, [68, 1, 84]],
    [0.25,[59, 82, 139]],
    [0.50,[33, 145, 140]],
    [0.60,[53, 183, 121]],
    [0.75,[127, 211, 93]],
    [1.0,[253, 231, 37]],
  ];
  if (t <= 0) return 'rgb(68,1,84)';
  if (t >= 1) return 'rgb(253,231,37)';
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t1, c1] = stops[i - 1];
      const [t2, c2] = stops[i];
      const u = (t - t1) / (t2 - t1);
      const r = Math.round(c1[0] + u * (c2[0] - c1[0]));
      const g = Math.round(c1[1] + u * (c2[1] - c1[1]));
      const b = Math.round(c1[2] + u * (c2[2] - c1[2]));
      return `rgb(${r},${g},${b})`;
    }
  }
  return 'rgb(253,231,37)';
}

export function drawHeadOverlay(ctx, W, H, { showLabels } = { showLabels: true }) {
  ctx.save();
  const M = 12; // margin
  const R = Math.min(W, H) / 2 - M;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
  ctx.stroke();
  const dotR = 2;
  for (const s of TOPO_SENSORS) {
    const p = SENSOR_POS[s];
    if (!p) continue;
    const x = W / 2 + p[0] * R * 0.9;
    const y = H / 2 - p[1] * R * 0.9;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();
    if (showLabels) {
      const vx = x - W / 2;
      const vy = y - H / 2;
      const len = Math.max(1, Math.hypot(vx, vy));
      const offset = 12 + dotR;
      const ox = -(vx / len) * offset;
      const oy = -(vy / len) * offset;
      ctx.font = '10px ui-sans-serif, system-ui, -apple-system, Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(s, x + ox, y + oy);
      ctx.fillStyle = '#000';
      ctx.fillText(s, x + ox, y + oy);
    }
  }
  ctx.restore();
}

export function interpolateIDW(points, values, px, py, power = 2) {
  let num = 0, den = 0;
  for (let i = 0; i < points.length; i++) {
    const dx = px - points[i][0];
    const dy = py - points[i][1];
    const d2 = dx * dx + dy * dy;
    const w = 1 / Math.pow(d2 + 1e-6, power / 2);
    num += w * values[i];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

function renderTopomap(canvas, band, bandSensorValues, state) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const M = 12;
  const R = Math.min(W, H) / 2 - M;
  const pts = [];
  const vals = [];
  let maxVal = 1e-6;
  for (const s of TOPO_SENSORS) {
    const v = bandSensorValues[s];
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    const p = SENSOR_POS[s];
    if (!p) continue;
    const x = W / 2 + p[0] * R * 0.9;
    const y = H / 2 - p[1] * R * 0.9;
    pts.push([x, y]);
    const vv = Math.log10(1 + Math.max(0, v));
    vals.push(vv);
    if (vv > maxVal) maxVal = vv;
  }
  const prev = state.bandMax[band] || 1;
  const updatedMax = Math.max(maxVal, prev * 0.98, 1e-6);
  state.bandMax[band] = updatedMax;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * W + x) * 4;
      if (r > R) { data[idx + 3] = 0; continue; }
      const iv = interpolateIDW(pts, vals, x, y, 2);
      const t = updatedMax > 0 ? Math.min(1, Math.max(0, iv / updatedMax)) : 0;
      const color = viridis(t);
      const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(color);
      const rr = m ? parseInt(m[1], 10) : 0;
      const gg = m ? parseInt(m[2], 10) : 0;
      const bb = m ? parseInt(m[3], 10) : 0;
      data[idx] = rr; data[idx + 1] = gg; data[idx + 2] = bb; data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  drawHeadOverlay(ctx, W, H, { showLabels: state.showLabels });
}

export function updateTopomapsFromPowArray(values, canvases, state, force = false) {
  const now = performance.now();
  if (!force && now - state.lastTopoDraw < 150) return;
  state.lastTopoDraw = now;
  const bands = ['theta', 'alpha', 'betaL', 'betaH', 'gamma'];
  const byBand = { theta: {}, alpha: {}, betaL: {}, betaH: {}, gamma: {} };
  for (const s of TOPO_SENSORS) {
    for (const b of bands) {
      const idx = state.indexByLabel[`${s}/${b}`];
      if (typeof idx === 'number') byBand[b][s] = values[idx];
    }
  }
  for (const b of bands) renderTopomap(canvases[b], b, byBand[b], state);
}

