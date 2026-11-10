'use strict';

/*
 * SkillSwap server
 * Express (REST API + static files) + Socket.IO (real-time chat) + a JSON file as database.
 *
 * Optional environment variables:
 *   PORT              port to listen on                      (default 3000)
 *   DATA_DIR          folder for db.json / secret.txt        (default ./data)
 *   JWT_SECRET        use this signing secret instead of data/secret.txt
 *   TRUST_PROXY       set to 1 when running behind a reverse proxy (so rate limits see the real IP)
 *   LOGIN_IP_MAX      failed logins allowed per IP / 15 min   (default 30)
 *   LOGIN_EMAIL_MAX   failed logins allowed per email / 15 min (default 8)
 *   REGISTER_MAX      sign-ups allowed per IP / hour          (default 20)
 *   API_MAX           API calls allowed per IP / minute       (default 600)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const app = express();
const server = http.createServer(app);
const io = new Server(server); // same-origin only (no CORS) on purpose

// ---------- Storage: a small JSON file (survives restarts) ----------
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Signing secret: env var, or a file created on first start (so logins survive restarts)
let SECRET = process.env.JWT_SECRET;
if (!SECRET && fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

let db = { users: [], requests: [], messages: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch (e) {
    // Never silently overwrite a damaged file: keep a copy first.
    const backup = path.join(DATA_DIR, `db.corrupt-${Date.now()}.json`);
    try { fs.copyFileSync(DB_FILE, backup); } catch { /* ignore */ }
    console.error(`Could not read db.json (${e.message}). A copy was saved to ${backup}. Starting with an empty database.`);
  }
}
db.users.forEach((u) => {
  if (!Array.isArray(u.teach)) u.teach = [];
  if (!Array.isArray(u.learn)) u.learn = [];
  if (typeof u.bio !== 'string') u.bio = '';
  if (typeof u.available !== 'boolean') u.available = true;
});

// Writes are batched (100 ms) and atomic (temp file + rename), so a crash can never leave a half-written db.json.
let dirty = false;
let saveTimer = null;
function writeNow() {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeNow(); } catch (e) { console.error('Could not save database:', e.message); }
  }, 100);
}
process.on('exit', () => { try { writeNow(); } catch { /* ignore */ } });

const uid = () => crypto.randomBytes(8).toString('hex');

// ---------- Small helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// "Front-End", "front end" and "frontend" are the same skill for matching purposes
const normSkill = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim().slice(0, 40);
const skillKey = (s) => s.replace(/\s+/g, '');
function cleanSkills(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = normSkill(raw);
    if (!s || seen.has(skillKey(s))) continue;
    seen.add(skillKey(s));
    out.push(s);
  }
  return out.slice(0, 15);
}

const publicUser = (u) => ({
  id: u.id, name: u.name, bio: u.bio, teach: u.teach, learn: u.learn, available: u.available,
});
const findUser = (id) => db.users.find((u) => u.id === id);
const isOnline = (id) => io.sockets.adapter.rooms.has(id);

const makeToken = (u) => jwt.sign({ id: u.id }, SECRET, { algorithm: 'HS256', expiresIn: '30d' });
const verifyToken = (t) => jwt.verify(String(t || ''), SECRET, { algorithms: ['HS256'] });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Please log in again' });
  try {
    const user = findUser(verifyToken(h.slice(7)).id);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

// A request between two people that is still alive (pending or accepted)
const activeRequest = (a, b) =>
  db.requests.find((r) =>
    r.status !== 'rejected' &&
    ((r.from === a && r.to === b) || (r.from === b && r.to === a)));

const conversation = (a, b) =>
  db.messages.filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a));

const partnersOf = (id) =>
  db.requests
    .filter((r) => r.status === 'accepted' && (r.from === id || r.to === id))
    .map((r) => (r.from === id ? r.to : r.from));

// Tell only the people you can chat with that you went online / offline
const emitPresence = (id, online) => partnersOf(id).forEach((p) => io.to(p).emit('presence', { id, online }));

