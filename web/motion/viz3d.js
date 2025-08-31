// Lightweight 3D visualization for Motion (ACC/MAG + orientation)
// Exports a factory that manages its own render loop and state.

export function createViz3D({
  canvas,
  yawEl,
  pitchEl,
  rollEl,
  accLenEl,
  magLenEl,
}) {
  const COLORS = {
    axisX: "rgba(239, 68, 68, 0.5)", // red-500 at 50% alpha
    axisY: "rgba(14, 165, 233, 0.5)", // sky-500
    axisZ: "rgba(99, 102, 241, 0.5)", // indigo-500
    forward: "#6b7280", // gray-500
    acc: "#16a34a", // green-600
    mag: "#7c3aed", // violet-700
  };

  const state = {
    // orientation
    hasQuat: false,
    quat: [1, 0, 0, 0],
    targetQuat: [1, 0, 0, 0],
    qOffset: [1, 0, 0, 0],
    mirror: true,
    // vectors (world frame)
    accWorld: [0, 0, 0],
    accWorldTarget: [0, 0, 0],
    magWorld: [0, 0, 0],
    magWorldTarget: [0, 0, 0],
    accTrail: [],
    magTrail: [],
    trailMax: 90,
    // scale control
    scaleMode: "auto", // unit | auto | manual
    gainAcc: 1.0,
    gainMag: 0.02,
    refAcc: 1.0,
    refMag: 50.0,
    accLenRaw: 0,
    magLenRaw: 0,
    // render
    running: false,
  };

  // ---------- Math utils ----------
  const v3 = {
    len: (v) => Math.hypot(v[0], v[1], v[2]),
    norm: (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    },
    scale: (v, s) => [v[0] * s, v[1] * s, v[2] * s],
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  };

  function qNorm(q) {
    const [w, x, y, z] = q;
    const n = Math.hypot(w, x, y, z) || 1;
    return [w / n, x / n, y / n, z / n];
  }
  function qConj(q) { return [q[0], -q[1], -q[2], -q[3]]; }
  function qMul(a, b) {
    const [aw, ax, ay, az] = a; const [bw, bx, by, bz] = b;
    return [aw*bw - ax*bx - ay*by - az*bz, aw*bx + ax*bw + ay*bz - az*by, aw*by - ax*bz + ay*bw + az*bx, aw*bz + ax*by - ay*bx + az*bw];
  }
  function qSlerp(a, b, t) {
    let cosHalfTheta = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
    let bb = b;
    if (cosHalfTheta < 0) { cosHalfTheta = -cosHalfTheta; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    if (cosHalfTheta >= 1.0) return a.slice();
    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta*cosHalfTheta) || 1e-6;
    const ra = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const rb = Math.sin(t * halfTheta) / sinHalfTheta;
    return qNorm([a[0]*ra + bb[0]*rb, a[1]*ra + bb[1]*rb, a[2]*ra + bb[2]*rb, a[3]*ra + bb[3]*rb]);
  }
  function qToMatrix(q) {
    const [w, x, y, z] = qNorm(q);
    const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
    return [
      1-2*(yy+zz), 2*(xy - wz), 2*(xz + wy),
      2*(xy + wz), 1-2*(xx+zz), 2*(yz - wx),
      2*(xz - wy), 2*(yz + wx), 1-2*(xx+yy),
    ];
  }
  function rotateVec(m, v) {
    return [m[0]*v[0] + m[1]*v[1] + m[2]*v[2], m[3]*v[0] + m[4]*v[1] + m[5]*v[2], m[6]*v[0] + m[7]*v[1] + m[8]*v[2]];
  }
  function eulerFromQuat(q) {
    const [w, x, y, z] = qNorm(q);
    const ys = 2*(w*y + x*z); const yc = 1 - 2*(y*y + z*z); const yaw = Math.atan2(ys, yc);
    let sp = 2*(w*x - y*z); if (sp > 1) sp = 1; if (sp < -1) sp = -1; const pitch = Math.asin(sp);
    const rs = 2*(w*z + x*y); const rc = 1 - 2*(z*z + x*x); const roll = Math.atan2(rs, rc);
    return { yaw, pitch, roll };
  }
  function project([x,y,z], w, h, mirror) {
    if (mirror) x = -x; const d = 3.5, f = 250; const zz = z + d; const s = f / (zz || 1e-3); return [w/2 + x*s, h/2 - y*s];
  }
  function drawLine(ctx, a, b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }

  function computeLen(mag, kind) {
    const base = 1.2; const mode = state.scaleMode;
    if (mode === 'unit') return base;
    if (mode === 'manual') {
      const gain = kind === 'acc' ? state.gainAcc : state.gainMag;
      return Math.max(0.05, Math.min(base, mag * gain));
    }
    const ref = kind === 'acc' ? state.refAcc : state.refMag;
    const ratio = ref > 1e-6 ? Math.min(1, Math.max(0, mag / ref)) : 0;
    const floor = 0.2;
    return base * (floor + (1 - floor) * ratio);
  }

  function drawArrow(ctx, vWorld, opts = {}) {
    const L = v3.len(vWorld); if (!(L > 1e-6)) return;
    const dir = v3.scale(vWorld, 1/L); const tip = vWorld; const headLen = Math.min(0.35, L*0.35);
    const base = v3.scale(dir, Math.max(0, L - headLen));
    let s = v3.cross(dir, [0,1,0]); if (v3.len(s) < 1e-6) s = v3.cross(dir, [1,0,0]); s = v3.norm(s);
    let t = v3.cross(dir, s); t = v3.norm(t);
    const r = 0.10; const N = 12; const ring = [];
    for (let i=0;i<N;i++) { const a = (i/N) * Math.PI*2; const off = v3.add(v3.scale(s, r*Math.cos(a)), v3.scale(t, r*Math.sin(a))); ring.push(v3.add(base, off)); }
    const w = canvas.width, h = canvas.height; const tipP = project(tip, w, h, state.mirror);
    const color = opts.color || '#222'; const width = opts.width || 2.5; const dash = Array.isArray(opts.dash) ? opts.dash : null; const headStyle = opts.head || 'outline';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    const originP = project([0,0,0], w, h, state.mirror); drawLine(ctx, originP, tipP);
    for (let i=0;i<N;i++) { const aP = project(ring[i], w, h, state.mirror); const bP = project(ring[(i+1)%N], w, h, state.mirror); drawLine(ctx, tipP, aP); drawLine(ctx, aP, bP); }
    ctx.stroke(); if (dash) ctx.setLineDash([]);
    if (headStyle === 'filled') {
      ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = color;
      for (let i=0;i<N;i++) { const aP = project(ring[i], w, h, state.mirror); const bP = project(ring[(i+1)%N], w, h, state.mirror); ctx.beginPath(); ctx.moveTo(tipP[0], tipP[1]); ctx.lineTo(aP[0], aP[1]); ctx.lineTo(bP[0], bP[1]); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
  }

  function drawTrail(ctx, trail, color, dash) {
    if (!trail || trail.length < 2) return; const w = canvas.width, h = canvas.height; ctx.lineWidth = 2; if (Array.isArray(dash)) ctx.setLineDash(dash);
    for (let i=1;i<trail.length;i++) { const a = project(trail[i-1], w, h, state.mirror); const b = project(trail[i], w, h, state.mirror); const t = i / (trail.length - 1); ctx.strokeStyle = color; ctx.globalAlpha = 0.15 + 0.65 * t; ctx.beginPath(); drawLine(ctx, a, b); ctx.stroke(); }
    ctx.globalAlpha = 1; if (Array.isArray(dash)) ctx.setLineDash([]);
  }

  function annotateTip(ctx, vWorld, text, color) {
    const w = canvas.width, h = canvas.height; const p = project(vWorld, w, h, state.mirror);
    ctx.save(); ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; const pad = 4; const tw = ctx.measureText(text).width; const x = p[0] + 8, y = p[1];
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.rect(x - pad, y - 10, tw + pad * 2, 20); ctx.fill(); ctx.stroke(); ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.restore();
  }

  function computeWorldVector(devVec, kind, mNow) {
    const mag = v3.len(devVec); const dir = v3.norm(devVec); const wdir = mNow ? rotateVec(mNow, dir) : dir;
    if (kind === 'acc') { state.accLenRaw = mag; state.refAcc = Math.max(state.accLenRaw, state.refAcc * 0.98); const len = computeLen(state.accLenRaw, 'acc'); return v3.scale(wdir, len); }
    state.magLenRaw = mag; state.refMag = Math.max(state.magLenRaw, state.refMag * 0.98); const len = computeLen(state.magLenRaw, 'mag'); return v3.scale(wdir, len);
  }

  function drawScene() {
    if (!canvas) return; const ctx = canvas.getContext('2d'); const w = canvas.width, h = canvas.height; ctx.clearRect(0,0,w,h);
    state.quat = qSlerp(state.quat, state.targetQuat, 0.25); const m = qToMatrix(state.quat);
    state.accWorld = v3.lerp(state.accWorld, state.accWorldTarget, 0.35); state.magWorld = v3.lerp(state.magWorld, state.magWorldTarget, 0.35);
    if (accLenEl) accLenEl.textContent = state.accLenRaw.toFixed(3); if (magLenEl) magLenEl.textContent = state.magLenRaw.toFixed(3);

    // Axes
    const L = 1.2; const axes = [
      { a: [-L,0,0], b: [L,0,0], color: COLORS.axisX, label: 'X' },
      { a: [0,-L,0], b: [0,L,0], color: COLORS.axisY, label: 'Y' },
      { a: [0,0,-L], b: [0,0,L], color: COLORS.axisZ, label: 'Z' },
    ];
    for (const ax of axes) {
      const A = project(rotateVec(m, ax.a), w, h, state.mirror); const B = project(rotateVec(m, ax.b), w, h, state.mirror);
      ctx.beginPath(); ctx.strokeStyle = ax.color; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]); drawLine(ctx, A, B); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ax.color; ctx.font = '14px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ax.label, B[0], B[1]);
    }

    // Device forward arrow
    const forward = rotateVec(m, [0,0,1.2]); drawArrow(ctx, forward, { color: COLORS.forward, width: 3, head: 'outline' });

    // Euler
    const { yaw, pitch, roll } = eulerFromQuat(state.quat);
    if (yawEl) yawEl.textContent = (yaw * 180/Math.PI).toFixed(1);
    if (pitchEl) pitchEl.textContent = (pitch * 180/Math.PI).toFixed(1);
    if (rollEl) rollEl.textContent = (roll * 180/Math.PI).toFixed(1);

    // Trails then arrows
    drawTrail(ctx, state.accTrail, COLORS.acc);
    drawTrail(ctx, state.magTrail, COLORS.mag, [6,4]);
    drawArrow(ctx, state.accWorld, { color: COLORS.acc, width: 4, head: 'filled' }); annotateTip(ctx, state.accWorld, 'ACC', COLORS.acc);
    drawArrow(ctx, state.magWorld, { color: COLORS.mag, width: 4, head: 'outline', dash: [6,4] }); annotateTip(ctx, state.magWorld, 'MAG', COLORS.mag);

    if (state.running) requestAnimationFrame(drawScene);
  }

  // ---------- Public API ----------
  function setHasQuaternion(has) { state.hasQuat = !!has; }
  function setQuaternion(q0, q1, q2, q3) {
    const q = [q0, q1, q2, q3]; if (!isFinite(q0)) return; const qAdj = qMul(state.qOffset, qNorm(q)); state.targetQuat = qAdj;
  }
  function updateVectors({ accDev, magDev }) {
    const mNow = state.hasQuat ? qToMatrix(state.targetQuat) : null;
    if (accDev && accDev.every((v) => typeof v === 'number' && isFinite(v))) {
      const vec = computeWorldVector(accDev, 'acc', mNow); state.accWorldTarget = vec; state.accTrail.push(vec); if (state.accTrail.length > state.trailMax) state.accTrail.shift();
    }
    if (magDev && magDev.every((v) => typeof v === 'number' && isFinite(v))) {
      const vec = computeWorldVector(magDev, 'mag', mNow); state.magWorldTarget = vec; state.magTrail.push(vec); if (state.magTrail.length > state.trailMax) state.magTrail.shift();
    }
  }
  function setScaleMode(mode) { state.scaleMode = mode === 'unit' || mode === 'manual' ? mode : 'auto'; }
  function setGains(acc, mag) { if (typeof acc === 'number') state.gainAcc = acc; if (typeof mag === 'number') state.gainMag = mag; }
  function calibrate() { state.qOffset = qConj(state.targetQuat); }
  function resetCalibration() { state.qOffset = [1,0,0,0]; }
  function setMirror(v) { state.mirror = !!v; }
  function start() { if (!state.running) { state.running = true; requestAnimationFrame(drawScene); } }
  function stop() { state.running = false; }

  return { setHasQuaternion, setQuaternion, updateVectors, setScaleMode, setGains, calibrate, resetCalibration, setMirror, start, stop };
}

