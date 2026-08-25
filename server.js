require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'skift-mig';
const PORT = process.env.PORT || 3000;

function defaultState() {
  return {
    live: false,
    target: '',
    title: 'Scan for dit tilbud',
    message: 'Gyldig i denne butik i dag',
    sessionId: genId(),
    lastUpdated: null,
    bg: 'mint',
    offlineTitle: 'Ingen aktiv session',
    offlineBody: 'Kom tilbage senere',
    customers: [],
    templates: [],
    stats: { totalScans: 0, scanLog: [] },
    schedule: { enabled: false, start: null, end: null }
  };
}

function genId() {
  return 'S-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}
function genTemplateId() {
  return 'T-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // merge with defaults so upgrades from older data.json don't crash on missing fields
    return { ...defaultState(), ...loaded, stats: { ...defaultState().stats, ...(loaded.stats || {}) }, schedule: { ...defaultState().schedule, ...(loaded.schedule || {}) } };
  } catch (e) {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
}

function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

app.use(express.json());
app.use('/display', express.static(path.join(__dirname, 'public'), { index: 'display.html' }));
app.use('/admin', express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Public: read-only state for the display screen (no auth, no secrets in payload) ---
app.get('/api/public-state', (req, res) => {
  res.json(publicPayload());
});

// --- Public: scan-tracking redirect. QR codes point here instead of straight to the target,
// so every real scan gets counted before the customer is sent on to the actual link. ---
app.get('/r/:sessionId', (req, res) => {
  if (state.live && state.target) {
    state.stats.totalScans += 1;
    state.stats.scanLog.push({ at: Date.now(), session: req.params.sessionId });
    if (state.stats.scanLog.length > 200) {
      state.stats.scanLog = state.stats.scanLog.slice(-200);
    }
    saveState(state);
    io.emit('admin-state-update', state);
    return res.redirect(302, state.target);
  }
  res.status(404).send(`
    <!DOCTYPE html><html lang="da"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>regningoutbounn</title>
    <style>body{font-family:sans-serif;background:#132E28;color:#DCF2E8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px;}</style>
    </head><body><div><h1>Ingen aktiv session</h1><p>Dette link er ikke aktivt lige nu.</p></div></body></html>
  `);
});

// --- Admin auth middleware ---
function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Forkert adgangskode' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.get('/api/state', requireAdmin, (req, res) => {
  res.json(state);
});

app.post('/api/state', requireAdmin, (req, res) => {
  const allowed = ['live', 'target', 'title', 'message', 'bg', 'offlineTitle', 'offlineBody'];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) state[key] = req.body[key];
  });
  state.lastUpdated = Date.now();
  saveState(state);
  io.emit('state-update', publicPayload());
  io.emit('admin-state-update', state);
  res.json(state);
});

app.post('/api/session/new', requireAdmin, (req, res) => {
  state.sessionId = genId();
  state.lastUpdated = Date.now();
  saveState(state);
  io.emit('admin-state-update', state);
  io.emit('state-update', publicPayload());
  res.json(state);
});

app.post('/api/customers', requireAdmin, (req, res) => {
  const ref = 'K-' + Math.floor(1000 + Math.random() * 9000);
  state.customers.push({
    ref,
    session: state.sessionId,
    started: Date.now(),
    status: 'active'
  });
  saveState(state);
  io.emit('admin-state-update', state);
  res.json(state);
});

// --- Templates: save & reuse a full session setup (title, message, target, bg) ---
app.get('/api/templates', requireAdmin, (req, res) => {
  res.json(state.templates);
});

app.post('/api/templates', requireAdmin, (req, res) => {
  const { name, title, message, target, bg } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Skabelonen skal have et navn' });
  }
  const template = {
    id: genTemplateId(),
    name: name.trim(),
    title: title || '',
    message: message || '',
    target: target || '',
    bg: bg || 'mint',
    createdAt: Date.now()
  };
  state.templates.push(template);
  saveState(state);
  io.emit('admin-state-update', state);
  res.json(template);
});

app.post('/api/templates/:id/apply', requireAdmin, (req, res) => {
  const tpl = state.templates.find(t => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });
  state.title = tpl.title;
  state.message = tpl.message;
  state.target = tpl.target;
  state.bg = tpl.bg;
  state.lastUpdated = Date.now();
  saveState(state);
  io.emit('state-update', publicPayload());
  io.emit('admin-state-update', state);
  res.json(state);
});

app.delete('/api/templates/:id', requireAdmin, (req, res) => {
  state.templates = state.templates.filter(t => t.id !== req.params.id);
  saveState(state);
  io.emit('admin-state-update', state);
  res.json({ ok: true });
});

// --- Stats ---
app.get('/api/stats', requireAdmin, (req, res) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const last24h = state.stats.scanLog.filter(s => now - s.at < dayMs).length;
  res.json({
    totalScans: state.stats.totalScans,
    last24h,
    recent: state.stats.scanLog.slice(-15).reverse()
  });
});

// --- Scheduling: auto go live/offline within a time window, checked every 30s ---
app.post('/api/schedule', requireAdmin, (req, res) => {
  const { enabled, start, end } = req.body;
  state.schedule = {
    enabled: !!enabled,
    start: start || null,
    end: end || null
  };
  saveState(state);
  io.emit('admin-state-update', state);
  res.json(state.schedule);
});

setInterval(() => {
  if (!state.schedule || !state.schedule.enabled || !state.schedule.start || !state.schedule.end) return;
  const now = Date.now();
  const start = new Date(state.schedule.start).getTime();
  const end = new Date(state.schedule.end).getTime();
  if (isNaN(start) || isNaN(end)) return;
  const shouldBeLive = now >= start && now <= end;
  if (shouldBeLive !== state.live) {
    state.live = shouldBeLive;
    state.lastUpdated = Date.now();
    saveState(state);
    io.emit('state-update', publicPayload());
    io.emit('admin-state-update', state);
  }
}, 30000);

function publicPayload() {
  return {
    live: state.live,
    target: state.target,
    sessionId: state.sessionId,
    title: state.title,
    message: state.message,
    bg: state.bg,
    offlineTitle: state.offlineTitle,
    offlineBody: state.offlineBody
  };
}

io.on('connection', (socket) => {
  socket.emit('state-update', publicPayload());
});

server.listen(PORT, () => {
  console.log(`QR-panel kører på http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`Skærm: http://localhost:${PORT}/display`);
});
