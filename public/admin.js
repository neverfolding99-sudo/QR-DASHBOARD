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
    ['session','customers','settings'].forEach(v=>{
      document.getElementById('view-'+v).style.display = (v===btn.dataset.view) ? 'block':'none';
    });
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

  document.getElementById('offlineTitle').value = state.offlineTitle || '';
  document.getElementById('offlineBody').value = state.offlineBody || '';
}

function renderQR(){
  const el = document.getElementById('qrcode');
  el.innerHTML = '';
  const url = state.target && state.target.trim() ? state.target.trim() : 'https://regningoutbounn.dk';
  new QRCode(el, {
    text: url, width: 180, height: 180,
    colorDark: '#132E28', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
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
