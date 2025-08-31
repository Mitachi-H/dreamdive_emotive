const CortexClient = require('../src/cortexClient');

describe('CortexClient mot helpers', () => {
  test('emits new_mot_data and mot on mot messages', (done) => {
    const c = new CortexClient({});
    const time = 1700000000;
    const payload = { mot: [1, 0, 0.1, 0.2, 0.3, 0.4], sid: 'S', time };
    let seenNew = false; let seenRaw = false;
    c.on('new_mot_data', (p) => {
      try {
        expect(p).toEqual({ mot: payload.mot, time });
        seenNew = true;
        if (seenNew && seenRaw) done();
      } catch (e) { done(e); }
    });
    c.on('mot', (msg) => {
      try {
        expect(msg).toEqual(payload);
        seenRaw = true;
        if (seenNew && seenRaw) done();
      } catch (e) { done(e); }
    });
    c._handleStreamData(payload);
  });

  test('subscribe emits new_data_labels for mot success', async () => {
    const c = new CortexClient({});
    c.authToken = 't';
    c.sessionId = 's';
    const cols = ['COUNTER_MEMS','INTERPOLATED_MEMS','Q0','Q1','Q2','Q3','ACCX','ACCY','ACCZ','MAGX','MAGY','MAGZ'];
    // Monkey-patch _rpc to simulate subscribe result
    c._rpc = jest.fn().mockResolvedValue({
      failure: [],
      success: [{ streamName: 'mot', cols }],
    });

    const seen = new Promise((resolve) => {
      c.on('new_data_labels', (p) => resolve(p));
    });

    await c.subscribe(['mot']);
    const payload = await seen;
    expect(payload).toEqual({ streamName: 'mot', labels: cols });
    expect(c._rpc).toHaveBeenCalledWith('subscribe', expect.any(Object));
  });
});
