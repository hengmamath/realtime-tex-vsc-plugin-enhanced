// Read navigation emitted by the completed TeX pass. This never evaluates TeX or reads
// source documents: the named destinations are checked against the compiled layout.
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import type { OutlineEntry, OutlineViewState } from '../outline';
import type { PageUpdate } from '../protocol';

export interface CompiledOutline { entries: OutlineEntry[]; unavailable?: string }
export interface OutlineFiles { out?: string; aux?: string; toc?: string }
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const levels: Readonly<Record<string, number>> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5,
};

export const documentIdFor = (mainFile: string): string => createHash('sha256').update(path.resolve(mainFile)).digest('hex');

/** Clamp data coming from a restored webview or workspace storage. */
export function outlineViewState(value: unknown): OutlineViewState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<OutlineViewState>;
  if (typeof state.open !== 'boolean' || typeof state.width !== 'number' || !Number.isFinite(state.width) || !Array.isArray(state.collapsed)) return undefined;
  return { open: state.open, width: Math.round(Math.max(200, Math.min(360, state.width))),
    collapsed: [...new Set(state.collapsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2048))].slice(0, MAX_ENTRIES) };
}

/** Physical pages come from actual destinations, never TeX's printed/roman page labels. */
export function outlineDestinations(pages: Iterable<PageUpdate>): Map<string, number> {
  const destinations = new Map<string, number>();
  for (const page of pages) for (const items of [page.dl.other, ...page.dl.lines.map(line => line.items)]) {
    for (const item of items) if (item[0] === 'D' && typeof item[1] === 'string' && !destinations.has(item[1])) destinations.set(item[1], page.page);
  }
  return destinations;
}

interface Group { value: string; end: number }
function white(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    if (/\s/.test(source[at])) { at++; continue; }
    if (source[at] === '%') { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end + 1; continue; }
    break;
  }
  return at;
}
function group(source: string, from: number, opening = '{', closing = '}'): Group | undefined {
  const start = white(source, from);
  if (source[start] !== opening) return undefined;
  let depth = 1;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === '\\') { at++; continue; }
    if (char === '%') { const end = source.indexOf('\n', at); if (end < 0) return undefined; at = end; continue; }
    if (char === opening && ++depth > 256) return undefined;
    if (char === closing && --depth === 0) return { value: source.slice(start + 1, at), end: at + 1 };
  }
  return undefined;
}
function withoutComments(source: string): string {
  let copied = 0;
  const parts: string[] = [];
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] !== '%') continue;
    parts.push(source.slice(copied, at));
    const end = source.indexOf('\n', at);
    copied = end < 0 ? source.length : end;
    at = copied;
  }
  parts.push(source.slice(copied));
  return parts.join('');
}
function calls(source: string, name: string, count: number): string[][] {
  source = withoutComments(source);
  const found: string[][] = [];
  const command = new RegExp(`\\\\${name}(?![A-Za-z@])`, 'g');
  for (let match; (match = command.exec(source)) && found.length < MAX_ENTRIES;) {
    const values: string[] = [];
    let at = command.lastIndex;
    if (name === 'BOOKMARK') {
      const level = group(source, at, '[', ']');
      if (!level) continue;
      values.push(level.value);
      at = level.end;
      const open = group(source, at, '[', ']');
      if (open) at = open.end;
    }
    for (let i = 0; i < count; i++) {
      const arg = group(source, at);
      if (!arg) break;
      values.push(arg.value); at = arg.end;
    }
    if (values.length === count + (name === 'BOOKMARK' ? 1 : 0)) { found.push(values); command.lastIndex = at; }
  }
  return found;
}

const pdfSpecial: Record<number, string> = {
  0x18: '˘', 0x19: 'ˇ', 0x1a: 'ˆ', 0x1b: '˙', 0x1c: '˝', 0x1d: '˛', 0x1e: '˚', 0x1f: '˜',
  0x80: '•', 0x81: '†', 0x82: '‡', 0x83: '…', 0x84: '—', 0x85: '–', 0x86: 'ƒ', 0x87: '⁄',
  0x88: '‹', 0x89: '›', 0x8a: '−', 0x8b: '‰', 0x8c: '„', 0x8d: '“', 0x8e: '”', 0x8f: '‘',
  0x90: '’', 0x91: '‚', 0x92: '™', 0x93: 'ﬁ', 0x94: 'ﬂ', 0x95: 'Ł', 0x96: 'Œ', 0x97: 'Š',
  0x98: 'Ÿ', 0x99: 'Ž', 0x9a: 'ı', 0x9b: 'ł', 0x9c: 'œ', 0x9d: 'š', 0x9e: 'ž', 0xa0: '€',
};
const clean = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

