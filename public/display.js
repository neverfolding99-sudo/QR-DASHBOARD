const bgOptions = [
  {id:'mint', css:'linear-gradient(135deg,#DCF2E8,#C3E9DA)'},
  {id:'forest', css:'linear-gradient(135deg,#1F4B3F,#132E28)'},
  {id:'cream', css:'linear-gradient(135deg,#F5F2EA,#EDE7D8)'},
  {id:'gold', css:'linear-gradient(135deg,#F1DFB8,#DDBE7C)'}
];

let lastSignature = null;
let lastUpdateAt = null;
let socketConnected = false;

function signatureOf(state){
  return JSON.stringify([state.live, state.target, state.sessionId, state.title, state.message, state.bg, state.offlineTitle, state.offlineBody]);
}

function render(state){
  const signature = signatureOf(state);
  lastUpdateAt = Date.now();
  updateSyncStatus();

  if(signature === lastSignature) return;
  lastSignature = signature;

  const screen = document.getElementById('screen');
  const bgDef = bgOptions.find(b=>b.id===state.bg) || bgOptions[0];
  screen.style.backgroundImage = bgDef.css;
  screen.classList.toggle('offline', !state.live);

  const qrBox = document.getElementById('qrBox');
  const offlineMsg = document.getElementById('offlineMsg');
  const title = document.getElementById('title');
  const msg = document.getElementById('msg');
  const liveBadge = document.getElementById('liveBadge');

  liveBadge.classList.toggle('show', !!state.live);

  if(state.live){
    qrBox.style.display = 'inline-block';
    offlineMsg.style.display = 'none';
    title.textContent = state.title || 'Scan for dit tilbud';
    msg.textContent = state.message || '';

    const el = document.getElementById('qrcode');
    el.innerHTML = '';
    const url = state.sessionId
      ? `${window.location.origin}/r/${state.sessionId}`
      : (state.target && state.target.trim() ? state.target.trim() : 'https://regningoutbounn.dk');
    new QRCode(el, {
      text: url, width: 220, height: 220,
      colorDark: '#132E28', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    qrBox.style.display = 'none';
    title.textContent = '';
    msg.textContent = '';
    offlineMsg.style.display = 'block';
    document.getElementById('offlineTitle').textContent = state.offlineTitle || 'Ingen aktiv session';
    document.getElementById('offlineBody').textContent = state.offlineBody || 'Kom tilbage senere';
  }
}

function updateSyncStatus(){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  if(!lastUpdateAt){
    el.textContent = 'Forbinder…';
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000));
  const connLabel = socketConnected ? 'Live-forbindelse' : 'Synkroniserer';
  el.textContent = secs <= 1
    ? `${connLabel} · opdateret lige nu`
    : `${connLabel} · opdateret for ${secs}s siden`;
}

async function poll(){
  try{
    const res = await fetch('/api/public-state', { cache: 'no-store' });
    const state = await res.json();
    render(state);
  }catch(e){
    // silent — next poll or socket push will recover
  }
}

poll();

const socket = io();
socket.on('connect', () => { socketConnected = true; updateSyncStatus(); });
socket.on('disconnect', () => { socketConnected = false; updateSyncStatus(); });
socket.on('state-update', render);

setInterval(poll, 1000);
setInterval(updateSyncStatus, 1000);
