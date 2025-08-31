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

describe('EEG Quality (eq) stream control and page', () => {
  test('POST /api/stream/eq/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/eq/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['eq']);
  });

  test('POST /api/stream/eq/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/eq/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['eq']);
  });

  test('GET /EEG_Quality serves HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r = await request(app).get('/EEG_Quality');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/EEG Quality \(eq\)/);
    expect(r.text).toMatch(/<script type="module" src="\/EEG_Quality.js"><\/script>/);
  });
});

