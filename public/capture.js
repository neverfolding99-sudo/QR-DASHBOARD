let adminPassword = sessionStorage.getItem('adminPassword') || '';
let stream = null;
let scanning = false;
let rafId = null;
let pushEnabled = false;
let lastPushed = null;
let lastPushAt = 0;

const video = document.getElementById('cam');
const canvas = document.getElementById('work');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const pw = document.getElementById('loginPassword').value;
  const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
    });
  const data = await res.json();
  if (data.ok) {
    adminPassword = pw;
    sessionStorage.setItem('adminPassword', pw);
    showApp();
  } else {
    document.getElementById('loginError').classList.add('show');
  }
}

function showApp() {
    document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('capApp').style.display = 'flex';
}

if (adminPassword) {
  fetch('/api/state', { headers: { 'x-admin-password': adminPassword } })
        .then(r => { if (r.ok) showApp(); });
}

document.getElementById('startBtn').addEventListener('click', startCamera);
document.getElementById('stopBtn').addEventListener('click', stopCamera);
document.getElementById('pushToggle').addEventListener('click', togglePush);

async function startCamera() {
  clearErr();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }, audio: false
      });
} catch (e) {
    showErr('Kunne ikke faa adgang til kameraet. Giv siden kameratilladelse i browseren, og proev igen. (' + e.name + ')');
    return;
  }
  video.srcObject = stream;
  await video.play();

  document.getElementById('camPlaceholder').style.display = 'none';
  document.getElementById('reticle').style.display = 'block';
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'inline-block';
  setReadStatus('reading', 'Soeger efter QR-kode...');

  scanning = true;
  scanLoop();
}

function stopCamera() {
    scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;

  document.getElementById('camPlaceholder').style.display = 'flex';
  document.getElementById('reticle').style.display = 'none';
  document.getElementById('startBtn').style.display = 'inline-block';
  document.getElementById('stopBtn').style.display = 'none';
  setReadStatus('stopped', 'Kamera stoppet');
}

function scanLoop() {
    if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        onDecoded(code.data);
      }
    }
  }
  rafId = requestAnimationFrame(scanLoop);
}

function onDecoded(value) {
    document.getElementById('readValue').textContent = value;
  setReadStatus('reading', 'Kode aflaest');

  if (!pushEnabled) return;

  const now = Date.now();
  if (value === lastPushed && now - lastPushAt < 1500) return;
  lastPushed = value;
  lastPushAt = now;
  pushToDisplay(value);
}

async function pushToDisplay(value) {
  try {
    const res = await fetch('/api/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ target: value })
      });
    if (!res.ok) {
      showErr('Kunne ikke sende til skaermen (' + res.status + '). Er du stadig logget ind?');
    }
  } catch (e) {
    showErr('Netvaerksfejl ved afsendelse til skaermen.');
  }
}

function togglePush() {
    pushEnabled = !pushEnabled;
  document.getElementById('pushToggle').textContent = 'Send til skaerm: ' + (pushEnabled ? 'til' : 'fra');
  document.getElementById('liveFlag').classList.toggle('on', pushEnabled);
  document.getElementById('liveFlagText').textContent = pushEnabled
        ? 'Sender aflaest kode til kundeskaerm (live)'
        : 'Sender ikke til kundeskaerm';
  if (pushEnabled && lastPushed === null) {
    const cur = document.getElementById('readValue').textContent;
    if (cur && cur !== '-') { lastPushed = cur; lastPushAt = Date.now(); pushToDisplay(cur); }
  }
}

function setReadStatus(cls, text) {
    const dot = document.getElementById('readDot');
  dot.className = 'read-dot ' + cls;
  document.getElementById('readText').textContent = text;
}

function showErr(msg) {
    const el = document.getElementById('capErr');
  el.textContent = msg;
  el.classList.add('show');
}
function clearErr() {
    document.getElementById('capErr').classList.remove('show');
}

window.addEventListener('pagehide', stopCamera);
