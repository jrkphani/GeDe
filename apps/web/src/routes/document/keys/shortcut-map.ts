/**
 * The keyboard map (KEYS-01..08), one table: `docs/handover/reference/shortcuts.md`
 * transcribed as data. The shortcut sheet renders it and the shell's bindings
 * are keyed by the same `ChordId`s, so a chord cannot be bound without being
 * listed, or listed without a binding (`shortcut-map.test.ts` checks both ways).
 *
 * Rows without a chord id (Tab, arrows, Enter) are handled by the cell itself
 * and are listed for the reader only.
 */
import type { ToggleMark } from '@gede/core';

import { ARIA_KEYS, CHORDS, LABELS, type Chord, type ChordId } from '../../../doc/shortcuts.js';
import { MARK_CHORDS } from '../cell/index.js';

export type ShortcutGroup =
  'Document' | 'Edit' | 'Find' | 'Format' | 'Table and cells' | 'Graphs' | 'Sheets' | 'View';

/**
 * ADR-048: the keys a focused sheet tab handles itself (like the grid's
 * Tab and Enter, not shell chords), spelled as the sheet and the tab menu
 * spell them. Physical keys: `F2`, `Delete` / `Backspace` (KEYS, I18N-02).
 */
export const SHEET_KEYS = {
  rename: 'F2',
  remove: LABELS.clear,
} as const;

/**
 * ADR-051: the key a table handles itself to rename its title or a column —
 * F2 with the column band selected or the table selected (Enter too, on the
 * focused header or title bar, where it is not GRID-04's Edit cell). The
 * sheet's key, so one physical key renames whatever is selected.
 */
export const RENAME_KEYS = {
  rename: SHEET_KEYS.rename,
} as const;

export interface ShortcutRow {
  readonly action: string;
  /** Not in `docs/handover/reference/shortcuts.md`; the ADR that added it. */
  readonly extra?: string;
  /**
   * The chord is the browser's own and never reaches the page in Chrome and
   * Safari (ADR-030); the sheet says so and names the other route (KEYS-08).
   */
  readonly reserved?: string;
  /** Chords bound by the shell, in the order the keys column shows them. */
  readonly ids?: readonly ChordId[];
  /** Inline marks bound by the cell editor and the shell (KEYS-05). */
  readonly marks?: readonly ToggleMark[];
  /** Keys with no shell binding — the grid handles them (GRID-05, GRID-06). */
  readonly keys?: readonly string[];
}

export interface ShortcutSection {
  readonly group: ShortcutGroup;
  readonly rows: readonly ShortcutRow[];
}

export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    group: 'Document',
    rows: [
      {
        action: 'New workscape',
        ids: ['newWorkscape'],
        reserved: 'the browser’s in Chrome and Safari — use + in the library',
      },
      { action: 'Open', ids: ['open'] },
      { action: 'Print', ids: ['print'] },
      {
        action: 'Close document',
        ids: ['close'],
        reserved: 'the browser’s in Chrome and Safari — use the mark to go back to the library',
      },
      { action: 'Show shortcut sheet', ids: ['shortcutSheet'] },
    ],
  },
  {
    group: 'Edit',
    rows: [
      { action: 'Undo / Redo', ids: ['undo', 'redo'] },
      { action: 'Cut / Copy / Paste', ids: ['cut', 'copy', 'paste'] },
      { action: 'Paste and match style', ids: ['pasteMatchStyle'] },
      { action: 'Select all', ids: ['selectAll'] },
      { action: 'Delete contents', ids: ['clear'] },
    ],
  },
  {
    group: 'Find',
    rows: [
      { action: 'Find', ids: ['find'] },
      { action: 'Find next / previous', ids: ['findNext', 'findPrevious'] },
      { action: 'Find and replace', ids: ['findReplace'] },
      { action: 'Close find bar', ids: ['escape'] },
    ],
  },
  {
    group: 'Format',
    rows: [
      { action: 'Bold / Italic / Underline', marks: ['bold', 'italic', 'underline'] },
      { action: 'Strikethrough', marks: ['strikethrough'] },
      { action: 'Superscript / Subscript', marks: ['superscript', 'subscript'] },
      { action: 'Format inspector', ids: ['formatInspector'] },
      { action: 'Organize inspector', ids: ['organizeInspector'] },
    ],
  },
  {
    group: 'Table and cells',
    rows: [
      { action: 'Move between cells', keys: ['Tab', '⇧Tab', 'arrows'] },
      { action: 'Edit cell', keys: ['⏎', 'double-click'] },
      { action: 'Commit and move down / right', keys: ['⏎', 'Tab'] },
      { action: 'Cancel edit', ids: ['escape'] },
      { action: 'Add row below', ids: ['addRow'] },
      { action: 'Add column after', ids: ['addColumn'] },
      { action: 'Nest / promote row', ids: ['nest', 'promote'] },
      { action: 'Collapse / expand row', ids: ['collapse', 'expand'], extra: 'ADR-025, ADR-030' },
      // ADR-047: ⌫ with the table selected (⌘A, or a press on its title) deletes the table;
      // undo is the safety. Owner-directed; not in the handover reference.
      { action: 'Delete table (table selected)', ids: ['clear'], extra: 'ADR-047' },
      // ADR-049 (#167, owner-directed, Numbers' row and column selection and resize): keys
      // the grid and a focused divider handle themselves — not shell chords, so no id.
      { action: 'Select rows / columns from the cell', keys: ['⇧arrows'], extra: 'ADR-049' },
      {
        action: 'Resize the focused divider (Shift: four units)',
        keys: ['arrows', '⌥arrows'],
        extra: 'ADR-049',
      },
      {
        action: 'Fit the focused divider to content',
        keys: ['⏎', 'double-click'],
        extra: 'ADR-049',
      },
      // ADR-051 (owner-directed, the customer's report): keys the table handles itself on the
      // selected column or the selected table; each is also an item of the context menus.
      {
        action: 'Rename column (column selected)',
        keys: [RENAME_KEYS.rename, 'double-click'],
        extra: 'ADR-051',
      },
      {
        action: 'Rename table (table selected)',
        keys: [RENAME_KEYS.rename, 'double-click'],
        extra: 'ADR-051',
      },
    ],
  },
  {
    // GRAPH-09 / GRAPH-10: keys the graph itself handles on a focused node, dot or
    // coverage cell (ADR-033); not in the handover reference, which predates graphs.
    group: 'Graphs',
    rows: [
      {
        action: 'Move between nodes, dots and cells',
        keys: ['arrows', 'Home', 'End'],
        extra: 'ADR-033',
      },
      { action: 'Select the node’s row', keys: ['⏎', 'click'], extra: 'ADR-033' },
      { action: 'Open a child sheet for the node', keys: ['⇧⏎', 'double-click'], extra: 'ADR-033' },
      { action: 'Cancel pointing', ids: ['escape'], extra: 'ADR-033' },
      // ADR-047: the selected half only — the other half stays bound to its table; ⌥← / ⌥→
      // are the row chevron's chords (ADR-030), here on the selected half.
      { action: 'Delete the ring or coverage', ids: ['clear'], extra: 'ADR-047' },
      {
        action: 'Collapse / expand the ring or coverage',
        ids: ['collapse', 'expand'],
        extra: 'ADR-047',
      },
    ],
  },
  {
    // ADR-048 / #165: keys a focused sheet tab handles (owner-directed; the handover map
    // has no sheet commands). Each is also an item of the tab's menu (KEYS-08).
    group: 'Sheets',
    rows: [
      { action: 'Rename sheet', keys: [SHEET_KEYS.rename, 'double-click'], extra: 'ADR-048' },
      { action: 'Delete sheet (sheet tab focused)', keys: [SHEET_KEYS.remove], extra: 'ADR-048' },
    ],
  },
  {
    group: 'View',
    rows: [
      { action: 'Zoom in / out', ids: ['zoomIn', 'zoomOut'] },
      { action: 'Actual size', ids: ['actualSize'] },
      { action: 'Fit to canvas', ids: ['fit'] },
      { action: 'Show or hide inspector', ids: ['inspector'] },
      {
        action: 'Next / previous sheet',
        ids: ['nextSheet', 'previousSheet'],
        reserved: 'the browser’s tab switch — use the sheet strip',
      },
      // A11Y-01 / #131: Tab never leaves a table forward (GRID-05 appends a row), so a
      // keyboard user needs a chord to reach the next object on the sheet — a graph.
      {
        action: 'Next / previous object on the sheet',
        ids: ['nextObject', 'previousObject'],
        extra: 'ADR-042',
      },
    ],
  },
];

