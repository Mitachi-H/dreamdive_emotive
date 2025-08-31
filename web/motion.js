(() => {
  const motTimeEl = document.getElementById("motTime");
  const motLenEl = document.getElementById("motLen");
  const motSidEl = document.getElementById("motSid");
  const motRawEl = document.getElementById("motRaw");
  const labelsEl = document.getElementById("labels");
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const headsetIdInput = document.getElementById("headsetId");
  const saveHeadsetBtn = document.getElementById("saveHeadset");
  const accBox = document.getElementById("accBox");
  const rotBox = document.getElementById("rotBox");
  const magBox = document.getElementById("magBox");
  const counterBox = document.getElementById("counterBox");
  // 3D viz
  const canvas = document.getElementById("viz3d");
  const yawEl = document.getElementById("yaw");
  const pitchEl = document.getElementById("pitch");
  const rollEl = document.getElementById("roll");
  const calibrateBtn = document.getElementById("calibrate");
  const resetCalibBtn = document.getElementById("resetCalib");
  const mirrorChk = document.getElementById("mirror");

  const state = {
    labels: [],
    index: new Map(),
    // orientation
    quat: [1, 0, 0, 0], // w,x,y,z
    targetQuat: [1, 0, 0, 0],
    qOffset: [1, 0, 0, 0], // calibration offset
    hasQuat: false,
    // vectors
    accWorld: [0, 0, 0],
    accWorldTarget: [0, 0, 0],
    magWorld: [0, 0, 0],
    magWorldTarget: [0, 0, 0],
    accTrail: [],
    magTrail: [],
    trailMax: 90,
  };

  const getHeaders = () => {
    const h = {};
    const t = localStorage.getItem("dashboard_token");
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  };

  function connect() {
    const token = localStorage.getItem("dashboard_token");
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${
      location.host
    }/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (
          msg.type === "labels" &&
          msg.payload &&
          msg.payload.streamName === "mot"
        ) {
          const labs = Array.isArray(msg.payload.labels)
            ? msg.payload.labels
            : [];
          state.labels = labs;
          state.index = new Map(labs.map((l, i) => [l, i]));
          if (labelsEl) labelsEl.textContent = JSON.stringify(labs, null, 2);
          state.hasQuat =
            state.index.has("Q0") &&
            state.index.has("Q1") &&
            state.index.has("Q2") &&
            state.index.has("Q3");
          return;
        }
        if (msg.type === "mot") {
          const p = msg.payload || {};
          const arr = Array.isArray(p.mot) ? p.mot : [];
          const t = p.time
            ? new Date(p.time * 1000).toLocaleTimeString()
            : new Date().toLocaleTimeString();
          motTimeEl.textContent = t;
          motLenEl.textContent = String(arr.length);
          if (motSidEl) motSidEl.textContent = p.sid || "-";
          if (motRawEl) motRawEl.textContent = JSON.stringify(arr, null, 2);

          // Render groups
          renderCounters(arr);
          renderRotationOrGyro(arr);
          renderAcc(arr);
          renderMag(arr);

          // Orientation update
          if (state.hasQuat) {
            const q = [
              num(arrAt("Q0", arr)),
              num(arrAt("Q1", arr)),
              num(arrAt("Q2", arr)),
              num(arrAt("Q3", arr)),
            ];
            if (isFinite(q[0])) {
              // Apply calibration offset: qAdj = qOffset * q
              const qAdj = qMul(state.qOffset, qNorm(q));
              state.targetQuat = qAdj;
            }
          }

          // Update ACC/MAG vectors (in world frame if quat available)
          const accDev = [
            num(arrAt("ACCX", arr)),
            num(arrAt("ACCY", arr)),
            num(arrAt("ACCZ", arr)),
          ];
          const magDev = [
            num(arrAt("MAGX", arr)),
            num(arrAt("MAGY", arr)),
            num(arrAt("MAGZ", arr)),
          ];
          const hasAcc = accDev.every((v) => isFinite(v));
          const hasMag = magDev.every((v) => isFinite(v));
          let mNow;
          if (state.hasQuat) {
            // Use latest adjusted orientation (no smoothing) for consistent trails
            mNow = qToMatrix(state.targetQuat);
          }
          if (hasAcc) {
            // Scale raw accelerometer values for better visualization
            const accScaled = v3scale(accDev, 0.5);
            const w = mNow ? rotateVec(mNow, accScaled) : accScaled;
            state.accWorldTarget = w;
            state.accTrail.push(w);
            if (state.accTrail.length > state.trailMax) state.accTrail.shift();
          }
          if (hasMag && magDev.every((v) => isFinite(v))) {
            // Scale raw magnetometer values for better visualization  
            const magScaled = v3scale(magDev, 20);
            const w = mNow ? rotateVec(mNow, magScaled) : magScaled;
            state.magWorldTarget = w;
            state.magTrail.push(w);
            if (state.magTrail.length > state.trailMax) state.magTrail.shift();
          }
        }
      } catch (_) {}
    });

    ws.addEventListener("close", () => setTimeout(connect, 2000));
  }

  function val(arr, key, digits = 6) {
    const i = state.index.get(key);
    if (i == null) return "-";
    const v = arr[i];
    if (typeof v !== "number") return String(v ?? "-");
    return Number.isInteger(v) ? String(v) : v.toFixed(digits);
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : NaN;
  }

  function arrAt(key, arr) {
    const i = state.index.get(key);
    return i != null ? arr[i] : NaN;
  }

  function renderCounters(arr) {
    const a = val(arr, "COUNTER_MEMS", 0);
    const b = val(arr, "INTERPOLATED_MEMS", 0);
    counterBox.textContent = `COUNTER_MEMS: ${a}\nINTERPOLATED_MEMS: ${b}`;
  }

  function renderRotationOrGyro(arr) {
    // Newer devices have Quaternion Q0..Q3; older have GYROX..Z
    const hasQuat = state.index.has("Q0") && state.index.has("Q3");
    if (hasQuat) {
      rotBox.textContent = `Q0: ${val(arr, "Q0")}\nQ1: ${val(
        arr,
        "Q1"
      )}\nQ2: ${val(arr, "Q2")}\nQ3: ${val(arr, "Q3")}`;
    } else {
      rotBox.textContent = `GYROX: ${val(arr, "GYROX", 0)}\nGYROY: ${val(
        arr,
        "GYROY",
        0
      )}\nGYROZ: ${val(arr, "GYROZ", 0)}`;
    }
  }

  function renderAcc(arr) {
    accBox.textContent = `ACCX: ${val(arr, "ACCX")}\nACCY: ${val(
      arr,
      "ACCY"
    )}\nACCZ: ${val(arr, "ACCZ")}`;
  }

  function renderMag(arr) {
    magBox.textContent = `MAGX: ${val(arr, "MAGX")}\nMAGY: ${val(
      arr,
      "MAGY"
    )}\nMAGZ: ${val(arr, "MAGZ")}`;
  }

  // --- 3D visualization helpers ---
  function qNorm(q) {
    const [w, x, y, z] = q;
    const n = Math.hypot(w, x, y, z) || 1;
    return [w / n, x / n, y / n, z / n];
  }
  function qConj(q) {
    return [q[0], -q[1], -q[2], -q[3]];
  }
  function qMul(a, b) {
    const [aw, ax, ay, az] = a;
    const [bw, bx, by, bz] = b;
    return [
      aw * bw - ax * bx - ay * by - az * bz,
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
    ];
  }
  function qSlerp(a, b, t) {
    // Spherical linear interpolation between unit quaternions
    let cosHalfTheta = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      bb = [-b[0], -b[1], -b[2], -b[3]];
    }
    if (cosHalfTheta >= 1.0) return a.slice();
    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta) || 1e-6;
    const ra = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const rb = Math.sin(t * halfTheta) / sinHalfTheta;
    return qNorm([
      a[0] * ra + bb[0] * rb,
      a[1] * ra + bb[1] * rb,
      a[2] * ra + bb[2] * rb,
      a[3] * ra + bb[3] * rb,
    ]);
  }
  function qToMatrix(q) {
    const [w, x, y, z] = qNorm(q);
    const xx = x * x,
      yy = y * y,
      zz = z * z;
    const xy = x * y,
      xz = x * z,
      yz = y * z;
    const wx = w * x,
      wy = w * y,
      wz = w * z;
    // Row-major 3x3
    return [
      1 - 2 * (yy + zz),
      2 * (xy - wz),
      2 * (xz + wy),
      2 * (xy + wz),
      1 - 2 * (xx + zz),
      2 * (yz - wx),
      2 * (xz - wy),
      2 * (yz + wx),
      1 - 2 * (xx + yy),
    ];
  }
  function rotateVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  }
  function eulerFromQuat(q) {
    const [w, x, y, z] = qNorm(q);
    const ys = 2 * (w * y + x * z);
    const yc = 1 - 2 * (y * y + z * z);
    const yaw = Math.atan2(ys, yc);
    let sp = 2 * (w * x - y * z);
    if (sp > 1) sp = 1;
    if (sp < -1) sp = -1;
    const pitch = Math.asin(sp);
    const rs = 2 * (w * z + x * y);
    const rc = 1 - 2 * (z * z + x * x);
    const roll = Math.atan2(rs, rc);
    return { yaw, pitch, roll };
  }
  function project([x, y, z], w, h, mirror) {
    if (mirror) x = -x;
    const d = 3.5; // camera distance
    const f = 250; // focal length-ish
    const zz = z + d;
    const s = f / (zz || 1e-3);
    return [w / 2 + x * s, h / 2 - y * s];
  }
  function drawLine(ctx, a, b) {
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }

  // 3D vector math
  function v3len(v) {
    return Math.hypot(v[0], v[1], v[2]);
  }
  function v3normalize(v) {
    const l = v3len(v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function v3scale(v, s) {
    return [v[0] * s, v[1] * s, v[2] * s];
  }
  function v3lerp(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }
  function v3cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function v3add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }
  function v3sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function drawArrow(ctx, m, vWorld, color) {
    const L = v3len(vWorld);
    if (!(L > 1e-6)) return;
    const dir = v3scale(vWorld, 1 / L);
    const tip = vWorld;
    const headLen = Math.min(0.35, L * 0.35);
    const base = v3scale(dir, Math.max(0, L - headLen));
    let s = v3cross(dir, [0, 1, 0]);
    if (v3len(s) < 1e-6) s = v3cross(dir, [1, 0, 0]);
    s = v3normalize(s);
    let t = v3cross(dir, s);
    t = v3normalize(t);
    const r = 0.1;
    const N = 12;
    const ring = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const off = v3add(
        v3scale(s, r * Math.cos(a)),
        v3scale(t, r * Math.sin(a))
      );
      ring.push(v3add(base, off));
    }
    const w = canvas.width,
      h = canvas.height;
    const tipP = project(tip, w, h, mirrorChk?.checked);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    // Shaft
    const originP = project([0, 0, 0], w, h, mirrorChk?.checked);
    drawLine(ctx, originP, tipP);
    // Head
    for (let i = 0; i < N; i++) {
      const aP = project(ring[i], w, h, mirrorChk?.checked);
      const bP = project(ring[(i + 1) % N], w, h, mirrorChk?.checked);
      drawLine(ctx, tipP, aP);
      drawLine(ctx, aP, bP);
    }
    ctx.stroke();
  }

  function drawTrail(ctx, trail, color) {
    if (!trail || trail.length < 2) return;
    const w = canvas.width,
      h = canvas.height;
    ctx.lineWidth = 2;
    for (let i = 1; i < trail.length; i++) {
      const a = project(trail[i - 1], w, h, mirrorChk?.checked);
      const b = project(trail[i], w, h, mirrorChk?.checked);
      const t = i / (trail.length - 1);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.15 + 0.65 * t; // fade from tail to head
      ctx.beginPath();
      drawLine(ctx, a, b);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawScene() {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width,
      h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Interpolate towards target for smoothness
    state.quat = qSlerp(state.quat, state.targetQuat, 0.25);
    const m = qToMatrix(state.quat);

    // Smooth vectors
    state.accWorld = v3lerp(state.accWorld, state.accWorldTarget, 0.35);
    state.magWorld = v3lerp(state.magWorld, state.magWorldTarget, 0.35);

    // Axes
    const L = 1.2;
    const axes = [
      { a: [-L, 0, 0], b: [L, 0, 0], color: "#e11", label: "X" },
      { a: [0, -L, 0], b: [0, L, 0], color: "#1b1", label: "Y" },
      { a: [0, 0, -L], b: [0, 0, L], color: "#17f", label: "Z" },
    ];
    ctx.lineWidth = 2;
    for (const ax of axes) {
      const A = project(rotateVec(m, ax.a), w, h, mirrorChk?.checked);
      const B = project(rotateVec(m, ax.b), w, h, mirrorChk?.checked);
      ctx.beginPath();
      ctx.strokeStyle = ax.color;
      drawLine(ctx, A, B);
      ctx.stroke();
      
      // Draw axis label
      ctx.fillStyle = ax.color;
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ax.label, B[0], B[1]);
    }

    // Device forward arrow (along +Z)
    const forward = rotateVec(m, [0, 0, 1.2]);
    drawArrow(ctx, m, forward, "#888");

    // Euler display
    const { yaw, pitch, roll } = eulerFromQuat(state.quat);
    if (yawEl) yawEl.textContent = ((yaw * 180) / Math.PI).toFixed(1);
    if (pitchEl) pitchEl.textContent = ((pitch * 180) / Math.PI).toFixed(1);
    if (rollEl) rollEl.textContent = ((roll * 180) / Math.PI).toFixed(1);

    // Trails then arrows (so tips are on top)
    drawTrail(ctx, state.accTrail, "#22c55e");
    drawTrail(ctx, state.magTrail, "#a855f7");
    drawArrow(ctx, m, state.accWorld, "#22c55e");
    drawArrow(ctx, m, state.magWorld, "#a855f7");

    requestAnimationFrame(drawScene);
  }

  calibrateBtn?.addEventListener("click", () => {
    // Set offset so that current orientation becomes identity
    state.qOffset = qConj(state.targetQuat);
  });
  resetCalibBtn?.addEventListener("click", () => {
    state.qOffset = [1, 0, 0, 0];
  });

  startBtn.addEventListener("click", async () => {
    try {
      const hid =
        headsetIdInput.value.trim() ||
        localStorage.getItem("headset_id") ||
        undefined;
      const res = await fetch("/api/stream/mot/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({ headsetId: hid }),
      });
      const j = await res.json();
      if (!j.ok) alert("start error: " + (j.error || JSON.stringify(j)));
    } catch (e) {
      alert("start fetch error: " + String(e));
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/stream/mot/stop", {
        method: "POST",
        headers: getHeaders(),
      });
      const j = await res.json();
      if (!j.ok) alert("stop error: " + (j.error || JSON.stringify(j)));
    } catch (e) {
      alert("stop fetch error: " + String(e));
    }
  });

  // Persist and preload headsetId
  const saved = localStorage.getItem("headset_id");
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener("click", () => {
    const v = headsetIdInput.value.trim();
    if (v) localStorage.setItem("headset_id", v);
  });

  connect();
  requestAnimationFrame(drawScene);
})();
