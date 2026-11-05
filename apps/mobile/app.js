import { ScrollMomentum } from './inertia.js';

const $ = (id) => document.getElementById(id);
let socket;
let retryTimer;
let heartbeat;
let connectTimeout;
let token = sessionStorage.getItem('motro.mobileToken');
const codeFromLink = new URLSearchParams(location.hash.slice(1)).get('code');
const scannedCode = /^\d{4}$/.test(codeFromLink || '') ? codeFromLink : null;
if (scannedCode) {
  // Fragments stay out of server logs; remove the short-lived code from history too.
  history.replaceState(null, '', location.pathname + location.search);
  token = null;
  sessionStorage.removeItem('motro.mobileToken');
}
let hostConnected = false;
let stopped = false;
let frame = 0;
let scrollX = 0;
let scrollY = 0;
let zoomFactor = 1;
const pointers = new Map();
const momentum = new ScrollMomentum();
let momentumFrame = 0;
let singleFingerGesture = false;

// iOS keyboards can resize the visual viewport without updating CSS viewport units.
function syncViewport() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--viewport-height', `${Math.round(height)}px`);
}
window.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('resize', syncViewport);
syncViewport();

async function recordVisit() {
  try {
    const response = await fetch('/api/visits', { method: 'POST' });
    if (!response.ok) throw new Error('Visit counter unavailable');
    const { count, version } = await response.json();
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid visit count');
    $('visit-count').textContent = `no.${count}`;
    $('visit-count').hidden = false;
    $('app-version').textContent = `v${version}`;
    $('app-version').hidden = false;
  } catch {
    // Counting is best effort and must never block pairing or trigger double counts.
    $('visit-count').textContent = 'no.--';
    $('visit-count').hidden = false;
  }
}
recordVisit();

const messages = {
  INVALID_CODE: '连接码无效、已过期或已使用，请查看电脑插件。',
  RATE_LIMITED: '尝试次数过多，请等待一分钟再试。',
  PAIRING_BUSY: '电脑正在处理另一个配对请求，请稍后再试。',
  HOST_OFFLINE: '电脑正在重新连接，请稍候。',
  SERVER_FULL: '服务当前连接较多，请稍后再试。',
  MOBILE_BUSY: '这个会话已经在另一处打开，请重新配对。',
};

function status(text, isError = false) {
  const element = token ? $('remote-status') : !$('waiting-view').hidden ? $('waiting-status') : $('pair-status');
  element.textContent = text;
  element.classList.toggle('error', isError);
}

function setOnline(online) {
  hostConnected = online;
  $('connection-dot').classList.toggle('offline', !online);
  $('trackpad').classList.toggle('disabled', !online);
  for (const id of ['zoom-out', 'zoom-in', 'reset-zoom']) $(id).disabled = !online;
  clearGesture();
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 32768) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function resetPairing(message) {
  stopped = true;
  clearTimeout(retryTimer);
  clearTimeout(connectTimeout);
  clearInterval(heartbeat);
  socket?.close();
  token = null;
  sessionStorage.removeItem('motro.mobileToken');
  setOnline(false);
  $('pair-view').hidden = false;
  $('remote-view').hidden = true;
  $('waiting-view').hidden = true;
  $('disconnect').hidden = true;
  $('connect').disabled = false;
  $('code').disabled = false;
  $('cancel').hidden = true;
  status(message);
}

function connect(message) {
  clearTimeout(retryTimer);
  stopped = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = ws;
  connectTimeout = setTimeout(() => ws.close(), 8000);
  ws.addEventListener('open', () => {
    if (socket !== ws || stopped) { ws.close(); return; }
    clearTimeout(connectTimeout);
    ws.send(JSON.stringify(message));
    heartbeat = setInterval(() => send({ type: 'ping' }), 20_000);
  });
  ws.addEventListener('message', (event) => {
    if (socket !== ws || stopped) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'mobile.pending') {
      status('在电脑上确认授权');
      $('cancel').hidden = false;
    } else if (data.type === 'mobile.ready') {
      token = data.token;
      sessionStorage.setItem('motro.mobileToken', token);
      $('pair-view').hidden = true;
      $('waiting-view').hidden = true;
      $('remote-view').hidden = false;
      $('disconnect').hidden = false;
      setOnline(data.hostConnected);
      status(data.hostConnected ? '已连接' : '等待电脑重新连接…');
      $('code').blur();
    } else if (data.type === 'host.status') {
      setOnline(data.connected);
      status(data.connected ? '已连接' : '等待电脑重新连接…');
    } else if (data.type === 'host.feedback') {
      status(data.message, true);
    } else if (data.type === 'session.ended') {
      resetPairing('连接已结束，请重新输入电脑上的连接码。');
    } else if (data.type === 'error') {
      if (data.code === 'SESSION_EXPIRED' || data.code === 'MOBILE_BUSY') {
        resetPairing('会话已失效，请重新配对。');
      } else if (!token) {
        resetPairing(messages[data.code] || data.message);
      } else status(messages[data.code] || data.message, true);
    }
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);
    clearInterval(heartbeat);
    setOnline(false);
    if (stopped) return;
    if (token) {
      status('连接中断，正在重连…');
      retryTimer = setTimeout(() => connect({ type: 'mobile.resume', token }), 2000);
    } else resetPairing('无法连接服务，请检查 Wi-Fi 和电脑服务后重试。');
  });
  ws.addEventListener('error', () => { /* close handles retry and user feedback */ });
}

