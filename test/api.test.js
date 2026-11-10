'use strict';

/*
 * End-to-end tests for the SkillSwap server. Run with:  npm test
 * Starts real server processes on random ports with temporary data folders,
 * so it never touches your own data/ folder. Needs Node 18+ (uses built-in fetch).
 * The socket client speaks the Socket.IO protocol directly over the "ws" package
 * (already installed together with socket.io).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(env = {}, dataDir) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'skillswap-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  for (let i = 0; i < 100 && !out.includes('running at'); i++) await sleep(50);
  if (!out.includes('running at')) throw new Error('server did not start: ' + err);
  const base = `http://127.0.0.1:${port}`;
  return {
    port, base, dataDir, child, exited,
    stderr: () => err,
    stop: async (sig = 'SIGTERM') => { child.kill(sig); return exited; },
  };
}

// minimal JSON helper
async function api(base, method, url, body, token, raw) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// Minimal Socket.IO v4 client (Engine.IO over WebSocket)
function sio(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const events = [];
    const acks = new Map();
    let nextAck = 1, closed = false;
    const client = {
      events,
      get closed() { return closed; },
      emit(ev, payload, withAck = true) {
        if (!withAck) return ws.send('42' + JSON.stringify([ev, payload]));
        const id = nextAck++;
        return new Promise((r) => {
          acks.set(id, r);
          ws.send('42' + id + JSON.stringify([ev, payload]));
          setTimeout(() => { if (acks.delete(id)) r('NO_ACK'); }, 2000);
        });
      },
      async waitFor(pred, ms = 3000) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const hit = events.find(pred);
          if (hit) return hit;
          await sleep(20);
        }
        return null;
      },
      close() { ws.close(); },
    };
    ws.on('message', (data) => {
      const s = data.toString();
      if (s[0] === '0') ws.send('40' + JSON.stringify({ token }));
      else if (s === '2') ws.send('3');
      else if (s.startsWith('40')) resolve(client);
      else if (s.startsWith('44')) reject(new Error(JSON.parse(s.slice(2)).message));
      else if (s.startsWith('42')) { const [ev, payload] = JSON.parse(s.slice(2)); events.push({ ev, payload }); }
      else if (s.startsWith('43')) {
        const m = /^43(\d+)(.*)$/s.exec(s);
        const cb = acks.get(Number(m[1]));
        if (cb) { acks.delete(Number(m[1])); cb(JSON.parse(m[2])[0]); }
      }
    });
    ws.on('close', () => { closed = true; });
    ws.on('error', reject);
  });
}

const reg = (base, name, email, password = 'secret123') => api(base, 'POST', '/api/register', { name, email, password });

async function main() {
  // =====================================================================
  section('1. Static files and security headers');
  const A = await startServer();
  let r = await fetch(A.base + '/');
  let html = await r.text();
  check('home page loads', r.status === 200 && html.includes('SkillSwap'));
  check('CSP header present', /default-src 'self'/.test(r.headers.get('content-security-policy') || ''));
  check('nosniff + frame protection', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY');
  check('X-Powered-By hidden', !r.headers.get('x-powered-by'));
  for (const p of ['/login.html', '/register.html', '/dashboard.html', '/css/style.css', '/css/dashboard.css', '/js/api.js', '/js/auth.js', '/js/main.js', '/js/dashboard.js', '/favicon.svg']) {
    const x = await fetch(A.base + p);
    check('serves ' + p, x.status === 200, x.status);
  }
  for (const p of ['/server.js', '/data/db.json', '/secret.txt', '/package.json', '/%2e%2e/server.js', '/..%2fserver.js', '/js/../../server.js']) {
    const x = await fetch(A.base + p);
    const t = await x.text();
    check('does NOT expose ' + p, x.status !== 200 || (!t.includes("require('express')") && !t.includes('"users"')), x.status);
  }
  r = await api(A.base, 'GET', '/api/health');
  check('/api/health ok + no-store', r.json && r.json.ok && r.headers.get('cache-control') === 'no-store');
  r = await api(A.base, 'GET', '/api/nope');
  check('unknown API route -> JSON 404', r.status === 404 && r.json && r.json.error);
  r = await api(A.base, 'POST', '/api/login', undefined, null, '{bad json');
  check('malformed JSON -> 400', r.status === 400 && r.json.error === 'Invalid JSON');
  r = await api(A.base, 'POST', '/api/login', undefined, null, JSON.stringify({ email: 'x'.repeat(40000) }));
  check('oversized body -> 413', r.status === 413);
  r = await api(A.base, 'GET', '/api/stats');
  check('stats start at zero', r.json.learners === 0 && r.json.skills === 0 && r.json.exchanges === 0, r.json);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(A.dataDir, 'secret.txt')).mode & 0o777;
    check('secret.txt is private (600)', mode === 0o600, mode.toString(8));
  }

  // =====================================================================
  section('2. Registration');
  const bad = [
    ['short name', { name: 'A', email: 'a@b.co', password: 'secret123' }],
    ['long name', { name: 'N'.repeat(61), email: 'a@b.co', password: 'secret123' }],
    ['bad email', { name: 'Alice', email: 'nope', password: 'secret123' }],
    ['short password', { name: 'Alice', email: 'a@b.co', password: '12345' }],
    ['73-byte password', { name: 'Alice', email: 'a@b.co', password: 'a'.repeat(73) }],
    ['multibyte password > 72 bytes', { name: 'Alice', email: 'a@b.co', password: '😀'.repeat(19) }],
    ['non-string password', { name: 'Alice', email: 'a@b.co', password: 123456789 }],
    ['empty body', {}],
  ];
  for (const [label, body] of bad) {
    r = await api(A.base, 'POST', '/api/register', body);
    check('rejects ' + label, r.status === 400, r.status);
  }
  r = await reg(A.base, 'Alice Reddy', 'Alice@Example.com', 'a'.repeat(72));
  check('72-byte password accepted', r.status === 200 && r.json.token, r.status);
  const alice = r.json;
  check('response has no email / hash leak', !('passwordHash' in alice.user) && !('email' in alice.user));
  r = await reg(A.base, 'Alice Again', 'alice@example.com');
  check('duplicate email (any case) -> 409', r.status === 409);
  const race = await Promise.all(Array.from({ length: 5 }, () => reg(A.base, 'Racer', 'race@example.com')));
  check('5 simultaneous sign-ups, same email -> exactly one wins', race.filter((x) => x.status === 200).length === 1 && race.filter((x) => x.status === 409).length === 4, race.map((x) => x.status));
  const bobR = await reg(A.base, 'Bob Manoj', 'bob@example.com');
  const carolR = await reg(A.base, 'Carol Test', 'carol@example.com');
  const bob = bobR.json, carol = carolR.json;
  const dbText = fs.readFileSync(path.join(A.dataDir, 'db.json'), 'utf8').length; // may not be flushed yet; checked later

  // =====================================================================
  section('3. Login and token security');
  r = await api(A.base, 'POST', '/api/login', { email: 'alice@example.com', password: 'wrong-password' });
  check('wrong password -> 401', r.status === 401 && r.json.error === 'Incorrect email or password');
  r = await api(A.base, 'POST', '/api/login', { email: 'ghost@example.com', password: 'whatever1' });
  check('unknown email -> same 401 message', r.status === 401 && r.json.error === 'Incorrect email or password');
  r = await api(A.base, 'POST', '/api/login', { email: ' ALICE@example.com ', password: 'a'.repeat(72) });
  check('login ignores email case/spaces', r.status === 200 && r.json.token);
  r = await api(A.base, 'POST', '/api/login', {});
  check('login with empty body -> 401 (no crash)', r.status === 401);
  const secret = fs.readFileSync(path.join(A.dataDir, 'secret.txt'), 'utf8').trim();
  const idOf = (u) => u.user.id;
  const forged = [
    ['no token', null],
    ['garbage token', 'abc.def.ghi'],
    ['alg=none token', Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: idOf(alice) })).toString('base64url') + '.'],
    ['wrong-secret token', jwt.sign({ id: idOf(alice) }, 'not-the-secret')],
    ['expired token', jwt.sign({ id: idOf(alice) }, secret, { expiresIn: -10 })],
    ['token for a non-existent user', jwt.sign({ id: 'deadbeefdeadbeef' }, secret)],
    ['HS512 token (algorithm pinned to HS256)', jwt.sign({ id: idOf(alice) }, secret, { algorithm: 'HS512' })],
  ];
  for (const [label, tok] of forged) {
    r = await api(A.base, 'GET', '/api/me', undefined, tok);
    check('rejects ' + label, r.status === 401, r.status);
  }
  r = await fetch(A.base + '/api/me', { headers: { Authorization: alice.token } });
  check('rejects header without "Bearer "', r.status === 401);
  r = await api(A.base, 'GET', '/api/me', undefined, alice.token);
  check('valid token works and returns email', r.status === 200 && r.json.email === 'alice@example.com');

  // brute-force lock-out (per email)
  let last;
  for (let i = 0; i < 8; i++) last = await api(A.base, 'POST', '/api/login', { email: 'victim@example.com', password: 'guess' + i });
  check('8 wrong guesses are plain 401s', last.status === 401);
  r = await api(A.base, 'POST', '/api/login', { email: 'victim@example.com', password: 'guess9' });
  check('9th attempt is rate-limited (429 + Retry-After)', r.status === 429 && Number(r.headers.get('retry-after')) > 0, r.status);
  r = await api(A.base, 'POST', '/api/login', { email: 'bob@example.com', password: 'secret123' });
  check('other accounts are unaffected', r.status === 200);

  // =====================================================================
  section('4. Profile and skill normalisation');
  r = await api(A.base, 'PUT', '/api/me', { teach: ['Front-End', 'frontend', '  JAVA ', '', 'x'.repeat(100), 'Front End'], learn: ['Python', 'Back-End'], bio: 'y'.repeat(400) }, alice.token);
  check('skills cleaned + de-duplicated (front-end = frontend = front end)', JSON.stringify(r.json.teach) === JSON.stringify(['front end', 'java', 'x'.repeat(40)]), r.json.teach);
  check('learn normalised', JSON.stringify(r.json.learn) === JSON.stringify(['python', 'back end']), r.json.learn);
  check('bio limited to 300 chars', r.json.bio.length === 300);
  r = await api(A.base, 'PUT', '/api/me', { learn: Array.from({ length: 30 }, (_, i) => 'skill' + i) }, alice.token);
  check('max 15 skills per list', r.json.learn.length === 15);
  r = await api(A.base, 'PUT', '/api/me', { teach: 'java' }, alice.token);
  check('non-array skills -> 400 (not silently wiped)', r.status === 400);
  r = await api(A.base, 'GET', '/api/me', undefined, alice.token);
  check('failed update left data intact', r.json.teach.length === 3);
  await api(A.base, 'PUT', '/api/me', { teach: ['java', 'frontend'], learn: ['backend', 'python'], bio: 'Hello <b>there</b>' }, alice.token);
  await api(A.base, 'PUT', '/api/me', { teach: ['python', 'Back-End'], learn: ['frontend', 'Java'], available: false }, bob.token);
  await api(A.base, 'PUT', '/api/me', { teach: ['guitar'], learn: ['spanish'] }, carol.token);
  r = await api(A.base, 'GET', '/api/me', undefined, bob.token);
  check('availability saved', r.json.available === false);

  // =====================================================================
  section('5. Matching');
  r = await api(A.base, 'GET', '/api/matches', undefined, alice.token);
  check('Alice matches Bob only (Carol has no overlap)', r.json.length === 1 && r.json[0].name === 'Bob Manoj', r.json.map((m) => m.name));
  const m = r.json[0];
  check('perfect match detected', m.perfect === true && m.score > 10);
  check('"back end" matches "backend"', m.theyTeachIWant.includes('python') && m.theyTeachIWant.includes('back end'), m.theyTeachIWant);
  check('"You teach" uses my own skills', JSON.stringify(m.iTeachTheyWant.sort()) === JSON.stringify(['frontend', 'java']), m.iTeachTheyWant);
  check('match leaks no email/hash', !('email' in m) && !('passwordHash' in m));
  check('no request yet', m.request === null);
  r = await api(A.base, 'GET', '/api/matches', undefined, carol.token);
  check('Carol has no matches', r.json.length === 0);

  // =====================================================================
  section('6. Requests, accept/reject and real-time chat');
  let bobSock, aliceSock, carolSock;
  try { await sio(A.port, 'garbage'); check('socket rejects bad token', false); } catch (e) { check('socket rejects bad token', e.message === 'unauthorized', e.message); }
  try { await sio(A.port, jwt.sign({ id: 'deadbeefdeadbeef' }, secret)); check('socket rejects token of unknown user', false); } catch (e) { check('socket rejects token of unknown user', e.message === 'unauthorized', e.message); }
  bobSock = await sio(A.port, bob.token);
  carolSock = await sio(A.port, carol.token);

  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(alice) }, alice.token);
  check('cannot request yourself', r.status === 400);
  r = await api(A.base, 'POST', '/api/requests', { toId: 'nobody' }, alice.token);
  check('cannot request unknown user', r.status === 400);
  r = await api(A.base, 'POST', '/api/requests', { toId: { $ne: 1 } }, alice.token);
  check('non-string toId rejected', r.status === 400);
  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(bob) }, alice.token);
  check('Alice -> Bob request created', r.status === 200 && r.json.status === 'pending');
  const reqId = r.json.id;
  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(bob) }, alice.token);
  check('duplicate request -> 409', r.status === 409);
  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(alice) }, bob.token);
  check('reverse duplicate -> 409', r.status === 409);
  check('Bob got a real-time notification', !!(await bobSock.waitFor((e) => e.ev === 'notify' && /Alice Reddy/.test(e.payload.text))));
  check('Carol (stranger) got nothing', !carolSock.events.some((e) => e.ev === 'notify'));

  r = await api(A.base, 'GET', '/api/messages/' + idOf(bob), undefined, alice.token);
  check('chat locked before acceptance (REST)', r.status === 403);
  aliceSock = await sio(A.port, alice.token);
  let ack = await aliceSock.emit('message', { to: idOf(bob), text: 'too early' });
  check('chat locked before acceptance (socket)', ack && ack.error === 'Not allowed', ack);

  r = await api(A.base, 'PUT', '/api/requests/' + reqId, { status: 'accepted' }, alice.token);
  check('sender cannot accept own request', r.status === 404);
  r = await api(A.base, 'PUT', '/api/requests/' + reqId, { status: 'accepted' }, carol.token);
  check('stranger cannot accept', r.status === 404);
  r = await api(A.base, 'PUT', '/api/requests/' + reqId, { status: 'hacked' }, bob.token);
  check('invalid status -> 400', r.status === 400);
  r = await api(A.base, 'GET', '/api/requests', undefined, bob.token);
  check('Bob sees incoming request with sender info', r.json.incoming.length === 1 && r.json.incoming[0].user.name === 'Alice Reddy' && !('email' in r.json.incoming[0].user));
  r = await api(A.base, 'PUT', '/api/requests/' + reqId, { status: 'accepted' }, bob.token);
  check('Bob accepts', r.status === 200 && r.json.status === 'accepted');
  check('Alice got the "accepted" notification', !!(await aliceSock.waitFor((e) => e.ev === 'notify' && /accepted/.test(e.payload.text))));
  r = await api(A.base, 'PUT', '/api/requests/' + reqId, { status: 'rejected' }, bob.token);
  check('cannot change an answered request', r.status === 404);

  ack = await aliceSock.emit('message', { to: idOf(bob), text: '  hello Bob <img src=x onerror=alert(1)>  ' });
  check('Alice -> Bob message acked', ack && ack.ok === true, ack);
  const gotB = await bobSock.waitFor((e) => e.ev === 'message');
  const gotA = await aliceSock.waitFor((e) => e.ev === 'message');
  check('Bob received it live', gotB && gotB.payload.text === 'hello Bob <img src=x onerror=alert(1)>');
  check('Alice got her own echo (multi-tab sync)', !!gotA && gotA.payload.id === gotB.payload.id);
  check('Carol did not receive it', !carolSock.events.some((e) => e.ev === 'message'));
  ack = await bobSock.emit('message', { to: idOf(alice), text: 'hi Alice' });
  check('Bob -> Alice works', ack && ack.ok === true);
  for (const [label, payload] of [['empty text', { to: idOf(bob), text: '   ' }], ['missing to', { text: 'x' }], ['non-string to', { to: { a: 1 }, text: 'x' }], ['null payload', null], ['string payload', 'hello'], ['unknown recipient', { to: 'nobody', text: 'x' }]]) {
    ack = await aliceSock.emit('message', payload);
    check('rejects ' + label, ack && ack.error, ack);
  }
  ack = await carolSock.emit('message', { to: idOf(alice), text: 'sneaky' });
  check('stranger cannot message Alice', ack && ack.error === 'Not allowed');
  aliceSock.emit('message', { to: idOf(bob), text: 'no callback given' }, false);
  await sleep(150);
  check('message without ack callback still delivered', bobSock.events.filter((e) => e.ev === 'message').some((e) => e.payload.text === 'no callback given'));
  ack = await aliceSock.emit('message', { to: idOf(bob), text: 'L'.repeat(1500) });
  r = await api(A.base, 'GET', '/api/messages/' + idOf(bob), undefined, alice.token);
  check('long message cut to 1000 chars', r.json.some((x) => x.text.length === 1000) && !r.json.some((x) => x.text.length > 1000));
  check('history has all valid messages, oldest first', r.json.length === 4 && r.json[0].text.startsWith('hello Bob'), r.json.map((x) => x.text.slice(0, 12)));
  r = await api(A.base, 'GET', '/api/messages/' + idOf(bob) + '?limit=2', undefined, alice.token);
  check('?limit returns the newest messages', r.json.length === 2 && r.json[1].text.length === 1000);
  const t2 = r.json[0].time;
  r = await api(A.base, 'GET', '/api/messages/' + idOf(bob) + '?before=' + t2, undefined, alice.token);
  check('?before pages backwards', r.json.every((x) => x.time < t2));
  r = await api(A.base, 'GET', '/api/messages/' + idOf(bob), undefined, carol.token);
  check('stranger cannot read the conversation', r.status === 403);
  r = await api(A.base, 'GET', '/api/chats', undefined, alice.token);
  check('chat list: partner online + last message', r.json.length === 1 && r.json[0].partner.online === true && r.json[0].last.text.length === 1000, r.json[0] && r.json[0].partner);
  check('chat list leaks no email', !('email' in r.json[0].partner));

  // presence is private to chat partners
  carolSock.events.length = 0; bobSock.events.length = 0;
  aliceSock.close();
  check('partner Bob is told Alice went offline', !!(await bobSock.waitFor((e) => e.ev === 'presence' && e.payload.online === false, 3000)));
  const aliceSock2 = await sio(A.port, alice.token);
  check('partner Bob is told Alice is back online', !!(await bobSock.waitFor((e) => e.ev === 'presence' && e.payload.online === true)));
  check('stranger Carol never sees Alice presence', !carolSock.events.some((e) => e.ev === 'presence'));

  // flood protection (per socket: 10 messages / 5 s)
  const flooder = await sio(A.port, alice.token);
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await flooder.emit('message', { to: idOf(bob), text: 'flood ' + i }));
  check('first 10 pass, rest are throttled', results.filter((x) => x.ok).length === 10 && results.slice(10).every((x) => x.error && /too fast/.test(x.error)), results);

  // decline + cool-down
  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(alice) }, carol.token);
  const creq = r.json.id;
  r = await api(A.base, 'PUT', '/api/requests/' + creq, { status: 'rejected' }, alice.token);
  check('Alice declines Carol', r.json.status === 'rejected');
  r = await api(A.base, 'POST', '/api/requests', { toId: idOf(alice) }, carol.token);
  check('Carol cannot re-ask within 24h (429)', r.status === 429, r.status);
  r = await api(A.base, 'GET', '/api/chats', undefined, carol.token);
  check('declined request does not unlock chat', r.json.length === 0);

  // stats
  r = await api(A.base, 'GET', '/api/stats');
  check('stats reflect real data', r.json.learners === 4 && r.json.exchanges === 1 && r.json.skills >= 6, r.json);

  // =====================================================================
  section('7. Persistence (restart, atomic save, graceful shutdown)');
  aliceSock2.close(); flooder.close(); bobSock.close(); carolSock.close();
  const dir = A.dataDir;
  const code = await A.stop('SIGTERM');
  check('server exits cleanly on SIGTERM', code === 0, code);
  const files = fs.readdirSync(dir);
  check('no temp file left behind', !files.some((f) => f.endsWith('.tmp')), files);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')); } catch (e) { saved = null; }
  check('db.json is valid JSON with everything flushed', saved && saved.users.length === 4 && saved.messages.length === 14, saved && saved.messages.length);
  check('passwords stored only as bcrypt hashes', saved.users.every((u) => /^\$2[aby]\$10\$/.test(u.passwordHash)) && !JSON.stringify(saved).includes('secret123'));
  check('server logged no errors', A.stderr() === '', A.stderr());

  const B = await startServer({}, dir);
  r = await api(B.base, 'GET', '/api/me', undefined, alice.token);
  check('old login token still valid after restart (secret persisted)', r.status === 200 && r.json.name === 'Alice Reddy');
  r = await api(B.base, 'POST', '/api/login', { email: 'bob@example.com', password: 'secret123' });
  check('password login works after restart', r.status === 200);
  r = await api(B.base, 'GET', '/api/messages/' + idOf(bob), undefined, alice.token);
  check('messages survived the restart', r.status === 200 && r.json.length === 14);
  r = await api(B.base, 'GET', '/api/chats', undefined, alice.token);
  check('after restart partner shows offline', r.json[0].partner.online === false);

  // =====================================================================
  section('8. Account deletion');
  const carolSock2 = await sio(B.port, carol.token);
  r = await api(B.base, 'DELETE', '/api/me', { password: 'wrong-one' }, carol.token);
  check('delete needs the right password (403)', r.status === 403);
  r = await api(B.base, 'DELETE', '/api/me', {}, carol.token);
  check('delete without password -> 403', r.status === 403);
  r = await api(B.base, 'DELETE', '/api/me', { password: 'secret123' }, bob.token === carol.token ? null : carol.token);
  check('correct password deletes the account', r.status === 200 && r.json.ok);
  r = await api(B.base, 'GET', '/api/me', undefined, carol.token);
  check('deleted user token stops working', r.status === 401);
  r = await api(B.base, 'POST', '/api/login', { email: 'carol@example.com', password: 'secret123' });
  check('deleted user cannot log in', r.status === 401);
  await sleep(200);
  check('deleted user socket was disconnected', carolSock2.closed === true);
  r = await api(B.base, 'GET', '/api/stats');
  check('stats updated', r.json.learners === 3, r.json);
  // delete Bob: should remove the chat + messages for Alice
  r = await api(B.base, 'DELETE', '/api/me', { password: 'secret123' }, bob.token);
  check('Bob deletes account', r.status === 200);
  r = await api(B.base, 'GET', '/api/chats', undefined, alice.token);
  check("Alice's chat list is clean (no orphan)", r.json.length === 0);
  r = await api(B.base, 'GET', '/api/requests', undefined, alice.token);
  check('requests involving Bob are gone', r.json.incoming.length === 0 && r.json.outgoing.length === 0);
  r = await api(B.base, 'GET', '/api/matches', undefined, alice.token);
  check('matches no longer include deleted users', r.json.length === 0);
  await B.stop();
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  check('messages of deleted users removed from disk', after.messages.length === 0 && after.users.length === 2, { m: after.messages.length, u: after.users.length });
  check('no unexpected server errors', B.stderr() === '', B.stderr());

  // =====================================================================
  section('9. Damaged or old database files');
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillswap-corrupt-'));
  fs.writeFileSync(path.join(cdir, 'db.json'), '{"users": [ {"id": "x"  <<< broken');
  const C = await startServer({}, cdir);
  check('starts despite a corrupt db.json', (await api(C.base, 'GET', '/api/health')).json.ok);
  check('corrupt file was backed up, not destroyed', fs.readdirSync(cdir).some((f) => f.startsWith('db.corrupt-')));
  check('warning logged', /Could not read db.json/.test(C.stderr()));
  await C.stop();

  const sample = '/mnt/user-data/uploads/db.json';
  if (fs.existsSync(sample)) {
    const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillswap-old-'));
    fs.copyFileSync(sample, path.join(odir, 'db.json'));
    const O = await startServer({}, odir);
    r = await api(O.base, 'GET', '/api/stats');
    check('your original db.json (v2.0) loads unchanged', r.json.learners === 2 && r.json.exchanges === 1, r.json);
    await O.stop();
  }
  const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillswap-min-'));
  fs.writeFileSync(path.join(edir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'Old', email: 'o@o.co', passwordHash: 'x' }] }));
  const E = await startServer({}, edir);
  r = await api(E.base, 'GET', '/api/stats');
  check('db with missing arrays/fields is repaired on load', r.json.learners === 1);
  await E.stop();

  // =====================================================================
  section('10. Rate limits (configurable)');
  const L = await startServer({ API_MAX: '5', REGISTER_MAX: '2' });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await api(L.base, 'GET', '/api/health')).status);
  check('API limiter: first 5 ok, then 429', codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429, codes);
  await L.stop();
  const L2 = await startServer({ REGISTER_MAX: '2' });
  const rc = [];
  for (let i = 0; i < 3; i++) rc.push((await reg(L2.base, 'User ' + i, `u${i}@x.co`)).status);
  check('sign-up limiter: 2 ok, 3rd -> 429', rc[0] === 200 && rc[1] === 200 && rc[2] === 429, rc);
  await L2.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
