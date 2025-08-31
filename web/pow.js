(() => {
  const powEl = document.getElementById('pow');
  const powLenEl = document.getElementById('powLen');
  const powTimeEl = document.getElementById('powTime');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const headsetIdInput = document.getElementById('headsetId');
  const saveHeadsetBtn = document.getElementById('saveHeadset');

  const getHeaders = () => {
    const h = {};
    const t = localStorage.getItem('dashboard_token');
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pow') {
          const p = msg.payload || {};
          const arr = p.pow || [];
          const t = p.time ? new Date(p.time * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          powTimeEl.textContent = t;
          powLenEl.textContent = String(arr.length);
          powEl.textContent = JSON.stringify(arr, null, 2);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => setTimeout(connect, 2000));
    ws.addEventListener('error', () => {});
  }

  startBtn.addEventListener('click', async () => {
    try {
      const hid = headsetIdInput.value.trim() || localStorage.getItem('headset_id') || undefined;
      const res = await fetch('/api/stream/pow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ headsetId: hid })
      });
      const j = await res.json();
      if (!j.ok) alert('start error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('start fetch error: ' + String(e)); }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/stream/pow/stop', { method: 'POST', headers: getHeaders() });
      const j = await res.json();
      if (!j.ok) alert('stop error: ' + (j.error || JSON.stringify(j)));
    } catch (e) { alert('stop fetch error: ' + String(e)); }
  });

  connect();

  // Persist and preload headsetId
  const saved = localStorage.getItem('headset_id');
  if (saved && !headsetIdInput.value) headsetIdInput.value = saved;
  saveHeadsetBtn.addEventListener('click', () => {
    const v = headsetIdInput.value.trim();
    if (v) localStorage.setItem('headset_id', v);
  });
})();
