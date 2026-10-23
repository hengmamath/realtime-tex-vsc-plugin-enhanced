/** Compiler-produced navigation, independent of preview pixels and PDF fallback. */
export interface OutlineEntry {
  id: string;
  title: string;
  level: number;
  target: string;
  page?: number;
}

/** Personal presentation preferences; no bookmarks or document edits. */
export interface OutlineViewState {
  open: boolean;
  width: number;
  collapsed: string[];
}
