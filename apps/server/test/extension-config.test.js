import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
const cloud = 'https://motro.rafa.love';

function background({ local = {}, session = {} } = {}) {
  local = structuredClone(local);
  session = structuredClone(session);
  const connections = [];
  let listener;
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: local[key] }; },
        async remove(key) { delete local[key]; },
      },
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(value) { Object.assign(session, value); },
      },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    alarms: { async create() {}, onAlarm: { addListener() {} } },
    runtime: {
      id: 'a'.repeat(32),
      getURL: (path) => `chrome-extension://${'a'.repeat(32)}/${path}`,
      async sendMessage() {},
      onMessage: { addListener(callback) { listener = callback; } },
    },
  };
  class WebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    constructor(url) { connections.push(url.href); }
    addEventListener() {}
    close() { this.readyState = 3; }
  }
  runInNewContext(source, {
    chrome, WebSocket, URL,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  return {
    local, session, connections,
    request(type) {
      return new Promise((resolve) => listener({ type }, {
        id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html'),
      }, resolve));
    },
  };
}

test('extension starts against the cloud by default without persisting the default', async () => {
  const app = background();
  const initial = await app.request('getState');
  assert.equal(initial.state.serverUrl, cloud);
  assert.equal(initial.state.enabled, false);
  const started = await app.request('start');
  assert.equal(started.state.serverUrl, cloud);
  assert.deepEqual(app.connections, ['wss://motro.rafa.love/ws']);
  assert.deepEqual(app.local, {});
});

test('legacy local address and session are cleared before switching origins', async () => {
  const app = background({
    local: { serverUrl: 'http://localhost:3030' },
    session: { motro: {
      serverUrl: 'http://localhost:3030', enabled: true, token: 'old-local-token',
      paired: true, pending: { id: 'old-request' }, code: '1234',
      mobileUrls: ['http://192.168.1.2:3030'],
    } },
  });
  const { state } = await app.request('getState');
  assert.equal(state.serverUrl, cloud);
  assert.equal(state.enabled, false);
  assert.equal(state.paired, false);
  assert.equal(state.pending, null);
  assert.equal(state.code, '');
  assert.equal(state.mobileUrls.length, 0);
  assert.equal(app.session.motro.token, null);
  assert.deepEqual(app.local, {});
  assert.deepEqual(app.connections, []);
  await app.request('start');
  assert.deepEqual(app.connections, ['wss://motro.rafa.love/ws']);
});

test('an explicit development override works and changing it discards old tokens', async () => {
  const app = background({
    local: { serverUrlOverride: 'http://127.0.0.1:4031' },
    session: { motro: { serverUrl: cloud, enabled: true, token: 'old-cloud-token', paired: true } },
  });
  const { state } = await app.request('getState');
  assert.equal(state.serverUrl, 'http://127.0.0.1:4031');
  assert.equal(app.session.motro.token, null);
  assert.deepEqual(app.connections, []);
  await app.request('start');
  assert.deepEqual(app.connections, ['ws://127.0.0.1:4031/ws']);
});

test('a worker restart on the same server preserves its existing session', async () => {
  const app = background({
    session: { motro: { serverUrl: cloud, enabled: true, token: 'existing-cloud-token', paired: true } },
  });
  const { state } = await app.request('getState');
  assert.equal(state.enabled, true);
  assert.equal(state.paired, true);
  assert.equal(app.session.motro.token, 'existing-cloud-token');
  assert.deepEqual(app.connections, ['wss://motro.rafa.love/ws']);
});
