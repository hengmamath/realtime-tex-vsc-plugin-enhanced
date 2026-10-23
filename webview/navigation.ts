/** Reading positions belong to this preview, independently of VS Code's editor history. */
export interface ReadingPosition {
  /** One-based page number. */
  page: number;
  /** Viewport top relative to the page height; survives zoom changes. */
  fraction: number;
  /** Horizontal scroll in TeX scaled points. */
  left: number;
}

export type NavigationDirection = 'back' | 'forward';

function same(a: ReadingPosition, b: ReadingPosition): boolean {
  return a.page === b.page && Math.abs(a.fraction - b.fraction) < 0.00001 && Math.abs(a.left - b.left) < 1;
}

export class ReadingHistory {
  private backward: ReadingPosition[] = [];
  private forward: ReadingPosition[] = [];

  constructor(private readonly limit = 200) {}

  /** Whether the corresponding toolbar control can restore a remembered position. */
  canMove(direction: NavigationDirection): boolean {
    return (direction === 'back' ? this.backward : this.forward).length > 0;
  }

  /** Record the position before following a reference; a new branch drops forward history. */
  remember(position: ReadingPosition): void {
    this.push(this.backward, position);
    this.forward = [];
  }

  move(direction: NavigationDirection, current: ReadingPosition): ReadingPosition | undefined {
    const source = direction === 'back' ? this.backward : this.forward;
    const destination = direction === 'back' ? this.forward : this.backward;
    const previous = source.pop();
    if (!previous) return undefined;
    this.push(destination, current);
    return { ...previous };
  }

  clear(): void {
    this.backward = [];
    this.forward = [];
  }

  private push(stack: ReadingPosition[], position: ReadingPosition): void {
    if (stack.length && same(stack[stack.length - 1], position)) return;
    stack.push({ ...position });
    if (stack.length > this.limit) stack.shift();
  }
}

/** Accept one-based page numbers, including pasted whitespace and leading zeros. */
export function parsePageNumber(value: string, pagesTotal: number): number | undefined {
  if (!Number.isSafeInteger(pagesTotal) || pagesTotal < 1) return undefined;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const page = Number(trimmed);
  return Number.isSafeInteger(page) && page >= 1 && page <= pagesTotal ? page : undefined;
}

export function navigationKey(event: {
  key: string; code?: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean;
}): NavigationDirection | undefined {
  if (event.ctrlKey || event.shiftKey || event.metaKey === event.altKey) return undefined;
  if (event.metaKey) {
    if (event.key === '[') return 'back';
    if (event.key === ']') return 'forward';
    if (event.code === 'BracketLeft') return 'back';
    if (event.code === 'BracketRight') return 'forward';
    return undefined;
  }
  if (event.key === 'ArrowLeft') return 'back';
  if (event.key === 'ArrowRight') return 'forward';
  return undefined;
}
