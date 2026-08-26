const bgOptions = [
  {id:'mint', css:'linear-gradient(135deg,#DCF2E8,#C3E9DA)'},
  {id:'forest', css:'linear-gradient(135deg,#1F4B3F,#132E28)'},
  {id:'cream', css:'linear-gradient(135deg,#F5F2EA,#EDE7D8)'},
  {id:'gold', css:'linear-gradient(135deg,#F1DFB8,#DDBE7C)'}
];

let state = null;
let adminPassword = sessionStorage.getItem('adminPassword') || '';

function fmtTime(d){
  if(!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('da-DK') + ' ' + dt.toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'});
}

async function apiGet(url){
  const res = await fetch(url, { headers: { 'x-admin-password': adminPassword } });
  if(res.status === 401) throw new Error('unauthorized');
  return res.json();
}

async function apiPost(url, body){
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'x-admin-password': adminPassword},
    body: JSON.stringify(body || {})
  });
  if(res.status === 401) throw new Error('unauthorized');
  return res.json();
}

// --- Login ---
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

async function doLogin(){
  const pw = document.getElementById('loginPassword').value;
  const res = await fetch('/api/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ password: pw })
  });
  const data = await res.json();
  if(data.ok){
    adminPassword = pw;
    sessionStorage.setItem('adminPassword', pw);
    showApp();
  } else {
    document.getElementById('loginError').classList.add('show');
  }
}

async function showApp(){
  try{
    state = await apiGet('/api/state');
  }catch(e){
    document.getElementById('loginWrap').style.display = 'flex';
    document.getElementById('adminApp').style.display = 'none';
    return;
  }
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('adminApp').style.display = 'grid';
  render();
  connectSocket();
}

// try auto-login with a stored password
if(adminPassword){
  showApp();
}

// --- Socket for instant sync across admin tabs ---
function connectSocket(){
  const socket = io();
  socket.on('admin-state-update', (s) => {
    state = s;
    render();
  });
}

// --- Nav ---
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    ['session','templates','schedule','stats','customers','settings','capture'].forEach(v=>{
      document.getElementById('view-'+v).style.display = (v===btn.dataset.view) ? 'block':'none';
    });
    if(btn.dataset.view === 'stats') loadStats();
  });
});

function render(){
  if(!state) return;
  document.getElementById('qrTarget').value = state.target || '';
  document.getElementById('stopTitle').value = state.title || '';
  document.getElementById('stopMsg').value = state.message || '';
  document.getElementById('sessionId').value = state.sessionId || '';
  document.getElementById('lastUpdated').value = fmtTime(state.lastUpdated);

  const dot = document.getElementById('statusDot');
  const kioskDot = document.getElementById('kioskDot');
  const statusText = document.getElementById('statusText');
  const toggle = document.getElementById('liveToggle');
  const screen = document.getElementById('previewScreen');
  const qrBox = document.getElementById('previewQrBox');
  const offlineMsg = document.getElementById('previewOfflineMsg');

  if(state.live){
    dot.classList.add('live'); kioskDot.classList.add('live');
    statusText.textContent = 'Live — vises på skærmen';
    toggle.textContent = 'Sæt offline';
    toggle.classList.add('is-live');
    screen.classList.remove('offline');
    qrBox.style.display = 'inline-block';
    offlineMsg.style.display = 'none';
    document.getElementById('previewTitle').textContent = state.title || 'Scan for dit tilbud';
    document.getElementById('previewMsg').textContent = state.message || '';
    renderQR();
  } else {
    dot.classList.remove('live'); kioskDot.classList.remove('live');
    statusText.textContent = 'Offline — intet vises';
    toggle.textContent = 'Sæt live';
    toggle.classList.remove('is-live');
    screen.classList.add('offline');
    qrBox.style.display = 'none';
    offlineMsg.style.display = 'block';
    document.getElementById('previewTitle').textContent = '';
    document.getElementById('previewMsg').textContent = '';
    document.getElementById('previewOfflineTitle').textContent = state.offlineTitle || 'Ingen aktiv session';
    document.getElementById('previewOfflineBody').textContent = state.offlineBody || '';
  }

  const bgDef = bgOptions.find(b=>b.id===state.bg) || bgOptions[0];
  screen.style.backgroundImage = bgDef.css;

  renderCustomers();
  renderSwatches();
  renderTemplates();
  renderSchedule();

  document.getElementById('offlineTitle').value = state.offlineTitle || '';
  document.getElementById('offlineBody').value = state.offlineBody || '';
}

