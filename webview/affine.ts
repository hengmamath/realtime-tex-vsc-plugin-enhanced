import type { Item } from '../src/protocol';

/** Affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function transformPoint(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** The same PDF graphics state for painted ink and its navigation metadata. */
export class TransformState {
  matrix: Mat = IDENTITY;
  private stack: Mat[] = [];

  apply(item: Item, dx = 0, dy = 0): void {
    if (item[0] !== 'M') return;
    const [, op, x, y, data] = item as [string, string, number, number, string];
    if (op === 'save') this.stack.push(this.matrix);
    else if (op === 'restore') this.matrix = this.stack.pop() ?? IDENTITY;
    else {
      const v = (data ?? '').trim().split(/\s+/).map(Number);
      if (v.length !== 4 || !v.every(Number.isFinite) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      // PDF matrices are y-up; display lists are y-down: conjugate by the flip.
      const [a, b, c, d] = [v[0], -v[1], -v[2], v[3]];
      const px = x + dx;
      const py = y + dy;
      this.matrix = mul(this.matrix, [a, b, c, d, px - (a * px + c * py), py - (b * px + d * py)]);
    }
  }
}
