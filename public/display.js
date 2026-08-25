const bgOptions = [
  {id:'mint', css:'linear-gradient(135deg,#DCF2E8,#C3E9DA)'},
  {id:'forest', css:'linear-gradient(135deg,#1F4B3F,#132E28)'},
  {id:'cream', css:'linear-gradient(135deg,#F5F2EA,#EDE7D8)'},
  {id:'gold', css:'linear-gradient(135deg,#F1DFB8,#DDBE7C)'}
];

function render(state){
  const screen = document.getElementById('screen');
  const bgDef = bgOptions.find(b=>b.id===state.bg) || bgOptions[0];
  screen.style.backgroundImage = bgDef.css;
  screen.classList.toggle('offline', !state.live);

  const qrBox = document.getElementById('qrBox');
  const offlineMsg = document.getElementById('offlineMsg');
  const title = document.getElementById('title');
  const msg = document.getElementById('msg');

  if(state.live){
    qrBox.style.display = 'inline-block';
    offlineMsg.style.display = 'none';
    title.textContent = state.title || 'Scan for dit tilbud';
    msg.textContent = state.message || '';

    const el = document.getElementById('qrcode');
    el.innerHTML = '';
    const url = state.target && state.target.trim() ? state.target.trim() : 'https://regningoutbounn.dk';
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

// initial load via REST, then live updates via socket
fetch('/api/public-state').then(r => r.json()).then(render);

const socket = io();
socket.on('state-update', render);
