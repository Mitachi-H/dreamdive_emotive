const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const config = require('./config');
const CortexClient = require('./cortexClient');

const app = express();
const server = http.createServer(app);

// Serve static dashboard
const webDir = path.join(__dirname, '..', '..', 'web');
app.use(express.static(webDir));

// Simple healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Authentication info API (aggregates Cortex auth endpoints)
app.get('/api/authentication', async (_req, res) => {
  try {
    await cortex.connect();
    const userLogin = await cortex.getUserLogin().catch((e) => ({ error: e.message || String(e) }));

    // Try authorize but don't fail entire response
    let authorizeError = null;
    try {
      await cortex.authorize();
    } catch (e) {
      authorizeError = e.message || String(e);
    }

    const accessRight = await cortex.hasAccessRight().catch((e) => ({ error: e.message || String(e) }));
    const userInfo = cortex.authToken
      ? await cortex.getUserInformation().catch((e) => ({ error: e.message || String(e) }))
      : { error: authorizeError || 'Not authorized' };
    const licenseInfo = cortex.authToken
      ? await cortex.getLicenseInfo().catch((e) => ({ error: e.message || String(e) }))
      : { error: authorizeError || 'Not authorized' };

    res.json({ ok: true, userLogin, accessRight, userInfo, licenseInfo, authorizeError });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Serve the Authentication page at /authentication
app.get('/authentication', (_req, res) => {
  res.sendFile(path.join(webDir, 'authentication.html'));
});

// Request access flow: user must approve in Emotiv Launcher
app.post('/api/request-access', async (_req, res) => {
  try {
    await cortex.connect();
    const result = await cortex.requestAccess();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// WebSocket for browser clients
const wss = new WebSocket.Server({ server, path: '/ws' });

const cortex = new CortexClient(config.cortex);

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// Cortex event wiring
cortex.on('log', (m) => console.log('[cortex]', m));
cortex.on('error', (e) => console.error('[cortex:error]', e.message || e));
cortex.on('eeg', (payload) => broadcast({ type: 'eeg', payload }));

// Client connections
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', message: 'Connected to dashboard stream' }));
});

async function start() {
  server.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });

  if (!config.autoConnect) {
    console.log('AUTO_CONNECT=false. Skipping Cortex connection.');
    return;
  }

  try {
    // Connect and subscribe (adjust streams as needed)
    await cortex.connect();
    await cortex.authorize();
    await cortex.createSession('open');
    await cortex.subscribe(['eeg']);
  } catch (err) {
    console.error('Failed to initialize Cortex flow:', err.message || err);
  }
}

start();
