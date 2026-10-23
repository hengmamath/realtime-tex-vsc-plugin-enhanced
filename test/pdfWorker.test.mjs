import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'pdf', logLevel: 'silent',
  stdin: { resolveDir: root, contents: `export * from './webview/pdf'; export { twoPagePdf } from './test/pdfFixture';` },
  plugins: [{ name: 'real-pdfjs', setup(build) {
    build.onResolve({ filter: /^pdfjs-dist\// }, () => ({ path: 'pdfjs', namespace: 'host' }));
    build.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents:
      'export const { getDocument, PDFWorker, GlobalWorkerOptions } = globalThis.pdfjs;' }));
  } }],
});

test('PDF cleanup and failed opens preserve other documents on the shared worker', { timeout: 10000 }, async t => {
  const ports = [], documents = [], failedLoads = [];
  // Use the real PDF.js parser and message protocol without a browser worker process.
  class WorkerPort {
    constructor() {
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      ports.push(port1, port2);
      WorkerMessageHandler.initializeFromPort(port2);
    }
    postMessage(...args) { this.port.postMessage(...args); }
    addEventListener(...args) { this.port.addEventListener(...args); }
    removeEventListener(...args) { this.port.removeEventListener(...args); }
  }
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerPort });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let closing;
  t.after(async () => {
    release();
    try {
      await closing;
      await Promise.allSettled(documents.map(doc => doc.destroy()));
      await Promise.allSettled(failedLoads.map(({ task }) => task.destroy()));
    } finally {
      for (const port of ports) port.close();
      pdfjs.GlobalWorkerOptions.workerPort = null;
      if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker);
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });
  let cleanupFails = false;
  const context = { pdfjs: { ...pdfjs, getDocument(options) {
    const task = pdfjs.getDocument(options);
    if (cleanupFails) {
      const destroy = task.destroy.bind(task);
      task.destroy = async () => { await destroy(); throw new Error('synthetic cleanup failure'); };
    }
    task.promise.catch(error => failedLoads.push({ task, error, transport: task._transport }));
    return task;
  } }, Worker: WorkerPort, Uint8Array, Blob,
    URL: { createObjectURL: () => 'blob:synthetic-pdf-worker' },
    fetch: async () => ({ text: async () => '' }) };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  await context.pdf.initPdfWorker('synthetic-worker');
  const bytes = new Uint8Array(Buffer.from(context.pdf.twoPagePdf()));
  const open = async () => {
    const doc = await context.pdf.openPdf(bytes);
    documents.push(doc);
    assert.equal(doc.numPages, 2);
    return doc;
  };
  const first = await open(), existing = await open();
  // Hold real transport cleanup so opening another document overlaps it deterministically.
  const transport = first.loadingTask._transport;
  const destroy = transport.destroy.bind(transport);
  transport.destroy = async () => { await gate; return destroy(); };
  closing = first.destroy();

  const next = await open();
  assert.ok((await (await next.getPage(1)).getOperatorList()).fnArray.length);
  assert.ok((await (await existing.getPage(2)).getOperatorList()).fnArray.length);
  release();
  await closing;
  assert.ok((await (await existing.getPage(1)).getOperatorList()).fnArray.length,
    'an existing document must remain usable after another document finishes cleanup');
  const later = await open();
  assert.ok((await (await later.getPage(2)).getOperatorList()).fnArray.length);
  for (const failCleanup of [false, true]) {
    cleanupFails = failCleanup;
    const invalid = new Uint8Array(Buffer.from('%PDF-1.4\nsynthetic invalid PDF\n%%EOF\n'));
    await assert.rejects(context.pdf.openPdf(invalid), error =>
      error.name === 'InvalidPDFException' && error === failedLoads.at(-1).error,
    'cleanup failures must not replace the original PDF loading error');
    const failed = failedLoads.at(-1);
    assert.equal(failed.task.destroyed, true, 'a rejected load must release its loading task');
    assert.equal(failed.task._transport, null);
    assert.equal(failed.transport.destroyed, true);
    assert.equal(failed.transport.messageHandler, null, 'cleanup must remove the failed document message handler');
    assert.ok((await (await existing.getPage(1)).getOperatorList()).fnArray.length);
    cleanupFails = false;
    const recovered = await open();
    assert.ok((await (await recovered.getPage(2)).getOperatorList()).fnArray.length);
  }
  assert.equal(ports.length, 2, 'all documents must share one worker connection');
  assert.equal(bytes.byteLength, Buffer.byteLength(context.pdf.twoPagePdf()), 'worker transfers must not consume the caller bytes');
});
