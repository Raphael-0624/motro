import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisitCounter } from '../src/visits.js';

async function location(t) {
  const directory = await mkdtemp(join(tmpdir(), 'motro-visits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'visits.json');
}

test('visit numbers are monotonic under concurrency and survive reopening the store', async (t) => {
  const file = await location(t);
  const counter = new VisitCounter(file);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => counter.increment())), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { count: 20 });
  assert.equal(await new VisitCounter(file).increment(), 21);
});

test('corrupt and invalid counters are not silently reset', async (t) => {
  const file = await location(t);
  for (const value of ['broken-json', '{"count":-1}', '{"count":1.5}', '{"count":"2"}']) {
    await writeFile(file, value);
    await assert.rejects(new VisitCounter(file).increment());
    assert.equal(await readFile(file, 'utf8'), value);
  }
});

test('a failed increment does not consume the next number or poison the queue', async (t) => {
  const file = await location(t);
  await writeFile(file, '{"count":-1}');
  const counter = new VisitCounter(file);
  await assert.rejects(counter.increment());
  await writeFile(file, '{"count":4}');
  assert.equal(await counter.increment(), 5);
});
