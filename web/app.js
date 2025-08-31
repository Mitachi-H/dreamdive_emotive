(() => {
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');

  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
  };

  function connect() {
    const token = localStorage.getItem('dashboard_token');
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      statusEl.textContent = 'WebSocket: connected';
      log('connected');
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello') log(`server: ${msg.message}`);
        if (msg.type === 'eeg') log(`eeg: ${JSON.stringify(msg.payload).slice(0, 200)}…`);
      } catch (e) {
        log(`message: ${String(ev.data).slice(0, 200)}…`);
      }
    });
    ws.addEventListener('close', () => {
      statusEl.textContent = 'WebSocket: disconnected (retrying)';
      log('disconnected, retry in 2s');
      setTimeout(connect, 2000);
    });
    ws.addEventListener('error', () => log('ws error'));
  }

  connect();
})();
