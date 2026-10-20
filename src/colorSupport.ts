import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// This overlay is for the shipped v0.0.5 support files only. Leave newer or customized
// engines alone rather than replacing support code whose assumptions may differ.
const ORIGINAL_DL_SHA256 = 'bfe5ab8833cfe54f63bb8bb85b5f4243d4e4d30c8c8d550bcc2804d448169239';
const ORIGINAL_SERVE_SHA256 = '9148607210bfb8d0f908ff1230ba97b227fd828f19c3382d064804bea311c3ae';
const ORIGINAL_BINARY_SHA256 = '999201f2e7d2355ee118ab2f33b5d6c4015b76d12e33caf718f2a1bdedbe2919';

export interface ColorSupportOptions {
  serverPath: string;
  texDir?: string;
  buildDir: string;
  extensionPath: string;
}

/** Prepare a session-local support tree; never change the installed engine or settings.
 * Returns undefined for a missing or unrecognized traversal. Mismatched paired support
 * and filesystem failures are left to the caller to report, while continuing with the
 * engine's original support files. */
export async function prepareColorSupport(options: ColorSupportOptions): Promise<string | undefined> {
  const { serverPath, texDir, buildDir, extensionPath } = options;
  const candidates = texDir ? [path.resolve(texDir)] : [
    path.resolve(path.dirname(serverPath), '..', 'share', 'rtex', 'tex'),
    path.resolve(path.dirname(serverPath), '..', '..', 'tex'),
  ];
  let source: string | undefined;
  for (const candidate of candidates) {
    let original: Buffer;
    try {
      original = await fs.readFile(path.join(candidate, 'rtex-dl.lua'));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (createHash('sha256').update(original).digest('hex') !== ORIGINAL_DL_SHA256) return undefined;
    source = candidate;
    break;
  }
  if (!source) return undefined;

  // The live-reference engine fix depends on this matching serve implementation.
  // Treat customized support as an unsupported pair instead of mixing versions.
  const originalServe = await fs.readFile(path.join(source, 'rtex-serve.lua'));
  if (createHash('sha256').update(originalServe).digest('hex') !== ORIGINAL_SERVE_SHA256) {
    throw new Error('Unrecognized rtex-serve.lua; keeping original engine support');
  }
  const originalBinary = await fs.readFile(path.join(source, 'rtex-dl-bin.lua'));
  if (createHash('sha256').update(originalBinary).digest('hex') !== ORIGINAL_BINARY_SHA256) {
    throw new Error('Unrecognized rtex-dl-bin.lua; keeping original engine support');
  }

  const patched = path.join(extensionPath, 'resources', 'rtex-color', 'rtex-dl.lua');
  const patchedServe = path.join(extensionPath, 'resources', 'rtex-color', 'rtex-serve.lua');
  const patchedBinary = path.join(extensionPath, 'resources', 'rtex-color', 'rtex-dl-bin.lua');
  await fs.access(patched);
  await fs.access(patchedServe);
  await fs.access(patchedBinary);
  await fs.mkdir(buildDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(buildDir, 'tex-color-support-'));
  const destination = path.join(buildDir, 'tex-color-support');
  try {
    await fs.cp(source, staging, { recursive: true, force: true });
    // A source checkout may use a symlink here. Replace the entry itself so the
    // overlay can never write through that link into the installed support tree.
    await fs.rm(path.join(staging, 'rtex-dl.lua'), { force: true });
    await fs.copyFile(patched, path.join(staging, 'rtex-dl.lua'));
    await fs.rm(path.join(staging, 'rtex-serve.lua'), { force: true });
    await fs.copyFile(patchedServe, path.join(staging, 'rtex-serve.lua'));
    await fs.rm(path.join(staging, 'rtex-dl-bin.lua'), { force: true });
    await fs.copyFile(patchedBinary, path.join(staging, 'rtex-dl-bin.lua'));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
    return destination;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
