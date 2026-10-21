import assert from 'node:assert/strict';
import { getBundledRuntime } from '../src/bundledRuntime';

export const realEngineUnavailable = !process.env.RTEX_TEST_BUNDLED &&
  'set RTEX_TEST_BUNDLED=1 to exercise the packaged enhanced engine and support';

/** Regressions use the exact verified offline pair that a fresh installation selects. */
export async function prepareTestRuntime(extensionPath: string) {
  const bundled = getBundledRuntime(extensionPath);
  assert.ok(bundled, 'the packaged engine regression requires a supported host');
  return { serverPath: bundled.path, texDir: bundled.texDir };
}