/** Label for a mark chord (KEYS-08), from the editor's own table. */
export function markLabel(mark: ToggleMark): string {
  const entry = MARK_CHORDS.find((m) => m.mark === mark);
  if (entry === undefined) throw new RangeError(`no chord for mark ${mark}`);
  return entry.label;
}

/** WAI-ARIA key token for a physical `KeyboardEvent.code`, in the spelling `ARIA_KEYS` uses. */
function ariaToken(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** `aria-keyshortcuts` for a chord, derived from its physical keys. */
export function ariaKeysFor(chord: Chord): string {
  const code = typeof chord.code === 'string' ? chord.code : (chord.code[0] ?? '');
  const parts: string[] = [];
  if (chord.ctrl === true) parts.push('Control');
  if (chord.alt === true) parts.push('Alt');
  if (chord.shift === true) parts.push('Shift');
  if (chord.mod === true) parts.push('Meta');
  parts.push(ariaToken(code));
  return parts.join('+');
}

/** `aria-keyshortcuts` for a mark chord: the same physical keys as `MARK_CHORDS`. */
export function markAriaKeys(mark: ToggleMark): string {
  const entry = MARK_CHORDS.find((m) => m.mark === mark);
  const chord = entry?.chords[0];
  if (chord === undefined) throw new RangeError(`no chord for mark ${mark}`);
  return ariaKeysFor(chord);
}

/** The keys a row lists, as glyph labels: "⌘Z · ⇧⌘Z". */
export function rowKeys(row: ShortcutRow): readonly string[] {
  return [
    ...(row.ids ?? []).map((id) => LABELS[id]),
    ...(row.marks ?? []).map(markLabel),
    ...(row.keys ?? []),
  ];
}

/** `aria-keyshortcuts` for a row's bound chords (none for grid-handled keys). */
export function rowAriaKeys(row: ShortcutRow): string | undefined {
  const tokens = [
    ...(row.ids ?? []).map((id) => ARIA_KEYS[id]),
    ...(row.marks ?? []).map(markAriaKeys),
  ];
  return tokens.length === 0 ? undefined : tokens.join(' ');
}

/** Rows the browser keeps for itself (KEYS-02, KEYS-07): listed, marked, unbound. */
export function reservedRows(): ShortcutRow[] {
  return SHORTCUT_SECTIONS.flatMap((s) => s.rows.filter((r) => r.reserved !== undefined));
}

/** Chord ids the sheet does not list — must be empty (KEYS-08: no unlisted shortcut). */
export function unlistedChords(): ChordId[] {
  const listed = new Set<ChordId>();
  for (const section of SHORTCUT_SECTIONS) {
    for (const row of section.rows) for (const id of row.ids ?? []) listed.add(id);
  }
  return (Object.keys(CHORDS) as ChordId[]).filter((id) => !listed.has(id));
}
