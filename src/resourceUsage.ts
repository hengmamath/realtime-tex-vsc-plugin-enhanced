// Resource tables may contain virtual fonts and image metadata that never draw anything.
// Resolve only resources referenced by actual display-list items, on both host and webview.
import { fontKey } from './fontKey';
import type { DisplayList, FontDesc, ImageInfo, Item, LayoutUpdateEvent } from './protocol';

export interface UsedResources {
  /** Actual glyph fonts, keyed by the shared font-resource key (not a process-local id). */
  fonts: ReadonlyMap<string, FontDesc>;
  /** Actual image resources, keyed by source file. Cached PDF pictures are excluded. */
  images: ReadonlyMap<string, ImageInfo>;
  /** An actual glyph/image refers to metadata absent from this display list. */
  missingMetadata: boolean;
  /** Unsupported drawing commands, cached PDF pictures, or extractor flags need the PDF. */
  requiresPdf: boolean;
}

/** The image an IMAGE item refers to. LuaTeX image indices and PDF object numbers can
 * differ; the rank fallback mirrors their common creation order. Cached pictures are not
 * LuaTeX images and must never shift that fallback's indices. */
export function imageInfo(dl: DisplayList, index: number): ImageInfo | undefined {
  const infos = dl.images_info;
  if (!infos) return undefined;
  const direct = infos[String(index)];
  if (direct) return direct;
  const sorted = Object.keys(infos)
    .filter((key) => !infos[key].cached_picture)
    .map(Number)
    .sort((a, b) => a - b);
  const key = sorted[index - 1];
  return key === undefined ? undefined : infos[String(key)];
}

export function usedResources(dl: DisplayList): UsedResources {
  const fonts = new Map<string, FontDesc>();
  const images = new Map<string, ImageInfo>();
  let missingMetadata = false;
  const flags = dl.flags;
  let requiresPdf = !!flags && typeof flags === 'object' && !Array.isArray(flags) && Object.keys(flags).length > 0;
  const inspect = (items: readonly Item[]) => {
    for (const item of items) {
      if (item[0] === 'g') {
        const desc = dl.fonts?.[String(item[1])];
        if (desc) fonts.set(fontKey(desc), desc);
        else missingMetadata = true;
      } else if (item[0] === 'i') {
        const info = imageInfo(dl, item[1] as number);
        if (!info?.file) missingMetadata = true;
        else if (info.cached_picture) requiresPdf = true;
        else images.set(info.file, info);
      } else if (item[0] === 'l' || item[0] === 'u') {
        requiresPdf = true;
      }
    }
  };
  inspect(dl.other ?? []);
  for (const line of dl.lines) inspect(line.items);
  return { fonts, images, missingMetadata, requiresPdf };
}

/** Missing *used* resources require PDF fallback; unrelated table entries do not. */
export function displayListsNeedPdf(dls: readonly DisplayList[], missing: ReadonlySet<string>): boolean {
  return dls.some((dl) => {
    const used = usedResources(dl);
    return used.missingMetadata || used.requiresPdf ||
      [...used.fonts.keys()].some((key) => missing.has(key)) ||
      [...used.images.keys()].some((file) => missing.has(`image:${file}`));
  });
}

/** The engine's PDF path is a document-wide availability hint. Only changed pages that
 * actually need fallback require a new PDF transfer; unrelated degraded pages keep the
 * PDF from their own last layout. Missing `exact` in older protocols remains conservative. */
export function layoutNeedsPdf(
  update: Pick<LayoutUpdateEvent, 'pages_changed' | 'pdf_fallback'>,
  missing: ReadonlySet<string>,
): boolean {
  return update.pages_changed.some((page) => !page.exact) ||
    displayListsNeedPdf(update.pages_changed.map((page) => page.dl), missing);
}
