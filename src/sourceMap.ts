/** A target in the current rendered frame, in TeX scaled points from the page top-left. */
export interface PreviewTarget {
  page: number;
  /** Baseline of the target row. */
  y: number;
  x: number;
}
