/**
 * Whole-cell inline marks (KEYS-05, INSP-06). The editor toggles a mark on
 * a selection through ProseMirror; a cell that is selected but not being
 * edited has no editor, so the inspector's Text tab and the format chords
 * toggle the mark over the whole document here, in the JSON algebra.
 */
import {
  docNode,
  normalise,
  paragraphNode,
  textNode,
  type RichDoc,
  type ToggleMark,
} from './types.js';

const EXCLUSIVE: Partial<Record<ToggleMark, ToggleMark>> = {
  superscript: 'subscript',
  subscript: 'superscript',
};

/** True when every text node of a non-empty document carries the mark. */
export function hasMarkThroughout(d: RichDoc, mark: ToggleMark): boolean {
  let nodes = 0;
  for (const p of d.content) {
    for (const n of p.content ?? []) {
      if (n.text === '') continue;
      nodes += 1;
      if (!(n.marks ?? []).some((m) => m.type === mark)) return false;
    }
  }
  return nodes > 0;
}

/**
 * Toggle a mark over the whole document, as the editor does over a selection:
 * on when any text lacks it, off when all text has it. Super and subscript
 * exclude each other. Returns the normalised document; an empty document is
 * returned as is (there is nothing to mark).
 */
export function toggleMarkThroughout(d: RichDoc, mark: ToggleMark): RichDoc {
  const on = !hasMarkThroughout(d, mark);
  const excluded = EXCLUSIVE[mark];
  return normalise(
    docNode(
      d.content.map((p) =>
        paragraphNode(
          (p.content ?? []).map((n) => {
            const kept = (n.marks ?? []).filter(
              (m) => m.type !== mark && (excluded === undefined || m.type !== excluded),
            );
            return textNode(n.text, on ? [...kept, { type: mark }] : kept);
          }),
        ),
      ),
    ),
  );
}
