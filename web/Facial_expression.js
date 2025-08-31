(() => {
  const facTimeEl = document.getElementById('facTime');
  const facSidEl = document.getElementById('facSid');
  const facRawEl = document.getElementById('facRaw');
  const eyeActEl = document.getElementById('eyeAct');
  const uActEl = document.getElementById('uAct');
  const uPowText = document.getElementById('uPowText');
  const uPowBar = document.getElementById('uPowBar');
  const lActEl = document.getElementById('lAct');
  const lPowText = document.getElementById('lPowText');
  const lPowBar = document.getElementById('lPowBar');

  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');

  const getHeaders = () => { const h = {}; const t = localStorage.getItem('dashboard_token'); if (t) h['Authorization'] = `Bearer ${t}`; return h; };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'fac') {
          const p = msg.payload || {}; const arr = Array.isArray(p.fac) ? p.fac : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          facTimeEl.textContent = t; if (facSidEl) facSidEl.textContent = p.sid || '-';
          if (facRawEl) facRawEl.textContent = JSON.stringify(arr, null, 2);

          const eyeAct = arr[0];
          const uAct = arr[1];
          const uPow = typeof arr[2] === 'number' ? arr[2] : NaN;
          const lAct = arr[3];
          const lPow = typeof arr[4] === 'number' ? arr[4] : NaN;

          eyeActEl.textContent = typeof eyeAct === 'string' ? eyeAct : '-';
          uActEl.textContent = typeof uAct === 'string' ? uAct : '-';
          lActEl.textContent = typeof lAct === 'string' ? lAct : '-';

          if (!Number.isNaN(uPow)) {
            const pct = clamp(uPow * 100, 0, 100);
            uPowText.textContent = `${uPow.toFixed(3)} (${Math.round(pct)})`;
            uPowBar.style.width = `${pct}%`;
          } else { uPowText.textContent = '-'; uPowBar.style.width = '0%'; }

          if (!Number.isNaN(lPow)) {
            const pct = clamp(lPow * 100, 0, 100);
            lPowText.textContent = `${lPow.toFixed(3)} (${Math.round(pct)})`;
            lPowBar.style.width = `${pct}%`;
          } else { lPowText.textContent = '-'; lPowBar.style.width = '0%'; }
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/fac/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/fac/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
})();