let adminQrInstance = null;
  function renderQR(){
        const el = document.getElementById('qrcode');
        el.innerHTML = '';
        const url = state.target && state.target.trim() ? state.target.trim() : 'https://regningoutbounn.dk';
        if (window.QRCodeStyling) {
                adminQrInstance = new QRCodeStyling({
                          width: 180, height: 180, type: 'svg', data: url, margin: 4,
                          qrOptions: { errorCorrectionLevel: 'M' },
                          dotsOptions: { type: 'rounded', color: '#132E28' },
                          cornersSquareOptions: { type: 'extra-rounded', color: '#132E28' },
                          cornersDotOptions: { type: 'dot', color: '#1F4B3F' },
                          backgroundOptions: { color: '#ffffff' }
                });
                adminQrInstance.append(el);
        } else if (window.QRCode) {
                new QRCode(el, {
                          text: url, width: 180, height: 180,
                          colorDark: '#132E28', colorLight: '#ffffff',
                          correctLevel: QRCode.CorrectLevel.M
                });
        }
  }

function renderSwatches(){
  const wrap = document.getElementById('bgSwatches');
  wrap.innerHTML = '';
  bgOptions.forEach(b=>{
    const sw = document.createElement('div');
    sw.className = 'swatch' + (state.bg===b.id ? ' selected':'');
    sw.style.background = b.css;
    sw.title = b.id;
    sw.onclick = async () => {
      state.bg = b.id;
      render();
      await apiPost('/api/state', { bg: b.id });
    };
    wrap.appendChild(sw);
  });
}

function renderCustomers(){
  const rows = document.getElementById('customerRows');
  const empty = document.getElementById('customerEmpty');
  rows.innerHTML = '';
  if(!state.customers || !state.customers.length){
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  state.customers.slice().reverse().forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.ref}</td>
      <td>${c.session}</td>
      <td>${fmtTime(c.started)}</td>
      <td><span class="pill ${c.status==='active'?'active':'done'}">${c.status==='active'?'I gang':'Afsluttet'}</span></td>
    `;
    rows.appendChild(tr);
  });
}

function flashSave(id){
  const el = document.getElementById(id);
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), 1800);
}

document.getElementById('liveToggle').addEventListener('click', async ()=>{
  state.live = !state.live;
  render();
  state = await apiPost('/api/state', { live: state.live });
  render();
});

document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const target = document.getElementById('qrTarget').value.trim();
  const title = document.getElementById('stopTitle').value.trim() || 'Scan for dit tilbud';
  const message = document.getElementById('stopMsg').value.trim();
  state = await apiPost('/api/state', { target, title, message });
  render();
  flashSave('saveMsg');
});

document.getElementById('newSessionBtn').addEventListener('click', async ()=>{
  state = await apiPost('/api/session/new');
  render();
});

document.getElementById('addCustomerBtn').addEventListener('click', async ()=>{
  state = await apiPost('/api/customers');
  render();
});

document.getElementById('saveSettingsBtn').addEventListener('click', async ()=>{
  const offlineTitle = document.getElementById('offlineTitle').value.trim();
  const offlineBody = document.getElementById('offlineBody').value.trim();
  state = await apiPost('/api/state', { offlineTitle, offlineBody });
  render();
  flashSave('settingsSaveMsg');
});

// --- Templates ---
function renderTemplates(){
  const wrap = document.getElementById('templateRows');
  const empty = document.getElementById('templateEmpty');
  if(!wrap) return;
  wrap.innerHTML = '';
  const templates = state.templates || [];
  if(!templates.length){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  templates.slice().reverse().forEach(t => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);';
    row.innerHTML = `
      <div>
        <div style="font-weight:500;color:var(--forest-deep);margin-bottom:2px;">${escapeHtml(t.name)}</div>
        <div style="font-size:12.5px;color:var(--ink-soft);">${escapeHtml(t.title || '')} ${t.target ? '· ' + escapeHtml(t.target) : ''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button class="ghost apply-tpl" data-id="${t.id}">Brug</button>
        <button class="ghost delete-tpl" data-id="${t.id}" style="color:#B4453A;">Slet</button>
      </div>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.apply-tpl').forEach(btn => {
    btn.addEventListener('click', async () => {
      state = await apiPost(`/api/templates/${btn.dataset.id}/apply`, {});
      render();
      flashApplied(btn);
    });
  });
  wrap.querySelectorAll('.delete-tpl').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/templates/${btn.dataset.id}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': adminPassword }
      });
      if(res.ok){
        state.templates = state.templates.filter(t => t.id !== btn.dataset.id);
        render();
      }
    });
  });
}

