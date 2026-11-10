'use strict';

// Dashboard: profile, matches, requests and real-time chat
(function () {
  const $ = (id) => document.getElementById(id);
  const fail = (e) => toast(e && e.message ? e.message : 'Something went wrong', 'error');

  let me = null, socket = null, activeChat = null;
  let chats = [], matches = [], reqs = { incoming: [], outgoing: [] };
  let chat = null; // the open conversation: { id, ready, queue, seen }
  const teach = [], learn = [];
  let teachUI, learnUI;

  // ---------- Boot ----------
  API.onExpired = () => location.replace('login.html');

  (async function init() {
    setTimeout(hideLoader, 6000); // safety: never stay stuck on the loader
    if (!API.token()) return location.replace('login.html');
    try {
      me = await API.req('/api/me');
    } catch (e) {
      if (e.status === 401) return location.replace('login.html');
      hideLoader();
      return toast(e.message, 'error');
    }
    try {
      $('greeting').textContent = 'Hello, ' + me.name.split(' ')[0] + ' 👋';
      $('subGreeting').textContent = 'Ready to swap some skills?';
      $('bio').value = me.bio || '';
      teach.push(...me.teach);
      learn.push(...me.learn);
      teachUI = tagInput($('teachBox'), teach, 'teachInput');
      learnUI = tagInput($('learnBox'), learn, 'learnInput');
      setAvailability(me.available);
      connectSocket();
      await refreshAll();
    } catch (err) {
      console.error(err);
      toast('Something failed: ' + err.message, 'error');
    } finally {
      hideLoader();
    }
  })();

  async function refreshAll() {
    await Promise.all([loadMatches(), loadRequests(), loadChats()]);
    renderStats();
  }

  // ---------- Tabs ----------
  document.querySelectorAll('.sidebar nav button').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
  function openTab(name) {
    document.querySelectorAll('.sidebar nav button').forEach((x) => {
      const on = x.dataset.tab === name;
      x.classList.toggle('active', on);
      if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'chat') loadChats().catch(fail);
  }
  const chatTabOpen = () => $('tab-chat').classList.contains('active');

  $('logout').addEventListener('click', () => {
    if (socket) socket.disconnect();
    API.clear();
    location.href = 'index.html';
  });

  // ---------- Availability ----------
  function setAvailability(v) {
    $('availToggle').checked = v;
    $('availText').textContent = v ? 'Available' : 'Busy';
  }
  $('availToggle').addEventListener('change', async (e) => {
    const v = e.target.checked;
    setAvailability(v);
    try {
      await API.req('/api/me', 'PUT', { available: v });
      me.available = v;
      toast(v ? 'You are now available' : 'You are marked busy', 'success');
    } catch (err) {
      setAvailability(!v); // put the switch back
      fail(err);
    }
  });

  // ---------- Skills ----------
  // Same clean-up as the server: lower-case, one space between words, "front-end" = "front end"
  const normSkill = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim().slice(0, 40);
  const skillKey = (s) => s.replace(/\s+/g, '');

  function tagInput(box, arr, inputId) {
    const input = document.createElement('input');
    input.id = inputId;
    input.placeholder = 'Type a skill and press Enter';
    input.maxLength = 40;
    input.autocomplete = 'off';

    function render() {
      box.querySelectorAll('.tag').forEach((t) => t.remove());
      arr.forEach((s, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.append(s + ' ');
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Remove ' + s);
        x.addEventListener('click', () => { arr.splice(i, 1); render(); });
        tag.appendChild(x);
        box.insertBefore(tag, input);
      });
    }
    function add() {
      const v = normSkill(input.value.replace(/,/g, ' '));
      input.value = '';
      if (!v) return;
      if (arr.some((a) => skillKey(a) === skillKey(v))) return;
      if (arr.length >= 15) return toast('You can add up to 15 skills in each list', 'error');
      arr.push(v);
      render();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && arr.length) { arr.pop(); render(); }
    });
    input.addEventListener('blur', add);
    box.appendChild(input);
    box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });
    render();
    return { render, flush: add };
  }

  $('saveSkills').addEventListener('click', async () => {
    const btn = $('saveSkills');
    teachUI.flush(); learnUI.flush();
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      const saved = await API.req('/api/me', 'PUT', { bio: $('bio').value, teach, learn });
      me = { ...me, ...saved };
      teach.splice(0, teach.length, ...saved.teach); // show exactly what the server stored
      learn.splice(0, learn.length, ...saved.learn);
      teachUI.render(); learnUI.render();
      $('bio').value = saved.bio;
      toast('Profile saved!', 'success');
      await loadMatches();
      renderStats();
    } catch (e) { fail(e); }
    btn.classList.remove('loading');
    btn.disabled = false;
  });

  // ---------- Delete account ----------
  $('delAcc').addEventListener('click', async () => {
    const password = $('delPass').value;
    if (!password) return toast('Enter your password to confirm', 'error');
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    const btn = $('delAcc');
    btn.disabled = true;
    try {
      await API.req('/api/me', 'DELETE', { password });
      if (socket) socket.disconnect();
      API.clear();
      toast('Your account was deleted', 'success');
      setTimeout(() => location.replace('index.html'), 900);
    } catch (e) { fail(e); btn.disabled = false; }
  });

  // ---------- Stats ----------
  function renderStats() {
    const pending = reqs.incoming.filter((r) => r.status === 'pending').length;
    const items = [
      ['🎓', me.teach.length, 'Skills teaching'], ['📚', me.learn.length, 'Skills learning'],
      ['🔍', matches.length, 'Matches found'], ['🤝', chats.length, 'Active exchanges'], ['⏳', pending, 'Pending requests'],
    ];
    $('statGrid').innerHTML = items
      .map(([i, n, l]) => `<div class="stat"><div>${i}</div><div class="big">${n}</div><div class="muted">${l}</div></div>`)
      .join('');
    $('reqBadge').hidden = pending === 0;
    $('reqBadge').textContent = pending;
  }

  // ---------- Matches ----------
  const initial = (n) => esc((n.trim()[0] || '?').toUpperCase());
  const chips = (arr) => arr.map((s) => `<span class="tag">${esc(s)}</span>`).join(' ');

  async function loadMatches() {
    matches = await API.req('/api/matches');
    const g = $('matchGrid');
    if (!matches.length) {
      g.innerHTML = '<div class="panel empty">No matches yet. Add skills you can teach and want to learn in <b>My Skills</b>, or invite friends to join!</div>';
      return;
    }
    g.innerHTML = matches.map((m, i) => {
      let action = `<button type="button" class="btn" data-send="${esc(m.id)}">Send exchange request</button>`;
      if (m.request) {
        if (m.request.status === 'accepted') action = `<button type="button" class="btn btn-green" data-chat="${esc(m.id)}">💬 Open chat</button>`;
        else if (m.request.direction === 'sent') action = '<button type="button" class="btn btn-gray" tabindex="-1">Request sent ⏳</button>';
        else action = '<button type="button" class="btn" data-tab-go="requests">Respond to request</button>';
      }
      return `<div class="user-card" style="animation-delay:${i * 0.07}s">
        <div class="user-head"><div class="av">${initial(m.name)}</div>
          <div><b>${esc(m.name)}</b><br><small class="muted"><span class="status-dot ${m.available ? 'on' : ''}"></span>${m.available ? 'Available' : 'Busy'}</small></div></div>
        <span class="match-badge ${m.perfect ? 'perfect' : ''}">${m.perfect ? '⭐ Perfect match' : 'Partial match'}</span>
        ${m.bio ? `<p class="line muted">${esc(m.bio)}</p>` : ''}
        ${m.theyTeachIWant.length ? `<div class="line">They teach: ${chips(m.theyTeachIWant)}</div>` : ''}
        ${m.iTeachTheyWant.length ? `<div class="line">You teach: ${chips(m.iTeachTheyWant)}</div>` : ''}
        ${action}</div>`;
    }).join('');
  }

  $('matchGrid').addEventListener('click', async (e) => {
    const send = e.target.closest('[data-send]');
    const open = e.target.closest('[data-chat]');
    const go = e.target.closest('[data-tab-go]');
    if (send && !send.disabled) {
      send.classList.add('loading');
      send.disabled = true;
      try {
        await API.req('/api/requests', 'POST', { toId: send.dataset.send });
        toast('Request sent!', 'success');
        await refreshAll();
      } catch (err) {
        fail(err);
        send.classList.remove('loading');
        send.disabled = false;
      }
    } else if (open) {
      openTab('chat');
      openChat(open.dataset.chat);
    } else if (go) {
      openTab(go.dataset.tabGo);
    }
  });

  // ---------- Requests ----------
  const reqRow = (r, actions) => `
    <div class="req-row"><div class="av">${initial(r.user.name)}</div>
      <div class="info"><b>${esc(r.user.name)}</b><br><small class="muted">Teaches: ${esc(r.user.teach.join(', ') || '-')}</small></div>
      ${actions}</div>`;

  async function loadRequests() {
    reqs = await API.req('/api/requests');
    $('incoming').innerHTML = reqs.incoming.length
      ? reqs.incoming.map((r) => reqRow(r, r.status === 'pending'
        ? `<div><button type="button" class="btn btn-green" data-act="accepted" data-id="${esc(r.id)}">Accept</button><button type="button" class="btn btn-red" data-act="rejected" data-id="${esc(r.id)}">Reject</button></div>`
        : `<span class="status ${esc(r.status)}">${esc(r.status)}</span>`)).join('')
      : '<div class="empty">No requests received yet.</div>';
    $('outgoing').innerHTML = reqs.outgoing.length
      ? reqs.outgoing.map((r) => reqRow(r, `<span class="status ${esc(r.status)}">${esc(r.status)}</span>`)).join('')
      : '<div class="empty">You have not sent any requests.</div>';
  }

  $('incoming').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    b.classList.add('loading');
    b.disabled = true;
    try {
      await API.req('/api/requests/' + b.dataset.id, 'PUT', { status: b.dataset.act });
      toast(b.dataset.act === 'accepted' ? 'Accepted! You can chat now 🎉' : 'Request rejected', 'success');
      await refreshAll();
    } catch (err) {
      fail(err);
      b.classList.remove('loading');
      b.disabled = false;
    }
  });

  // ---------- Chat list ----------
  async function loadChats() {
    chats = await API.req('/api/chats');
    renderChatList();
    updateChatHeader();
    renderStats();
  }

  function renderChatList() {
    const list = $('chatList');
    list.innerHTML = chats.length ? chats.map((c) => {
      const last = c.last ? (c.last.from === me.id ? 'You: ' : '') + c.last.text : 'Say hello 👋';
      const on = activeChat === c.partner.id;
      return `<button type="button" class="chat-item ${on ? 'active' : ''}" data-id="${esc(c.partner.id)}"${on ? ' aria-current="true"' : ''}>
        <div class="av">${initial(c.partner.name)}</div>
        <div class="meta"><b>${esc(c.partner.name)}</b>
          <small><span class="status-dot ${c.partner.online ? 'on' : ''}"></span>${esc(last)}</small></div>
      </button>`;
    }).join('') : '<div class="empty">No chats yet.<br>Get a request accepted to start.</div>';
  }

  $('chatList').addEventListener('click', (e) => {
    const el = e.target.closest('.chat-item');
    if (el) openChat(el.dataset.id);
  });

  function updateChatHeader() {
    const el = $('chatStatus');
    const c = chats.find((x) => x.partner.id === activeChat);
    if (!el || !c) return;
    el.innerHTML = `<span class="status-dot ${c.partner.online ? 'on' : ''}"></span>${c.partner.online ? 'Online' : 'Offline'} · ${c.partner.available ? 'Available to teach' : 'Currently busy'}`;
  }

  // ---------- Open conversation ----------
  async function openChat(id) {
    const c = chats.find((x) => x.partner.id === id);
    if (!c) return;
    activeChat = id;
    const mine = (chat = { id, ready: false, queue: [], seen: new Set() });
    renderChatList();

    $('chatWindow').innerHTML = `
      <div class="chat-head"><div class="av">${initial(c.partner.name)}</div>
        <div><b>${esc(c.partner.name)}</b><br><small class="muted" id="chatStatus"></small></div></div>
      ${c.partner.available ? '' : '<div class="warn">This person is currently busy. They will see your message when they are back.</div>'}
      <div class="chat-msgs" id="msgs" role="log" aria-live="polite" aria-label="Messages"></div>
      <form class="chat-form" id="chatForm"><input id="chatInput" placeholder="Type a message..." aria-label="Message" autocomplete="off" maxlength="1000" /><button type="submit" class="btn">Send ➤</button></form>`;
    updateChatHeader();

    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text) return;
      if (!socket || !socket.connected) return toast('Not connected. Trying to reconnect…', 'error');
      input.value = '';
      socket.emit('message', { to: id, text }, (res) => {
        if (res && res.error) {
          toast(res.error, 'error');
          if (!input.value) input.value = text; // give the text back so nothing is lost
        }
      });
    });
    $('chatInput').focus();

    try {
      const msgs = await API.req('/api/messages/' + id);
      if (chat !== mine) return; // the user already opened another chat
      msgs.forEach(appendMsg);
    } catch (err) {
      if (chat === mine) fail(err);
    }
    if (chat !== mine) return;
    mine.queue.forEach(appendMsg); // messages that arrived while history was loading
    mine.queue = [];
    mine.ready = true;
  }

  function fmtTime(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
  }

  function appendMsg(m) {
    const box = $('msgs');
    if (!chat || !box || chat.seen.has(m.id)) return; // never show a message twice
    chat.seen.add(m.id);
    const d = document.createElement('div');
    d.className = 'bubble ' + (m.from === me.id ? 'me' : 'them');
    d.append(m.text); // text only, never HTML
    const t = document.createElement('time');
    t.textContent = fmtTime(m.time);
    d.appendChild(t);
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // ---------- Real-time socket ----------
  function connectSocket() {
    if (typeof io === 'undefined') return toast('Chat could not connect. Restart the server with: node server.js', 'error');
    socket = io({ auth: { token: API.token() } });
    let wasConnected = false, warned = false;

    socket.on('connect', () => {
      warned = false;
      if (wasConnected) { // we were offline for a while: catch up on anything we missed
        refreshAll().catch(() => {});
        if (chat) API.req('/api/messages/' + chat.id).then((ms) => ms.forEach(appendMsg)).catch(() => {});
      }
      wasConnected = true;
    });
    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') { API.clear(); location.replace('login.html'); }
      else if (!warned) { warned = true; toast('Connection lost. Trying to reconnect…', 'error'); }
    });
    socket.on('disconnect', (reason) => { if (reason === 'io server disconnect') socket.connect(); });

    socket.on('message', (m) => {
      const partner = m.from === me.id ? m.to : m.from;
      const c = chats.find((x) => x.partner.id === partner);
      if (c) {
        c.last = m;
        chats.sort((a, b) => (b.last?.time || 0) - (a.last?.time || 0));
        renderChatList();
      } else {
        loadChats().catch(() => {});
      }
      if (chat && chat.id === partner) {
        if (chat.ready) appendMsg(m); else chat.queue.push(m);
      }
      const viewing = chat && chat.id === partner && chatTabOpen();
      if (!viewing && m.from !== me.id) toast('💬 New message' + (c ? ' from ' + c.partner.name : ''));
    });

    socket.on('notify', (n) => { toast(n.text, 'success'); refreshAll().catch(() => {}); });

    socket.on('presence', ({ id, online }) => {
      const c = chats.find((x) => x.partner.id === id);
      if (!c) return;
      c.partner.online = online;
      renderChatList();
      updateChatHeader();
    });
  }
})();
