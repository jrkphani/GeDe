/**
 * Grapheme clusters (SORT-03, FIND-05). Fuzzy matching counts edits in
 * user-perceived characters, never UTF-16 units: a Tamil conjunct such as
 * "க்ஷ" or a Devanagari "क्ष" is one cluster, so one typo in it is one edit.
 *
 * `Intl.Segmenter` is available in every runtime GeDe targets (Node 22, the
 * evergreen browsers); the code-point fallback keeps the package loadable
 * where it is not, at the cost of counting combining marks separately.
 */

let segmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  segmenter =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  return segmenter;
}

/** Split text into grapheme clusters, NFC-normalised so composed and decomposed forms agree. */
export function graphemes(text: string): string[] {
  const normalised = text.normalize('NFC');
  const seg = graphemeSegmenter();
  if (seg === null) return Array.from(normalised);
  const out: string[] = [];
  for (const { segment } of seg.segment(normalised)) out.push(segment);
  return out;
}

/** Case-folded clusters for matching: locale-independent lower case, one cluster per entry. */
export function foldGraphemes(text: string): string[] {
  return graphemes(text.toLocaleLowerCase());
}
