// Acceptance checks for the opt-in source-anchor experiment. These checks verify
// file and line only: a marker's source column is not an accuracy measurement.
// Named, exact exceptions document current heuristic limitations. A percentage
// threshold would hide an unrelated regression with the same aggregate score.

export class AnchorAssertionError extends Error {
  constructor(failures) {
    super(`Source-anchor acceptance failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    this.name = 'AnchorAssertionError';
    this.failures = failures;
  }
}

const point = (value, defaultFile) => {
  if (typeof value === 'number') return { file: defaultFile, line: value };
  if (typeof value === 'string') {
    const match = /^(.*):(\d+)$/.exec(value);
    return match ? { file: match[1], line: Number(match[2]) } : undefined;
  }
  return value;
};
const validPoint = (p) => p && typeof p.file === 'string' && p.file.length > 0 && Number.isInteger(p.line) && p.line > 0;
const samePoint = (a, b) => validPoint(a) && validPoint(b) && a.file === b.file && a.line === b.line;
const label = (p) => validPoint(p) ? `${p.file}:${p.line}` : 'missing/invalid file:line';
const count = (n) => Number.isInteger(n) && n >= 0;
const validName = (name) => typeof name === 'string' && name.trim().length > 0;
const RULES = ['after', 'before', 'nearest'];

/**
 * Throw on malformed or unsuccessful experimental evidence. The CLI catches
 * this exception and exits nonzero. SyncTeX agreement is deliberately excluded:
 * the independent source markers, not another mapper, are the ground truth.
 *
 * @param {object} report
 * @param {object} [policy]
 * @returns {{precision: string, markerExceptions: string[], liveExceptions: string[]}}
 */
export function assertAnchorExperiment(report, policy = {}) {
  const failures = [];
  const markerExceptions = [], liveExceptions = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  for (const kind of ['marker', 'live']) {
    const rules = policy[`${kind}Rules`];
    if (rules !== undefined) check(Array.isArray(rules) && rules.length > 0 &&
      rules.every((rule) => RULES.includes(rule)) && new Set(rules).size === rules.length,
    `${kind}Rules must contain unique known rules (after, before, nearest)`);
    const exceptions = policy[`${kind}Exceptions`];
    if (exceptions !== undefined) {
      check(Array.isArray(exceptions), `${kind}Exceptions must be an array`);
      for (const entry of Array.isArray(exceptions) ? exceptions : []) check(entry && validName(entry.marker) &&
        RULES.includes(entry.rule) && validPoint(entry.expected) && validPoint(entry.actual) && validName(entry.reason),
      `invalid ${kind} exception: an exact marker, rule, expected/actual file:line and reason are required`);
    }
  }
  for (const name of ['expectedMarkers', 'expectedLiveMarkers']) if (policy[name] !== undefined) {
    const expected = policy[name];
    check(Array.isArray(expected), `${name} must be an array`);
    if (Array.isArray(expected)) {
      const identities = expected.map((entry) => typeof entry === 'string' ? entry : entry?.marker);
      check(identities.every(validName) && new Set(identities).size === identities.length,
        `${name} must contain valid, unique marker identities`);
      if (name === 'expectedMarkers') check(expected.every((entry) => typeof entry === 'string' || validPoint(entry)),
        'expectedMarkers points must contain valid source file:line values');
      else check(expected.every((entry) => typeof entry === 'string'), 'expectedLiveMarkers must contain marker names');
    }
  }
  // Reject policy mistakes before using them to select checks. In particular []
  // must not make a failed experiment pass by disabling every accuracy rule.
  if (failures.length) throw new AnchorAssertionError(failures);
  const rows = report.rows;
  check(rows && count(rows.rows) && rows.rows > 0, 'background capture has no valid rows');
  check(rows?.mismatched === 0, `row geometry mismatches: ${rows?.mismatched ?? 'missing count'}`);
  check(Array.isArray(rows?.unknownTags) && rows.unknownTags.length === 0,
    `unresolved source-file tags: ${JSON.stringify(rows?.unknownTags ?? 'missing tag coverage')}`);
  if (rows?.withAnchors !== undefined) check(count(rows.withAnchors) && rows.withAnchors <= rows.rows, 'invalid anchor coverage count');

  if (report.displayLists !== undefined) {
    const dl = report.displayLists;
    check(dl?.same === true && count(dl.pagesOff) && dl.pagesOff > 0 && dl.pagesOff === dl.pagesOn,
      'display lists differ with anchors off/on, or compared page sets are empty/incomplete');
  }

  const accept = (kind, marker, rule, expected, actual) => {
    if (samePoint(expected, actual)) return;
    const exceptions = kind === 'marker' ? policy.markerExceptions : policy.liveExceptions;
    const exception = (exceptions ?? []).find((e) => e.marker === marker && e.rule === rule &&
      typeof e.reason === 'string' && e.reason.trim().length > 0 && samePoint(e.expected, expected) && samePoint(e.actual, actual));
    if (exception) (kind === 'marker' ? markerExceptions : liveExceptions).push(`${marker}/${rule}`);
    else failures.push(`${kind} ${marker}/${rule}: expected ${label(expected)}, got ${label(actual)}`);
  };

  if (report.markers !== undefined || policy.expectedMarkers !== undefined) {
    const markers = report.markers;
    check(markers && count(markers.total) && markers.total > 0, 'source-marker report is missing or empty');
    check(markers?.decoys === 0, `comment markers appeared in output: ${markers?.decoys ?? 'missing count'}`);
    check(Array.isArray(markers?.checks) && markers.checks.length === markers.total, 'source-marker checks do not cover every source marker');
    const seen = new Map();
    for (const entry of markers?.checks ?? []) {
      check(typeof entry.marker === 'string' && entry.marker.length > 0, 'source-marker identity is missing');
      check(!seen.has(entry.marker), `duplicate source marker ${entry.marker}`);
      seen.set(entry.marker, entry);
      check(entry.found === true, `source marker ${entry.marker} is missing from output`);
      check(validPoint(entry.expected), `source marker ${entry.marker} has no valid source file:line`);
      for (const rule of policy.markerRules ?? ['after']) accept('marker', entry.marker, rule, entry.expected, entry.got?.[rule]);
    }
    if (policy.expectedMarkers !== undefined) {
      check(Array.isArray(policy.expectedMarkers), 'expected-marker policy is not an array');
      const expected = new Set();
      for (const entry of policy.expectedMarkers ?? []) {
        const name = typeof entry === 'string' ? entry : entry.marker;
        check(!expected.has(name), `duplicate expected-marker policy ${name}`);
        expected.add(name);
        const actual = seen.get(name);
        check(Boolean(actual), `fixture marker ${name} was removed from the source/report`);
        if (typeof entry !== 'string' && actual) check(samePoint(entry, actual.expected),
          `fixture marker ${name} source changed: expected ${label(entry)}, got ${label(actual.expected)}`);
      }
      for (const name of seen.keys()) check(expected.has(name), `fixture marker ${name} has no expected result`);
    }
  }

  if (report.live !== undefined || policy.expectedLiveMarkers !== undefined) {
    check(Array.isArray(report.live), 'live-result report is missing');
    const seen = new Set();
    for (const entry of report.live ?? []) {
      check(typeof entry.marker === 'string' && entry.marker.length > 0 && !seen.has(entry.marker), `missing or duplicate live-marker identity ${entry.marker}`);
      seen.add(entry.marker);
      check(entry.routed === 'fast' && entry.event === 'ParagraphUpdate' && entry.status === 'ok' && !entry.missing && !entry.error,
        `live ${entry.marker}: expected a successful ParagraphUpdate with matched anchors`);
      const expected = point(entry.expected);
      check(validPoint(expected), `live ${entry.marker}: missing valid expected file:line`);
      for (const rule of policy.liveRules ?? ['after']) accept('live', entry.marker, rule, expected, point(entry[rule], expected?.file));
    }
    for (const marker of policy.expectedLiveMarkers ?? []) check(seen.has(marker), `live result for ${marker} is missing`);
  }

  if (report.rebase !== undefined || policy.expectedRebaseCount !== undefined) {
    const rebase = report.rebase;
    check(rebase && count(rebase.total) && rebase.total > 0 && rebase.rebased === rebase.total,
      'source-line rebasing is missing, empty, or does not match every checked marker');
    if (policy.expectedRebaseCount !== undefined) check(rebase?.total === policy.expectedRebaseCount,
      `expected ${policy.expectedRebaseCount} rebasing checks, got ${rebase?.total ?? 'none'}`);
  }
  check(report.projectFilesUnchanged === true, 'project source files changed, or preservation was not checked');
  if (failures.length) throw new AnchorAssertionError(failures);
  return { precision: 'file:line', markerExceptions, liveExceptions };
}