/** Hyperref writes PDF strings (often octal-escaped UTF-16BE), not executable TeX. */
export function decodeOutlineString(source: string): string {
  const value = source.replace(/\\([0-7]{1,3}|[nrtbf(){}\\]|\r?\n)/g, (_whole, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\n': '', '\r\n': '' } as Record<string, string>)[escape] ?? escape;
  });
  if (value.startsWith('\xfe\xff') || value.startsWith('\xff\xfe')) {
    const bigEndian = value.charCodeAt(0) === 0xfe;
    let decoded = '';
    for (let i = 2; i + 1 < value.length; i += 2) decoded += String.fromCharCode(bigEndian
      ? (value.charCodeAt(i) << 8) | value.charCodeAt(i + 1)
      : value.charCodeAt(i) | (value.charCodeAt(i + 1) << 8));
    return clean(decoded);
  }
  return clean([...value].map(char => pdfSpecial[char.charCodeAt(0)] ?? char).join(''));
}

/** Plain text fallback for compiler .toc titles, including nested formatting groups. */
function tocTitle(source: string): string {
  let title = source;
  for (const args of calls(title, 'numberline', 1)) {
    title = title.replace(/\\numberline\s*\{[^}]*\}/, `${args[0]} `);
  }
  title = title.replace(/\\texorpdfstring\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$2');
  title = title.replace(/\\([&%$#_{}])/g, '$1').replace(/\\(?:protect|ignorespaces|relax)\b/g, '')
    .replace(/\\(?:textbf|textit|emph|textnormal|textrm|textsf|texttt|ensuremath|mathrm|mathbf)\b/g, '')
    .replace(/\\([A-Za-z@]+)\s*/g, '$1 ').replace(/[{}$]/g, '');
  return clean(title);
}
function fromHex(source: string): string | undefined {
  return source.length % 2 === 0 && /^[\da-f]*$/i.test(source) ? Buffer.from(source, 'hex').toString('latin1') : undefined;
}

/** Pure parser, used by loader and synthetic unit/engine regressions. */
export function parseCompiledOutline(files: OutlineFiles, destinations: ReadonlyMap<string, number>): CompiledOutline {
  const toc = [...calls(files.aux ?? '', 'contentsline', 4), ...calls(files.toc ?? '', 'contentsline', 4)]
    .filter(([kind, , , target]) => Object.hasOwn(levels, kind.trim()) && target.trim());
  const sections = new Map<string, { level: number; title: string }>();
  for (const [kind, title, , target] of toc) if (!sections.has(target.trim())) sections.set(target.trim(), { level: levels[kind.trim()], title: tocTitle(title) });
  const bookmarks = calls(files.out ?? '', 'BOOKMARK', 3).flatMap(([level, target, title]) => {
    const depth = Number(level.trim());
    return Number.isInteger(depth) && depth >= -10 && depth <= 100
      ? [{ target: decodeOutlineString(target), title: decodeOutlineString(title), level: sections.get(decodeOutlineString(target))?.level ?? depth }] : [];
  });
  const bkm = calls(files.aux ?? '', 'BKM@entry', 2).flatMap(([options, title]) => {
    const encodedTarget = /(?:^|,)\s*dest\s*=\s*\{([\da-f]+)\}/i.exec(options)?.[1];
    const rawTarget = encodedTarget && fromHex(encodedTarget);
    const rawTitle = fromHex(title.trim());
    if (!rawTarget || rawTitle === undefined) return [];
    // BKM's aux format lacks depth. The compiler's contentsline supplies the exact
    // hierarchy; custom bookmarks without section metadata are omitted honestly.
    const target = Buffer.from(rawTarget, 'latin1').toString('utf8');
    const heading = sections.get(target);
    return heading ? [{ target, title: decodeOutlineString(rawTitle), level: heading.level }] : [];
  });
  const candidates = bkm.length ? bkm : bookmarks.length ? bookmarks : [...sections].map(([target, heading]) => ({ target, ...heading }));
  const seen = new Set<string>();
  const entries: OutlineEntry[] = [];
  for (const entry of candidates) {
    const target = `name:${entry.target}`;
    const page = destinations.get(target);
    if (!entry.title || !page || seen.has(target) || target.length > 2048) continue;
    seen.add(target);
    entries.push({ id: target, title: entry.title.slice(0, 4096), level: entry.level, target, page });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries.length ? { entries } : { entries, unavailable: 'No compiled outline is available. The document needs section bookmarks or a table of contents with named destinations.' };
}

/** Bound reads and confine recursive compiler aux includes to the build directory. */
async function loadSidecars(pdfPath: string, destinations: ReadonlyMap<string, number>, signal?: AbortSignal): Promise<CompiledOutline> {
  const directory = path.dirname(pdfPath);
  const stem = pdfPath.slice(0, -path.extname(pdfPath).length);
  let remaining = MAX_BYTES;
  const seen = new Set<string>();
  let canonicalDirectory: string;
  try { canonicalDirectory = await fs.realpath(directory); } catch { return parseCompiledOutline({}, destinations); }
  const read = async (file: string): Promise<string> => {
    if (signal?.aborted || seen.size >= 128) return '';
    try {
      const canonical = await fs.realpath(file);
      const relative = path.relative(canonicalDirectory, canonical);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || seen.has(canonical)) return '';
      seen.add(canonical);
      const before = await fs.stat(canonical);
      if (!before.isFile() || before.size > remaining) return '';
      remaining -= before.size;
      const value = await fs.readFile(canonical, { encoding: 'utf8', signal });
      const after = await fs.stat(canonical);
      // Ignore files being rewritten by another pass. A newer layout retries them.
      return before.size === after.size && before.mtimeMs === after.mtimeMs ? value : '';
    } catch { return ''; }
  };
  const [out, initialAux, toc] = await Promise.all([read(stem + '.out'), read(stem + '.aux'), read(stem + '.toc')]);
  const includeAux = async (source: string, parent: string): Promise<string> => {
    source = withoutComments(source);
    const parts: string[] = [];
    const command = /\\@input(?![A-Za-z@])/g;
    let copied = 0;
    for (let match; (match = command.exec(source));) {
      const arg = group(source, command.lastIndex);
      if (!arg) continue;
      parts.push(source.slice(copied, match.index));
      copied = command.lastIndex = arg.end;
      if (signal?.aborted || !arg.value.endsWith('.aux')) continue;
      const file = path.resolve(path.dirname(parent), arg.value);
      const part = await read(file);
      if (part) parts.push(await includeAux(part, file));
    }
    parts.push(source.slice(copied));
    return parts.join('\n');
  };
  return parseCompiledOutline({ out, aux: await includeAux(initialAux, stem + '.aux'), toc }, destinations);
}

interface PdfSignature { hash: string; stamp: string }
const stamp = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
async function pdfSignature(file: string, signal?: AbortSignal): Promise<PdfSignature | undefined> {
  try {
    const before = await fs.stat(file);
    if (!before.isFile() || before.size === 0 || before.size > 128 * 1024 * 1024 || signal?.aborted) return undefined;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    const after = await fs.stat(file);
    return stamp(before) === stamp(after) ? { hash: hash.digest('hex'), stamp: stamp(after) } : undefined;
  } catch { return undefined; }
}

/** The enhanced engine alternates compiler directories while its delivered PDF is
 * a stable copy. Match that PDF to a completed pass so speculative standby output
 * can never provide a newer title/tree for an older displayed layout. */
export async function loadCompiledOutline(mainPdfPath: string, destinations: ReadonlyMap<string, number>, signal?: AbortSignal, deliveredPdfPath = mainPdfPath): Promise<CompiledOutline> {
  const directory = path.dirname(mainPdfPath);
  const name = path.basename(mainPdfPath);
  let canonicalDirectory: string;
  try { canonicalDirectory = await fs.realpath(directory); } catch { return parseCompiledOutline({}, destinations); }
  const passDirectories = (await Promise.all(['pass-0', 'pass-1'].map(async slot => {
    const candidate = path.join(directory, slot);
    try {
      const canonical = await fs.realpath(candidate);
      const relative = path.relative(canonicalDirectory, canonical);
      return relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && (await fs.stat(canonical)).isDirectory() ? canonical : undefined;
    } catch { return undefined; }
  }))).filter((candidate): candidate is string => !!candidate);
  // Legacy direct compiler outputs and pure sidecar fixtures do not use pass slots.
  if (!passDirectories.length) return loadSidecars(mainPdfPath, destinations, signal);
  const delivered = await pdfSignature(deliveredPdfPath, signal);
  if (!delivered) return parseCompiledOutline({}, destinations);
  for (const pass of passDirectories) {
    if (signal?.aborted) break;
    const pdf = path.join(pass, name);
    const capture = path.join(pass, name.slice(0, -path.extname(name).length) + '.rtex.json');
    try { if (!(await fs.stat(capture)).isFile()) continue; } catch { continue; }
    const signature = await pdfSignature(pdf, signal);
    if (!signature || signature.hash !== delivered.hash) continue;
    const result = await loadSidecars(pdf, destinations, signal);
    try {
      if (signature.stamp === stamp(await fs.stat(pdf)) && !signal?.aborted) return result;
    } catch { /* a later pass reused the slot; the next completed layout retries */ }
  }
  return { entries: [], unavailable: 'The compiled outline will be available after the next complete layout update.' };
}
