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
});

