const WebSocket = require('ws');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Cortex client (JSON-RPC 2.0 via WebSocket) inspired by Emotiv's python/cortex.py
// https://github.com/Emotiv/cortex-example/tree/master/python

class CortexClient extends EventEmitter {
  constructor({ url, clientId, clientSecret, license, debit, profile }) {
    super();
    this.url = url || 'wss://localhost:6868';
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    this.license = license || '';
    this.debit = debit ?? 10;
    this.profile = profile || '';

    this.ws = null;
    this.requestId = 1;
    this.authToken = null;
    this.sessionId = '';
    this.headsetId = '';
    this.isHeadsetConnected = false;
    this.currentRecordId = '';
  }

  // Open WebSocket and wire message handlers
  async connect() {
    if (this.ws) return;
    await new Promise((resolve, reject) => {
      // By default, Emotiv uses a self-signed cert. Allow opting out via env.
      // Prefer loading CA cert if provided at server/certificates/rootCA.pem
      const tlsEnv = String(process.env.NODE_TLS_REJECT_UNAUTHORIZED || '').toLowerCase();
      const rejectUnauthorized = !(tlsEnv === '0' || tlsEnv === 'false');
      let ca;
      try {
        const caPath = path.join(__dirname, '..', 'certificates', 'rootCA.pem');
        if (fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
      } catch (_) {}

      const ws = new WebSocket(this.url, {
        rejectUnauthorized,
        ca,
      });
      this.ws = ws;

      ws.on('open', () => {
        this.emit('log', 'Cortex WS connected');
        resolve();
      });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('error', (err) => this.emit('error', err));
      ws.on('close', (code, reason) => {
        this.emit('log', `Cortex WS closed: ${code} ${reason}`);
        this.ws = null;
        this.sessionId = '';
        this.isHeadsetConnected = false;
      });
    });
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  // One-shot JSON-RPC call
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
        } catch (_) {
          // ignore non-JSON messages here
        }
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify(payload));
    });
  }

  _extractErrorCode(err) {
    const s = (err && err.message) ? err.message : String(err || '');
    try {
      const j = JSON.parse(s);
      return j && j.code ? j.code : undefined;
    } catch (_) {
      return undefined;
    }
  }

  // Official flow: hasAccessRight -> (requestAccess) -> authorize -> refresh -> query/connect -> create session
  async prepare({ headsetId, profile } = {}) {
    await this.connect();
    // Step 1: hasAccessRight
    const access = await this.hasAccessRight().catch((e) => ({ error: e.message || String(e) }));
    if (access && access.accessGranted === false) {
      const req = await this.requestAccess().catch((e) => ({ error: e.message || String(e) }));
      // User must approve in Launcher; emit hint
      if (!req || req.error || req.accessGranted === false) {
        this.emit('log', 'Access not granted yet. Approve in Emotiv Launcher.');
      }
    }

    // Step 2: authorize
    await this.authorize();

    // Step 3: refresh + query/connect desired headset
    await this.refreshHeadsetList().catch(() => {});
    const hid = await this._connectDesiredHeadset(headsetId);
    this.headsetId = hid;

    // Step 4: create working session
    try {
      await this.createSessionWithRetry('active', hid);
    } catch (e) {
      this.emit('log', `Active session failed (${e.message || e}). Falling back to open.`);
      if (!this.sessionId) await this.createSession('open', hid);
    }

    // Optional: profile prepare if provided
    if (profile || this.profile) {
      // Align with python: try getCurrentProfile then setupProfile(load) if needed
      try {
        const profName = profile || this.profile;
        const current = await this.getCurrentProfile().catch(() => null);
        const name = current && current.name;
        if (name !== profName) {
          await this.setupProfile(profName, 'load').catch(() => {});
        }
      } catch (_) {}
    }

    return { sessionId: this.sessionId, headsetId: this.headsetId };
  }

  // Backward-compatible wrapper used by routes/tests
  async ensureReadyForStreams(preferredHeadsetId) {
    const res = await this.prepare({ headsetId: preferredHeadsetId });
    return res;
  }

  // ----- Auth & basic info -----
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
    this.emit('log', 'Authorize successfully.');
    return this.authToken;
  }

  async hasAccessRight() {
    return this._rpc('hasAccessRight', {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  async requestAccess() {
    return this._rpc('requestAccess', {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  async getUserLogin() {
    return this._rpc('getUserLogin');
  }

  async getUserInformation() {
    if (!this.authToken) await this.authorize();
    return this._rpc('getUserInformation', { cortexToken: this.authToken });
  }

  async getLicenseInfo() {
    if (!this.authToken) await this.authorize();
    return this._rpc('getLicenseInfo', { cortexToken: this.authToken });
  }

  async getCortexInfo() {
    return this._rpc('getCortexInfo', {});
  }

  // ----- Detection info -----
  async getDetectionInfo(detection /* 'mentalCommand' | 'facialExpression' */) {
    return this._rpc('getDetectionInfo', { detection });
  }

  // ----- Headset control -----
  async refreshHeadsetList() {
    return this._rpc('controlDevice', { command: 'refresh' });
  }

  async queryHeadsets() {
    const res = await this._rpc('queryHeadsets', {});
    return res || [];
  }

  async controlDevice(command = 'refresh', headset) {
    return this._rpc('controlDevice', { command, headset });
  }

  async disconnectHeadset(headsetId) {
    const id = headsetId || this.headsetId;
    if (!id) return;
    return this._rpc('controlDevice', { command: 'disconnect', headset: id });
  }

  async _connectDesiredHeadset(preferredId) {
    // Try up to ~10 iterations: connect or refresh and wait
    let attempts = 0;
    while (attempts < 10) {
      const list = await this.queryHeadsets();
      if (!Array.isArray(list) || list.length === 0) {
        await this.refreshHeadsetList().catch(() => {});
        await this._sleep(500);
        attempts++;
        continue;
      }

      // Pick desired or first
      let target = preferredId ? list.find((h) => h.id === preferredId) : list[0];
      if (!target) target = list[0];
      const { id, status } = target;
      this.emit('log', `Headset ${id} status: ${status}`);
      if (status === 'connected') {
        this.isHeadsetConnected = true;
        return id;
      }
      if (status === 'discovered') {
        await this.controlDevice('connect', id).catch(() => {});
      }
      // status could be 'connecting' or others -> wait and retry
      await this._sleep(1000);
      attempts++;
    }
    throw new Error('No connected headset');
  }

  // ----- Session control -----
  async createSession(status = 'open', headsetId) {
    if (!this.authToken) throw new Error('Not authorized');
    const params = { cortexToken: this.authToken, status };
    if (headsetId) params.headset = headsetId;
    const result = await this._rpc('createSession', params);
    this.sessionId = result?.id || result?.sessionId;
    this.emit('log', `The session ${this.sessionId} is created successfully.`);
    return this.sessionId;
  }

  async closeSession() {
    if (!this.authToken || !this.sessionId) return;
    await this._rpc('updateSession', {
      cortexToken: this.authToken,
      session: this.sessionId,
      status: 'close',
    }).catch(() => {});
    this.sessionId = '';
  }

  async createSessionWithRetry(status = 'active', headsetId, maxAttempts = 12, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await this.createSession(status, headsetId);
      } catch (e) {
        const code = this._extractErrorCode(e);
        if (code === -32152 /* Headset not ready/busy */) {
          this.emit('log', `createSession retry ${i + 1}/${maxAttempts} (headset busy)`);
          await this._sleep(delayMs);
          continue;
        }
        throw e;
      }
    }
    throw new Error('createSession retry exhausted');
  }

  // ----- Stream control -----
  async subscribe(streams = ['eeg']) {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    const result = await this._rpc('subscribe', {
      cortexToken: this.authToken,
      session: this.sessionId,
      streams,
    });
    // Mimic python: emit labels for success items except com/fac
    if (result && Array.isArray(result.success)) {
      for (const s of result.success) {
        const name = s.streamName;
        const cols = s.cols;
        this.emit('log', `The data stream ${name} is subscribed successfully.`);
        if (name !== 'com' && name !== 'fac') {
          const labels = { streamName: name, labels: this._extractLabels(name, cols) };
          this.emit('new_data_labels', labels);
        }
      }
    }
    if (result && Array.isArray(result.failure)) {
      for (const s of result.failure) {
        this.emit('log', `The data stream ${s.streamName} is subscribed unsuccessfully. Because: ${s.message}`);
      }
    }
    return result;
  }

  async subscribeWithRetry(streams = ['pow'], maxAttempts = 12, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await this.subscribe(streams);
      } catch (e) {
        const code = this._extractErrorCode(e);
        if (code === -32152 /* Headset not ready/busy */) {
          this.emit('log', `subscribe retry ${i + 1}/${maxAttempts} (headset busy)`);
          await this._sleep(delayMs);
          continue;
        }
        throw e;
      }
    }
    throw new Error('subscribe retry exhausted');
  }

  // ----- Records -----
  async createRecord({ title, description = '', subjectName, tags = [], experimentId } = {}) {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    if (!title) throw new Error('Missing title');
    const params = {
      cortexToken: this.authToken,
      session: this.sessionId,
      title,
    };
    if (description) params.description = description;
    if (subjectName) params.subjectName = subjectName;
    if (Array.isArray(tags) && tags.length) params.tags = tags;
    if (typeof experimentId === 'number') params.experimentId = experimentId;
    const res = await this._rpc('createRecord', params);
    const rec = res && (res.record || res);
    const uuid = rec && rec.uuid;
    if (uuid) this.currentRecordId = uuid;
    this.emit('log', `Record created: ${uuid || 'unknown'}`);
    return { record: rec, sessionId: res && res.sessionId ? res.sessionId : this.sessionId };
  }

  async stopRecord() {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    const res = await this._rpc('stopRecord', {
      cortexToken: this.authToken,
      session: this.sessionId,
    });
    const rec = res && res.record;
    if (rec && rec.uuid) this.currentRecordId = rec.uuid;
    this.emit('log', `Record stopped: ${rec && rec.uuid ? rec.uuid : 'unknown'}`);
    return { record: rec, sessionId: res && res.sessionId ? res.sessionId : this.sessionId };
  }

  async updateRecord({ recordId, title, description, tags } = {}) {
    if (!this.authToken) throw new Error('Not authorized');
    const record = recordId || this.currentRecordId;
    if (!record) throw new Error('Missing record id');
    const params = { cortexToken: this.authToken, record };
    if (typeof title === 'string') params.title = title;
    if (typeof description === 'string') params.description = description;
    if (Array.isArray(tags)) params.tags = tags;
    return this._rpc('updateRecord', params);
  }

  async exportRecord({ recordIds, folder, streamTypes, format = 'CSV', version = 'V2',
    licenseIds = [], includeDemographics = false, includeSurvey = false, includeMarkerExtraInfos = false, includeDeprecatedPM = false } = {}) {
    if (!this.authToken) throw new Error('Not authorized');
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds || this.currentRecordId].filter(Boolean);
    if (!ids.length) throw new Error('Missing record id(s)');
    if (!folder) throw new Error('Missing folder');
    if (!Array.isArray(streamTypes) || !streamTypes.length) throw new Error('Missing streamTypes');
    const params = {
      cortexToken: this.authToken,
      recordIds: ids,
      folder,
      streamTypes,
      format,
    };
    if (format.toUpperCase() === 'CSV' && version) params.version = version;
    if (Array.isArray(licenseIds) && licenseIds.length) params.licenseIds = licenseIds;
    if (includeDemographics) params.includeDemographics = true;
    if (includeSurvey) params.includeSurvey = true;
    if (includeMarkerExtraInfos) params.includeMarkerExtraInfos = true;
    if (includeDeprecatedPM) params.includeDeprecatedPM = true;
    return this._rpc('exportRecord', params);
  }

  async exportRecordWithRetry(opts = {}, maxAttempts = 10, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await this.exportRecord(opts);
      } catch (e) {
        const code = this._extractErrorCode(e);
        // Retry on generic errors; export may require waiting for record finalization
        this.emit('log', `exportRecord retry ${i + 1}/${maxAttempts} (${code || e.message || e})`);
        await this._sleep(delayMs);
      }
    }
    throw new Error('exportRecord retry exhausted');
  }

  async unsubscribe(streams = ['eeg']) {
    if (!this.authToken || !this.sessionId) throw new Error('No session');
    const result = await this._rpc('unsubscribe', {
      cortexToken: this.authToken,
      session: this.sessionId,
      streams,
    });
    if (result && Array.isArray(result.success)) {
      for (const s of result.success) this.emit('log', `The data stream ${s.streamName} is unsubscribed successfully.`);
    }
    if (result && Array.isArray(result.failure)) {
      for (const s of result.failure) this.emit('log', `The data stream ${s.streamName} is unsubscribed unsuccessfully. Because: ${s.message}`);
    }
    return result;
  }

  // ----- Facial Expression Threshold -----
  // Wrapper for Cortex `facialExpressionThreshold` JSON-RPC
  // params: { status: 'get'|'set', action: string, value?: number, profile?: string, session?: string }
  async facialExpressionThreshold({ status, action, value, profile, session } = {}) {
    if (!this.authToken) await this.authorize();
    const params = {
      cortexToken: this.authToken,
      status,
      action,
    };
    if (typeof value === 'number' && status === 'set') params.value = value;
    // Prefer explicit session/profile, else use current session/profile
    if (session) params.session = session; else if (this.sessionId) params.session = this.sessionId;
    if (profile) params.profile = profile; else if (this.profile) params.profile = this.profile;
    if (!params.session && !params.profile) throw new Error('Missing session or profile');
    return this._rpc('facialExpressionThreshold', params);
  }

  // ----- Profiles (minimal parity) -----
  async getCurrentProfile() {
    if (!this.authToken || !this.headsetId) return null;
    return this._rpc('getCurrentProfile', {
      cortexToken: this.authToken,
      headset: this.headsetId,
    });
  }

  async setupProfile(profileName, status /* create|load|unload|save */) {
    if (!this.authToken || !this.headsetId) return null;
    return this._rpc('setupProfile', {
      cortexToken: this.authToken,
      headset: this.headsetId,
      profile: profileName,
      status,
    });
  }

  // ----- Message handling -----
  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      // Stream payload
      if (msg && msg.sid) {
        this._handleStreamData(msg);
        return;
      }
      // Result handled by _rpc listeners; ignore here
      if (Object.prototype.hasOwnProperty.call(msg, 'result')) return;
      if (msg && msg.error) {
        this.emit('error', new Error(JSON.stringify(msg.error)));
        return;
      }
      if (msg && msg.warning) {
        this._handleWarning(msg.warning);
        return;
      }
    } catch (_) {
      // ignore non-JSON
    }
  }

  _handleWarning(warning) {
    try {
      const code = warning.code;
      const message = warning.message;
      this.emit('log', `Cortex warning ${code}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
      // Minimal parity for key warnings
      // 104 HEADSET_CONNECTED -> often followed by query/createSession in python
      if (code === 104 /* HEADSET_CONNECTED */) {
        this.isHeadsetConnected = true;
      }
      // 142 HEADSET_SCANNING_FINISHED -> refresh if not connected
      if (code === 142 && !this.isHeadsetConnected) {
        this.refreshHeadsetList().catch(() => {});
      }
    } catch (_) {}
  }

  _extractLabels(streamName, cols) {
    if (!Array.isArray(cols)) return [];
    if (streamName === 'eeg') return cols.slice(0, -1); // drop MARKERS
    if (streamName === 'dev') return Array.isArray(cols[2]) ? cols[2] : cols; // CQ header (sensors only)
    if (streamName === 'eq') return cols.slice(3); // sensors only after the first 3 fields
    return cols;
  }

  _handleStreamData(msg) {
    const t = msg.time;
    if (msg.com) {
      this.emit('new_com_data', { action: msg.com[0], power: msg.com[1], time: t });
      this.emit('com', msg);
      return;
    }
    if (msg.fac) {
      this.emit('new_fe_data', { eyeAct: msg.fac[0], uAct: msg.fac[1], uPow: msg.fac[2], lAct: msg.fac[3], lPow: msg.fac[4], time: t });
      this.emit('fac', msg);
      return;
    }
    if (msg.eeg) {
      const eeg = Array.isArray(msg.eeg) ? msg.eeg.slice(0, -1) : msg.eeg;
      this.emit('new_eeg_data', { eeg, time: t });
      this.emit('eeg', msg); // keep compatibility with current server broadcast
      return;
    }
    if (msg.mot) {
      this.emit('new_mot_data', { mot: msg.mot, time: t });
      this.emit('mot', msg); // keep compatibility with server broadcast pattern
      return;
    }
    if (msg.dev) {
      this.emit('new_dev_data', { signal: msg.dev[1], dev: msg.dev[2], batteryPercent: msg.dev[3], time: t });
      this.emit('dev', msg);
      return;
    }
    if (msg.met) {
      this.emit('new_met_data', { met: msg.met, time: t });
      this.emit('met', msg); // broadcast-friendly
      return;
    }
    if (msg.pow) {
      this.emit('new_pow_data', { pow: msg.pow, time: t });
      this.emit('pow', msg); // keep compatibility with current server broadcast
      return;
    }
    if (msg.eq) {
      // eq layout: [batteryPercent, overall, sampleRateQuality, ...sensorQualities]
      this.emit('eq', msg);
      return;
    }
    if (msg.sys) {
      this.emit('new_sys_data', msg.sys);
      return;
    }
  }

  // ----- Small utils -----
  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = CortexClient;
