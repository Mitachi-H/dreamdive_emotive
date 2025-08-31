const WebSocket = require('ws');
const { EventEmitter } = require('events');

// Minimal Cortex client skeleton (JSON-RPC 2.0 via WebSocket)
// Note: This is a template. Fill in real JSON-RPC calls per docs:
// https://emotiv.gitbook.io/cortex-api

class CortexClient extends EventEmitter {
  constructor({ url, clientId, clientSecret, license, debit, profile }) {
    super();
    this.url = url;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.license = license;
    this.debit = debit;
    this.profile = profile;

    this.ws = null;
    this.requestId = 1;
    this.authToken = null;
    this.sessionId = null;
    this.headsetId = null;
  }

  async connect() {
    if (this.ws) return;
    await new Promise((resolve, reject) => {
      const tlsEnv = String(process.env.NODE_TLS_REJECT_UNAUTHORIZED || '').toLowerCase();
      const rejectUnauthorized = !(tlsEnv === '0' || tlsEnv === 'false');
      const ws = new WebSocket(this.url, { rejectUnauthorized });
      this.ws = ws;

      ws.on('open', () => {
        this.emit('log', 'Cortex WS connected');
        resolve();
      });
      ws.on('message', (data) => this._handleMessage(data));
      ws.on('error', (err) => this.emit('error', err));
      ws.on('close', (code, reason) => {
        this.emit('log', `Cortex WS closed: ${code} ${reason}`);
        this.ws = null;
      });
    });
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  // JSON-RPC helper
  _rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }
      const id = this.requestId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      const onMessage = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            this.ws.off('message', onMessage);
            if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
            resolve(msg.result);
          }
        } catch (e) {
          // ignore non-JSON messages here
        }
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify(payload));
    });
  }

  // Placeholder flows: Implement per Cortex docs
  async authorize() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Missing clientId/clientSecret');
    }
    const result = await this._rpc('authorize', {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      license: this.license,
      debit: this.debit,
    });
    this.authToken = result?.cortexToken;
    this.emit('log', 'Authorized with Cortex');
    return this.authToken;
  }

  async createSession(status = 'open', headsetId) {
    if (!this.authToken) throw new Error('Not authorized');
    const params = {
      cortexToken: this.authToken,
      status,
    };
    if (headsetId) params.headset = headsetId;
    const result = await this._rpc('createSession', params);
    this.sessionId = result?.id || result?.sessionId;
    this.emit('log', `Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  async subscribe(streams = ['eeg']) {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    const result = await this._rpc('subscribe', {
      cortexToken: this.authToken,
      session: this.sessionId,
      streams,
    });
    this.emit('log', `Subscribed: ${streams.join(',')}`);
    return result;
  }

  async unsubscribe(streams = ['eeg']) {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    const result = await this._rpc('unsubscribe', {
      cortexToken: this.authToken,
      session: this.sessionId,
      streams,
    });
    this.emit('log', `Unsubscribed: ${streams.join(',')}`);
    return result;
  }

  async ensureReadyForStreams() {
    await this.connect();
    await this.authorize();
    const hid = await this.ensureHeadsetConnected();
    if (!this.sessionId) await this.createSession('active', hid);
    return { sessionId: this.sessionId, headsetId: hid };
  }

  async queryHeadsets() {
    const res = await this._rpc('queryHeadsets', {});
    return res || [];
  }

  async controlDevice(command = 'refresh', headset) {
    return this._rpc('controlDevice', {
      command,
      headset,
    });
  }

  async ensureHeadsetConnected() {
    let attempts = 0;
    let connected;
    let lastList = [];
    while (attempts < 10 && !connected) {
      const list = await this.queryHeadsets();
      lastList = list;
      connected = list.find((h) => h.status === 'connected');
      if (!connected) {
        const target = list[0];
        if (target) {
          try { await this.controlDevice('connect', target.id); } catch (_) {}
        } else {
          // ask Cortex to refresh discovery if nothing listed
          try { await this.controlDevice('refresh'); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 500));
      }
      attempts++;
    }
    if (!connected) throw new Error('No connected headset');
    this.headsetId = connected.id;
    this.emit('log', `Headset connected: ${this.headsetId}`);
    return this.headsetId;
  }

  // Convenience: ensure connection + auth token
  async ensureAuthorized() {
    if (!this.ws) await this.connect();
    if (!this.authToken) await this.authorize();
  }

  // Authentication-related helpers
  async getUserLogin() {
    // This method may not require auth; call directly
    return this._rpc('getUserLogin');
  }

  async hasAccessRight() {
    const params = {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      license: this.license,
    };
    if (this.authToken) params.cortexToken = this.authToken;
    return this._rpc('hasAccessRight', params);
  }

  async getUserInformation() {
    await this.ensureAuthorized();
    return this._rpc('getUserInformation', {
      cortexToken: this.authToken,
    });
  }

  async getLicenseInfo() {
    await this.ensureAuthorized();
    return this._rpc('getLicenseInfo', {
      cortexToken: this.authToken,
      clientId: this.clientId,
      license: this.license,
    });
  }

  async requestAccess() {
    return this._rpc('requestAccess', {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  _handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      // Cortex stream data messages usually have e.g. `eeg`, `met`, `dev`, etc.
      if (msg?.sid && msg?.eeg) {
        this.emit('eeg', msg);
      } else if (msg?.pow) {
        this.emit('pow', msg);
      } else if (msg?.warning) {
        this.emit('log', `Cortex warning: ${JSON.stringify(msg.warning)}`);
      }
    } catch (_) {
      // ignore
    }
  }
}

module.exports = CortexClient;
