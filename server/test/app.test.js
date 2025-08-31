const request = require('supertest');
const { createApp } = require('../src/app');

class CortexStub {
  constructor() {
    this.authToken = null;
  }
  async connect() { /* no-op */ }
  async getUserLogin() { return { loggedIn: true, username: 'tester' }; }
  async authorize() { this.authToken = 'token-123'; return { cortexToken: this.authToken }; }
  async hasAccessRight() { return { accessGranted: true }; }
  async getUserInformation() { return { id: 'u1', name: 'Test User' }; }
  async getLicenseInfo() { return { license: 'dev', expireDate: '2099-01-01' }; }
  async requestAccess() { return { accessGranted: true }; }
}

describe('HTTP endpoints', () => {
  const cortex = new CortexStub();
  const app = createApp(cortex);

  test('GET /healthz returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('GET /api/authentication aggregates results', async () => {
    const res = await request(app).get('/api/authentication').set('accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userLogin).toHaveProperty('loggedIn', true);
    expect(res.body.accessRight).toHaveProperty('accessGranted', true);
    expect(res.body.userInfo).toHaveProperty('name', 'Test User');
    expect(res.body.licenseInfo).toHaveProperty('license', 'dev');
  });

  test('POST /api/request-access returns ok', async () => {
    const res = await request(app).post('/api/request-access');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { accessGranted: true } });
  });

  test('GET /authentication serves HTML', async () => {
    const res = await request(app).get('/authentication');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

