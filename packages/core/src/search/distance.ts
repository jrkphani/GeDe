/**
 * Edit distance over grapheme-cluster arrays (FIND-05, SORT-03).
 *
 * Two algorithms, both Levenshtein (insert, delete, substitute — each one
 * edit), both bounded so a hopeless comparison stops early:
 *
 * - `editDistance` compares two whole strings.
 * - `approximateFind` finds the best *substring* of a haystack within `max`
 *   edits of the needle (Sellers 1980: a Levenshtein table whose first row is
 *   all zeros, so a match may start anywhere). "Sngapore" finds "Singapore"
 *   inside "Singapore office" at distance 1.
 */

export interface Found {
  /** Edits between the needle and the matched span. */
  readonly distance: number;
  /** Grapheme offset of the span's first cluster in the haystack. */
  readonly start: number;
  /** Grapheme offset one past the span's last cluster. */
  readonly end: number;
}

/** Levenshtein distance between two cluster arrays, capped at `max + 1`. */
export function editDistance(a: readonly string[], b: readonly string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  const d = prev[b.length] ?? max + 1;
  return d > max ? max + 1 : d;
}

/** Exact cluster-array substring search; the first occurrence wins. */
export function exactFind(haystack: readonly string[], needle: readonly string[]): Found | null {
  const m = needle.length;
  if (m === 0) return { distance: 0, start: 0, end: 0 };
  const last = haystack.length - m;
  const first = needle[0];
  for (let s = 0; s <= last; s += 1) {
    if (haystack[s] !== first) continue;
    let k = 1;
    while (k < m && haystack[s + k] === needle[k]) k += 1;
    if (k === m) return { distance: 0, start: s, end: s + m };
  }
  return null;
}

/**
 * Best approximate occurrence of `needle` in `haystack` within `max` edits, or
 * null. Ties resolve to the lower distance, then the earliest start, then the
 * span whose length is closest to the needle's. `max = 0` short-circuits to
 * `exactFind`.
 */
function better(distance: number, start: number, end: number, best: Found, m: number): boolean {
  if (distance !== best.distance) return distance < best.distance;
  if (start !== best.start) return start < best.start;
  return Math.abs(end - start - m) < Math.abs(best.end - best.start - m);
}

export function approximateFind(
  haystack: readonly string[],
  needle: readonly string[],
  max: number,
): Found | null {
  if (max <= 0) return exactFind(haystack, needle);
  const m = needle.length;
  const n = haystack.length;
  if (m === 0) return { distance: 0, start: 0, end: 0 };
  // A needle longer than the haystack plus the budget cannot fit within `max`
  // edits: skip the O(n·m) table, so a pasted essay costs nothing per cell.
  if (m > n + max) return null;
  // An exact hit is always the best answer and costs a fraction of the table.
  const exact = exactFind(haystack, needle);
  if (exact !== null) return exact;
  if (n === 0) return null; // a span must cover at least one cluster

  // Column j of the table is the needle aligned to end at haystack[j-1].
  // `cost[i]` / `start[i]` are the current column; `pcost` / `pstart` the previous.
  let pcost = new Array<number>(m + 1);
  let pstart = new Array<number>(m + 1);
  let cost = new Array<number>(m + 1);
  let start = new Array<number>(m + 1);
  for (let i = 0; i <= m; i += 1) {
    pcost[i] = i; // needle prefix deleted before the haystack begins
    pstart[i] = 0;
  }
  let best: Found | null = null;
  for (let j = 1; j <= n; j += 1) {
    cost[0] = 0;
    start[0] = j; // a match may begin at any cluster: the free-start row
    const hj = haystack[j - 1];
    for (let i = 1; i <= m; i += 1) {
      const sub = (pcost[i - 1] ?? 0) + (needle[i - 1] === hj ? 0 : 1);
      const del = (cost[i - 1] ?? 0) + 1; // needle cluster unmatched
      const ins = (pcost[i] ?? 0) + 1; // haystack cluster skipped
      // Among equal-cost alignments keep the earliest start, so the span shown
      // is the whole near-miss word ("Singapore" for "Sngapore"), not its tail.
      let c = sub;
      let s = pstart[i - 1] ?? 0;
      if (ins < c || (ins === c && (pstart[i] ?? 0) < s)) {
        c = ins;
        s = pstart[i] ?? 0;
      }
      if (del < c || (del === c && (start[i - 1] ?? 0) < s)) {
        c = del;
        s = start[i - 1] ?? 0;
      }
      cost[i] = c;
      start[i] = s;
    }
    const d = cost[m] ?? max + 1;
    if (d <= max) {
      const s = start[m] ?? 0;
      if (s < j && (best === null || better(d, s, j, best, m))) {
        best = { distance: d, start: s, end: j };
      }
    }
    [pcost, cost] = [cost, pcost];
    [pstart, start] = [start, pstart];
  }
  return best;
}
