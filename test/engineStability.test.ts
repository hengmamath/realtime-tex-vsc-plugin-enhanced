import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

test('malformed edit offsets leave the engine running and the source revision intact', {
  skip: realEngineUnavailable, timeout: 60000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\begin{document}
% Test multi-byte boundaries: é😀
The original body.
\end{document}
` });
  try {
    const initial = await fixture.start();
    const emoji = fixture.source.indexOf('😀');
    const at = Buffer.byteLength(fixture.source.slice(0, emoji));
    for (const [start, end] of [[-1, 0], [0, 0.5], [at + 4, at], [at, at + 1],
      [at + 1, at + 1], [at, Buffer.byteLength(fixture.source) + 1]]) {
      const reply = await fixture.engine.request({ cmd: 'edit', path: 'main.tex', start, end, text: 'bad' });
      assert.equal(reply.reply, 'error', `invalid range ${start}..${end} must be rejected`);
    }
    const status = await fixture.engine.request({ cmd: 'status' });
    assert.ok(status.reply === 'status');
    assert.equal(status.versions.source_revision, initial.versions.source_revision);

    const valid = await fixture.edit(emoji, emoji + '😀'.length, 'é');
    assert.equal(valid.source_revision, initial.versions.source_revision + 1);
    await fixture.layout(valid.source_revision);
    await fixture.editMarker('original');
  } finally { await fixture.close(); }
});
