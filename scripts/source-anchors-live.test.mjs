import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkpointLiveRecords, freshLiveRecords, matchLiveRecord, createEngineClient, timingOrder, stopAllEngines } from './source-anchors-live.mjs';

const dl = (letter = 65) => ({ kind: 'paragraph', unit: 'sp', fonts: {}, lines: [{ x: 0, y: 10, w: 20, h: 8, d: 2, items: [['g', 1, letter, null, 0, 10, 20, 0]] }], other: [], flags: {}, width: 20, height: 8, depth: 2 });
const event = (letter = 65) => ({ event: 'ParagraphUpdate', status: 'ok', dl: dl(letter) });
const record = (req = 1, changes = {}) => ({ version: 2, req, ctx: 7, status: 'ok', lines: 1, rows: [{ x: 0, y: 10, a: [[0, 2, 0, 4, 'g']] }], dl_hex: '41', log: 'live-a.jsonl', ...changes });
const decode = (value) => dl(parseInt(value.dl_hex, 16));
function temporary(t) { const dir = mkdtempSync(path.join(os.tmpdir(), 'rtex-anchor-live-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('checkpoint excludes an old result with identical geometry and glyphs', (t) => {
  const dir = temporary(t), log = path.join(dir, 'live-a.jsonl');
  writeFileSync(log, JSON.stringify(record(1)) + '\n');
  const checkpoint = checkpointLiveRecords(dir);
  appendFileSync(log, JSON.stringify(record(2, { rows: [{ x: 0, y: 10, a: [[0, 2, 0, 90, 'g']] }] })) + '\n');
  const records = freshLiveRecords(dir, checkpoint);
  assert.equal(records.length, 1);
  assert.equal(matchLiveRecord(records, event(), decode).req, 2);
  assert.equal(matchLiveRecord(records, event(), decode).rows[0].a[0][3], 90);
});

test('matching compares complete glyph content, not just the same row geometry', () => {
  const wanted = record(2), other = record(1, { dl_hex: '42' });
  assert.equal(matchLiveRecord([other, wanted], event(), decode).req, 2);
  assert.throws(() => matchLiveRecord([other], event(), decode), /no fresh anchor result matches/);
});

test('ambiguous results, failed compiles, missing payloads and invalid row counts are rejected', () => {
  assert.throws(() => matchLiveRecord([record(1), record(2)], event(), decode), /ambiguous/);
  assert.throws(() => matchLiveRecord([record(1), record(2, { source_lines: 80, rows: [{ x: 0, y: 10, a: [[0, 2, 0, 78, 'g']] }] })], event(), decode), /ambiguous/);
  assert.throws(() => matchLiveRecord([record(1, { status: 'error' })], event(), decode), /not successful/);
  assert.throws(() => matchLiveRecord([record(1, { status: 'ok_degraded' })], event(), decode), /not successful/);
  assert.throws(() => matchLiveRecord([record(1, { dl_hex: undefined })], event(), decode), /binary result/);
  assert.throws(() => matchLiveRecord([record(1, { rows: [] })], event(), decode), /row count/);
  assert.throws(() => matchLiveRecord([record()], { ...event(), status: 'error' }, decode), /not a successful/);
  assert.throws(() => matchLiveRecord([], event(), decode), /no fresh anchor records/);
});

test('server restarts and duplicate request identities cannot silently choose a record', () => {
  assert.throws(() => matchLiveRecord([record(1), record(2, { log: 'live-b.jsonl' })], event(), decode), /multiple servers/);
  assert.throws(() => matchLiveRecord([record(1), record(1, { dl_hex: '42' })], event(), decode), /duplicate/);
});

test('rewritten/truncated prefixes, malformed records and incomplete appends are rejected', (t) => {
  const dir = temporary(t), log = path.join(dir, 'live-a.jsonl');
  writeFileSync(log, '{}\n');
  const checkpoint = checkpointLiveRecords(dir);
  writeFileSync(log, '{"long":1}\n');
  assert.throws(() => freshLiveRecords(dir, checkpoint), /changed before/);
  writeFileSync(log, '{}\n');
  const next = checkpointLiveRecords(dir);
  appendFileSync(log, 'not json\n');
  assert.throws(() => freshLiveRecords(dir, next), /invalid anchor JSON/);
  writeFileSync(log, '{}\n');
  const last = checkpointLiveRecords(dir);
  appendFileSync(log, '{');
  assert.throws(() => freshLiveRecords(dir, last), /incomplete/);
  assert.throws(() => checkpointLiveRecords(dir), /incomplete/);
});

function nodeClient(t, code, options = {}) {
  const client = createEngineClient(process.execPath, ['-e', code], { label: 'fake', requestTimeoutMs: 300, stopTimeoutMs: 100, ...options });
  t.after(() => client.stop());
  return client;
}

test('invalid JSON rejects pending requests and event waits without hanging', async (t) => {
  const client = nodeClient(t, "process.stdin.once('data', () => console.log('not-json')); setInterval(() => {}, 1000);");
  const results = await Promise.allSettled([client.request({ cmd: 'ping' }), client.waitEvent(0, () => false, 'test event', 1000)]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /invalid JSON/); }
});

