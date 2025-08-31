const request = require('supertest');
const { createApp } = require('../src/app');

class CortexStub {
  constructor() {
    this.authToken = 't';
    this.ensureReadyForStreams = jest.fn().mockResolvedValue({ sessionId: 'S1', headsetId: 'H1' });
    this.subscribe = jest.fn().mockResolvedValue({});
    this.unsubscribe = jest.fn().mockResolvedValue({});
  }
}

describe('Device information (dev) stream control and page', () => {
  test('POST /api/stream/dev/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/dev/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['dev']);
  });

  test('POST /api/stream/dev/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/dev/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['dev']);
  });

  test('GET /device_information serves HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r = await request(app).get('/device_information');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/Device Information \(dev\)/);
    expect(r.text).toMatch(/<script type="module" src="\/device_information.js"><\/script>/);
  });
});

