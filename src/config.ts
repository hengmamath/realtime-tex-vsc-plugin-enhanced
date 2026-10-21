// Settings and the locations derived from them.
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUNDLED_PLATFORM, getBundledRuntime } from './bundledRuntime';
import { FollowCursorMode, isFollowCursorMode } from './followCursor';

export const SECTION = 'realtimeTex';

export function cfg(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

/** An explicit gesture setting wins over the old on/off preference. Existing disabled
 * follow preferences remain disabled until the user chooses one of the new modes. */
export function followCursorMode(scope?: vscode.Uri): FollowCursorMode {
  const c = cfg(scope);
  const value = c.inspect<FollowCursorMode>('followCursor');
  const explicit = value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue;
  if (isFollowCursorMode(explicit)) return explicit;
  return c.get<boolean>('syncCursor', true) ? 'doubleClick' : 'off';
}

/** Keep toolbar changes at the scope where the user configured following. In particular,
 * changing a workspace override must not write an ineffective global preference. */
export async function setFollowCursorMode(mode: FollowCursorMode, scope?: vscode.Uri): Promise<void> {
  const c = cfg(scope);
  const current = c.inspect<FollowCursorMode>('followCursor');
  const legacy = c.inspect<boolean>('syncCursor');
  const target = current?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : current?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
    : current?.globalValue !== undefined ? vscode.ConfigurationTarget.Global
    : legacy?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : legacy?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await c.update('followCursor', mode, target);
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const WINDOWS = process.platform === 'win32';

/** This enhanced release ships a tested engine for Apple Silicon macOS. */
export function platformSupported(): boolean {
  return `${process.platform}-${process.arch}` === BUNDLED_PLATFORM;
}

/** `name` as an executable file name on this platform (`rtex` → `rtex.exe` on Windows). */
export function exe(name: string): string {
  return WINDOWS && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}

/** Earlier versions stored a locally installed TeX environment here. Read its environment
 * file for migration only; this release never installs or updates an upstream engine. */
function legacyTexLocations(ctx: vscode.ExtensionContext): string[] {
  return ['texlive', 'realtime-tex'].map((directory) => path.join(ctx.globalStorageUri.fsPath, directory));
}

/** The key of PATH in `env`: a copy of process.env keeps Windows' spelling (`Path`), and a
 * second `PATH` next to it would leave the child's search path to chance. */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

export interface ServerLocation {
  path: string;
  source: 'bundled';
  kind: 'bundled';
  /** The complete verified support paired with this executable. */
  texDir: string;
  version: string;
}

/** Only the verified bundled executable and support may run. Old path settings remain
 * registered for migration, but cannot select another engine or mismatched support. */
export function resolveServer(ctx: vscode.ExtensionContext): ServerLocation | undefined {
  try {
    const bundled = getBundledRuntime(ctx.extensionUri.fsPath);
    return bundled ? { ...bundled, source: 'bundled', kind: 'bundled' } : undefined;
  } catch {
    // Check Setup reports verification errors. Never fall back to an unrelated engine.
    return undefined;
  }
}

/** Read an earlier local TeX installation's saved environment without running its installer. */
function texliveEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^export\s+([A-Z_]+)="([^"]*)"/.exec(line.trim());
    if (m && m[1] !== 'PATH') out[m[1]] = m[2];
  }
  return out;
}

/** Environment for rtex and the TeX tools it runs. */
export function processEnv(ctx: vscode.ExtensionContext, server?: ServerLocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Preserve an earlier local TeX environment without adopting its engine.
  const envFile = legacyTexLocations(ctx).map((d) => path.join(d, 'build', 'texlive.env')).find((f) => existsSync(f));
  const managedTl = envFile ? texliveEnvFile(envFile) : {};
  let bin = expandHome(cfg().get<string>('texliveBin', '').trim());
  if (!bin && managedTl.RTEX_TEXLIVE_BIN) {
    bin = managedTl.RTEX_TEXLIVE_BIN;
    Object.assign(env, managedTl);
  }
  if (bin) {
    env.RTEX_TEXLIVE_BIN = bin;
    const key = pathKey(env);
    env[key] = `${bin}${path.delimiter}${env[key] ?? ''}`;
  }
  const bundled = server ?? resolveServer(ctx);
  if (bundled) env.RTEX_TEXDIR = bundled.texDir;
  else delete env.RTEX_TEXDIR;
  // Source positions travel with the exact compiled result in this paired runtime.
  if (bundled?.version === '0.0.5+live.3') env.RTEX_SOURCE_SYNC = '1';
  else delete env.RTEX_SOURCE_SYNC;
  return env;
}

export function buildDirFor(ctx: vscode.ExtensionContext, mainFile: string): string {
  const configured = expandHome(cfg(vscode.Uri.file(mainFile)).get<string>('buildDir', '').trim());
  if (configured) return path.isAbsolute(configured) ? configured : path.join(path.dirname(mainFile), configured);
  const base = ctx.storageUri?.fsPath ?? ctx.globalStorageUri.fsPath;
  // one directory per main file
  const id = Buffer.from(mainFile).toString('base64url').slice(-48);
  return path.join(base, 'build', id);
}

export function exportPathFor(mainFile: string): string {
  const tmpl = cfg(vscode.Uri.file(mainFile)).get<string>('exportPath', '${mainDir}/${mainName}.pdf') || '${mainDir}/${mainName}.pdf';
  const mainDir = path.dirname(mainFile);
  const mainName = path.basename(mainFile, path.extname(mainFile));
  const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mainFile))?.uri.fsPath ?? mainDir;
  const p = expandHome(
    tmpl.replace(/\$\{mainDir\}/g, mainDir).replace(/\$\{mainName\}/g, mainName).replace(/\$\{workspaceFolder\}/g, wsFolder),
  );
  return path.isAbsolute(p) ? p : path.join(mainDir, p);
}

export function isTexDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && (doc.languageId === 'latex' || doc.languageId === 'tex' || /\.tex$/i.test(doc.fileName));
}

/** `rtex serve` options that override the bundled engine's defaults. */
export function engineArgs(scope?: vscode.Uri): string[] {
  const c = cfg(scope);
  const args: string[] = [];
  const eligibility = c.get<string>('engine.eligibility', 'probe');
  if (eligibility && eligibility !== 'probe') args.push('--eligibility', eligibility);
  const budget = Math.round(c.get<number>('engine.fastBudgetMs', 50));
  if (budget > 0 && budget !== 50) args.push('--fast-budget-ms', String(budget));
  if (!c.get<boolean>('engine.pictureCache', true)) args.push('--no-picture-cache');
  return args;
}

/** The bundled engine's debug directory when realtimeTex.debug.enabled is on. */
export function debugDir(ctx: vscode.ExtensionContext): string | undefined {
  if (!cfg().get<boolean>('debug.enabled', false)) return undefined;
  const configured = expandHome(cfg().get<string>('debug.directory', '').trim());
  return configured || path.join(ctx.globalStorageUri.fsPath, 'debug');
}
