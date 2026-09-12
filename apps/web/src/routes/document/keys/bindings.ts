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
    open: () => void;
    print: () => void;
  };
  /** A shortcut sheet, context menu or overlay rail is open: Escape belongs to it (D7). */
  layerOpen: boolean;
  view: {
    zoomIn: () => void;
    zoomOut: () => void;
    actualSize: () => void;
    fit: () => void;
    toggleInspector: () => void;
    showInspector: (mode: InspectorMode) => void;
    toggleShortcutSheet: () => void;
    /** ADR-042 ⇧⌘→ / ⇧⌘←: focus the next or previous object on the sheet (A11Y-01). */
    nextObject: () => void;
    previousObject: () => void;
  };
  edit: {
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
    clear: () => void;
    /** ⌫ with a table selected and no cell armed: say what it would need (ADR-042). */
    clearNeedsCell?: (() => void) | undefined;
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
    // Document (KEYS-02). ⌘N and ⌘W are the browser's (new window, close tab) in Chrome
    // and Safari and never reach the page; they are listed on the sheet as reserved
    // (ADR-030) and not bound, so the one engine that lets ⌘W through closes the tab
    // as the person expects rather than something else.
    { id: 'open', chord: CHORDS.open, label: LABELS.open, run: h.document.open },
    { id: 'print', chord: CHORDS.print, label: LABELS.print, run: h.document.print },
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
    // ⌃⇥ / ⌃⇧⇥ (KEYS-07) are the browser's tab switch everywhere: reserved on the
    // sheet, not bound; the sheet strip is the route (KEYS-08).
    // ⇧⌘→ / ⇧⌘← (ADR-042): the next or previous object on the sheet, from anywhere
    // in the document — a cell, a graph node, the toolbar.
    {
      id: 'nextObject',
      chord: CHORDS.nextObject,
      label: LABELS.nextObject,
      run: h.view.nextObject,
      disabled: h.editing,
    },
    {
      id: 'previousObject',
      chord: CHORDS.previousObject,
      label: LABELS.previousObject,
      run: h.view.previousObject,
      disabled: h.editing,
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
    // Edit (KEYS-03). ⌘X ⌘C ⌘V are NOT bound here: the browser's own copy / cut / paste
    // commands run on the focused cell and raise the native `copy` / `cut` / `paste`
    // events that `keys/clipboard.ts` handles — no permission prompt, no popup
    // (ADR-028). Binding them would prevent that default and force the async API.
    { id: 'undo', chord: CHORDS.undo, label: LABELS.undo, run: h.edit.undo, disabled: !h.editable },
    { id: 'redo', chord: CHORDS.redo, label: LABELS.redo, run: h.edit.redo, disabled: !h.editable },
    {
      // ⌥⇧⌘V has no browser command on most engines; Chromium and WebKit raise a `paste`
      // for Paste and Match Style. Passive: the flag is armed, the browser's paste (if any)
      // consumes it as plain text, and the clipboard falls back to `readText` otherwise.
      id: 'pasteMatchStyle',
      chord: CHORDS.pasteMatchStyle,
      label: LABELS.pasteMatchStyle,
      run: h.clipboard.armMatchStyle,
      passive: true,
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
      // ⌫ clears the armed cell. With the table selected and no cell armed (after ⌘A, or a
      // press on the title) it says what it would need rather than clearing the table
      // (ADR-042): the selection model has no range, and a whole table is not one keystroke.
      id: 'clear',
      chord: CHORDS.clear,
      label: LABELS.clear,
      run: () => {
        if (h.cell === null) h.edit.clearNeedsCell?.();
        else h.edit.clear();
      },
      disabled: !h.editable || h.editing || !h.hasSelection,
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
    // Last: Escape clears the selection (GRID-03) — unless a layered surface (the
    // shortcut sheet, a menu, the tablet overlay) is what Escape is closing.
    {
      id: 'escape',
      chord: CHORDS.escape,
      label: LABELS.escape,
      run: h.edit.clearSelection,
      disabled: h.layerOpen,
    },
  ];
  return bindings;
}
