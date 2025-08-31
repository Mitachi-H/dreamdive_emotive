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
  }

  async connect() {
    if (this.ws) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { rejectUnauthorized: false });
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

  async createSession(status = 'open') {
    if (!this.authToken) throw new Error('Not authorized');
    const result = await this._rpc('createSession', {
      cortexToken: this.authToken,
      status,
    });
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

  _handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      // Cortex stream data messages usually have e.g. `eeg`, `met`, `dev`, etc.
      if (msg?.sid && msg?.eeg) {
        this.emit('eeg', msg);
      } else if (msg?.warning) {
        this.emit('log', `Cortex warning: ${JSON.stringify(msg.warning)}`);
      }
    } catch (_) {
      // ignore
    }
  }
}

module.exports = CortexClient;
