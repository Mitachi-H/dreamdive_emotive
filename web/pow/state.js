export const state = {
  labels: [],
  sensors: [],
  bands: [],
  indexByLabel: {},
  rollingMax: [],
  bandMax: { theta: 1, alpha: 1, betaL: 1, betaH: 1, gamma: 1 },
  lastTopoDraw: 0,
  showLabels: true,
  lastPow: null,
};

export function deriveFromLabels(labels) {
  const idx = {};
  (labels || []).forEach((l, i) => { idx[l] = i; });
  const seenSensors = new Set();
  const sensors = [];
  let firstSensor = null;
  let bands = [];
  for (const lab of labels || []) {
    const [sensor, band] = String(lab).split('/');
    if (!sensor || !band) continue;
    if (!firstSensor) firstSensor = sensor;
    if (!seenSensors.has(sensor)) {
      seenSensors.add(sensor);
      sensors.push(sensor);
    }
    if (sensor === firstSensor && !bands.includes(band)) bands.push(band);
  }
  if (bands.length === 0) bands = ['theta','alpha','betaL','betaH','gamma'];
  return { sensors, bands, indexByLabel: idx };
}

