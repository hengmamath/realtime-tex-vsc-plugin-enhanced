import assert from 'node:assert/strict';
import { getBundledRuntime } from '../src/bundledRuntime';
import { prepareColorSupport } from '../src/colorSupport';

export const realEngineUnavailable = !process.env.RTEX_TEST_BUNDLED &&
  (!process.env.RTEX_TEST_SERVER || !process.env.RTEX_TEST_TEXDIR) &&
  'set RTEX_TEST_BUNDLED=1 to exercise the packaged enhanced engine and support';

/** Release regressions use the exact offline pair that a fresh installation selects.
 * Explicit external paths remain available for engine development diagnostics. */
export async function prepareTestRuntime(extensionPath: string, buildDir: string) {
  if (process.env.RTEX_TEST_BUNDLED) {
    const bundled = getBundledRuntime(extensionPath);
    assert.ok(bundled, 'the packaged engine regression requires a supported host');
    return { serverPath: bundled.path, texDir: bundled.texDir };
  }
  const support = await prepareColorSupport({
    serverPath: process.env.RTEX_TEST_SERVER ?? '',
    texDir: process.env.RTEX_TEST_TEXDIR,
    buildDir, extensionPath,
  });
  assert.ok(support, 'external engine diagnostics require the recognized original support tree');
  return { serverPath: process.env.RTEX_TEST_SERVER!, texDir: support };
}
