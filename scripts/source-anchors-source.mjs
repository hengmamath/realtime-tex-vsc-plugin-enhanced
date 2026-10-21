/** Strip ordinary TeX comments. A percent is escaped only after an odd run of backslashes.
 * This is a source-line utility, not a TeX interpreter (verbatim/custom catcodes are excluded).
 */
export function uncommented(line) {
  let slashes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '%' && slashes % 2 === 0) return line.slice(0, i);
    slashes = ch === '\\' ? slashes + 1 : 0;
  }
  return line;
}
