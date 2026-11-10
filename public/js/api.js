'use strict';

// Shared helpers used by every page
const API = {
  token: () => localStorage.getItem('ss_token'),
  setToken: (t) => localStorage.setItem('ss_token', t),
  clear: () => localStorage.removeItem('ss_token'),
  onExpired: null, // pages can set this to react to an expired login

  async req(url, method = 'GET', body) {
    const headers = { 'Content-Type': 'application/json' };
    if (API.token()) headers.Authorization = 'Bearer ' + API.token();
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (res.status === 401 && url !== '/api/login') {
      API.clear();
      if (typeof API.onExpired === 'function') API.onExpired();
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong');
      err.status = res.status;
      throw err;
    }
    return data;
  },
};

// Escape text before putting it into HTML
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Small pop-up messages
function toast(msg, type = '') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  // identical messages are shown once, and at most 3 toasts are on screen
  const live = [...box.children].filter((x) => !x.classList.contains('out'));
  if (live.some((x) => x.textContent === msg)) return;
  if (live.length >= 3) live[0].remove();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3500);
}

// Fade the loading screen away
function hideLoader() {
  const l = document.getElementById('loader');
  if (!l) return;
  l.classList.add('hide');
  setTimeout(() => l.remove(), 700);
}
