import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedRasterCache } from '../webview/rasterCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('simultaneous paints share one pending background and preserve its surface identity', async () => {
  const cache = new BoundedRasterCache<object>(100, 4);
  const work = deferred<object>();
  const surface = { width: 4, height: 4 };
  let creations = 0;
  const first = cache.getOrCreate('page-1', 64, () => { creations++; return work.promise; });
  const second = cache.getOrCreate('page-1', 64, async () => { throw new Error('duplicate factory'); });
  assert.equal(first, second);
  assert.equal(cache.get('page-1'), first);
  assert.deepEqual([cache.size, cache.bytes], [1, 64]);
  await Promise.resolve();
  assert.equal(creations, 1);
  work.resolve(surface);
  assert.equal(await first, surface);
  assert.equal(await cache.get('page-1'), surface);
});

test('least recently used backgrounds are evicted to respect the byte budget', async () => {
  const cache = new BoundedRasterCache<string>(100, 4);
  await cache.getOrCreate('a', 40, async () => 'a');
  await cache.getOrCreate('b', 40, async () => 'b');
  cache.get('a');
  await cache.getOrCreate('c', 40, async () => 'c');
  assert.equal(cache.get('b'), undefined);
  assert.equal(await cache.get('a'), 'a');
  assert.equal(await cache.get('c'), 'c');
  assert.deepEqual([cache.size, cache.bytes], [2, 80]);
});

test('entry count is bounded separately from pixel bytes, including pending renders', async () => {
  const cache = new BoundedRasterCache<string>(1000, 2);
  const work = deferred<string>();
  const pending = cache.getOrCreate('a', 10, () => work.promise);
  await cache.getOrCreate('b', 10, async () => 'b');
  await cache.getOrCreate('c', 10, async () => 'c');
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual([cache.size, cache.bytes], [2, 20]);
  work.resolve('a');
  assert.equal(await pending, 'a');
  assert.equal(cache.get('a'), undefined, 'completion must not reinsert evicted work');
});

test('oversized backgrounds render without evicting or retaining other cache entries', async () => {
  const cache = new BoundedRasterCache<object>(100, 2);
  const small = {};
  await cache.getOrCreate('small', 64, async () => small);
  let creations = 0;
  const large = {};
  assert.equal(await cache.getOrCreate('large', 101, async () => { creations++; return large; }), large);
  assert.equal(cache.get('large'), undefined);
  assert.equal(await cache.get('small'), small);
  await cache.getOrCreate('large', 101, async () => { creations++; return large; });
  assert.equal(creations, 2);
  assert.deepEqual([cache.size, cache.bytes], [1, 64]);
});

test('failed backgrounds are removed so a later paint can retry', async () => {
  const cache = new BoundedRasterCache<string>(100, 4);
  const work = deferred<string>();
  const first = cache.getOrCreate('page', 20, () => work.promise);
  const rejection = assert.rejects(first, /render failed/);
  work.reject(new Error('render failed'));
  await rejection;
  assert.equal(cache.get('page'), undefined);
  assert.deepEqual([cache.size, cache.bytes], [0, 0]);
  assert.equal(await cache.getOrCreate('page', 20, async () => 'recovered'), 'recovered');
});

test('a synchronous factory error also releases its reserved cache budget', async () => {
  const cache = new BoundedRasterCache<string>(100, 4);
  const first = cache.getOrCreate('page', 20, () => { throw new Error('context unavailable'); });
  await assert.rejects(first, /context unavailable/);
  assert.deepEqual([cache.size, cache.bytes], [0, 0]);
});

test('clear invalidates pending work without resurrecting it when it resolves', async () => {
  const cache = new BoundedRasterCache<string>(100, 4);
  const work = deferred<string>();
  const old = cache.getOrCreate('page', 20, () => work.promise);
  cache.clear();
  assert.deepEqual([cache.size, cache.bytes], [0, 0]);
  work.resolve('old');
  assert.equal(await old, 'old');
  assert.equal(cache.get('page'), undefined);
});

test('a stale rejection after clear cannot delete a newer background under the same key', async () => {
  const cache = new BoundedRasterCache<string>(100, 4);
  const work = deferred<string>();
  const old = cache.getOrCreate('page', 20, () => work.promise);
  const rejection = assert.rejects(old, /old render cancelled/);
  cache.clear();
  const fresh = cache.getOrCreate('page', 30, async () => 'fresh');
  assert.equal(await fresh, 'fresh');
  work.reject(new Error('old render cancelled'));
  await rejection;
  assert.equal(cache.get('page'), fresh);
  assert.deepEqual([cache.size, cache.bytes], [1, 30]);
});

test('eviction and clear never resize a surface still used by another paint', async () => {
  const cache = new BoundedRasterCache<{ width: number; height: number }>(100, 1);
  const borrowed = await cache.getOrCreate('page-1', 64, async () => ({ width: 4, height: 4 }));
  const next = await cache.getOrCreate('page-2', 64, async () => ({ width: 4, height: 4 }));
  assert.deepEqual(borrowed, { width: 4, height: 4 });
  cache.clear();
  assert.deepEqual(borrowed, { width: 4, height: 4 });
  assert.deepEqual(next, { width: 4, height: 4 });
});

test('invalid byte estimates cannot bypass the cache budget', () => {
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new BoundedRasterCache(value, 4), RangeError);
    assert.throws(() => new BoundedRasterCache(100, value), RangeError);
    assert.throws(() => new BoundedRasterCache(100, 4).getOrCreate('page', value, async () => ({})), RangeError);
  }
});
