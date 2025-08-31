(function () {
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const errorBox = $('error');
  const login = $('login');
  const access = $('access');
  const userinfo = $('userinfo');
  const license = $('license');
  const reloadBtn = $('reload');
  const requestBtn = $('request');

  function render(el, data) {
    el.textContent = JSON.stringify(data, null, 2);
  }

  async function load() {
    status.textContent = '取得中…';
    errorBox.textContent = '';
    try {
      const res = await fetch('/api/authentication');
      const json = await res.json();
      status.textContent = json.ok ? '取得完了' : 'エラー';
      if (!json.ok && json.error) errorBox.textContent = json.error;
      if (json.authorizeError) errorBox.textContent = `authorize error: ${json.authorizeError}`;
      render(login, json.userLogin ?? {});
      render(access, json.accessRight ?? {});
      render(userinfo, json.userInfo ?? {});
      render(license, json.licenseInfo ?? {});
    } catch (e) {
      status.textContent = '通信エラー';
      errorBox.textContent = String(e);
    }
  }

  reloadBtn.addEventListener('click', load);
  requestBtn.addEventListener('click', async () => {
    status.textContent = 'requestAccess 実行中… Emotiv Launcher で承認してください。';
    errorBox.textContent = '';
    try {
      const res = await fetch('/api/request-access', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        status.textContent = 'requestAccess を送信しました。Launcher で承認後に再取得してください。';
      } else {
        status.textContent = 'requestAccess エラー';
        errorBox.textContent = json.error || JSON.stringify(json);
      }
    } catch (e) {
      status.textContent = 'requestAccess 通信エラー';
      errorBox.textContent = String(e);
    }
  });
  load();
})();
