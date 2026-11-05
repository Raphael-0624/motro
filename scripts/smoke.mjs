import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run smoke -- https://your-motro-domain');
const base = new URL(input);
if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.username || base.password || base.search || base.hash) {
  throw new Error('Use an HTTP/HTTPS origin without credentials or a path.');
}
const extensionId = process.env.MOTRO_EXTENSION_ID;
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  throw new Error('Set MOTRO_EXTENSION_ID to a valid extension ID to test the Origin allowlist.');
}
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const sockets = [];
async function json(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, `${path} failed`);
  return response.json();
}

async function peer(host = false) {
  const endpoint = new URL('/ws', base);
  endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(endpoint, { origin: host ? `chrome-extension://${extensionId}` : base.origin });
  sockets.push(ws);
  const queue = [];
  const waiting = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiting.findIndex((item) => item.type === message.type || message.type === 'error');
    if (index < 0) queue.push(message);
    else { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(message); }
  });
  await once(ws, 'open', { signal: AbortSignal.timeout(8000) });
  return {
    send(message) { ws.send(JSON.stringify(message)); },
    async next(type) {
      const index = queue.findIndex((item) => item.type === type || item.type === 'error');
      const message = index >= 0 ? queue.splice(index, 1)[0] : await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), 8000);
        timer.unref(); waiting.push({ type, resolve, timer });
      });
      if (message.type === 'error') throw new Error(`Server rejected smoke: ${message.code}`);
      return message;
    },
  };
}

try {
  const health = await json('/api/health');
  assert.equal(health.ok, true); assert.equal(health.version, version);
  const versions = await json('/api/version');
  assert.ok(Object.values(versions).every((item) => item === version));
  const page = await fetch(base, { signal: AbortSignal.timeout(8000) });
  assert.equal(page.status, 200); assert.match(await page.text(), /id="pair-form"/);
  const first = await json('/api/visits', { method: 'POST', headers: { Origin: base.origin } });
  const second = await json('/api/visits', { method: 'POST', headers: { Origin: base.origin } });
  assert.equal(second.count, first.count + 1);
  const host = await peer(true);
  host.send({ type: 'host.open' });
  const session = await host.next('host.state');
  const phone = await peer();
  phone.send({ type: 'mobile.join', code: session.code });
  await phone.next('mobile.pending');
  const pending = await host.next('host.state');
  host.send({ type: 'host.approve', id: pending.pending.id, allow: true });
  await phone.next('mobile.ready');
  phone.send({ type: 'control', action: 'scroll', dx: 0, dy: 40 });
  assert.equal((await host.next('control')).dy, 40);
  host.send({ type: 'host.end' });
  await phone.next('session.ended');
  console.log(`Motro v${version}: HTTP, versions, durable visit increments and WebSocket pairing/relay passed.`);
} finally {
  for (const ws of sockets) ws.terminate();
}
