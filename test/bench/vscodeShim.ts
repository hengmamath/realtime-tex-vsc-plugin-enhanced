// The part of the VS Code API that Session and its helpers touch, for the node-only typing
// benchmark (esbuild aliases `vscode` to this file). Behaviour that the benchmark does not
// exercise (dialogs, commands, editors' decorations) does nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from 'path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(e: T): void { for (const l of [...this.listeners]) l(e); }
  dispose(): void { this.listeners = []; }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

export class Selection extends Range {}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string): Uri { return new Uri('file', p); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(base.scheme, path.join(base.fsPath, ...parts)); }
  get path(): string { return this.fsPath; }
  toString(): string { return `${this.scheme}://${this.fsPath}`; }
}

export class ThemeColor { constructor(readonly id: string) {} }
export class MarkdownString { constructor(public value = '') {} appendMarkdown(s: string) { this.value += s; return this; } }
export class RelativePattern { constructor(readonly base: string, readonly pattern: string) {} }

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export class Diagnostic {
  source?: string;
  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity) {}
}

export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

const noop = { dispose() { /* nothing */ } };

/** Settings read through `workspace.getConfiguration('realtimeTex')`; tests set these. */
export const settings = new Map<string, unknown>();

export const workspace = {
  textDocuments: [] as any[],
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, fallback?: T): T => (settings.has(key) ? settings.get(key) as T : fallback as T),
    inspect: () => undefined,
    update: async () => undefined,
  }),
  createFileSystemWatcher: () => ({ ...noop, onDidChange: () => noop, onDidCreate: () => noop, onDidDelete: () => noop }),
  getWorkspaceFolder: () => undefined,
  openTextDocument: async () => { throw new Error('not available in the benchmark'); },
  onDidChangeConfiguration: () => noop,
};

export const window = {
  visibleTextEditors: [] as any[],
  onDidChangeVisibleTextEditors: () => noop,
  createTextEditorDecorationType: () => noop,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showTextDocument: async () => undefined,
  withProgress: async (_o: unknown, task: () => Promise<unknown>) => task(),
};

export const commands = { executeCommand: async () => undefined };
export const env = { clipboard: { writeText: async () => undefined } };
export const languages = { createDiagnosticCollection: () => new DiagnosticCollection() };

export class DiagnosticCollection {
  readonly entries = new Map<string, Diagnostic[]>();
  set(uri: Uri, list: Diagnostic[]): void { this.entries.set(uri.fsPath, list); }
  clear(): void { this.entries.clear(); }
  dispose(): void { this.entries.clear(); }
}
