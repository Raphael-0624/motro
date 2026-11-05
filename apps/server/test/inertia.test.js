import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollMomentum } from '../../mobile/inertia.js';

function fling() {
  const momentum = new ScrollMomentum();
  momentum.begin(0);
  momentum.sample(0, 40, 20);
  momentum.sample(0, 40, 40);
  assert.equal(momentum.release(45), true);
  return momentum;
}

test('a fast swipe gets a short, decaying, bounded continuation', () => {
  const momentum = fling();
  let total = 0;
  let previous = Infinity;
  for (let time = 61; time <= 701 && momentum.active; time += 16) {
    const { dx, dy } = momentum.step(time);
    assert.equal(dx, 0);
    assert.ok(dy > 0 && dy < previous);
    previous = dy; total += dy;
  }
  assert.ok(total > 80 && total < 150);
  assert.equal(momentum.active, false);
});

test('slow drags and a pause before release produce no momentum', () => {
  const momentum = new ScrollMomentum();
  momentum.begin(0); momentum.sample(0, 3, 30); momentum.sample(0, 3, 60);
  assert.equal(momentum.release(65), false);
  momentum.begin(100); momentum.sample(0, 80, 140);
  assert.equal(momentum.release(230), false);
});

test('cancellation stops immediately and cancels pending velocity samples', () => {
  const momentum = fling();
  momentum.cancel();
  assert.equal(momentum.step(61), null);
  assert.equal(momentum.release(62), false);
});

test('travel is independent of animation frame rate', () => {
  const travel = (interval) => {
    const momentum = fling();
    let total = 0;
    for (let time = 45 + interval; time <= 365; time += interval) total += momentum.step(time).dy;
    return total;
  };
  assert.ok(Math.abs(travel(8) - travel(16)) < 0.001);
});

test('extreme swipes are capped and stalled animation never jumps forward', () => {
  const momentum = new ScrollMomentum();
  momentum.begin(0); momentum.sample(1000, -1000, 20);
  assert.equal(momentum.release(25), true);
  const delta = momentum.step(41);
  assert.ok(delta.dx > 0 && delta.dy < 0);
  assert.ok(Math.hypot(delta.dx, delta.dy) < 30);
  assert.equal(momentum.step(300), null);
  assert.equal(momentum.active, false);
});
