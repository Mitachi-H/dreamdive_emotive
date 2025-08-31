(() => {
  const comTimeEl = document.getElementById('comTime');
  const comSidEl = document.getElementById('comSid');
  const comRawEl = document.getElementById('comRaw');
  const actText = document.getElementById('actText');
  const powText = document.getElementById('powText');
  const powBar = document.getElementById('powBar');

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
        if (msg.type === 'com') {
          const p = msg.payload || {}; const arr = Array.isArray(p.com) ? p.com : [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          comTimeEl.textContent = t; if (comSidEl) comSidEl.textContent = p.sid || '-';
          if (comRawEl) comRawEl.textContent = JSON.stringify(arr, null, 2);

          const action = arr[0];
          const power = typeof arr[1] === 'number' ? arr[1] : NaN;
          actText.textContent = typeof action === 'string' ? action : '-';
          if (!Number.isNaN(power)) {
            const pct = clamp(power * 100, 0, 100);
            powText.textContent = `${power.toFixed(3)} (${Math.round(pct)})`;
            powBar.style.width = `${pct}%`;
          } else {
            powText.textContent = '-'; powBar.style.width = '0%';
          }
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/com/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getHeaders() }, body: JSON.stringify({ headsetId: hid }) });
      const j = await res.json(); if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/com/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json(); if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => { const v = headsetIdInput.value.trim(); if (v) localStorage.setItem('headset_id', v); });

  connect();
})();

