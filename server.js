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
    customers: []
  };
}

function genId() {
  return 'S-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
  res.json({
    live: state.live,
    target: state.target,
    title: state.title,
    message: state.message,
    bg: state.bg,
    offlineTitle: state.offlineTitle,
    offlineBody: state.offlineBody
  });
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

function publicPayload() {
  return {
    live: state.live,
    target: state.target,
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
