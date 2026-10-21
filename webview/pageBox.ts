// Page geometry shared by layout and painting. Pure module, unit-tested with node:test.

export interface PageBox {
  /** Backing-store size of the page canvas, device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** CSS size that shows those pixels 1:1 at `dpr`. */
  cssWidth: number;
  cssHeight: number;
}

/**
 * The canvas size of a page and the CSS box it is shown in. Rounding the CSS size and the pixel
 * size separately leaves them a device pixel apart in half of all cases (A4 at 100 % on a 2×
 * screen: 1587 pixels shown in 1588), and the browser then resamples the whole page, which
 * softens every glyph. The CSS size is derived from the whole number of device pixels instead.
 */
export function pageBox(widthSp: number, heightSp: number, cssPerSp: number, dpr: number): PageBox {
  const pixelWidth = Math.max(1, Math.round(widthSp * cssPerSp * dpr));
  const pixelHeight = Math.max(1, Math.round(heightSp * cssPerSp * dpr));
  return { pixelWidth, pixelHeight, cssWidth: pixelWidth / dpr, cssHeight: pixelHeight / dpr };
}
