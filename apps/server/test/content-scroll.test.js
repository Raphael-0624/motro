import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../extension/content.js', import.meta.url), 'utf8');

function node(parentElement = null, { maxX = 0, maxY = 0, minX = 0, ...style } = {}) {
  return {
    parentElement, scrollLeft: 0, scrollTop: 0,
    style: { overflowX: 'auto', overflowY: 'auto', ...style },
    scrollBy({ left, top, behavior }) {
      assert.equal(behavior, 'instant');
      this.scrollLeft = Math.max(minX, Math.min(maxX, this.scrollLeft + left));
      this.scrollTop = Math.max(0, Math.min(maxY, this.scrollTop + top));
    },
  };
}

function fixture() {
  const root = node(null, { maxX: 1000, maxY: 2000 });
  const vertical = node(root, { maxY: 1000 });
  const horizontal = node(vertical, { maxX: 500, overflowY: 'hidden' });
  let listener;
  let listeners = 0;
  const context = {
    document: { scrollingElement: root, elementFromPoint(x, y) { assert.equal(x, 640); assert.equal(y, 360); return horizontal; } },
    innerWidth: 1280, innerHeight: 720, getComputedStyle: (el) => el.style,
    chrome: { runtime: { id: 'motro', onMessage: { addListener(fn) { listener = fn; listeners++; } } } },
  };
  runInNewContext(source, context);
  return {
    root, vertical, horizontal,
    scroll(dx, dy, sender = 'motro') {
      let replied = false;
      listener({ type: 'motro.scroll', dx, dy }, { id: sender }, () => { replied = true; });
      return replied;
    },
    reinstall() { runInNewContext(source, context); return listeners; },
  };
}

test('horizontal then vertical then horizontal resolves separate containers without axis latching', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    assert.equal(f.scroll(100, 0), true);
    f.scroll(0, 100);
    f.scroll(-40, 0);
    f.scroll(0, -30);
  }
  assert.equal(f.horizontal.scrollLeft, 180);
  assert.equal(f.vertical.scrollTop, 210);
  assert.equal(f.root.scrollTop, 0);
});

test('diagonal legacy input resolves each axis independently', () => {
  const f = fixture();
  f.scroll(80, 120);
  assert.equal(f.horizontal.scrollLeft, 80);
  assert.equal(f.vertical.scrollTop, 120);
});

test('fractional input accumulates without per-packet rounding drift', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.scroll(7.5, 2.5);
  assert.equal(f.horizontal.scrollLeft, 150);
  assert.equal(f.vertical.scrollTop, 50);
  for (let i = 0; i < 20; i++) f.scroll(-7.5, -2.5);
  assert.equal(f.horizontal.scrollLeft, 0);
  assert.equal(f.vertical.scrollTop, 0);
});

test('only the unconsumed boundary delta chains to an ancestor', () => {
  const f = fixture();
  f.scroll(600, 1200);
  assert.equal(f.horizontal.scrollLeft, 500);
  assert.equal(f.root.scrollLeft, 100);
  assert.equal(f.vertical.scrollTop, 1000);
  assert.equal(f.root.scrollTop, 200);
});

test('overscroll containment prevents escaping the intended panel', () => {
  const f = fixture();
  f.horizontal.style.overscrollBehaviorX = 'contain';
  f.scroll(600, 0);
  assert.equal(f.horizontal.scrollLeft, 500);
  assert.equal(f.root.scrollLeft, 0);
});

test('RTL negative scroll positions work without left-edge assumptions', () => {
  const f = fixture();
  const rtl = node(f.root, { minX: -500 });
  f.horizontal.parentElement = rtl;
  f.horizontal.style.overflowX = 'hidden';
  f.scroll(-100, 0);
  assert.equal(rtl.scrollLeft, -100);
  assert.equal(f.root.scrollLeft, 0);
});

test('invalid or external messages are ignored and repeated injection is idempotent', () => {
  const f = fixture();
  assert.equal(f.scroll(NaN, 20), false);
  assert.equal(f.scroll(20, 20, 'other'), false);
  assert.equal(f.horizontal.scrollLeft, 0);
  assert.equal(f.vertical.scrollTop, 0);
  assert.equal(f.reinstall(), 1);
});

test('extension uses content scripts without debugger permission or native input', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  const background = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
  assert.equal(manifest.permissions.includes('debugger'), false);
  assert.equal(manifest.permissions.includes('scripting'), true);
  assert.ok(manifest.content_scripts.some((entry) => entry.js.includes('content.js')));
  assert.doesNotMatch(background, /chrome\.debugger|NativeWheel/);
});