function flashApplied(btn){
  const original = btn.textContent;
  btn.textContent = 'Brugt ✓';
  setTimeout(() => { btn.textContent = original; }, 1500);
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

document.getElementById('saveAsTemplateBtn').addEventListener('click', async () => {
  const name = prompt('Navn på skabelonen (fx "Julekampagne" eller "Åbningstilbud"):');
  if(!name || !name.trim()) return;
  const target = document.getElementById('qrTarget').value.trim();
  const title = document.getElementById('stopTitle').value.trim();
  const message = document.getElementById('stopMsg').value.trim();
  const template = await apiPost('/api/templates', { name, title, message, target, bg: state.bg });
  if(!state.templates) state.templates = [];
  state.templates.push(template);
  render();
});

// --- Scheduling ---
function toLocalInputValue(isoOrNull){
  if(!isoOrNull) return '';
  const d = new Date(isoOrNull);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSchedule(){
  const sch = state.schedule || { enabled:false, start:null, end:null };
  const dot = document.getElementById('scheduleDot');
  const text = document.getElementById('scheduleStatusText');
  const toggle = document.getElementById('scheduleToggle');
  if(!dot) return;

  dot.classList.toggle('live', !!sch.enabled);
  toggle.textContent = sch.enabled ? 'Slå fra' : 'Slå til';
  toggle.classList.toggle('is-live', !!sch.enabled);
  text.textContent = sch.enabled ? 'Planlægning aktiv' : 'Planlægning slået fra';

  const startEl = document.getElementById('scheduleStart');
  const endEl = document.getElementById('scheduleEnd');
  if(document.activeElement !== startEl) startEl.value = toLocalInputValue(sch.start);
  if(document.activeElement !== endEl) endEl.value = toLocalInputValue(sch.end);
}

document.getElementById('scheduleToggle').addEventListener('click', async () => {
  const sch = state.schedule || { enabled:false, start:null, end:null };
  const startVal = document.getElementById('scheduleStart').value;
  const endVal = document.getElementById('scheduleEnd').value;
  const newSchedule = await apiPost('/api/schedule', {
    enabled: !sch.enabled,
    start: startVal ? new Date(startVal).toISOString() : sch.start,
    end: endVal ? new Date(endVal).toISOString() : sch.end
  });
  state.schedule = newSchedule;
  render();
});

document.getElementById('saveScheduleBtn').addEventListener('click', async () => {
  const startVal = document.getElementById('scheduleStart').value;
  const endVal = document.getElementById('scheduleEnd').value;
  if(!startVal || !endVal){
    alert('Vælg både start- og sluttidspunkt.');
    return;
  }
  const newSchedule = await apiPost('/api/schedule', {
    enabled: state.schedule ? state.schedule.enabled : false,
    start: new Date(startVal).toISOString(),
    end: new Date(endVal).toISOString()
  });
  state.schedule = newSchedule;
  render();
  flashSave('scheduleSaveMsg');
});

// --- Stats ---
async function loadStats(){
  const stats = await apiGet('/api/stats');
  document.getElementById('statTotal').value = stats.totalScans;
  document.getElementById('statToday').value = stats.last24h;

  const rows = document.getElementById('statRows');
  const empty = document.getElementById('statEmpty');
  rows.innerHTML = '';
  if(!stats.recent.length){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  stats.recent.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtTime(s.at)}</td><td>${escapeHtml(s.session)}</td>`;
    rows.appendChild(tr);
  });
}


let captureStream = null;
let captureScanning = false;
let captureRafId = null;
let capturePushEnabled = false;
let captureLastPushed = null;
let captureLastPushAt = 0;
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

document.getElementById('captureStartBtn').addEventListener('click', startScreenShare);
document.getElementById('captureStopBtn').addEventListener('click', stopScreenShare);
document.getElementById('capturePushToggle').addEventListener('click', toggleCapturePush);

async function startScreenShare(){
    clearCaptureErr();
    const video = document.getElementById('screenVideo');
    try {
          captureStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch(e) {
          showCaptureErr('Kunne ikke starte skaermdeling. Vaelg det vindue hvor QR-koden vises, og proev igen.');
          return;
    }
    video.srcObject = captureStream;
    await video.play();
    captureStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);

  document.getElementById('screenPlaceholder').style.display = 'none';
    document.getElementById('captureStartBtn').style.display = 'none';
    document.getElementById('captureStopBtn').style.display = 'inline-block';
    setCaptureStatus(true, 'Soeger efter QR-kode...');

  captureScanning = true;
    captureScanLoop();
}

function stopScreenShare(){
    captureScanning = false;
    if(captureRafId) cancelAnimationFrame(captureRafId);
    if(captureStream) captureStream.getTracks().forEach(t=>t.stop());
    captureStream = null;
    const video = document.getElementById('screenVideo');
    if(video) video.srcObject = null;
    const ph = document.getElementById('screenPlaceholder');
    if(ph) ph.style.display = 'flex';
    const startBtn = document.getElementById('captureStartBtn');
    const stopBtn = document.getElementById('captureStopBtn');
    if(startBtn) startBtn.style.display = 'inline-block';
    if(stopBtn) stopBtn.style.display = 'none';
    setCaptureStatus(false, 'Skaermdeling stoppet');
}

function captureScanLoop(){
    if(!captureScanning) return;
    const video = document.getElementById('screenVideo');
    if(video && video.readyState === video.HAVE_ENOUGH_DATA){
          const w = video.videoWidth, h = video.videoHeight;
          if(w && h){
                  captureCanvas.width = w;
                  captureCanvas.height = h;
                  captureCtx.drawImage(video, 0, 0, w, h);
                  const img = captureCtx.getImageData(0, 0, w, h);
                  const code = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
                  if(code && code.data){
                            onCaptureDecoded(code.data);
                  }
          }
    }
    captureRafId = requestAnimationFrame(captureScanLoop);
}

function onCaptureDecoded(value){
    const readEl = document.getElementById('captureReadValue');
    if(readEl) readEl.value = value;
    setCaptureStatus(true, 'Kode aflaest');
    if(!capturePushEnabled) return;
    const now = Date.now();
    if(value === captureLastPushed && now - captureLastPushAt < 1500) return;
    captureLastPushed = value;
    captureLastPushAt = now;
    pushCaptureToDisplay(value);
}

async function pushCaptureToDisplay(value){
    try{
          const res = await fetch('/api/capture-push', {
                  method:'POST',
                  headers:{'Content-Type':'application/json','x-admin-password':adminPassword},
                  body: JSON.stringify({ target: value })
          });
          if(res.ok){
                  state = await apiGet('/api/state');
                  render();
          } else {
                  showCaptureErr('Kunne ikke sende til skaermen. Er du stadig logget ind?');
          }
    }catch(e){
          showCaptureErr('Netvaerksfejl ved afsendelse til skaermen.');
    }
}

function toggleCapturePush(){
    capturePushEnabled = !capturePushEnabled;
    const toggleBtn = document.getElementById('capturePushToggle');
    const statusEl = document.getElementById('capturePushStatus');
    if(toggleBtn) toggleBtn.textContent = 'Send til kundeskaerm: ' + (capturePushEnabled ? 'til' : 'fra');
    if(statusEl) statusEl.textContent = capturePushEnabled
      ? 'Sender aflaest kode live til kundeskaerm'
          : 'Sender ikke til kundeskaerm';
    if(capturePushEnabled && captureLastPushed === null){
          const cur = document.getElementById('captureReadValue').value;
          if(cur && cur !== '-'){ captureLastPushed = cur; captureLastPushAt = Date.now(); pushCaptureToDisplay(cur); }
    }
}

function setCaptureStatus(active, text){
    const dot = document.getElementById('captureDot');
    const textEl = document.getElementById('captureStatusText');
    if(!dot) return;
    dot.classList.toggle('live', !!active);
    if(textEl) textEl.textContent = text;
}

function showCaptureErr(msg){
    const el = document.getElementById('captureErr');
    if(el) el.textContent = msg;
}
function clearCaptureErr(){
    const el = document.getElementById('captureErr');
    if(el) el.textContent = '';
}

window.addEventListener('pagehide', stopScreenShare);
