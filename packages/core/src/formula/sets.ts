/**
 * Set algebra over the strings in cells (FX-09, ADR-053).
 *
 * A cell's text is a set: its elements are the runs between commas,
 * semicolons and newlines, each trimmed and NFC-normalised, empties dropped.
 * Equality is exact after that — case-sensitive, so `Apple` and `apple` are
 * two elements. A set keeps first-seen order (the left operand's order, then
 * the right operand's new elements) so a result reads the way its sources do
 * and is the same on every replica.
 *
 * A separator inside parentheses does not split: `(1, 2), (1, 3)` is the two
 * pairs `Cross` renders, so a product feeds another set function unchanged.
 * Braces nest the same way, so `∅, {a}, {a, b}` — a `Power` result (FX-10) —
 * is three elements. Consequently a lone `(` or `{` swallows the rest of the
 * text into one element.
 * Quotes are not delimiters: `"a, b", c` is three elements.
 *
 * Framework-free: strings in, arrays out.
 */

const SEPARATORS = new Set([',', ';', '\n', '\r']);

/**
 * The most tuples a Cross may build (ADR-053): two 3,000-element cells would
 * otherwise make 9,000,000 tuples and ~137 MB across the Worker boundary. The
 * evaluator checks `crossCardinality` before allocating anything.
 */
export const MAX_CROSS_TUPLES = 10_000;

/**
 * The elements a text contributes, in order of appearance, duplicates
 * collapsed on first occurrence.
 */
export function splitSetElements(text: string): string[] {
  return dedupe(splitSetPieces(text));
}

/**
 * The elements a text contributes, in order of appearance, repeats kept: what Split into
 * rows writes one row per (SET-02), so a repeat typed in a comma value survives as a
 * flagged bag entry rather than vanishing.
 */
export function splitSetPieces(text: string): string[] {
  return splitSetSpans(text).map(({ start, end }) => normaliseElement(text.slice(start, end)));
}

/** Where one piece of a text sits: UTF-16 offsets, surrounding whitespace excluded. */
export interface SetPieceSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The pieces of `splitSetPieces` as offsets into `text`, trimmed and never empty, so a
 * caller holding marked text can cut it at the same places (Split into rows keeps marks).
 */
export function splitSetSpans(text: string): SetPieceSpan[] {
  const spans: SetPieceSpan[] = [];
  const push = (from: number, to: number): void => {
    const raw = text.slice(from, to);
    const start = from + (raw.length - raw.trimStart().length);
    const end = to - (raw.length - raw.trimEnd().length);
    if (end > start) spans.push({ start, end });
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === '}') {
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && ch !== undefined && SEPARATORS.has(ch)) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, text.length);
  return spans;
}

/** One element as the algebra compares it: trimmed, NFC. */
export function normaliseElement(text: string): string {
  return text.trim().normalize('NFC');
}

/** First occurrence wins; order is first-seen. */
export function dedupe(elements: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of elements) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** A ∪ B ∪ …: every element of the first set, then each later set's new elements. */
export function union(sets: readonly (readonly string[])[]): string[] {
  return dedupe(sets.flat());
}

/** A ∩ B ∩ …: the elements of the first set that every other set holds, in the first set's order. */
export function intersection(sets: readonly (readonly string[])[]): string[] {
  const [first = [], ...rest] = sets;
  const others = rest.map((s) => new Set(s));
  return dedupe(first).filter((e) => others.every((s) => s.has(e)));
}

/** A \ (B ∪ …): the elements of the first set that no other set holds, in the first set's order. */
export function difference(sets: readonly (readonly string[])[]): string[] {
  const [first = [], ...rest] = sets;
  const taken = new Set(rest.flat());
  return dedupe(first).filter((e) => !taken.has(e));
}

/** Aᶜ within U: the elements of the universe `u` that `a` does not hold, in the universe's order. */
export function complement(a: readonly string[], u: readonly string[]): string[] {
  const inA = new Set(a);
  return dedupe(u).filter((e) => !inA.has(e));
}

/** |A| · |B| · …, over the deduplicated operands, without building a tuple. */
export function crossCardinality(sets: readonly (readonly string[])[]): number {
  return sets.reduce((n, set) => n * dedupe(set).length, sets.length === 0 ? 0 : 1);
}

/**
 * A × B × …: every ordered tuple, first-operand-major, rendered `(a, b)` /
 * `(a, b, c)`. An empty operand makes an empty product. Unbounded: the
 * caller checks `crossCardinality` against `MAX_CROSS_TUPLES` first.
 */
export function cross(sets: readonly (readonly string[])[]): string[] {
  return crossTuples(sets).map(renderTuple);
}

/**
 * `cross` before rendering: each tuple's members as an array. A spread
 * computed column (SET-09) writes these, since the rendering cannot always be
 * split back — `(sad :(, x)` reads as one member to a bracket-depth splitter.
 */
export function crossTuples(sets: readonly (readonly string[])[]): string[][] {
  let tuples: string[][] = [[]];
  for (const set of sets) {
    const next: string[][] = [];
    for (const tuple of tuples) for (const e of dedupe(set)) next.push([...tuple, e]);
    tuples = next;
  }
  return tuples;
}

export function renderTuple(members: readonly string[]): string {
  return `(${members.join(', ')})`;
}

/**
 * The first element `power` cannot wrap in braces and still re-split to
 * itself, or `undefined` when there is none (FX-10). An element must keep its
 * brackets paired — `a}` or `(x` would move the splitter's depth inside the
 * rendered subset — and hold no separator outside them: a Split piece such as
 * `x, y` would render `{x, y}`, the same text as the subset of `x` and `y`.
 * The evaluator refuses such a set rather than render an ambiguous result.
 */
export function unenclosableElement(set: readonly string[]): string | undefined {
  return set.find((e) => {
    let depth = 0;
    for (const ch of e) {
      if (ch === '(' || ch === '{') depth += 1;
      else if (ch === ')' || ch === '}') {
        depth -= 1;
        if (depth < 0) return true;
      } else if (depth === 0 && SEPARATORS.has(ch)) return true;
    }
    return depth !== 0;
  });
}

/** 2^|A| over the deduplicated set, without building a subset (FX-10). */
export function powerCardinality(set: readonly string[]): number {
  return 2 ** dedupe(set).length;
}

/**
 * 𝒫(A): every subset, the empty set first, then by size; within a size in
 * combination order over A's first-seen order. Rendered `{a, b}`, the empty
 * subset `∅`. Unbounded: the caller checks `powerCardinality` against
 * `MAX_CROSS_TUPLES` and `unenclosableElement` first (FX-10).
 *
 * Each subset is spelled in A's order, so the same subset of a differently
 * ordered operand is a different string: `{1, 2}` from `Power("1, 2")` and
 * `{2, 1}` from `Power("2, 1")` do not compare equal (ADR-056, known limit).
 */
export function power(set: readonly string[]): string[] {
  const a = dedupe(set);
  const out: string[] = ['∅'];
  // Subsets of size k as index combinations, ascending; k grows by one per pass.
  let level: number[][] = [[]];
  for (let k = 1; k <= a.length; k += 1) {
    const next: number[][] = [];
    for (const combo of level) {
      for (let i = (combo.at(-1) ?? -1) + 1; i < a.length; i += 1) next.push([...combo, i]);
    }
    for (const combo of next) out.push(`{${combo.map((i) => a[i] ?? '').join(', ')}}`);
    level = next;
  }
  return out;
}
