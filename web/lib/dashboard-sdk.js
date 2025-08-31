// Lightweight dashboard SDK to reuse WebSocket and API helpers across dashboards.
// Usage (as ES module):
//   import { wsConnect, api, auth } from '/lib/dashboard-sdk.js';
//   const ws = wsConnect({ onType: { pow: (msg) => { /* ... */ } } });
//   await api.stream.start('pow', { headsetId: 'EPOCPLUS-1234' });

const auth = {
  getToken() {
    try { return localStorage.getItem('dashboard_token') || ''; } catch (_) { return ''; }
  },
  setToken(t) {
    try { localStorage.setItem('dashboard_token', String(t || '')); } catch (_) {}
  },
  headers() {
    const h = {};
    const t = auth.getToken();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  },
};

async function http(path, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers: { ...auth.headers(), ...headers } };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data.error || JSON.stringify(data)));
  return data;
}

function getClientId() {
  try {
    let id = localStorage.getItem('client_id');
    if (!id) {
      try { id = (self.crypto && crypto.randomUUID && crypto.randomUUID()) || null; } catch (_) {}
      if (!id) id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('client_id', id);
    }
    return id;
  } catch (_) {
    return 'c_' + Math.random().toString(36).slice(2);
  }
}

const api = {
  get: (path) => http(path),
  post: (path, body) => http(path, { method: 'POST', body }),
  stream: {
    start: (type, { headsetId, subscribeStreams, clientId } = {}) =>
      http(`/api/stream/${encodeURIComponent(type)}/start`, {
        method: 'POST',
        body: { headsetId, subscribeStreams, clientId: clientId || getClientId() },
      }),
    stop: (type, { clientId } = {}) =>
      http(`/api/stream/${encodeURIComponent(type)}/stop`, {
        method: 'POST',
        body: { clientId: clientId || getClientId() },
      }),
  },
  headset: {
    list: () => http('/api/headset'),
    refresh: () => http('/api/headset/refresh', { method: 'POST' }),
    connect: (id) => http('/api/headset/connect', { method: 'POST', body: { id } }),
  },
  record: {
    start: (opts) => http('/api/record/start', { method: 'POST', body: opts }),
    stop: () => http('/api/record/stop', { method: 'POST' }),
    export: (opts) => http('/api/record/export', { method: 'POST', body: opts }),
  },
  dashboards: {
    list: () => http('/api/dashboards'),
  }
};

function wsConnect({ onMessage, onType = {}, onOpen, onClose, onError, autoReconnectMs = 1500 } = {}) {
  const makeUrl = () => {
    const token = auth.getToken();
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
  };

  let ws;
  let closedByClient = false;
  const connect = () => {
    ws = new WebSocket(makeUrl());
    ws.addEventListener('open', () => { if (onOpen) onOpen(ws); });
    ws.addEventListener('message', (ev) => {
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload && payload.type && onType[payload.type]) {
        try { onType[payload.type](payload.payload, payload); } catch (_) {}
      }
      if (onMessage) onMessage(ev, payload);
    });
    ws.addEventListener('close', () => {
      if (onClose) onClose();
      if (!closedByClient && autoReconnectMs > 0) setTimeout(connect, autoReconnectMs);
    });
    ws.addEventListener('error', (e) => { if (onError) onError(e); });
  };
  connect();
  return {
    get socket() { return ws; },
    close() { closedByClient = true; try { ws && ws.close(); } catch (_) {} },
  };
}

export { auth, api, wsConnect };
