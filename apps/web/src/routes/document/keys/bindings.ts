/**
 * The shell's key bindings (KEYS-02..07), built from `CHORDS` and
 * `MARK_CHORDS` — the tables the shortcut sheet lists (KEYS-01) — so a bound
 * chord is always a listed one. Order matters: the first match wins, so Find
 * comes first (its chords work from the Find field) and the bare Escape that
 * clears the selection comes last.
 */
import type { ToggleMark } from '@gede/core';

import { CHORDS, LABELS, type ShortcutBinding } from '../../../doc/shortcuts.js';
import type { CellSelection } from '../../../doc/selection.js';
import type { InspectorMode } from '../Toolbar.js';
import { MARK_CHORDS } from '../cell/index.js';
import type { CellClipboard } from './clipboard.js';

/**
 * KEYS-06 / HIER-01 / HIER-06: ⌘] ⌘[ ⌥← ⌥→ on the selected row. The focused
 * cell handles the same chords itself (`TableView`, `grid/hier-keys.ts`) and
 * prevents their default, so these window bindings only run when focus sits
 * elsewhere — a toolbar button, the inspector — with a cell still selected.
 */
export interface HierarchyActions {
  nest: (cell: CellSelection) => void;
  promote: (cell: CellSelection) => void;
  collapse: (cell: CellSelection) => void;
  expand: (cell: CellSelection) => void;
}

export interface KeyHandlers {
  phone: boolean;
  editable: boolean;
  /** The selected cell, when there is one and it is not being edited. */
  cell: CellSelection | null;
  editing: boolean;
  hasSelection: boolean;
  find: {
    open: boolean;
    show: (options?: { replace?: boolean }) => void;
    close: () => void;
    next: () => void;
    previous: () => void;
  };
  document: {
    newWorkscape: () => void;
    open: () => void;
    print: () => void;
    close: () => void;
  };
  view: {
    zoomIn: () => void;
    zoomOut: () => void;
    actualSize: () => void;
    fit: () => void;
    nextSheet: () => void;
    previousSheet: () => void;
    toggleInspector: () => void;
    showInspector: (mode: InspectorMode) => void;
    toggleShortcutSheet: () => void;
  };
  edit: {
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
    clear: () => void;
    clearSelection: () => void;
    toggleMark: (mark: ToggleMark) => void;
  };
  table: {
    addRow: () => void;
    addColumn: () => void;
  };
  clipboard: CellClipboard;
  hierarchy?: HierarchyActions | undefined;
}

