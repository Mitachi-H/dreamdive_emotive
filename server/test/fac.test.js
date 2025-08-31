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

describe('Facial expression (fac) stream control and page', () => {
  test('POST /api/stream/fac/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/fac/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['fac']);
  });

  test('POST /api/stream/fac/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/fac/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['fac']);
  });

  test('GET /Facial_expression serves HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r = await request(app).get('/Facial_expression');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/Facial Expression \(fac\)/);
    expect(r.text).toMatch(/<script type="module" src="\/Facial_expression.js"><\/script>/);
  });
});

