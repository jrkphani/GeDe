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
 *
 * Framework-free: strings in, arrays out.
 */

const SEPARATORS = new Set([',', ';', '\n', '\r']);

/**
 * The elements a text contributes, in order of appearance, duplicates
 * collapsed on first occurrence.
 */
export function splitSetElements(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && ch !== undefined && SEPARATORS.has(ch)) {
      pieces.push(text.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(text.slice(start));
  return dedupe(pieces.map(normaliseElement).filter((p) => p !== ''));
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

/**
 * A × B × …: every ordered tuple, first-operand-major, rendered `(a, b)` /
 * `(a, b, c)`. An empty operand makes an empty product.
 */
export function cross(sets: readonly (readonly string[])[]): string[] {
  let tuples: string[][] = [[]];
  for (const set of sets) {
    const next: string[][] = [];
    for (const tuple of tuples) for (const e of dedupe(set)) next.push([...tuple, e]);
    tuples = next;
  }
  return tuples.map((t) => `(${t.join(', ')})`);
}
