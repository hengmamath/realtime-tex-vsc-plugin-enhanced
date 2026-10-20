import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface LiveEngineOptions {
  serverPath: string;
  buildDir: string;
  extensionPath: string;
}

interface EngineManifest {
  platform: string;
  originalSha256: string;
  sha256: string;
  version: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Use the bundled live-preview fixes only with the exact release they were built for.
 * The original executable and configuration are never changed. The caller must also
 * prepare the matching Lua support overlay before using this session-local engine. */
export async function prepareLiveEngine(options: LiveEngineOptions): Promise<string | undefined> {
  const resourceDir = path.join(options.extensionPath, 'resources', 'rtex-engine');
  let raw: string;
  try {
    raw = await fs.readFile(path.join(resourceDir, 'manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const manifest: EngineManifest = JSON.parse(raw);
  if (!manifest || typeof manifest.platform !== 'string') throw new Error('Invalid enhanced engine manifest');
  if (manifest.platform !== `${process.platform}-${process.arch}`) return undefined;
  if (typeof manifest.originalSha256 !== 'string' || typeof manifest.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.originalSha256) || !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
      typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('Invalid enhanced engine manifest');
  }
  const original = await fs.readFile(options.serverPath);
  if (sha256(original) !== manifest.originalSha256) return undefined;
  const executable = process.platform === 'win32' ? 'rtex.exe' : 'rtex';
  const bundled = await fs.readFile(path.join(resourceDir, manifest.platform, executable));
  if (sha256(bundled) !== manifest.sha256) throw new Error('Enhanced engine checksum mismatch');

  await fs.mkdir(options.buildDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(options.buildDir, 'enhanced-engine-'));
  const destination = path.join(options.buildDir, 'enhanced-engine');
  try {
    const stagedExecutable = path.join(staging, executable);
    await fs.writeFile(stagedExecutable, bundled);
    await fs.chmod(stagedExecutable, 0o755);
    // Replace the disposable directory itself, including any old symlink entries.
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
    return path.join(destination, executable);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
