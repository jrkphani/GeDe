/**
 * Ordering (SORT-02, PRD §9, §22). A–Z and Z–A use `Intl.Collator` for the
 * active locale — numeric, base sensitivity, as PRD §23 fixes it — so Tamil,
 * Hindi and Telugu order by their script's rules rather than by code point:
 * Grantha letters after the native Tamil consonants, a nukta form beside its
 * base letter, digits of any script by value.
 *
 * A Number, Currency or Date cell orders by its value (dates chronologically
 * "regardless of pattern", §22); text after values, blanks always last so an
 * empty row never leads a sorted table in either direction.
 *
 * Chars and Words order longest first ("bringing the longest paragraphs to
 * the top"); Freq orders most frequent first. Ties fall back to A–Z, and the
 * sort is stable, so equal keys keep document order.
 */
import type { CellFormat } from '../format/types.js';
import { resolveValue } from '../format/value.js';
import { graphemes } from '../search/graphemes.js';
import type { SortMode } from './types.js';

export function createCollator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
}

/** Value rank: values before dates before text before blanks. */
type Rank = 0 | 1 | 2 | 3;

export interface SortKey {
  readonly rank: Rank;
  /** Numeric value (rank 0) or epoch-ish ISO string compare (rank 1). */
  readonly num: number;
  readonly iso: string;
  readonly text: string;
}

export function sortKey(text: string, format: CellFormat): SortKey {
  const value = resolveValue(text, format);
  switch (value.kind) {
    case 'blank':
      return { rank: 3, num: 0, iso: '', text: '' };
    case 'number':
    case 'currency':
      return { rank: 0, num: value.value, iso: '', text };
    case 'date':
      return { rank: 1, num: 0, iso: value.iso, text };
    case 'text':
    case 'invalid':
      return { rank: 2, num: 0, iso: '', text };
  }
}

let wordSegmenters: Map<string, Intl.Segmenter | null> | undefined;

function wordSegmenter(locale: string): Intl.Segmenter | null {
  wordSegmenters ??= new Map();
  let seg = wordSegmenters.get(locale);
  if (seg === undefined) {
    seg =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(locale, { granularity: 'word' })
        : null;
    wordSegmenters.set(locale, seg);
  }
  return seg;
}

/** Characters as user-perceived clusters (SORT-03's unit), never UTF-16 units. */
export function charCount(text: string): number {
  return graphemes(text.trim()).length;
}

/** Words by the locale's segmentation; whitespace runs where `Intl.Segmenter` is missing. */
export function wordCount(text: string, locale: string): number {
  const seg = wordSegmenter(locale);
  if (seg === null) return text.trim().split(/\s+/).filter(Boolean).length;
  let n = 0;
  for (const s of seg.segment(text)) if (s.isWordLike === true) n += 1;
  return n;
}

/** The identity Freq counts: NFC, trimmed, case-folded — "Singapore" and "singapore " are one string. */
export function freqKey(text: string): string {
  return text.normalize('NFC').trim().toLocaleLowerCase();
}

export interface Comparable {
  readonly key: SortKey;
  readonly chars: number;
  readonly words: number;
  readonly freq: number;
}

/** A–Z: by rank, then by value; text through the collator. */
function compareAz(a: SortKey, b: SortKey, collator: Intl.Collator): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  switch (a.rank) {
    case 0:
      return a.num - b.num || collator.compare(a.text, b.text);
    case 1:
      return (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0) || collator.compare(a.text, b.text);
    case 2:
      return collator.compare(a.text, b.text);
    case 3:
      return 0;
  }
}

/** Blanks last whatever the mode; `then` decides the rest. */
function blanksLast(a: SortKey, b: SortKey, then: () => number): number {
  const ab = a.rank === 3;
  const bb = b.rank === 3;
  if (ab || bb) return ab === bb ? 0 : ab ? 1 : -1;
  return then();
}

export function createComparator(
  mode: SortMode,
  collator: Intl.Collator,
): (a: Comparable, b: Comparable) => number {
  switch (mode) {
    case 'az':
      return (a, b) => compareAz(a.key, b.key, collator);
    case 'za':
      return (a, b) => blanksLast(a.key, b.key, () => -compareAz(a.key, b.key, collator));
    case 'chars':
      return (a, b) =>
        blanksLast(a.key, b.key, () => b.chars - a.chars || compareAz(a.key, b.key, collator));
    case 'words':
      return (a, b) =>
        blanksLast(a.key, b.key, () => b.words - a.words || compareAz(a.key, b.key, collator));
    case 'freq':
      return (a, b) =>
        blanksLast(a.key, b.key, () => b.freq - a.freq || compareAz(a.key, b.key, collator));
  }
}
