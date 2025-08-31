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

describe('Headset endpoints', () => {
  test('GET /api/headset returns headsets', async () => {
    const cortex = new CortexStub([{ id: 'H1', status: 'connected', channels: ['AF3'], firmware: '1.0' }]);
    const app = createApp(cortex);
    const res = await request(app).get('/api/headset');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.headsets).toEqual([{ id: 'H1', status: 'connected', channels: ['AF3'], firmware: '1.0' }]);
    expect(cortex.connect).toHaveBeenCalled();
    expect(cortex.queryHeadsets).toHaveBeenCalled();
  });

  test('POST /api/headset/refresh triggers refresh and returns list', async () => {
    const cortex = new CortexStub([{ id: 'H2', status: 'discovered' }]);
    const app = createApp(cortex);
    const res = await request(app).post('/api/headset/refresh');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.connect).toHaveBeenCalled();
    expect(cortex.controlDevice).toHaveBeenCalledWith('refresh');
    expect(cortex.queryHeadsets).toHaveBeenCalled();
  });

  test('POST /api/headset/connect requires id and connects', async () => {
    const cortex = new CortexStub([{ id: 'H3', status: 'connected' }]);
    const app = createApp(cortex);
    const resBad = await request(app).post('/api/headset/connect').send({});
    expect(resBad.status).toBe(400);
    const res = await request(app)
      .post('/api/headset/connect')
      .set('Content-Type', 'application/json')
      .send({ id: 'H3' });
    expect(res.status).toBe(200);
    expect(cortex.controlDevice).toHaveBeenCalledWith('connect', 'H3');
    expect(cortex.queryHeadsets).toHaveBeenCalled();
  });
});

describe('Pow stream control and pages', () => {
  test('POST /api/stream/pow/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/pow/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['pow']);
  });

  test('POST /api/stream/pow/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/pow/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['pow']);
  });

  test('GET /headset and /pow serve HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r1 = await request(app).get('/headset');
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toMatch(/html/);
    const r2 = await request(app).get('/pow');
    expect(r2.status).toBe(200);
    expect(r2.headers['content-type']).toMatch(/html/);
  });
});