// ---------- Rate limiting (in memory, no extra packages) ----------
function makeBucket(windowMs, max) {
  const map = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) if (v.reset <= now) map.delete(k);
  }, Math.min(windowMs, 60 * 1000)).unref();
  const live = (k) => { const h = map.get(k); return h && h.reset > Date.now() ? h : null; };
  return {
    blocked: (k) => { const h = live(k); return !!h && h.count >= max; },
    retryAfter: (k) => { const h = live(k); return h ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 0; },
    hit(k) {
      if (map.size > 50000) map.clear(); // memory safety valve
      let h = live(k);
      if (!h) { h = { count: 0, reset: Date.now() + windowMs }; map.set(k, h); }
      h.count++;
      return h.count;
    },
    reset: (k) => map.delete(k),
  };
}
function limiter(windowMs, max, message) {
  const bucket = makeBucket(windowMs, max);
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    if (bucket.hit(key) > max) {
      res.set('Retry-After', String(bucket.retryAfter(key)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
const loginIpFails = makeBucket(15 * 60 * 1000, num(process.env.LOGIN_IP_MAX, 30));
const loginEmailFails = makeBucket(15 * 60 * 1000, num(process.env.LOGIN_EMAIL_MAX, 8));
const TOO_MANY_LOGINS = 'Too many failed attempts. Please wait a few minutes and try again.';

// ---------- Middleware ----------
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', limiter(60 * 1000, num(process.env.API_MAX, 600), 'Too many requests. Please slow down.'));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth ----------
const registerLimit = limiter(60 * 60 * 1000, num(process.env.REGISTER_MAX, 20), 'Too many sign-ups from this network. Please try again later.');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing the same for unknown emails

app.post('/api/register', registerLimit, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name' });
  if (name.length > 60) return res.status(400).json({ error: 'Name is too long (max 60 characters)' });
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Password is too long (max 72 bytes)' });
  const taken = { error: 'This email is already registered. Please log in.' };
  if (db.users.some((u) => u.email === email)) return res.status(409).json(taken);

  const passwordHash = await bcrypt.hash(password, 10);
  if (db.users.some((u) => u.email === email)) return res.status(409).json(taken); // double sign-up during hashing

  const user = {
    id: uid(), name, email, passwordHash,
    bio: '', teach: [], learn: [], available: true, createdAt: Date.now(),
  };
  db.users.push(user);
  save();
  res.json({ token: makeToken(user), user: publicUser(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
  const ip = req.ip || 'unknown';
  if (loginIpFails.blocked(ip) || loginEmailFails.blocked(email)) {
    res.set('Retry-After', String(Math.max(loginIpFails.retryAfter(ip), loginEmailFails.retryAfter(email))));
    return res.status(429).json({ error: TOO_MANY_LOGINS });
  }
  const user = db.users.find((u) => u.email === email);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) {
    loginIpFails.hit(ip);
    loginEmailFails.hit(email);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  loginEmailFails.reset(email);
  res.json({ token: makeToken(user), user: publicUser(user) });
}));

app.get('/api/me', auth, (req, res) => res.json({ ...publicUser(req.user), email: req.user.email }));

app.put('/api/me', auth, (req, res) => {
  const u = req.user;
  const b = req.body;
  if ((b.teach !== undefined && !Array.isArray(b.teach)) || (b.learn !== undefined && !Array.isArray(b.learn)))
    return res.status(400).json({ error: 'Skills must be a list' });
  if (b.bio !== undefined) u.bio = String(b.bio).trim().slice(0, 300);
  if (b.teach !== undefined) u.teach = cleanSkills(b.teach);
  if (b.learn !== undefined) u.learn = cleanSkills(b.learn);
  if (b.available !== undefined) u.available = !!b.available;
  save();
  res.json(publicUser(u));
});

// Delete my account and everything attached to it
app.delete('/api/me', auth, wrap(async (req, res) => {
  const me = req.user;
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
  const key = 'delete:' + me.id;
  if (loginEmailFails.blocked(key)) return res.status(429).json({ error: TOO_MANY_LOGINS });
  if (!(await bcrypt.compare(password, me.passwordHash))) {
    loginEmailFails.hit(key);
    return res.status(403).json({ error: 'Incorrect password' });
  }
  const partners = partnersOf(me.id);
  db.users = db.users.filter((u) => u.id !== me.id);
  db.requests = db.requests.filter((r) => r.from !== me.id && r.to !== me.id);
  db.messages = db.messages.filter((m) => m.from !== me.id && m.to !== me.id);
  save();
  io.in(me.id).disconnectSockets(true);
  partners.forEach((p) => io.to(p).emit('presence', { id: me.id, online: false }));
  res.json({ ok: true });
}));

// Public, anonymous numbers for the landing page
app.get('/api/stats', (req, res) => {
  const skills = new Set();
  db.users.forEach((u) => [...u.teach, ...u.learn].forEach((s) => skills.add(skillKey(s))));
  res.json({
    learners: db.users.length,
    skills: skills.size,
    exchanges: db.requests.filter((r) => r.status === 'accepted').length,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Smart matching ----------
app.get('/api/matches', auth, (req, res) => {
  const me = req.user;
  const myLearn = new Set(me.learn.map(skillKey));
  const list = db.users
    .filter((u) => u.id !== me.id)
    .map((u) => {
      const theyTeachIWant = u.teach.filter((s) => myLearn.has(skillKey(s)));
      const theirLearn = new Set(u.learn.map(skillKey));
      const iTeachTheyWant = me.teach.filter((s) => theirLearn.has(skillKey(s)));
      if (!theyTeachIWant.length && !iTeachTheyWant.length) return null;
      const perfect = theyTeachIWant.length > 0 && iTeachTheyWant.length > 0;
      const r = activeRequest(me.id, u.id);
      return {
        ...publicUser(u), theyTeachIWant, iTeachTheyWant, perfect,
        score: theyTeachIWant.length + iTeachTheyWant.length + (perfect ? 10 : 0),
        request: r ? { id: r.id, status: r.status, direction: r.from === me.id ? 'sent' : 'received' } : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  res.json(list);
});

// ---------- Exchange requests ----------
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // after a "no", wait a day before asking the same person again

app.post('/api/requests', auth, (req, res) => {
  const to = typeof req.body.toId === 'string' ? findUser(req.body.toId) : null;
  if (!to || to.id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  if (activeRequest(req.user.id, to.id)) return res.status(409).json({ error: 'A request already exists' });
  const declinedRecently = db.requests.some((r) =>
    r.from === req.user.id && r.to === to.id && r.status === 'rejected' && Date.now() - (r.respondedAt || r.createdAt) < COOLDOWN_MS);
  if (declinedRecently) return res.status(429).json({ error: 'This person declined recently. Please try again tomorrow.' });
  const r = { id: uid(), from: req.user.id, to: to.id, status: 'pending', createdAt: Date.now() };
  db.requests.push(r);
  save();
  io.to(to.id).emit('notify', { type: 'request', text: `${req.user.name} sent you a skill exchange request` });
  res.json(r);
});

app.get('/api/requests', auth, (req, res) => {
  const me = req.user.id;
  const shape = (r, otherId) => {
    const other = findUser(otherId);
    return other ? { ...r, user: publicUser(other) } : null;
  };
  res.json({
    incoming: db.requests.filter((r) => r.to === me).map((r) => shape(r, r.from)).filter(Boolean).reverse(),
    outgoing: db.requests.filter((r) => r.from === me).map((r) => shape(r, r.to)).filter(Boolean).reverse(),
  });
});

app.put('/api/requests/:id', auth, (req, res) => {
  const r = db.requests.find((x) => x.id === req.params.id && x.to === req.user.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
  if (!['accepted', 'rejected'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  r.status = req.body.status;
  r.respondedAt = Date.now();
  save();
  io.to(r.from).emit('notify', {
    type: 'update',
    text: `${req.user.name} ${r.status} your request${r.status === 'accepted' ? ' - you can chat now!' : ''}`,
  });
  res.json(r);
});

// ---------- Chat ----------
app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  const chats = db.requests
    .filter((r) => r.status === 'accepted' && (r.from === me || r.to === me))
    .map((r) => {
      const pid = r.from === me ? r.to : r.from;
      const partner = findUser(pid);
      if (!partner) return null;
      const msgs = conversation(me, pid);
      return { partner: { ...publicUser(partner), online: isOnline(pid) }, last: msgs[msgs.length - 1] || null };
    })
    .filter(Boolean)
    .sort((a, b) => (b.last?.time || 0) - (a.last?.time || 0));
  res.json(chats);
});

// Latest messages (default 200). Use ?before=<timestamp> to page backwards.
app.get('/api/messages/:partnerId', auth, (req, res) => {
  const me = req.user.id, pid = req.params.partnerId;
  const r = activeRequest(me, pid);
  if (!r || r.status !== 'accepted') return res.status(403).json({ error: 'Chat not unlocked' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const before = Number(req.query.before) || Infinity;
  res.json(conversation(me, pid).filter((m) => m.time < before).slice(-limit));
});

// ---------- Real-time ----------
io.use((socket, next) => {
  try {
    const payload = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!findUser(payload.id)) return next(new Error('unauthorized'));
    socket.userId = payload.id;
    next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
  socket.join(socket.userId);
  emitPresence(socket.userId, true);

  const sent = []; // timestamps of this socket's recent messages (flood protection: 10 per 5 s)

  socket.on('message', (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { to, text: raw } = payload && typeof payload === 'object' ? payload : {};
    const text = String(raw || '').trim().slice(0, 1000);
    const now = Date.now();
    while (sent.length && now - sent[0] > 5000) sent.shift();
    if (sent.length >= 10) return reply({ error: 'You are sending messages too fast' });
    if (!text || typeof to !== 'string' || !findUser(socket.userId)) return reply({ error: 'Not allowed' });
    const r = activeRequest(socket.userId, to);
    if (!r || r.status !== 'accepted') return reply({ error: 'Not allowed' });
    sent.push(now);
    const msg = { id: uid(), from: socket.userId, to, text, time: now };
    db.messages.push(msg);
    save();
    io.to(socket.userId).to(to).emit('message', msg);
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    // short delay so a page refresh does not flash "offline"
    setTimeout(() => { if (!isOnline(socket.userId)) emitPresence(socket.userId, false); }, 500);
  });
});

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// ---------- Start / stop ----------
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other server or run with a different PORT.`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, () => console.log(`SkillSwap running at http://localhost:${PORT}`));

function shutdown() {
  try { writeNow(); } catch { /* ignore */ }
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
