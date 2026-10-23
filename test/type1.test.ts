import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseType1, type1Outlines } from '../src/type1';

const clear = Buffer.from('/FontMatrix [0.001 0 0 0.001 0 0] def\n/Encoding 256 array dup 65 /A put def\ncurrentfile eexec\n');
const glyph = Buffer.from([139, 248, 136, 13, 139, 139, 21, 239, 139, 5, 89, 239, 5, 9, 14]);

function encryptedProgram(): Buffer {
  const plain = Buffer.concat([Buffer.alloc(4), Buffer.from(`/lenIV -1 def\n/CharStrings 1 dict dup begin\n/A ${glyph.length} RD `), glyph, Buffer.from(' ND\nend\n')]);
  let key = 55665;
  return Buffer.from(plain.map((byte) => {
    const encrypted = byte ^ (key >> 8);
    key = ((encrypted + key) * 52845 + 22719) & 0xffff;
    return encrypted;
  }));
}

function segment(type: number, bytes: Uint8Array = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0x80; header[1] = type;
  header.writeUInt32LE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}

const expected = { upem: 1000, glyphs: { 65: 'M0 0 L100 0 L50 100 Z' } };

test('PFB parses split and empty segments, a two-byte EOF marker and a sliced buffer', () => {
  const encrypted = encryptedProgram();
  const pfb = Buffer.concat([
    segment(1), segment(1, clear.subarray(0, 20)), segment(1, clear.subarray(20)),
    segment(2, encrypted.subarray(0, 7)), segment(2), segment(2, encrypted.subarray(7)),
    segment(1, Buffer.from('/FontMatrix [0.002 0 0 0.002 0 0] def\ncleartomark\n')),
    Buffer.from([0x80, 3]),
  ]);
  const padded = Buffer.concat([Buffer.from([0xff]), pfb, Buffer.from([0xff])]);
  assert.deepEqual(type1Outlines(padded.subarray(1, padded.length - 1)), expected);
});

test('PFB accepts a final complete segment without an EOF marker', () => {
  assert.deepEqual(type1Outlines(Buffer.concat([segment(1, clear), segment(2, encryptedProgram())])), expected);
});

test('PFA keeps hex decoding and cleartext-only fonts', () => {
  const hex = encryptedProgram().toString('hex').match(/.{1,32}/g)!.join('\n');
  assert.deepEqual(type1Outlines(Buffer.concat([clear, Buffer.from(hex)])), expected);
  assert.deepEqual(parseType1(Buffer.from('/FontMatrix [0.002 0 0 0.002 0 0] def\n')).fontMatrix, [0.002, 0, 0, 0.002, 0, 0]);
});

test('PFB rejects invalid or truncated segment headers and unsigned lengths without hanging', () => {
  const malformed = [
    [0x80], [0x80, 1, 0, 0, 0], [0x80, 4, 0, 0, 0, 0],
    [0x80, 2, 0xfa, 0xff, 0xff, 0xff],
    [0x80, 2, 0, 0, 0, 0x80], [0x80, 2, 0xff, 0xff, 0xff, 0xff],
    [0x80, 1, 1, 0, 0, 0], [...segment(1), 0x7f],
  ];
  for (const bytes of malformed) {
    // A synchronous parser regression must fail the test instead of freezing the runner.
    assert.throws(() => runInNewContext('parseType1(input)', { parseType1, input: Uint8Array.from(bytes) }, { timeout: 1000 }), /Invalid Type1 PFB/);
  }
});
