(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const logEl = $('#log');
  const statusEl = $('#status');
  const sessionIdEl = $('#sessionId');
  const recordIdEl = $('#recordId');
  const downloadsEl = $('#downloads');

  let currentRecordId = '';
  let currentSessionId = '';

  const getToken = () => localStorage.getItem('dashboard_token') || '';
  const getHeadsetId = () => $('#headsetId').value.trim();

  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
  };

  const setStatus = (s) => { statusEl.textContent = s; };
  const setSession = (sid) => { currentSessionId = sid || ''; sessionIdEl.textContent = currentSessionId || '-'; };
  const setRecord = (rid) => { currentRecordId = rid || ''; recordIdEl.textContent = currentRecordId || '-'; };

  // Persist headset id
  const savedHeadset = localStorage.getItem('headset_id') || '';
  if (savedHeadset) $('#headsetId').value = savedHeadset;
  $('#saveHeadset').addEventListener('click', () => {
    localStorage.setItem('headset_id', getHeadsetId());
    log('Saved headset id');
  });

  function authHeaders() {
    const token = getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  function selectedSubs() {
    return $$('input[name="sub"]:checked').map((el) => el.value);
  }
  function selectedExports() {
    return $$('input[name="exp"]:checked').map((el) => el.value);
  }
  function selectedFormat() {
    const f = $$('input[name="format"]:checked')[0];
    return f ? f.value : 'CSV';
  }

  function defaultExportsFromSubs(subs) {
    // Map subscription streams to export streams
    const m = new Set();
    for (const s of subs) {
      if (s === 'eeg') m.add('EEG');
      if (s === 'mot') m.add('MOTION');
      if (s === 'pow') m.add('BP');
      if (s === 'met') m.add('PM');
      if (s === 'com') m.add('MC');
      if (s === 'fac') m.add('FE');
    }
    return Array.from(m);
  }

  async function startRecording() {
    const subs = selectedSubs();
    const title = $('#title').value.trim();
    const description = $('#description').value.trim();
    const subjectName = $('#subjectName').value.trim();
    const tags = $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean);
    if (!title) { alert('Title is required'); return; }

    setStatus('starting…');
    $('#startRecord').disabled = true;
    try {
      const resp = await fetch('/api/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          headsetId: getHeadsetId() || undefined,
          subscribeStreams: subs,
          title,
          description: description || undefined,
          subjectName: subjectName || undefined,
          tags: tags.length ? tags : undefined,
        }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'start failed');
      const rec = data.record || {};
      setSession(data.sessionId);
      setRecord(rec.uuid);
      setStatus('recording');
      $('#stopRecord').disabled = false;

      // Suggest initial export selections based on subs
      const exps = defaultExportsFromSubs(subs);
      $$('input[name="exp"]').forEach((el) => {
        el.checked = exps.includes(el.value);
      });
      log(`Recording started: ${rec.uuid}`);
    } catch (e) {
      log(`Error: ${e.message || e}`);
      setStatus('idle');
      $('#startRecord').disabled = false;
    }
  }

  async function stopRecording() {
    setStatus('stopping…');
    $('#stopRecord').disabled = true;
    try {
      const resp = await fetch('/api/record/stop', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'stop failed');
      const rec = data.record || {};
      setRecord(rec.uuid);
      setStatus('stopped');
      $('#exportRecord').disabled = false;
      $('#startRecord').disabled = false;
      log(`Recording stopped: ${rec.uuid}`);
    } catch (e) {
      log(`Error: ${e.message || e}`);
      setStatus('unknown');
      $('#stopRecord').disabled = false;
    }
  }

  async function exportRecording() {
    const rid = currentRecordId;
    if (!rid) { alert('No recordId'); return; }
    const streams = selectedExports();
    if (!streams.length) { alert('Select export streams'); return; }
    const fmt = selectedFormat();
    const version = fmt === 'CSV' ? 'V2' : undefined;
    const includeMarkerExtraInfos = $('#markerCSV').checked;
    const includeDeprecatedPM = $('#deprecatedPM').checked;

    $('#exportRecord').disabled = true;
    setStatus('exporting…');
    downloadsEl.textContent = '';
    try {
      const resp = await fetch('/api/record/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          recordId: rid,
          exportStreams: streams,
          format: fmt,
          version,
          includeMarkerExtraInfos,
          includeDeprecatedPM,
        }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'export failed');
      const files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) {
        downloadsEl.textContent = 'No files detected.';
      } else {
        const list = document.createElement('ul');
        for (const f of files) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = f.url;
          a.textContent = f.name;
          a.download = f.name;
          li.appendChild(a);
          list.appendChild(li);
        }
        downloadsEl.innerHTML = '';
        downloadsEl.appendChild(list);
      }
      setStatus('exported');
      $('#exportRecord').disabled = false;
      log('Export finished');
    } catch (e) {
      log(`Error: ${e.message || e}`);
      setStatus('stopped');
      $('#exportRecord').disabled = false;
    }
  }

  $('#startRecord').addEventListener('click', startRecording);
  $('#stopRecord').addEventListener('click', stopRecording);
  $('#exportRecord').addEventListener('click', exportRecording);
})();

