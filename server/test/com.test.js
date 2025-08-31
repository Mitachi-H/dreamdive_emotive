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

describe('Mental command (com) stream control and page', () => {
  test('POST /api/stream/com/start calls ensureReadyForStreams + subscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/com/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.ensureReadyForStreams).toHaveBeenCalled();
    expect(cortex.subscribe).toHaveBeenCalledWith(['com']);
  });

  test('POST /api/stream/com/stop calls unsubscribe', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const res = await request(app).post('/api/stream/com/stop');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(cortex.unsubscribe).toHaveBeenCalledWith(['com']);
  });

  test('GET /Mental_command serves HTML', async () => {
    const cortex = new CortexStub();
    const app = createApp(cortex);
    const r = await request(app).get('/Mental_command');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/Mental Command \(com\)/);
    expect(r.text).toMatch(/<script type="module" src="\/Mental_command.js"><\/script>/);
  });
});

