import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createMotroServer } from '../src/server.js';
import { versions } from '../src/version.js';

async function fixture(t, options = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'motro-server-'));
  const app = createMotroServer({ mobileUrls: ['http://192.168.1.2:3030'], dataDirectory, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    async client(wsOptions) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', wsOptions);
      const queue = [];
      const waiting = [];
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const index = waiting.findIndex((item) => item.type === message.type);
        if (index < 0) queue.push(message);
        else { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(message); }
      });
      await once(ws, 'open');
      return {
        ws,
        send(message) { ws.send(JSON.stringify(message)); },
        next(type) {
          const index = queue.findIndex((item) => item.type === type);
          if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
          return new Promise((resolve, reject) => {
            const item = { type, resolve, timer: null };
            item.timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error(`Timed out waiting for ${type}; queued: ${JSON.stringify(queue)}`)); }, 2000);
            waiting.push(item);
          });
        },
        async close() { const closed = once(ws, 'close'); ws.close(); await closed; },
      };
    },
  };
}

async function pair(f) {
  const host = await f.client();
  host.send({ type: 'host.open' });
  const initial = await host.next('host.state');
  const phone = await f.client({ origin: f.base });
  phone.send({ type: 'mobile.join', code: initial.code });
  await phone.next('mobile.pending');
  const pending = await host.next('host.state');
  host.send({ type: 'host.approve', id: pending.pending.id, allow: true });
  const ready = await phone.next('mobile.ready');
  await host.next('host.state');
  return { host, phone, initial, ready };
}

