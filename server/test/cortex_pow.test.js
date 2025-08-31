const CortexClient = require('../src/cortexClient');

describe('CortexClient pow helpers', () => {
  test('extracts pow labels unchanged', () => {
    const c = new CortexClient({});
    const cols = ['AF3/theta','AF3/alpha','AF3/betaL'];
    const labels = c._extractLabels('pow', cols);
    expect(labels).toEqual(cols);
  });

  test('emits new_pow_data and pow on pow messages', (done) => {
    const c = new CortexClient({});
    const time = 1700000000;
    const payload = { pow: [0.1, 0.2, 0.3], sid: 'S', time };
    let seenNew = false; let seenRaw = false;
    c.on('new_pow_data', (p) => {
      try {
        expect(p).toEqual({ pow: payload.pow, time });
        seenNew = true;
        if (seenNew && seenRaw) done();
      } catch (e) { done(e); }
    });
    c.on('pow', (msg) => {
      try {
        expect(msg).toEqual(payload);
        seenRaw = true;
        if (seenNew && seenRaw) done();
      } catch (e) { done(e); }
    });
    c._handleStreamData(payload);
  });

  test('subscribe emits new_data_labels for pow success', async () => {
    const c = new CortexClient({});
    c.authToken = 't';
    c.sessionId = 's';
    const cols = ['AF3/theta','AF3/alpha'];
    // Monkey-patch _rpc to simulate subscribe result
    c._rpc = jest.fn().mockResolvedValue({
      failure: [],
      success: [{ streamName: 'pow', cols }],
    });

    const seen = new Promise((resolve) => {
      c.on('new_data_labels', (p) => resolve(p));
    });

    await c.subscribe(['pow']);
    const payload = await seen;
    expect(payload).toEqual({ streamName: 'pow', labels: cols });
    expect(c._rpc).toHaveBeenCalledWith('subscribe', expect.any(Object));
  });
});

