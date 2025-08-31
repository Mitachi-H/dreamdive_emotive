const request = require('supertest');
const { createApp } = require('../src/app');

class CortexStub {
  constructor(list = []) {
    this._list = list;
    this.authToken = 't';
    // spies
    this.connect = jest.fn().mockResolvedValue(undefined);
    this.queryHeadsets = jest.fn().mockResolvedValue(this._list);
    this.controlDevice = jest.fn().mockResolvedValue({});
    this.ensureReadyForStreams = jest.fn().mockResolvedValue({ sessionId: 'S1', headsetId: 'H1' });
    this.subscribe = jest.fn().mockResolvedValue({});
    this.unsubscribe = jest.fn().mockResolvedValue({});
  }
}

describe('Motion stream control and page', () => {
  test('POST /api/stream/mot/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/mot/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['mot']);
  });

  test('POST /api/stream/mot/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/mot/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['mot']);
  });

  test('GET /motion serves HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r = await request(app).get('/motion');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    // basic content checks
    expect(r.text).toMatch(/3D Visualization/);
    expect(r.text).toMatch(/id="calibrate"/);
    expect(r.text).toMatch(/<script type="module" src="\/motion.js"><\/script>/);
  });
});
