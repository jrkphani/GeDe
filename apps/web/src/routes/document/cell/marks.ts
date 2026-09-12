/**
 * Inline-mark commands and their chords (KEYS-05, INSP-06). Chords resolve
 * from `event.code` (KEYS, I18N-02), so ⌘B is the same physical key on
 * Tamil99, InScript and Remington. `⌃⌘+` is Equal (with or without Shift)
 * or NumpadAdd; `⌃⌘−` is Minus or NumpadSubtract.
 */
import { toggleMark } from 'prosemirror-commands';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { MarkName, ToggleMark } from '@gede/core';

import { matchesChord, type Chord } from '../../../doc/shortcuts.js';
import { editorSchema } from './schema.js';

export interface MarkChord {
  readonly mark: ToggleMark;
  readonly chords: readonly Chord[];
  /** Label for tooltips and the shortcut sheet (KEYS-08). */
  readonly label: string;
}

export const MARK_CHORDS: readonly MarkChord[] = [
  { mark: 'bold', chords: [{ code: 'KeyB', mod: true }], label: '⌘B' },
  { mark: 'italic', chords: [{ code: 'KeyI', mod: true }], label: '⌘I' },
  { mark: 'underline', chords: [{ code: 'KeyU', mod: true }], label: '⌘U' },
  { mark: 'strikethrough', chords: [{ code: 'KeyX', mod: true, shift: true }], label: '⇧⌘X' },
  {
    mark: 'superscript',
    chords: [
      { code: ['Equal', 'NumpadAdd'], mod: true, ctrl: true },
      { code: ['Equal', 'NumpadAdd'], mod: true, ctrl: true, shift: true },
    ],
    label: '⌃⌘+',
  },
  {
    mark: 'subscript',
    chords: [
      { code: ['Minus', 'NumpadSubtract'], mod: true, ctrl: true },
      { code: ['Minus', 'NumpadSubtract'], mod: true, ctrl: true, shift: true },
    ],
    label: '⌃⌘−',
  },
];

/** The mark a keydown asks for, or null. */
export function markForKey(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  apple: boolean,
): ToggleMark | null {
  for (const entry of MARK_CHORDS) {
    if (entry.chords.some((chord) => matchesChord(event, chord, apple))) return entry.mark;
  }
  return null;
}

const EXCLUSIVE_PAIR: Partial<Record<MarkName, MarkName>> = {
  superscript: 'subscript',
  subscript: 'superscript',
};

/** Toggle a mark on the selection (or the stored marks at a collapsed cursor). */
export function toggleCellMark(view: EditorView, mark: MarkName): boolean {
  const type = editorSchema.marks[mark];
  const dispatch = (tr: Transaction) => {
    view.dispatch(tr);
  };
  // Super and subscript exclude each other, so ProseMirror swaps one for the other
  // in a single step. y-prosemirror's text-equality check counts marks and treats
  // two attribute-less marks as the same, so that swap never reaches the fragment.
  // Removing the excluded mark in its own step first makes both changes visible.
  const other = EXCLUSIVE_PAIR[mark];
  if (other !== undefined) {
    const { from, to, empty } = view.state.selection;
    if (!empty && view.state.doc.rangeHasMark(from, to, editorSchema.marks[other])) {
      dispatch(view.state.tr.removeMark(from, to, editorSchema.marks[other]));
    }
  }
  return toggleMark(type)(view.state, dispatch);
}

/** Marks active at the selection: stored marks at a cursor, else the marks the whole range shares. */
export function activeMarks(state: EditorState): ReadonlySet<MarkName> {
  const { from, to, empty, $from } = state.selection;
  const out = new Set<MarkName>();
  const names = Object.keys(editorSchema.marks) as MarkName[];
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    for (const m of marks) out.add(m.type.name as MarkName);
    return out;
  }
  for (const name of names) {
    if (state.doc.rangeHasMark(from, to, editorSchema.marks[name])) out.add(name);
  }
  return out;
}
