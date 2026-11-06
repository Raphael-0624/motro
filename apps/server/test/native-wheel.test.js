import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWheel } from '../../extension/native-wheel.js';

function fixture() {
  const calls = [];
  let onDetach;
  const api = {
    onDetach: { addListener(listener) { onDetach = listener; } },
    async attach(target) { calls.push(['attach', target.tabId]); },
    async detach(target) { calls.push(['detach', target.tabId]); },
    async sendCommand(target, method, parameters) {
      calls.push([method, target.tabId, parameters]);
      return { result: { value: { x: 640, y: 360 } } };
    },
  };
  return { api, calls, wheel: new NativeWheel(api), detach: (id) => onDetach({ tabId: id }) };
}

test('native wheel dispatches both axes at the current viewport center', async () => {
  const { wheel, calls } = fixture();
  await wheel.scroll(10, 120, -60, () => true);
  assert.equal(calls[0][0], 'attach');
  assert.deepEqual(calls.at(-1), ['Input.dispatchMouseEvent', 10, {
    type: 'mouseWheel', x: 640, y: 360, deltaX: 120, deltaY: -60,
  }]);
  await wheel.scroll(10, -80, 0, () => true);
  assert.equal(calls.filter(([kind]) => kind === 'attach').length, 1);
  await wheel.scroll(20, 0, 50, () => true);
  assert.deepEqual(calls.filter(([kind]) => ['attach', 'detach'].includes(kind)), [
    ['attach', 10], ['detach', 10], ['attach', 20],
  ]);
  await wheel.release();
  assert.deepEqual(calls.at(-1), ['detach', 20]);
});

test('stopping during attach releases the debugger without injecting input', async () => {
  const { wheel, api, calls } = fixture();
  let attached;
  let started;
  const beginning = new Promise((resolve) => { started = resolve; });
  api.attach = () => new Promise((resolve) => { attached = resolve; started(); });
  const scrolling = wheel.scroll(10, 100, 0, () => true);
  await beginning;
  const released = wheel.release();
  attached();
  await Promise.all([scrolling, released]);
  assert.deepEqual(calls, [['detach', 10]]);
});

test('external debugger cancellation does not immediately reattach', async () => {
  const { wheel, calls, detach } = fixture();
  await wheel.scroll(10, 100, 0, () => true);
  detach(10);
  await assert.rejects(wheel.scroll(10, 100, 0, () => true), /调试连接已关闭/);
  assert.equal(calls.filter(([kind]) => kind === 'attach').length, 1);
  await wheel.release();
  await wheel.scroll(10, 100, 0, () => true);
  assert.equal(calls.filter(([kind]) => kind === 'attach').length, 2);
});

test('inactive sessions and failed attach do not inject input', async () => {
  const { wheel, api, calls } = fixture();
  await wheel.scroll(10, 100, 0, () => false);
  assert.deepEqual(calls, []);
  api.attach = async () => { throw new Error('Another debugger is attached'); };
  await assert.rejects(wheel.scroll(10, 100, 0, () => true), /关闭该网页的开发者工具/);
  assert.deepEqual(calls, []);
});
