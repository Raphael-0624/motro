const DEFAULT_SERVER = 'http://localhost:3030';
let state = {
  enabled: false, serverUrl: DEFAULT_SERVER, token: null, code: '', expiresAt: 0,
  mobileUrls: [], connected: false, paired: false, mobileConnected: false, pending: null, error: '',
};
let socket;
let heartbeat;
let retryTimer;
let connectTimeout;
let retries = 0;
let controlTimer;
let processing = false;
let pendingControl = { dx: 0, dy: 0, factor: 1, reset: false };
let lastFeedback = 0;

function publicState() {
  const { token, ...visible } = state;
  return visible;
}

async function publish() {
  await chrome.storage.session.set({ motro: state });
  await chrome.action.setBadgeText({ text: state.mobileConnected ? 'ON' : state.pending ? '?' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#739237' });
  chrome.runtime.sendMessage({ type: 'state', state: publicState() }).catch(() => {});
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  if (!state.enabled || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(retryTimer);
  const url = new URL('/ws', state.serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  socket = ws;
  connectTimeout = setTimeout(() => ws.close(), 8000);
  ws.addEventListener('open', () => {
    if (socket !== ws || !state.enabled) { ws.close(); return; }
    clearTimeout(connectTimeout);
    send({ type: 'host.open', token: state.token || undefined });
    // Chrome 116+ keeps the worker alive while WebSocket messages flow.
    heartbeat = setInterval(() => {
      send({ type: 'ping' });
      if (state.connected && !state.paired && !state.pending && Date.now() >= state.expiresAt - 20_000) {
        send({ type: 'host.refresh' });
      }
    }, 20_000);
  });
  ws.addEventListener('message', async (event) => {
    if (socket !== ws || !state.enabled) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'host.state') {
      Object.assign(state, {
        token: data.token, code: data.code, expiresAt: data.expiresAt, mobileUrls: data.mobileUrls,
        paired: data.paired, mobileConnected: data.connected, pending: data.pending,
        connected: true, error: '',
      });
      retries = 0;
      await publish();
    } else if (data.type === 'control') {
      enqueueControl(data);
    } else if (data.type === 'error') {
      if (data.code === 'SESSION_EXPIRED') {
        state.token = null; state.code = ''; state.pending = null; state.paired = false;
        state.error = '服务已重启，正在生成新的连接码。';
        await publish();
        ws.close();
      } else {
        state.error = data.message;
        if (data.code === 'HOST_BUSY') { state.enabled = false; ws.close(); }
        await publish();
      }
    }
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);
    clearInterval(heartbeat);
    state.connected = false; state.mobileConnected = false;
    if (state.enabled) {
      state.error = '服务暂不可用，正在重连。';
      retryTimer = setTimeout(connect, Math.min(2000 * 2 ** retries++, 30_000));
    }
    publish();
  });
  ws.addEventListener('error', () => { /* close handles reconnect */ });
}

function enqueueControl(message) {
  if (message.action === 'scroll') { pendingControl.dx += message.dx; pendingControl.dy += message.dy; }
  if (message.action === 'zoom') pendingControl.factor = Math.max(0.1, Math.min(10, pendingControl.factor * message.factor));
  if (message.action === 'resetZoom') { pendingControl.reset = true; pendingControl.factor = 1; }
  if (!controlTimer && !processing) controlTimer = setTimeout(flushControls, 16);
}

async function flushControls() {
  controlTimer = null;
  processing = true;
  const command = pendingControl;
  pendingControl = { dx: 0, dy: 0, factor: 1, reset: false };
  try {
    if (!state.enabled || !state.mobileConnected) return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('请切换到普通网站；浏览器内部页面不支持控制。');
    if (command.dx || command.dy) {
      const message = { type: 'motro.scroll', dx: command.dx, dy: command.dy };
      try { await chrome.tabs.sendMessage(tab.id, message); }
      catch {
        // Also supports tabs opened before the extension was loaded.
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tab.id, message);
      }
    }
    if (command.reset || command.factor !== 1) {
      const current = command.reset ? 1 : await chrome.tabs.getZoom(tab.id);
      await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
      await chrome.tabs.setZoom(tab.id, Math.max(0.25, Math.min(3, current * command.factor)));
    }
  } catch (error) {
    if (Date.now() - lastFeedback > 3000) {
      lastFeedback = Date.now();
      send({ type: 'host.feedback', message: error.message.startsWith('请') ? error.message : '此页面不允许控制，请切换到普通网站后重试。' });
    }
  } finally {
    processing = false;
    if (pendingControl.dx || pendingControl.dy || pendingControl.factor !== 1 || pendingControl.reset) {
      controlTimer = setTimeout(flushControls, 16);
    }
  }
}

function stop() {
  state.enabled = false;
  send({ type: 'host.end' });
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  clearTimeout(connectTimeout);
  clearTimeout(controlTimer); controlTimer = null;
  pendingControl = { dx: 0, dy: 0, factor: 1, reset: false };
  socket?.close(); socket = null;
  Object.assign(state, { token: null, code: '', connected: false, paired: false, mobileConnected: false, pending: null, error: '' });
}

const ready = (async () => {
  const [session, config] = await Promise.all([
    chrome.storage.session.get('motro'), chrome.storage.local.get('serverUrl'),
  ]);
  if (session.motro) Object.assign(state, session.motro);
  if (config.serverUrl) state.serverUrl = config.serverUrl;
  state.connected = false; state.mobileConnected = false;
  await chrome.alarms.create('motro-reconnect', { periodInMinutes: 1 });
  if (state.enabled) connect();
})();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === 'motro-reconnect') connect();
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (!['getState', 'start', 'stop', 'approve', 'refresh'].includes(message.type)) return false;
  (async () => {
    await ready;
    if (message.type === 'start') {
      const config = await chrome.storage.local.get('serverUrl');
      const url = new URL(config.serverUrl || DEFAULT_SERVER);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('服务地址配置无效。');
      }
      stop();
      state.serverUrl = url.origin; state.enabled = true;
      await chrome.storage.local.set({ serverUrl: state.serverUrl });
      await publish();
      connect();
    } else if (message.type === 'stop') { stop(); await publish(); }
    else if (message.type === 'approve') send({ type: 'host.approve', id: message.id, allow: message.allow === true });
    else if (message.type === 'refresh') send({ type: 'host.refresh' });
    respond({ state: publicState() });
  })().catch((error) => respond({ error: error.message }));
  return true;
});