export function documentBindings(h: KeyHandlers): ShortcutBinding[] {
  const noCell = h.cell === null || h.editing;
  const cellEdit = !h.editable || noCell;
  const bindings: ShortcutBinding[] = [
    // Find (KEYS-04): from the Find field too; Esc closes the bar before it clears the selection.
    {
      id: 'find',
      chord: CHORDS.find,
      label: LABELS.find,
      run: () => {
        h.find.show();
      },
      inEditors: true,
    },
    {
      id: 'findReplace',
      chord: CHORDS.findReplace,
      label: LABELS.findReplace,
      run: () => {
        h.find.show({ replace: true });
      },
      inEditors: true,
      disabled: h.phone,
    },
    {
      id: 'findNext',
      chord: CHORDS.findNext,
      label: LABELS.findNext,
      run: h.find.next,
      inEditors: true,
      disabled: !h.find.open,
    },
    {
      id: 'findPrevious',
      chord: CHORDS.findPrevious,
      label: LABELS.findPrevious,
      run: h.find.previous,
      inEditors: true,
      disabled: !h.find.open,
    },
    {
      id: 'closeFind',
      chord: CHORDS.escape,
      label: LABELS.escape,
      run: h.find.close,
      inEditors: true,
      disabled: !h.find.open,
    },
    // Document (KEYS-02). Print and close are the browser's too; the shell claims them
    // so ⌘W leaves the document the way the library's Back does, keeping the session.
    {
      id: 'newWorkscape',
      chord: CHORDS.newWorkscape,
      label: LABELS.newWorkscape,
      run: h.document.newWorkscape,
    },
    { id: 'open', chord: CHORDS.open, label: LABELS.open, run: h.document.open },
    { id: 'print', chord: CHORDS.print, label: LABELS.print, run: h.document.print },
    { id: 'close', chord: CHORDS.close, label: LABELS.close, run: h.document.close },
    {
      id: 'shortcutSheet',
      chord: CHORDS.shortcutSheet,
      label: LABELS.shortcutSheet,
      run: h.view.toggleShortcutSheet,
    },
    // View (KEYS-07)
    { id: 'zoomIn', chord: CHORDS.zoomIn, label: LABELS.zoomIn, run: h.view.zoomIn },
    // ⌘+ is ⌘⇧= on most layouts; accept both physical spellings.
    {
      id: 'zoomInShift',
      chord: { ...CHORDS.zoomIn, shift: true },
      label: LABELS.zoomIn,
      run: h.view.zoomIn,
    },
    { id: 'zoomOut', chord: CHORDS.zoomOut, label: LABELS.zoomOut, run: h.view.zoomOut },
    {
      id: 'actualSize',
      chord: CHORDS.actualSize,
      label: LABELS.actualSize,
      run: h.view.actualSize,
    },
    { id: 'fit', chord: CHORDS.fit, label: LABELS.fit, run: h.view.fit },
    {
      id: 'nextSheet',
      chord: CHORDS.nextSheet,
      label: LABELS.nextSheet,
      run: h.view.nextSheet,
      inEditors: true,
    },
    {
      id: 'previousSheet',
      chord: CHORDS.previousSheet,
      label: LABELS.previousSheet,
      run: h.view.previousSheet,
      inEditors: true,
    },
    {
      id: 'inspector',
      chord: CHORDS.inspector,
      label: LABELS.inspector,
      run: h.view.toggleInspector,
      disabled: h.phone,
    },
    {
      id: 'formatInspector',
      chord: CHORDS.formatInspector,
      label: LABELS.formatInspector,
      run: () => {
        h.view.showInspector('format');
      },
      disabled: h.phone,
    },
    {
      id: 'organizeInspector',
      chord: CHORDS.organizeInspector,
      label: LABELS.organizeInspector,
      run: () => {
        h.view.showInspector('organize');
      },
      disabled: h.phone,
    },
    // Table and cells (KEYS-06)
    {
      id: 'addRow',
      chord: CHORDS.addRow,
      label: LABELS.addRow,
      run: h.table.addRow,
      disabled: !h.editable || !h.hasSelection,
    },
    {
      id: 'addColumn',
      chord: CHORDS.addColumn,
      label: LABELS.addColumn,
      run: h.table.addColumn,
      disabled: !h.editable || !h.hasSelection,
    },
    {
      id: 'nest',
      chord: CHORDS.nest,
      label: LABELS.nest,
      run: () => {
        if (h.cell !== null) h.hierarchy?.nest(h.cell);
      },
      disabled: cellEdit || h.hierarchy === undefined,
    },
    {
      id: 'promote',
      chord: CHORDS.promote,
      label: LABELS.promote,
      run: () => {
        if (h.cell !== null) h.hierarchy?.promote(h.cell);
      },
      disabled: cellEdit || h.hierarchy === undefined,
    },
    {
      id: 'collapse',
      chord: CHORDS.collapse,
      label: LABELS.collapse,
      run: () => {
        if (h.cell !== null) h.hierarchy?.collapse(h.cell);
      },
      disabled: cellEdit || h.hierarchy === undefined,
    },
    {
      id: 'expand',
      chord: CHORDS.expand,
      label: LABELS.expand,
      run: () => {
        if (h.cell !== null) h.hierarchy?.expand(h.cell);
      },
      disabled: cellEdit || h.hierarchy === undefined,
    },
    // Edit (KEYS-03). The clipboard chords act on the selected cell through the async
    // Clipboard API (`clipboard.ts`): a cell is not an editable element, so the browser
    // raises no paste event of its own for it. Inside the editor the chords are the
    // editor's (inEditors is off), so typing is never intercepted.
    { id: 'undo', chord: CHORDS.undo, label: LABELS.undo, run: h.edit.undo, disabled: !h.editable },
    { id: 'redo', chord: CHORDS.redo, label: LABELS.redo, run: h.edit.redo, disabled: !h.editable },
    {
      id: 'cut',
      chord: CHORDS.cut,
      label: LABELS.cut,
      run: () => {
        void h.clipboard.cut();
      },
      disabled: cellEdit,
    },
    {
      id: 'copy',
      chord: CHORDS.copy,
      label: LABELS.copy,
      run: () => {
        void h.clipboard.copy();
      },
      disabled: noCell,
    },
    {
      id: 'paste',
      chord: CHORDS.paste,
      label: LABELS.paste,
      run: () => {
        void h.clipboard.paste();
      },
      disabled: cellEdit,
    },
    {
      id: 'pasteMatchStyle',
      chord: CHORDS.pasteMatchStyle,
      label: LABELS.pasteMatchStyle,
      run: () => {
        void h.clipboard.pasteMatchStyle();
      },
      disabled: cellEdit,
    },
    {
      id: 'selectAll',
      chord: CHORDS.selectAll,
      label: LABELS.selectAll,
      run: h.edit.selectAll,
      disabled: !h.hasSelection || h.editing,
    },
    {
      id: 'clear',
      chord: CHORDS.clear,
      label: LABELS.clear,
      run: h.edit.clear,
      disabled: cellEdit,
    },
    // Format (KEYS-05): on a selected cell the mark covers the whole cell; while
    // editing, the editor binds the same physical keys to the selection.
    ...MARK_CHORDS.flatMap((entry) =>
      entry.chords.map<ShortcutBinding>((chord, i) => ({
        id: `mark-${entry.mark}-${String(i)}`,
        chord,
        label: entry.label,
        run: () => {
          h.edit.toggleMark(entry.mark);
        },
        disabled: cellEdit,
      })),
    ),
    // Last: Escape clears the selection (GRID-03).
    { id: 'escape', chord: CHORDS.escape, label: LABELS.escape, run: h.edit.clearSelection },
  ];
  return bindings;
}