test('serves the mobile app and health endpoint without exposing project files', async (t) => {
  const { base } = await fixture(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="trackpad"/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const file of ['/app.js', '/styles.css', '/inertia.js']) assert.equal((await fetch(base + file)).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true, name: 'motro', version: versions.server });
  assert.deepEqual(await (await fetch(base + '/api/version')).json(), versions);
  assert.equal((await fetch(base + '/package.json')).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('counts explicit page visits once per POST and blocks cross-site increments', async (t) => {
  const { base } = await fixture(t);
  const visit = () => fetch(base + '/api/visits', { method: 'POST', headers: { Origin: base } }).then((response) => response.json());
  assert.deepEqual(await visit(), { count: 1, version: versions.mobile });
  await fetch(base); await fetch(base + '/styles.css'); await fetch(base + '/api/health');
  assert.equal((await fetch(base + '/api/visits')).status, 405);
  assert.equal((await fetch(base + '/api/visits', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  const counts = await Promise.all(Array.from({ length: 10 }, visit));
  assert.deepEqual(counts.map((item) => item.count).sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i + 2));
});

test('serves the phone favicon and home-screen icon as PNGs at the expected sizes', async (t) => {
  const { base } = await fixture(t);
  for (const [file, size] of [
    ['/assets/icon-32.png', 32], ['/assets/icon-128.png', 128], ['/assets/apple-touch-icon.png', 180],
  ]) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('extension manifest registers packaged icons for both management and toolbar', async () => {
  const root = new URL('../../extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(new URL(manifest.icons[size], root));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('requires host approval and relays scroll, zoom, reset and feedback', async (t) => {
  const f = await fixture(t);
  const { host, phone, initial } = await pair(f);
  assert.match(initial.code, /^\d{4}$/);
  for (const control of [
    { action: 'scroll', dx: 12, dy: 80 },
    { action: 'zoom', factor: 1.1 },
    { action: 'resetZoom' },
  ]) {
    phone.send({ type: 'control', ...control });
    assert.deepEqual(await host.next('control'), { type: 'control', ...control });
  }
  host.send({ type: 'host.feedback', message: 'Protected page' });
  assert.equal((await phone.next('host.feedback')).message, 'Protected page');
});

test('pending phones cannot control and hosts can reject pairing', async (t) => {
  const f = await fixture(t);
  const host = await f.client(); host.send({ type: 'host.open' });
  const { code } = await host.next('host.state');
  const phone = await f.client(); phone.send({ type: 'mobile.join', code });
  await phone.next('mobile.pending');
  phone.send({ type: 'control', action: 'resetZoom' });
  assert.equal((await phone.next('error')).code, 'FORBIDDEN');
  const pending = await host.next('host.state');
  host.send({ type: 'host.approve', id: pending.pending.id, allow: false });
  assert.equal((await phone.next('session.ended')).message, 'Computer declined the connection');
  const state = await host.next('host.state');
  assert.equal(state.paired, false); assert.equal(state.pending, null);
});

test('validates messages, rejects role forgery, and clamps scroll distance', async (t) => {
  const f = await fixture(t);
  const { host, phone } = await pair(f);
  phone.send({ type: 'host.end' });
  assert.equal((await phone.next('error')).code, 'FORBIDDEN');
  phone.send({ type: 'control', action: 'zoom', factor: 100 });
  assert.equal((await phone.next('error')).code, 'INVALID_CONTROL');
  phone.send({ type: 'control', action: 'scroll', dx: 10000, dy: -10000 });
  assert.deepEqual(await host.next('control'), { type: 'control', action: 'scroll', dx: 1500, dy: -1500 });
  phone.ws.send('not-json');
  assert.equal((await phone.next('error')).code, 'INVALID_MESSAGE');
  const other = await f.client({ origin: f.base });
  other.send({ type: 'host.open' });
  assert.equal((await other.next('error')).code, 'FORBIDDEN');
  other.send({ type: 'mobile.join', code: { toString: null, valueOf: null } });
  assert.equal((await other.next('error')).code, 'INVALID_CODE');
});

test('limits code guessing to five attempts per minute per network address', async (t) => {
  const f = await fixture(t);
  const phone = await f.client();
  for (let i = 0; i < 6; i++) {
    phone.send({ type: 'mobile.join', code: '0000' });
    assert.equal((await phone.next('error')).code, i < 5 ? 'INVALID_CODE' : 'RATE_LIMITED');
  }
});

test('resumes both peers with independent tokens and invalidates tokens on session end', async (t) => {
  const f = await fixture(t);
  const { host, phone, initial, ready } = await pair(f);
  assert.notEqual(initial.token, ready.token);
  await host.close();
  assert.equal((await phone.next('host.status')).connected, false);
  const newHost = await f.client();
  newHost.send({ type: 'host.open', token: initial.token });
  assert.equal((await newHost.next('host.state')).paired, true);
  assert.equal((await phone.next('host.status')).connected, true);
  await phone.close();
  await newHost.next('host.state');
  const newPhone = await f.client();
  newPhone.send({ type: 'mobile.resume', token: ready.token });
  assert.equal((await newPhone.next('mobile.ready')).token, ready.token);
  newHost.send({ type: 'host.end' });
  await newPhone.next('session.ended');
  const stranger = await f.client();
  stranger.send({ type: 'mobile.resume', token: ready.token });
  assert.equal((await stranger.next('error')).code, 'SESSION_EXPIRED');
});

test('a paired code cannot be reused; a phone can leave and revoke its token', async (t) => {
  const f = await fixture(t);
  const { host, phone, initial, ready } = await pair(f);
  const stranger = await f.client();
  stranger.send({ type: 'mobile.join', code: initial.code });
  assert.equal((await stranger.next('error')).code, 'INVALID_CODE');
  phone.send({ type: 'mobile.leave' });
  await phone.next('session.ended');
  const state = await host.next('host.state');
  assert.equal(state.paired, false);
  assert.notEqual(state.code, initial.code);
  stranger.send({ type: 'mobile.resume', token: ready.token });
  assert.equal((await stranger.next('error')).code, 'SESSION_EXPIRED');
});

test('rejects cross-site WebSocket requests and unexpected Host headers', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { origin: 'https://evil.example' },
    { headers: { Host: 'evil.example' } },
  ]) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', options);
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  }
});

test('can restrict browser extension origins to an explicit allowlist', async (t) => {
  const allowed = 'a'.repeat(32);
  const f = await fixture(t, { extensionIds: [allowed] });
  const host = await f.client({ origin: `chrome-extension://${allowed}` });
  host.send({ type: 'host.open' });
  assert.match((await host.next('host.state')).code, /^\d{4}$/);
  const rejected = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { origin: `chrome-extension://${'b'.repeat(32)}` });
  const [error] = await once(rejected, 'error');
  assert.match(error.message, /403/);
});

for (const extensionIds of [undefined, []]) {
  test(`accepts different extension IDs without a whitelist (${extensionIds ? 'empty' : 'unset'})`, async (t) => {
    const f = await fixture(t, { extensionIds });
    const computers = [];
    for (const letter of ['a', 'b']) {
      const host = await f.client({ origin: `chrome-extension://${letter.repeat(32)}` });
      host.send({ type: 'host.open' });
      const initial = await host.next('host.state');
      const phone = await f.client({ origin: f.base });
      phone.send({ type: 'mobile.join', code: initial.code });
      await phone.next('mobile.pending');
      phone.send({ type: 'control', action: 'resetZoom' });
      assert.equal((await phone.next('error')).code, 'FORBIDDEN');
      const pending = await host.next('host.state');
      host.send({ type: 'host.approve', id: pending.pending.id, allow: true });
      await phone.next('mobile.ready');
      await host.next('host.state');
      computers.push({ host, phone, initial });
    }
    assert.notEqual(computers[0].initial.code, computers[1].initial.code);
    assert.notEqual(computers[0].initial.token, computers[1].initial.token);
    for (const [index, { host, phone }] of computers.entries()) {
      phone.send({ type: 'control', action: 'scroll', dx: 0, dy: 40 + index });
      assert.equal((await host.next('control')).dy, 40 + index);
    }
  });
}

test('deployment smoke runs without supplying an extension ID', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../../../scripts/smoke.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, f.base], {
    env: { ...process.env, MOTRO_EXTENSION_ID: '' }, timeout: 15_000,
  });
  assert.match(stdout, /WebSocket pairing\/relay passed/);
});
