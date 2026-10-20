// The executable and Lua/TeX support are a versioned, offline pair shipped in the VSIX.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';

export const BUNDLED_PLATFORM = 'darwin-arm64';

export interface BundledRuntime {
  path: string;
  texDir: string;
  version: string;
  platform: string;
}

export interface RuntimeManifest {
  schemaVersion: number;
  platform: string;
  version: string;
  sourceCommit: string;
  engine: { relativePath: string; sha256: string };
  texFiles: Record<string, string>;
}

const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const requiredSupport = [
  'rtex-bg.lua', 'rtex-capture.lua', 'rtex-dl.lua', 'rtex-dl-bin.lua',
  'rtex-json.lua', 'rtex-pic.lua', 'rtex-serve.lua',
  'latex/rtex-capture.sty', 'latex/rtex-pic.tex', 'latex/rtex-serve-patches.tex',
];

/** An unsupported machine has no bundled runtime. A broken supported bundle is an error,
 * never a reason to download a different engine or silently use one found on PATH. */
export function getBundledRuntime(
  extensionPath: string,
  platform: string = process.platform,
  arch: string = process.arch,
): BundledRuntime | undefined {
  if (`${platform}-${arch}` !== BUNDLED_PLATFORM) return undefined;
  const root = path.join(extensionPath, 'resources', 'rtex-runtime');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as RuntimeManifest;
  const expectedExecutable = `../rtex-engine/${BUNDLED_PLATFORM}/rtex`;
  if (manifest?.schemaVersion !== 1 || manifest.platform !== BUNDLED_PLATFORM ||
      typeof manifest.version !== 'string' || !manifest.version ||
      typeof manifest.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
      manifest.engine?.relativePath !== expectedExecutable || !validHash(manifest.engine?.sha256) ||
      !manifest.texFiles || typeof manifest.texFiles !== 'object' || Array.isArray(manifest.texFiles) ||
      requiredSupport.some((file) => !validHash(manifest.texFiles[file]))) {
    throw new Error('Invalid bundled runtime manifest. Reinstall Realtime TeX Enhanced.');
  }
  const executable = path.resolve(root, expectedExecutable);
  if (digest(executable) !== manifest.engine.sha256) {
    throw new Error('Bundled engine checksum mismatch. Reinstall Realtime TeX Enhanced.');
  }
  const texDir = path.join(root, 'tex');
  for (const [relative, expected] of Object.entries(manifest.texFiles)) {
    // The manifest may name only files inside its support tree.
    if (!validHash(expected) || relative.includes('\\') || relative.startsWith('/') ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid bundled support file manifest. Reinstall Realtime TeX Enhanced.');
    }
    if (digest(path.join(texDir, relative)) !== expected) {
      throw new Error(`Bundled support checksum mismatch: ${relative}. Reinstall Realtime TeX Enhanced.`);
    }
  }
  return { path: executable, texDir, version: manifest.version, platform: manifest.platform };
}