test('an early process exit rejects both requests and event waits', async (t) => {
  const client = nodeClient(t, "process.stdin.once('data', () => process.exit(4));");
  const results = await Promise.allSettled([client.request({ cmd: 'ping' }), client.waitEvent(0, () => false, 'test event', 1000)]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /exited before completion/); }
});

test('silent requests have a deadline and concurrent requests are rejected', async (t) => {
  const client = nodeClient(t, 'process.stdin.resume(); setInterval(() => {}, 1000);', { requestTimeoutMs: 60 });
  const pending = client.request({ cmd: 'ping' });
  await assert.rejects(client.request({ cmd: 'other' }), /concurrent requests/);
  await assert.rejects(pending, /timed out waiting for ping reply/);
});

test('start errors and structurally invalid protocol messages reject cleanly', async (t) => {
  const missing = createEngineClient('/does/not/exist/rtex', [], { label: 'missing', requestTimeoutMs: 500, stopTimeoutMs: 10 });
  t.after(() => missing.stop());
  await assert.rejects(missing.request({ cmd: 'ping' }), /could not start/);
  const invalid = nodeClient(t, "process.stdin.once('data', () => console.log('[]')); setInterval(() => {}, 1000);");
  await assert.rejects(invalid.request({ cmd: 'ping' }), /invalid protocol message/);
});

test('clean replies/events and repeated shutdown are supported', async (t) => {
  const client = nodeClient(t, `const rl = require('node:readline').createInterface({ input: process.stdin }); rl.on('line', (line) => { const cmd = JSON.parse(line); if (cmd.cmd === 'quit') { process.exit(0); return; } console.log(JSON.stringify({ event: 'ready', value: 3 })); console.log(JSON.stringify({ reply: cmd.cmd })); });`);
  assert.equal((await client.request({ cmd: 'ping' })).reply, 'ping');
  assert.equal((await client.waitEvent(0, (message) => message.event === 'ready', 'ready')).value, 3);
  await client.stop(); await client.stop();
  await assert.rejects(client.request({ cmd: 'ping' }), /closed/);
});

test('benchmark alternates which mode runs first', () => {
  assert.deepEqual(timingOrder(0), ['off', 'on']);
  assert.deepEqual(timingOrder(1), ['on', 'off']);
  assert.deepEqual(timingOrder(2), ['off', 'on']);
});

test('shutdown also terminates a child process left by the engine', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const dir = temporary(t), marker = path.join(dir, 'child-stopped');
  const code = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'child-ready'))}, 'ready'); process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.exit(0); }); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' }); console.log(JSON.stringify({ event: 'child', pid: child.pid })); process.stdin.resume(); setInterval(() => {}, 1000);`;
  const client = nodeClient(t, code, { stopTimeoutMs: 30 });
  await client.waitEvent(0, (message) => message.event === 'child', 'child started', 1000);
  const { existsSync } = await import('node:fs');
  for (let count = 0; count < 50 && !existsSync(path.join(dir, 'child-ready')); count++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(path.join(dir, 'child-ready')), true);
  await client.stop();
  for (let count = 0; count < 50 && !existsSync(marker); count++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(marker), true);
});

test('shutdown escalates for an orphan descendant that ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const dir = temporary(t), ready = path.join(dir, 'child-ready');
  const grandchild = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const code = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); console.log(JSON.stringify({ event: 'child', pid: child.pid })); process.stdin.once('data', () => process.exit(0));`;
  const client = nodeClient(t, code, { stopTimeoutMs: 100 });
  const event = await client.waitEvent(0, (message) => message.event === 'child', 'child started', 1000);
  const { existsSync } = await import('node:fs');
  for (let count = 0; count < 50 && !existsSync(ready); count++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(ready), true);
  await client.stop();
  let gone = false;
  for (let count = 0; count < 50; count++) {
    try { process.kill(event.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(gone, true, 'SIGTERM-ignoring orphan must be terminated after its parent exits');
});

test('stopAllEngines reports a denied cleanup and still cleans the other engine', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const dir = temporary(t), marker = path.join(dir, 'other-engine-stopped');
  const bad = createEngineClient(process.execPath, ['-e', "console.log(JSON.stringify({event:'ready'})); process.stdin.resume(); setInterval(() => {}, 1000);"], { label: 'denied', stopTimeoutMs: 20 });
  const good = createEngineClient(process.execPath, ['-e', `console.log(JSON.stringify({event:'ready'})); process.stdin.once('data', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.exit(0); });`], { label: 'other', stopTimeoutMs: 100 });
  const originalKill = process.kill;
  try {
    await Promise.all([bad.waitEvent(0, (e) => e.event === 'ready', 'ready', 1000), good.waitEvent(0, (e) => e.event === 'ready', 'ready', 1000)]);
    process.kill = function(pid, signal) {
      if (pid === -bad.pid) throw Object.assign(new Error('controlled cleanup denial'), { code: 'EPERM' });
      return originalKill.call(process, pid, signal);
    };
    await assert.rejects(stopAllEngines(), (error) => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === 'EPERM');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(marker), true, 'other engine must be cleaned despite the first cleanup failing');
  } finally {
    process.kill = originalKill;
    // The mock only denied our own test group's cleanup. Always restore the real syscall and
    // terminate it before leaving the test, so the negative case cannot leak a process.
    for (const client of [bad, good]) {
      try { originalKill.call(process, client.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});
