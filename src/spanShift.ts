// A file's spans kept in step with an edit the engine acknowledged, so the gutter does not fetch
// every span of the file after each keystroke. Pure module.
import type { EditOutcome, Span } from './protocol';

/**
 * The spans after bytes `[start, end)` were replaced by `inserted` bytes, when the engine's
 * outcome shows the boundaries did not move: the edit stayed strictly inside the one span it
 * touched, or inside the whitespace between two spans (nothing touched). Undefined otherwise:
 * fetch the spans again.
 */
export function shiftSpans(spans: readonly Span[], start: number, end: number, inserted: number, outcome: EditOutcome): Span[] | undefined {
  if (outcome.added.length || outcome.removed.length || outcome.touched.length > 1) return undefined;
  const delta = inserted - (end - start);
  const out: Span[] = [];
  let inside = 0;
  for (const s of spans) {
    if (s.range.end <= start) out.push(s);
    else if (s.range.start >= end) out.push({ ...s, range: { start: s.range.start + delta, end: s.range.end + delta } });
    else if (s.range.start < start && end < s.range.end && s.id === outcome.touched[0]) {
      inside++;
      out.push({ ...s, range: { start: s.range.start, end: s.range.end + delta } });
    } else return undefined;
  }
  return inside === outcome.touched.length ? out : undefined;
}
