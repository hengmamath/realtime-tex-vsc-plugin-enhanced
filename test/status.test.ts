import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, explainReasons } from '../src/status';
import { parseEncFile, parseMapFile } from '../src/type1';

test('status texts', () => {
  const base = { pending: false, errorCount: 0 };
  assert.equal(describe({ ...base, phase: 'starting' }).kind, 'busy');
  assert.equal(describe({ ...base, phase: 'live', lastFastMs: 0.84 }).text, 'Live · 0.8 ms');
  assert.equal(describe({ ...base, phase: 'live', pending: true }).text, 'Updating layout…');
  // a stale layout is busy through `pending`, which the engine's pass_pending can clear
  assert.equal(describe({ ...base, phase: 'live', pending: false, convergence: { state: 'Stale', pending_since: 4 } }).kind, 'ok');
  assert.equal(describe({ ...base, phase: 'live', errorCount: 2 }).text, '2 errors');
  assert.equal(describe({ ...base, phase: 'live', convergence: { state: 'PassLimitReached', passes: 5, reasons: [] } }).kind, 'warn');
  assert.equal(describe({ ...base, phase: 'live', convergence: { state: 'Converged' } }).text, 'Up to date');
  assert.match(explainReasons(['paragraph boundaries changed']), /split or merged/);
  assert.equal(explainReasons(['DisallowedEnvironment("tabularx")', 'NoPlacement']), 'the tabularx environment is not supported by live typesetting yet');
  assert.equal(explainReasons(['math macro \\texttt']), '\\texttt inside math is not supported by live typesetting yet');
  assert.match(explainReasons(['NoPlacement']), /no position/);
  assert.match(explainReasons(['unverified: row 2 differs']), /did not match the last full compile/);
  assert.match(explainReasons(['ParagraphBreak']), /source block contains paragraph breaks/);
  assert.match(explainReasons(['unverified: no layout unit to compare with', 'NoContext']), /no matching unit/);
  assert.match(explainReasons(['NoContext']), /no reusable typesetting context/);
  // the reason rtex gives for a part quarantined after a crash is not a preamble change
  assert.match(explainReasons(['EngineFailed: the live engine hung or crashed on this paragraph; it stays on the full compile until the preamble changes']),
    /stopped the live engine once/);
  assert.match(explainReasons(['\\usepackage changed in the preamble']), /preamble changed/);
  assert.match(explainReasons(['preamble context is not ready; waiting for a full compile']),
    /successful full compile before live editing resumes/);
  assert.match(explainReasons(['EngineFailed: this version hung or crashed the live engine; edit the paragraph to retry']),
    /editing the paragraph allows a limited retry/);
  assert.match(explainReasons(['EngineFailed: automatic recovery attempts are exhausted; this paragraph stays on the full compile until the preamble changes']),
    /automatic recovery limit/);
  assert.match(explainReasons(['EngineFailed: this layout snapshot hung or crashed during the live probe; a fresh full compile is needed']),
    /saved layout.*fresh full compile/);
  // a structure still being typed is named as such, not as an unsupported environment
  assert.match(explainReasons(['UnbalancedMath']), /formula is not closed yet/);
  assert.match(explainReasons(['IncompleteMath']), /missing an argument, script, or matching delimiter/);
  assert.match(explainReasons(['UnbalancedEnvironment', 'UnbalancedBraces']), /environment is not closed yet/);
  assert.match(explainReasons(['UnbalancedBraces']), /brace is not closed yet/);
  assert.match(explainReasons(['unverified: the last full compile saw this part unfinished']), /saw this part unfinished/);
});

test('map and encoding files', () => {
  const map = parseMapFile('% comment\ncmmi10 CMMI10 <cmmi10.pfb\nec-lmr10 LMRoman10-Regular " enclmec ReEncodeFont " <lm-ec.enc <lmr10.pfb\nptmro8r Times-Roman " .167 SlantFont TeXBase1Encoding ReEncodeFont " <8r.enc <utmr8a.pfb\n');
  assert.deepEqual(map.get('cmmi10'), { tfm: 'cmmi10', psname: 'CMMI10', fontFile: 'cmmi10.pfb' });
  assert.equal(map.get('ec-lmr10')?.encFile, 'lm-ec.enc');
  assert.equal(map.get('ptmro8r')?.slant, 0.167);
  const enc = parseEncFile('% x\n/enc [\n/grave /acute % c\n/circumflex\n] def\n');
  assert.deepEqual(enc, ['grave', 'acute', 'circumflex']);
});
