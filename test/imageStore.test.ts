/// <reference lib="dom" />
/// <reference path="../webview/opentype.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList } from '../src/protocol';
import { FontStore, IDENTITY, ImageStore, Painter, inexactReason } from '../webview/render';

function deferred() {
  let resolve!: (image: CanvasImageSource) => void, reject!: (error: Error) => void;
  const promise = new Promise<CanvasImageSource>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const bitmap = (id: string) => ({ id } as unknown as CanvasImageSource);
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const pdf = (data = new Uint8Array([1])) => ({ kind: 'pdf' as const, mime: 'application/pdf', data });

function display(pages: number[]): DisplayList {
  return { kind: 'page', fonts: {}, lines: [], flags: [], width: 100, height: 100, depth: 0,
    other: pages.map((_, i) => ['i', i + 1, i * 10, 0, 10, 10]),
    images_info: Object.fromEntries(pages.map((page, i) => [String(i + 1), { file: 'multi.pdf', page }])) };
}

function controlled() {
  const calls: ({ data: Uint8Array; page: number } & ReturnType<typeof deferred>)[] = [];
  const images = new ImageStore((data, page) => {
    const pending = deferred(); calls.push({ data, page, ...pending }); return pending.promise;
  });
  return { images, calls };
}

test('Painter and exactness checks select distinct PDF pages while repeated pages share one decode', async () => {
  const { images, calls } = controlled(), data = new Uint8Array([1, 2]);
  images.add('multi.pdf', pdf(data));
  const dl = display([1, 2, 2]), drawn: CanvasImageSource[] = [], fonts = new FontStore();
  const ctx = { setTransform() {}, fillRect() {}, drawImage(image: CanvasImageSource) { drawn.push(image); } };
  const painter = new Painter(ctx as unknown as CanvasRenderingContext2D, IDENTITY, fonts, images);
  assert.equal(inexactReason(dl, fonts, images), 'images are loading');
  painter.draw(dl, dl.other);
  assert.deepEqual(calls.map(call => call.page), [1, 2]);
  assert.ok(calls.every(call => call.data === data), 'all pages reuse the same file bytes');
  const first = bitmap('page one'), second = bitmap('page two');
  calls[0].resolve(first); await settle();
  assert.equal(inexactReason(dl, fonts, images), 'images are loading', 'page one cannot satisfy pending page two');
  calls[1].resolve(second); await settle();
  painter.draw(dl, dl.other);
  assert.deepEqual(drawn, [first, second, second]);
  assert.equal(inexactReason(dl, fonts, images), undefined);
});

test('PDF pages load on demand, including the default first page, and pending lookups are shared', async () => {
  const { images, calls } = controlled();
  images.add('multi.pdf', pdf());
  assert.equal(calls.length, 0, 'an inclusion of page two must not decode page one first');
  const pending = images.get('multi.pdf', 2);
  assert.equal(pending?.kind, 'pending');
  assert.equal(images.get('multi.pdf', 2), pending);
  assert.deepEqual(calls.map(call => call.page), [2]);
  calls[0].resolve(bitmap('two')); await settle();
  assert.equal(images.get('multi.pdf', 2)?.kind, 'bitmap');
  assert.equal(images.get('multi.pdf')?.kind, 'pending');
  assert.deepEqual(calls.map(call => call.page), [2, 1]);
});

test('replacing a file invalidates every page and ignores its stale decode', async () => {
  const { images, calls } = controlled();
  let loaded = 0; images.onLoaded = () => { loaded++; };
  images.add('multi.pdf', pdf());
  images.get('multi.pdf', 1); images.get('multi.pdf', 2);
  calls[0].resolve(bitmap('old one')); await settle();
  assert.equal(loaded, 1);
  const nextData = new Uint8Array([2]);
  images.add('multi.pdf', pdf(nextData));
  assert.equal(images.get('multi.pdf', 1)?.kind, 'pending');
  assert.equal(images.get('multi.pdf', 2)?.kind, 'pending');
  assert.deepEqual(calls.map(call => call.page), [1, 2, 1, 2]);
  assert.ok(calls.slice(2).every(call => call.data === nextData));
  calls[1].resolve(bitmap('stale two')); await settle();
  assert.equal(loaded, 1);
  assert.equal(images.get('multi.pdf', 2)?.kind, 'pending');
  const first = bitmap('new one'), second = bitmap('new two');
  calls[2].resolve(first); calls[3].resolve(second); await settle();
  assert.deepEqual(images.get('multi.pdf', 1), { kind: 'bitmap', image: first });
  assert.deepEqual(images.get('multi.pdf', 2), { kind: 'bitmap', image: second });
  assert.equal(loaded, 3);
});

test('reset drops all pages and suppresses late successful or failed decodes', async () => {
  const { images, calls } = controlled();
  let loaded = 0; images.onLoaded = () => { loaded++; };
  images.add('multi.pdf', pdf());
  images.get('multi.pdf', 1); images.get('multi.pdf', 2);
  images.clear();
  calls[0].resolve(bitmap('stale one')); calls[1].reject(new Error('stale two')); await settle();
  assert.equal(images.get('multi.pdf', 1), undefined);
  assert.equal(images.get('multi.pdf', 2), undefined);
  assert.equal(loaded, 0);
});

test('a failed PDF page remains separate from loaded pages and is reported by exactness checks', async () => {
  const { images, calls } = controlled();
  images.add('multi.pdf', pdf());
  images.get('multi.pdf', 1); images.get('multi.pdf', 2);
  calls[0].resolve(bitmap('one')); calls[1].reject(new Error('synthetic page two error')); await settle();
  assert.equal(images.get('multi.pdf', 1)?.kind, 'bitmap');
  assert.match(inexactReason(display([2]), new FontStore(), images)!, /synthetic page two error/);
  assert.equal(calls.length, 2, 'failed page lookups share the recorded failure');
  images.add('multi.pdf', { kind: 'missing', reason: 'file missing' });
  assert.deepEqual(images.get('multi.pdf', 2), { kind: 'missing', reason: 'file missing' });
});

test('bitmap images retain eager decoding and share their image across page metadata', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const image = bitmap('png'); let decodes = 0;
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { decodes++; return image; } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });
  const { images } = controlled();
  images.add('figure.png', { kind: 'bitmap', mime: 'image/png', data: new Uint8Array([1]) });
  assert.equal(decodes, 1);
  await settle();
  assert.deepEqual(images.get('figure.png'), { kind: 'bitmap', image });
  assert.equal(images.get('figure.png', 2), images.get('figure.png'));
  assert.equal(decodes, 1);
});
