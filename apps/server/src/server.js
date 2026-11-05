import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { VisitCounter } from './visits.js';
import { versions } from './version.js';

const CODE_TTL = 5 * 60_000;
const RECONNECT_TTL = 2 * 60_000;
const MAX_SESSIONS = 100;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/inertia.js', ['inertia.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/assets/icon-32.png', ['assets/icon-32.png', 'image/png']],
  ['/assets/icon-128.png', ['assets/icon-128.png', 'image/png']],
  ['/assets/apple-touch-icon.png', ['assets/apple-touch-icon.png', 'image/png']],
]);

export function createMotroServer({
  mobileUrls = [], allowedHosts = ['localhost', '127.0.0.1'], extensionIds,
  dataDirectory = fileURLToPath(new URL('../../../data/', import.meta.url)),
} = {}) {
  const visits = new VisitCounter(join(dataDirectory, 'visits.json'));
  const sessions = new Map();
  const clients = new Set();
  const attempts = new Map();
  const send = (ws, message) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const error = (ws, code, message) => send(ws, { type: 'error', code, message });

  const server = createServer(async (request, response) => {
    let requestHost;
    try { requestHost = new URL(`http://${request.headers.host}`); } catch { response.writeHead(400).end(); return; }
    if (!allowedHosts.includes(requestHost.hostname) || requestHost.username || requestHost.password) {
      response.writeHead(403).end('Forbidden host'); return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    // Explicit WebSocket sources also cover browsers that do not map 'self' to ws/wss.
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://${requestHost.host} wss://${requestHost.host}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { response.writeHead(400).end(); return; }
    if (url.pathname === '/api/visits') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (request.headers.origin) {
        let origin;
        try { origin = new URL(request.headers.origin); } catch { response.writeHead(403).end(); return; }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) {
          response.writeHead(403).end(); return;
        }
      }
      try {
        const count = await visits.increment();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ count, version: versions.mobile }));
      } catch {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Visit counter unavailable' }));
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, name: 'motro', version: versions.server }));
      return;
    }
    if (url.pathname === '/api/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(versions));
      return;
    }
    const file = staticFiles.get(url.pathname);
    if (!file) { response.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(new URL(`../../mobile/${file[0]}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': file[1] });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(500).end('Unable to load mobile app'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    let host;
    let origin;
    try {
      host = new URL(`http://${request.headers.host}`).hostname;
      origin = request.headers.origin ? new URL(request.headers.origin) : null;
    } catch { socket.destroy(); return; }
    const extensionOrigin = origin?.protocol === 'chrome-extension:'
      && /^[a-p]{32}$/.test(origin.hostname)
      && (!extensionIds || extensionIds.includes(origin.hostname));
    const pageOrigin = origin && ['http:', 'https:'].includes(origin.protocol)
      && origin.host === request.headers.host;
    // Native test clients have no Origin. Browsers cannot omit or forge it.
    if (request.url !== '/ws' || !allowedHosts.includes(host)
      || (origin && !extensionOrigin && !pageOrigin) || clients.size >= 200) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isExtension = Boolean(extensionOrigin) || !origin;
      wss.emit('connection', ws, request);
    });
  });

  function state(session) {
    send(session.host, {
      type: 'host.state', token: session.token, code: session.code,
      expiresAt: session.expiresAt, mobileUrls, paired: Boolean(session.mobileToken),
      connected: session.mobile?.readyState === WebSocket.OPEN,
      pending: session.pending ? { id: session.pending.id } : null,
    });
  }

  function removeSession(session, reason = 'Session ended') {
    sessions.delete(session.token);
    for (const peer of [session.mobile, session.pending?.ws]) {
      send(peer, { type: 'session.ended', message: reason });
      peer?.close(1000, reason);
    }
    if (session.host) session.host.session = null;
  }

  function nextCode() {
    let code;
    do { code = String(randomInt(0, 10_000)).padStart(4, '0'); }
    while ([...sessions.values()].some((session) => session.code === code));
    return code;
  }

  wss.on('connection', (ws, request) => {
    clients.add(ws);
    ws.alive = true;
    ws.connectedAt = Date.now();
    ws.rate = { start: Date.now(), count: 0 };
    ws.on('error', () => {});
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, binary) => {
      const now = Date.now();
      if (now - ws.rate.start >= 1000) ws.rate = { start: now, count: 0 };
      if (++ws.rate.count > 180) { ws.close(1008, 'Too many messages'); return; }
      let message;
      try { message = binary ? null : JSON.parse(data.toString()); } catch { /* handled below */ }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        error(ws, 'INVALID_MESSAGE', 'Invalid message'); return;
      }
      if (message.type === 'ping') { send(ws, { type: 'pong' }); return; }

      if (message.type === 'host.open') {
        if (!ws.isExtension) { error(ws, 'FORBIDDEN', 'Use the browser extension'); return; }
        if (ws.role) { error(ws, 'ALREADY_CONNECTED', 'Already connected'); return; }
        let session;
        if (message.token) {
          session = sessions.get(message.token);
          if (!session) { error(ws, 'SESSION_EXPIRED', 'Session expired; start a new session'); return; }
          if (session.host?.readyState === WebSocket.OPEN) { error(ws, 'HOST_BUSY', 'Host already connected'); return; }
        } else {
          if (sessions.size >= MAX_SESSIONS) { error(ws, 'SERVER_FULL', 'Server is full'); return; }
          session = { token: randomUUID(), code: nextCode(), expiresAt: now + CODE_TTL, mobileToken: null };
          sessions.set(session.token, session);
        }
        ws.role = 'host'; ws.session = session;
        session.host = ws; session.disconnectedAt = null;
        state(session);
        send(session.mobile, { type: 'host.status', connected: true });
        return;
      }

      if (message.type === 'mobile.join') {
        if (ws.role) { error(ws, 'ALREADY_CONNECTED', 'Already connected'); return; }
        const ip = request.socket.remoteAddress;
        let rate = attempts.get(ip);
        if (!rate || now > rate.until) { rate = { count: 0, until: now + 60_000 }; attempts.set(ip, rate); }
        if (++rate.count > 5) { error(ws, 'RATE_LIMITED', 'Too many attempts; wait one minute'); return; }
        const session = [...sessions.values()].find((item) => item.code === message.code
          && item.expiresAt > now && !item.mobileToken && item.host?.readyState === WebSocket.OPEN);
        if (typeof message.code !== 'string' || !/^\d{4}$/.test(message.code) || !session) {
          error(ws, 'INVALID_CODE', 'Code is invalid, expired, or already used'); return;
        }
        if (session.pending) { error(ws, 'PAIRING_BUSY', 'Another pairing request is pending'); return; }
        ws.role = 'pending'; ws.session = session;
        session.pending = { id: randomUUID(), ws, expiresAt: now + 60_000 };
        send(ws, { type: 'mobile.pending' });
        state(session);
        return;
      }

      if (message.type === 'mobile.resume') {
        if (ws.role) { error(ws, 'ALREADY_CONNECTED', 'Already connected'); return; }
        const session = typeof message.token === 'string'
          ? [...sessions.values()].find((item) => item.mobileToken === message.token) : null;
        if (!session) { error(ws, 'SESSION_EXPIRED', 'Please pair again'); return; }
        if (session.mobile?.readyState === WebSocket.OPEN) { error(ws, 'MOBILE_BUSY', 'Phone already connected'); return; }
        ws.role = 'mobile'; ws.session = session; session.mobile = ws;
        send(ws, { type: 'mobile.ready', token: session.mobileToken, hostConnected: session.host?.readyState === WebSocket.OPEN });
        state(session);
        return;
      }

      const session = ws.session;
      if (!session || !sessions.has(session.token)) { error(ws, 'NOT_PAIRED', 'Pair first'); return; }
      if (ws.role === 'host' && message.type === 'host.approve') {
        const pending = session.pending;
        if (!pending || message.id !== pending.id || pending.expiresAt <= now || pending.ws.readyState !== WebSocket.OPEN) {
          error(ws, 'NO_REQUEST', 'Request expired'); return;
        }
        session.pending = null;
        if (message.allow === true) {
          session.mobileToken = randomUUID(); session.mobile = pending.ws;
          pending.ws.role = 'mobile';
          send(pending.ws, { type: 'mobile.ready', token: session.mobileToken, hostConnected: true });
        } else {
          send(pending.ws, { type: 'session.ended', message: 'Computer declined the connection' });
          pending.ws.close(1000, 'Pairing declined');
        }
        state(session); return;
      }
      if (ws.role === 'host' && message.type === 'host.refresh') {
        if (!session.mobileToken && !session.pending) {
          session.code = nextCode(); session.expiresAt = now + CODE_TTL;
        }
        state(session); return;
      }
      if (ws.role === 'host' && message.type === 'host.end') {
        removeSession(session); ws.close(1000, 'Session ended'); return;
      }
      if (ws.role === 'host' && message.type === 'host.feedback') {
        if (typeof message.message === 'string') send(session.mobile, { type: 'host.feedback', message: message.message.slice(0, 200) });
        return;
      }
      if (ws.role === 'mobile' && message.type === 'mobile.leave') {
        session.mobileToken = null; session.mobile = null;
        session.code = nextCode(); session.expiresAt = now + CODE_TTL;
        ws.session = null;
        send(ws, { type: 'session.ended', message: 'Phone disconnected' });
        ws.close(1000, 'Phone disconnected');
        state(session); return;
      }
      if (ws.role === 'mobile' && message.type === 'control') {
        let control;
        if (message.action === 'scroll' && Number.isFinite(message.dx) && Number.isFinite(message.dy)) {
          control = { action: 'scroll', dx: Math.max(-1500, Math.min(1500, message.dx)), dy: Math.max(-1500, Math.min(1500, message.dy)) };
        } else if (message.action === 'zoom' && Number.isFinite(message.factor) && message.factor >= 0.5 && message.factor <= 2) {
          control = { action: 'zoom', factor: message.factor };
        } else if (message.action === 'resetZoom') control = { action: 'resetZoom' };
        if (!control) { error(ws, 'INVALID_CONTROL', 'Invalid control action'); return; }
        if (session.host?.readyState !== WebSocket.OPEN) { error(ws, 'HOST_OFFLINE', 'Computer is reconnecting'); return; }
        send(session.host, { type: 'control', ...control }); return;
      }
      error(ws, 'FORBIDDEN', 'Action is not allowed');
    });
    ws.on('close', () => {
      clients.delete(ws);
      const session = ws.session;
      if (!session || !sessions.has(session.token)) return;
      if (session.host === ws) {
        session.disconnectedAt = Date.now();
        send(session.mobile, { type: 'host.status', connected: false });
      }
      if (session.mobile === ws) { session.mobile = null; state(session); }
      if (session.pending?.ws === ws) { session.pending = null; state(session); }
    });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.disconnectedAt && now - session.disconnectedAt > RECONNECT_TTL) removeSession(session, 'Computer disconnected');
      else if (session.pending && now > session.pending.expiresAt) {
        send(session.pending.ws, { type: 'session.ended', message: 'Pairing request timed out' });
        session.pending.ws.close(1000, 'Pairing timed out');
        session.pending = null; state(session);
      }
    }
    for (const [ip, rate] of attempts) if (now > rate.until) attempts.delete(ip);
    for (const ws of clients) {
      if (!ws.alive || (!ws.role && now - ws.connectedAt > 30_000)) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 15_000);
  sweep.unref();

  return {
    server,
    async close() {
      clearInterval(sweep);
      for (const ws of clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
