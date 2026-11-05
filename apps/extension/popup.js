import qrcode from './vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);
$('app-version').textContent = `v${chrome.runtime.getManifest().version}`;
let state;
let qrUrl = '';

async function request(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response) throw new Error('请重新加载插件。');
    if (response.error) throw new Error(response.error);
    render(response.state);
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = error.message;
  }
}

function drawQr(url) {
  if (url === qrUrl) return;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const scale = 5;
  const canvas = $('qr');
  canvas.width = canvas.height = (count + quiet * 2) * scale;
  canvas.dataset.url = url;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#242820';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (qr.isDark(row, column)) context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
  qrUrl = url;
}

function render(next) {
  if (!next) return;
  state = next;
  const view = !state.enabled ? 'start-view' : !state.connected ? 'connecting-view'
    : state.pending ? 'approval' : state.paired ? 'connected-view' : 'pair-view';
  for (const id of ['start-view', 'connecting-view', 'pair-view', 'approval', 'connected-view']) $(id).hidden = id !== view;
  $('stop').hidden = !state.enabled;
  $('stop').textContent = state.paired ? '结束连接' : '结束';
  $('connection-status').textContent = state.mobileConnected ? '连接中' : '等待手机重连';
  $('code').textContent = state.code || '----';
  $('error').hidden = !state.error;
  $('error').textContent = state.error;
  let phoneUrl = '';
  for (const candidate of state.mobileUrls) {
    try {
      const parsed = new URL(candidate);
      if (['http:', 'https:'].includes(parsed.protocol)) { phoneUrl = parsed.origin; break; }
    } catch { /* ignore malformed server metadata */ }
  }
  $('qr-entry').hidden = !phoneUrl;
  if (phoneUrl) {
    const pairingUrl = new URL(phoneUrl);
    pairingUrl.hash = new URLSearchParams({ code: state.code }).toString();
    drawQr(pairingUrl.href);
  }
}

$('start').addEventListener('click', () => request({ type: 'start' }));
$('stop').addEventListener('click', () => request({ type: 'stop' }));
$('refresh').addEventListener('click', () => request({ type: 'refresh' }));
$('allow').addEventListener('click', () => request({ type: 'approve', id: state.pending?.id, allow: true }));
$('deny').addEventListener('click', () => request({ type: 'approve', id: state.pending?.id, allow: false }));
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'state') render(message.state); });
request({ type: 'getState' });
