(() => {
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const errorBox = $('error');
  const listEl = $('list');
  const refreshBtn = $('refresh');

  const getHeaders = () => {
    const h = {};
    const t = localStorage.getItem('dashboard_token');
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  function render(headsets) {
    if (!Array.isArray(headsets)) headsets = [];
    if (headsets.length === 0) {
      listEl.innerHTML = '<p class="muted">No headsets found. Emotiv Launcher を確認してください。</p>';
      return;
    }
    const html = headsets.map(h => {
      const btn = `<button data-id="${h.id}" class="connect">Connect</button>`;
      return `<div style="border:1px solid #ccc3; padding:8px; margin:8px 0; border-radius:6px;">
        <div><b>ID</b>: ${h.id || '-'} | <b>Status</b>: ${h.status || '-'} | <b>Firmware</b>: ${h.firmware || '-'}</div>
        <div><b>Channels</b>: ${Array.isArray(h.channels) ? h.channels.join(', ') : '-'}</div>
        <div>${h.status === 'connected' ? '<span style="color:#0c0">Connected</span>' : btn}</div>
      </div>`;
    }).join('');
    listEl.innerHTML = html;
    listEl.querySelectorAll('button.connect').forEach(b => {
      b.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        status.textContent = `Connecting ${id}…`;
        errorBox.textContent = '';
        try {
          const res = await fetch('/api/headset/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeaders() },
            body: JSON.stringify({ id })
          });
          const j = await res.json();
          if (!j.ok) { errorBox.textContent = j.error || JSON.stringify(j); }
          await load();
        } catch (e) {
          errorBox.textContent = String(e);
        }
      });
    });
  }

  async function load() {
    status.textContent = '取得中…';
    errorBox.textContent = '';
    try {
      const res = await fetch('/api/headset', { headers: getHeaders() });
      const j = await res.json();
      if (!j.ok) { status.textContent = 'エラー'; errorBox.textContent = j.error || JSON.stringify(j); return; }
      status.textContent = `取得完了 (${(j.headsets || []).length} 件)`;
      render(j.headsets);
    } catch (e) {
      status.textContent = '通信エラー';
      errorBox.textContent = String(e);
    }
  }

  refreshBtn.addEventListener('click', async () => {
    status.textContent = 'Refreshing…';
    errorBox.textContent = '';
    try {
      const res = await fetch('/api/headset/refresh', { method: 'POST', headers: getHeaders() });
      const j = await res.json();
      if (!j.ok) { errorBox.textContent = j.error || JSON.stringify(j); }
      await load();
    } catch (e) {
      errorBox.textContent = String(e);
    }
  });

  load();
})();

