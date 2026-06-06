/**
 * Levenshtein edit distance — naive O(n*m) DP.
 *
 * Used by the unit-parse-feedback loop to quantify how heavily a user has
 * rewritten a parsed unit's text. We only call this on unit text bodies,
 * which are typically <2KB, so the naive table is fine. A two-row rolling
 * buffer keeps memory at O(min(n,m)).
 *
 * Returns 0 for identical strings, max(a.length, b.length) for total
 * rewrites. Treats null/undefined as empty string.
 */
export function editDistance(a, b) {
  const s1 = a == null ? "" : String(a);
  const s2 = b == null ? "" : String(b);

  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  // Make s1 the shorter side so the rolling buffer is O(min).
  const [short, long] =
    s1.length <= s2.length ? [s1, s2] : [s2, s1];

  const n = short.length;
  const m = long.length;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ci = long.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = short.charCodeAt(j - 1) === ci ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[n];
}
