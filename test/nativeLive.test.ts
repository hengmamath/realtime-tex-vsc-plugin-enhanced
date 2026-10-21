import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { fontKey } from '../src/fontKey';
import { nativeSfntCodePoint } from '../src/nativeSfnt';
import type { DisplayList } from '../src/protocol';
import { ResourceLoader } from '../src/resources';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

test('real newtx live edits reuse the prepared SFNT font for newly introduced Unicode glyphs', {
  skip: realEngineUnavailable, timeout: 90000,
}, async () => {
  const fixture = await realEngineFixture('opentype-live.tex');
  try {
    await fixture.start();
    const pages: DisplayList[] = fixture.events.flatMap(event => event.event === 'LayoutUpdate'
      ? event.pages_changed.map(page => page.dl) : []);
    const bin = process.env.RTEX_TEST_TEXLIVE_BIN;
    const loader = new ResourceLoader({ ...process.env, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH });
    const original = await loader.fontsFor(pages, new Set());
    const sfnt = [...original.values()].filter(f => f.kind === 'sfnt');
    assert.ok(sfnt.length > 0 && sfnt.every(f => f.kind === 'sfnt' && f.native), 'newtx must exercise prepared OpenType fonts');
    const oldGlyphs = new Set(pages.flatMap(dl => [dl.other, ...dl.lines.map(line => line.items)]
      .flatMap(items => items.filter(item => item[0] === 'g').map(item => `${fontKey(dl.fonts[String(item[1])])}:${item[3]}`))));
    const marker = 'Nativequartz', at = fixture.source.indexOf(marker) + marker.length;
    const update = await fixture.editLive(at, at, ' caf\u00e9 \u03a9', 'new OpenType Unicode glyphs');
    assert.equal(await loader.glyphsNeedPdf([update.dl]), false);
    assert.equal((await loader.fontsFor([update.dl], new Set(original.keys()))).size, 0,
      'typing a previously unused glyph must not prepare or deliver another font');
    let newGlyphs = 0;
    for (const items of [update.dl.other, ...update.dl.lines.map(line => line.items)]) for (const item of items) {
      if (item[0] !== 'g') continue;
      const key = fontKey(update.dl.fonts[String(item[1])]), resource = original.get(key);
      if (resource?.kind !== 'sfnt') continue;
      assert.ok(resource.native);
      assert.notEqual(nativeSfntCodePoint(item[3] as number, resource.native.numGlyphs), undefined);
      if (!oldGlyphs.has(`${key}:${item[3]}`)) newGlyphs++;
    }
    assert.ok(newGlyphs > 0, 'the synthetic edit must genuinely introduce a previously unused glyph');
  } finally { await fixture.close(); }
});