$('pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('code').value.trim();
  if (!/^\d{4}$/.test(code)) { status('请输入四位数字连接码。', true); return; }
  $('connect').disabled = true;
  $('code').disabled = true;
  $('code').blur();
  $('pair-view').hidden = true;
  $('waiting-view').hidden = false;
  $('cancel').hidden = false;
  status('连接中…');
  connect({ type: 'mobile.join', code });
});
$('code').addEventListener('input', () => { $('code').value = $('code').value.replace(/\D/g, '').slice(0, 4); });
$('cancel').addEventListener('click', () => resetPairing('已取消，可以重新输入连接码。'));
$('disconnect').addEventListener('click', () => {
  send({ type: 'mobile.leave' });
  resetPairing('已断开连接。');
});

function control(action, values = {}) {
  if (hostConnected) send({ type: 'control', action, ...values });
}
$('zoom-out').addEventListener('click', () => control('zoom', { factor: 1 / 1.1 }));
$('zoom-in').addEventListener('click', () => control('zoom', { factor: 1.1 }));
$('reset-zoom').addEventListener('click', () => control('resetZoom'));

function clearGesture() {
  stopMomentum();
  singleFingerGesture = false;
  pointers.clear();
  scrollX = 0; scrollY = 0; zoomFactor = 1;
  cancelAnimationFrame(frame); frame = 0;
  $('trackpad').classList.remove('active');
}

function stopMomentum() {
  cancelAnimationFrame(momentumFrame);
  momentumFrame = 0;
  momentum.cancel();
}

function animateMomentum(time) {
  momentumFrame = 0;
  if (!hostConnected || document.hidden || pointers.size) { stopMomentum(); return; }
  const delta = momentum.step(time);
  if (delta && (delta.dx || delta.dy)) control('scroll', delta);
  if (momentum.active) momentumFrame = requestAnimationFrame(animateMomentum);
}

function flush() {
  frame = 0;
  if (Math.abs(scrollX) + Math.abs(scrollY) > 0) control('scroll', { dx: scrollX, dy: scrollY });
  if (Math.abs(zoomFactor - 1) > 0.001) control('zoom', { factor: Math.max(0.5, Math.min(2, zoomFactor)) });
  scrollX = 0; scrollY = 0; zoomFactor = 1;
}

const distance = () => {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};
const pad = $('trackpad');
// Any new touch, including toolbar controls, immediately cancels a fling.
document.addEventListener('pointerdown', stopMomentum, { capture: true });
pad.addEventListener('pointerdown', (event) => {
  if (!hostConnected) return;
  event.preventDefault();
  pad.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  singleFingerGesture = pointers.size === 1;
  if (singleFingerGesture) momentum.begin(event.timeStamp);
  else momentum.cancel();
  pad.classList.add('active');
});
pad.addEventListener('pointermove', (event) => {
  const old = pointers.get(event.pointerId);
  if (!old || !hostConnected) return;
  event.preventDefault();
  const before = distance();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    const dx = -(event.clientX - old.x) * Number($('speed').value);
    const dy = -(event.clientY - old.y) * Number($('speed').value);
    scrollX += dx; scrollY += dy;
    if (singleFingerGesture) momentum.sample(dx, dy, event.timeStamp);
  } else if (pointers.size === 2 && before > 12) {
    zoomFactor *= distance() / before;
  }
  if (!frame) frame = requestAnimationFrame(flush);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  pad.addEventListener(name, (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (name !== 'pointerup') { singleFingerGesture = false; stopMomentum(); }
    if (pointers.size === 0) {
      pad.classList.remove('active');
      if (name === 'pointerup' && singleFingerGesture && momentum.release(event.timeStamp)) {
        momentumFrame = requestAnimationFrame(animateMomentum);
      }
      singleFingerGesture = false;
    }
  });
}
pad.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('visibilitychange', () => {
  clearGesture();
  if (!document.hidden && token && socket?.readyState === WebSocket.CLOSED && !stopped) {
    connect({ type: 'mobile.resume', token });
  }
});

if (scannedCode) {
  $('code').value = scannedCode;
  $('pair-form').requestSubmit();
} else if (token) {
  $('pair-view').hidden = true;
  $('remote-view').hidden = false;
  $('disconnect').hidden = false;
  setOnline(false);
  status('正在恢复连接…');
  connect({ type: 'mobile.resume', token });
}
