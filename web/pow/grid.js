export function colorFor(norm) {
  const l = 95 - Math.round(60 * Math.max(0, Math.min(1, norm)));
  const color = `hsl(220, 85%, ${l}%)`;
  const text = l < 60 ? '#fff' : '#000';
  return { bg: color, fg: text };
}

export function buildGrid(gridEl, state) {
  if (!gridEl) return;
  gridEl.innerHTML = '';
  gridEl.style.setProperty('--band-count', String(state.bands.length || 5));
  const headBlank = document.createElement('div');
  headBlank.className = 'pow-head';
  headBlank.textContent = '';
  gridEl.appendChild(headBlank);
  for (const band of state.bands) {
    const d = document.createElement('div');
    d.className = 'pow-head';
    d.textContent = band;
    gridEl.appendChild(d);
  }
  for (const sensor of state.sensors) {
    const s = document.createElement('div');
    s.className = 'pow-sensor';
    s.textContent = sensor;
    gridEl.appendChild(s);
    for (const band of state.bands) {
      const cell = document.createElement('div');
      cell.className = 'pow-cell';
      const key = `${sensor}/${band}`;
      cell.dataset.key = key;
      cell.title = key;
      cell.textContent = '-';
      gridEl.appendChild(cell);
    }
  }
}

export function updateGrid(gridEl, state, values) {
  if (!gridEl || !Array.isArray(values) || values.length === 0) return;
  if (!Array.isArray(state.rollingMax) || state.rollingMax.length !== values.length) {
    state.rollingMax = Array(values.length).fill(1);
  }
  for (const sensor of state.sensors) {
    for (const band of state.bands) {
      const key = `${sensor}/${band}`;
      const i = state.indexByLabel[key];
      if (typeof i !== 'number') continue;
      const v = values[i] ?? 0;
      const prev = state.rollingMax[i] || 1;
      const updatedMax = Math.max(v, prev * 0.98, 1e-6);
      state.rollingMax[i] = updatedMax;
      const norm = Math.log10(1 + Math.max(0, v)) / Math.log10(1 + updatedMax);
      const { bg, fg } = colorFor(norm);
      const cell = gridEl.querySelector(`.pow-cell[data-key="${CSS.escape(key)}"]`);
      if (cell) {
        cell.style.backgroundColor = bg;
        cell.style.color = fg;
        cell.textContent = (Math.round((v + Number.EPSILON) * 1000) / 1000).toString();
      }
    }
  }
}

