// Experimental source-anchor transport checks. This is deliberately independent of the UI:
// an uncertain result is rejected instead of guessing which compile produced the anchors.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import path from 'node:path';

const active = new Set();
export async function stopAllEngines() {
  const results = await Promise.allSettled([...active].map((engine) => engine.stop()));
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Could not clean up all experiment engines');
}

/** JSON-lines client with bounded requests and teardown of the engine's TeX descendants. */
export function createEngineClient(command, args, { label = 'engine', cwd, env, requestTimeoutMs = 30000, stopTimeoutMs = 2000 } = {}) {
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, { cwd, env, detached, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [], stderr = [], listeners = new Set();
  let pending, failure, closed = false, stopping = false, stopPromise;
  let didClose;
  const closePromise = new Promise((resolve) => { didClose = resolve; });
  const detail = (what) => new Error(`${label}: ${what}${stderr.length ? `\n${stderr.join('\n')}` : ''}`);
  function kill(signal) {
    if (detached && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!closed) child.kill(signal);
  }
  function groupAlive() {
    if (!detached || !child.pid) return !closed;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      // EPERM is not evidence that a group has exited. Surface the cleanup failure.
      throw error;
    }
  }
  function fail(error) {
    if (failure) return;
    failure = error;
    try { kill('SIGTERM'); }
    catch (signalError) { failure = new AggregateError([error, signalError], `${label}: engine failure and termination failure`); }
    if (pending) { clearTimeout(pending.timer); pending.reject(failure); pending = undefined; }
    for (const listener of [...listeners]) listener();
  }
  createInterface({ input: child.stderr }).on('line', (line) => { stderr.push(line); if (stderr.length > 40) stderr.shift(); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (failure) return;
    let message;
    try { message = JSON.parse(line); } catch { fail(detail('invalid JSON on stdout')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(detail('invalid protocol message')); return; }
    if (typeof message.event === 'string') {
      events.push(message);
      for (const listener of [...listeners]) listener();
    } else if (typeof message.reply === 'string' && pending) {
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message);
    } else if (!(stopping && message.reply === 'quit')) fail(detail('unexpected protocol reply'));
  });
  child.on('error', (error) => fail(detail(`could not start: ${error.message}`)));
  child.stdin.on('error', (error) => { if (!stopping) fail(detail(`stdin failed: ${error.message}`)); });
  child.once('close', (code, signal) => {
    closed = true; didClose();
    if (!stopping) fail(detail(`exited before completion (${signal ?? code})`));
  });
  function request(command) {
    if (failure || closed || stopping) return Promise.reject(failure ?? detail('engine is closed'));
    if (pending) return Promise.reject(detail('concurrent requests are not supported'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(detail(`timed out waiting for ${command.cmd} reply`)), requestTimeoutMs);
      pending = { resolve, reject, timer };
      child.stdin.write(JSON.stringify(command) + '\n');
    });
  }
  function waitEvent(after, predicate, what, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); listeners.delete(check); };
      const check = () => {
        if (failure || closed || stopping) { cleanup(); reject(failure ?? detail(`closed while waiting for ${what}`)); return; }
        let event;
        try { event = events.slice(after).find(predicate); } catch (error) { cleanup(); reject(error); return; }
        if (event) { cleanup(); resolve(event); }
      };
      listeners.add(check);
      timer = setTimeout(() => { const error = detail(`timed out waiting for ${what}`); fail(error); }, timeoutMs);
      check();
    });
  }
  async function waitClosed(timeoutMs) {
    let timer;
    try { await Promise.race([closePromise, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      if (pending) { clearTimeout(pending.timer); pending.reject(detail('stopped while waiting for a reply')); pending = undefined; }
      for (const listener of [...listeners]) listener();
      if (!closed && !failure && child.stdin.writable) child.stdin.end('{"cmd":"quit"}\n');
      if (!closed) await waitClosed(stopTimeoutMs);
      // Kill the whole process group even when its parent already exited: a crashed host can
      // otherwise leave a persistent LuaTeX child behind.
      kill('SIGTERM');
      // The leader may close before its descendants. Always give the group a bounded grace
      // period, then inspect the group itself rather than using the leader's exit as evidence.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (groupAlive()) kill('SIGKILL');
      if (!closed) await waitClosed(1000);
      if (!closed) throw detail('engine did not close after forced shutdown');
      active.delete(client);
    })();
    return stopPromise;
  }
  const client = { events, request, waitEvent, stop, pid: child.pid };
  active.add(client);
  return client;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const logNames = (directory) => readdirSync(directory).filter((name) => /^live-.*\.jsonl$/.test(name)).sort();

/** Capture file identity and exact prefix, before issuing one serialized edit. */
export function checkpointLiveRecords(directory) {
  return new Map(logNames(directory).map((name) => {
    const file = path.join(directory, name), bytes = readFileSync(file), stat = statSync(file);
    if (bytes.length && bytes.at(-1) !== 10) throw new Error(`incomplete anchor log at checkpoint: ${name}`);
    return [name, { size: bytes.length, prefix: digest(bytes), ino: stat.ino, dev: stat.dev }];
  }));
}

export function freshLiveRecords(directory, checkpoint) {
  const records = [];
  const names = logNames(directory);
  for (const name of checkpoint.keys()) if (!names.includes(name)) throw new Error(`anchor log disappeared: ${name}`);
  for (const name of names) {
    const file = path.join(directory, name), bytes = readFileSync(file), stat = statSync(file), before = checkpoint.get(name);
    if (before && (stat.ino !== before.ino || stat.dev !== before.dev || bytes.length < before.size || digest(bytes.subarray(0, before.size)) !== before.prefix)) {
      throw new Error(`anchor log changed before its checkpoint: ${name}`);
    }
    const suffix = bytes.subarray(before?.size ?? 0);
    if (suffix.length && suffix.at(-1) !== 10) throw new Error(`incomplete fresh anchor log: ${name}`);
    for (const line of suffix.toString('utf8').split('\n').filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { throw new Error(`invalid anchor JSON: ${name}`); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`invalid anchor record: ${name}`);
      records.push({ ...record, log: name });
    }
  }
  return records;
}

const withoutHostImages = ({ images_info: _images, ...dl }) => dl;

/** A fresh record is evidence only when its complete compiled display list matches the event.
 * req/ctx belong to the Lua server and cannot be equated with the public edit/par IDs. */
export function matchLiveRecord(records, event, decode) {
  if (event.event !== 'ParagraphUpdate' || event.status !== 'ok' || !Array.isArray(event.dl?.lines)) throw new Error('live event is not a successful ParagraphUpdate');
  if (!records.length) throw new Error('no fresh anchor records for this edit');
  if (new Set(records.map((record) => record.log)).size !== 1) throw new Error('fresh anchor records span multiple servers');
  const ids = new Set();
  const matches = [];
  for (const record of records) {
    if (record.version !== 2 || !Number.isSafeInteger(record.req) || record.req < 0 || !Number.isSafeInteger(record.ctx)) throw new Error('anchor record has invalid identity');
    const id = `${record.log}:${record.req}`;
    if (ids.has(id)) throw new Error('duplicate anchor request identity');
    ids.add(id);
    if (record.status !== 'ok') throw new Error(`anchor compile was not successful: ${record.status}`);
    if (!Array.isArray(record.rows) || record.lines !== record.rows.length) throw new Error('anchor row count is invalid');
    if (typeof record.dl_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(record.dl_hex)) throw new Error('anchor record has no valid binary result');
    const dl = decode(record);
    if (!isDeepStrictEqual(withoutHostImages(dl), withoutHostImages(event.dl))) continue;
    if (record.rows.length !== event.dl.lines.length || record.rows.some((row, index) => row.x !== event.dl.lines[index].x || row.y !== event.dl.lines[index].y)) throw new Error('anchor rows disagree with their exact result');
    matches.push(record);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous fresh anchor results' : 'no fresh anchor result matches the complete live display list');
  return matches[0];
}

/** Use the very same bundled decoder as the session, avoiding a second incomplete JS decoder. */
export function decodeLiveDisplayList(record, executable, directory) {
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(record.dl_hex, 'hex');
  const file = path.join(directory, `${digest(bytes)}.rtdl`);
  writeFileSync(file, bytes);
  return JSON.parse(execFileSync(executable, ['dl2json', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20 }));
}

export function timingOrder(round) { return round % 2 ? ['on', 'off'] : ['off', 'on']; }
