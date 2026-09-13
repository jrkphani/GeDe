import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShortcuts } from '../../../doc/shortcuts.js';
import type { CellClipboard } from './clipboard.js';
import { documentBindings, type KeyHandlers } from './bindings.js';

const CELL = { tableId: 't', rowId: 'r', colId: 'c' };

/** Every handler a spy; the shell wires the real ones. */
function handlers(overrides: Partial<KeyHandlers> = {}): KeyHandlers {
  const clipboard: CellClipboard = {
    copy: vi.fn(() => Promise.resolve()),
    copySnapshot: vi.fn(() => Promise.resolve()),
    cut: vi.fn(() => Promise.resolve()),
    paste: vi.fn(() => Promise.resolve()),
    pasteMatchStyle: vi.fn(() => Promise.resolve()),
    armMatchStyle: vi.fn(),
    reason: () => undefined,
    column: {
      copy: vi.fn(() => Promise.resolve()),
      copySnapshot: vi.fn(() => Promise.resolve()),
      cut: vi.fn(() => Promise.resolve()),
      paste: vi.fn(() => Promise.resolve()),
      pasteMatchStyle: vi.fn(() => Promise.resolve()),
      clear: vi.fn(),
      reason: () => undefined,
    },
  };
  return {
    phone: false,
    editable: true,
    cell: CELL,
    editing: false,
    hasSelection: true,
    find: { open: false, show: vi.fn(), close: vi.fn(), next: vi.fn(), previous: vi.fn() },
    document: { open: vi.fn(), print: vi.fn() },
    layerOpen: false,
    view: {
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      actualSize: vi.fn(),
      fit: vi.fn(),
      toggleInspector: vi.fn(),
      showInspector: vi.fn(),
      toggleShortcutSheet: vi.fn(),
      nextObject: vi.fn(),
      previousObject: vi.fn(),
    },
    edit: {
      undo: vi.fn(),
      redo: vi.fn(),
      selectAll: vi.fn(),
      clear: vi.fn(),
      deleteTable: vi.fn(),
      clearSelection: vi.fn(),
      toggleMark: vi.fn(),
    },
    table: { addRow: vi.fn(), addColumn: vi.fn() },
    graph: {
      selected: false,
      pointing: false,
      remove: vi.fn(),
      collapse: vi.fn(),
      expand: vi.fn(),
    },
    clipboard,
    hierarchy: undefined,
    ...overrides,
  };
}

/** ADR-047: a graph half selected, every handler a spy. */
function graphSelected(): KeyHandlers['graph'] {
  return { selected: true, pointing: false, remove: vi.fn(), collapse: vi.fn(), expand: vi.fn() };
}

function Host({ h }: { h: KeyHandlers }) {
  useShortcuts(documentBindings(h));
  return <input aria-label="Field" />;
}

function press(init: KeyboardEventInit & { code: string }, target: Element | Window = window) {
  return fireEvent.keyDown(target, init);
}

describe('document key bindings', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('KEYS-02 ⌘O ⌘P and ? resolve from event.code; ⌘N and ⌘W are the browser’s and are not claimed', () => {
    const h = handlers();
    render(<Host h={h} />);
    press({ code: 'KeyO', metaKey: true });
    press({ code: 'KeyP', metaKey: true });
    // Shift+/ is `?` on the reference layout; the physical key is what counts.
    press({ code: 'Slash', shiftKey: true, key: '?' });
    expect(h.document.open).toHaveBeenCalledTimes(1);
    expect(h.document.print).toHaveBeenCalledTimes(1);
    expect(h.view.toggleShortcutSheet).toHaveBeenCalledTimes(1);
    // Reserved (ADR-030): the default is left to the browser, whatever it does with it.
    expect(press({ code: 'KeyN', metaKey: true })).toBe(true);
    expect(press({ code: 'KeyW', metaKey: true })).toBe(true);
    // `key` is never consulted: a `?` typed on a key whose code is not Slash does nothing.
    press({ code: 'Digit7', shiftKey: true, key: '?' });
    expect(h.view.toggleShortcutSheet).toHaveBeenCalledTimes(1);
  });

  it('KEYS-03 ⌘Z ⇧⌘Z ⌘A and ⌫ reach the edit handlers; ⌘X ⌘C ⌘V are never claimed, so the browser’s own copy / cut / paste run; ⌥⇧⌘V arms match-style without preventing its default', () => {
    const h = handlers();
    render(<Host h={h} />);
    press({ code: 'KeyZ', metaKey: true });
    press({ code: 'KeyZ', metaKey: true, shiftKey: true });
    press({ code: 'KeyA', metaKey: true });
    press({ code: 'Backspace' });
    press({ code: 'Delete' });
    expect(h.edit.undo).toHaveBeenCalledTimes(1);
    expect(h.edit.redo).toHaveBeenCalledTimes(1);
    expect(h.edit.selectAll).toHaveBeenCalledTimes(1);
    expect(h.edit.clear).toHaveBeenCalledTimes(2);
    // ADR-028: the native clipboard events are the keyboard route — not prevented, not handled here.
    expect(press({ code: 'KeyX', metaKey: true })).toBe(true);
    expect(press({ code: 'KeyC', metaKey: true })).toBe(true);
    expect(press({ code: 'KeyV', metaKey: true })).toBe(true);
    expect(h.clipboard.cut).not.toHaveBeenCalled();
    expect(h.clipboard.copy).not.toHaveBeenCalled();
    expect(h.clipboard.paste).not.toHaveBeenCalled();
    // ⌥⇧⌘V: armed, and the default stays so the browser's paste (where it raises one) follows.
    expect(press({ code: 'KeyV', metaKey: true, altKey: true, shiftKey: true })).toBe(true);
    expect(h.clipboard.armMatchStyle).toHaveBeenCalledTimes(1);
    expect(h.clipboard.pasteMatchStyle).not.toHaveBeenCalled();
  });

  it('KEYS-04 ⌘F ⌥⌘F work from a text field; ⌘G ⇧⌘G only while the bar is open', () => {
    const closed = handlers();
    const { unmount, getByLabelText } = render(<Host h={closed} />);
    const field = getByLabelText('Field');
    press({ code: 'KeyF', metaKey: true }, field);
    press({ code: 'KeyF', metaKey: true, altKey: true }, field);
    press({ code: 'KeyG', metaKey: true });
    expect(closed.find.show).toHaveBeenCalledTimes(2);
    expect(closed.find.show).toHaveBeenLastCalledWith({ replace: true });
    expect(closed.find.next).not.toHaveBeenCalled();
    unmount();
    const open = handlers({ find: { ...closed.find, open: true } });
    render(<Host h={open} />);
    press({ code: 'KeyG', metaKey: true });
    press({ code: 'KeyG', metaKey: true, shiftKey: true });
    press({ code: 'Escape' });
    expect(open.find.next).toHaveBeenCalledTimes(1);
    expect(open.find.previous).toHaveBeenCalledTimes(1);
    expect(open.find.close).toHaveBeenCalledTimes(1);
    expect(open.edit.clearSelection).not.toHaveBeenCalled(); // Esc closed the bar first
  });

  it('KEYS-05 ⌘B ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− toggle marks on the selected cell; ⌥⌘1 and ⌥⌘2 pick an inspector', () => {
    const h = handlers();
    render(<Host h={h} />);
    press({ code: 'KeyB', metaKey: true });
    press({ code: 'KeyI', metaKey: true });
    press({ code: 'KeyU', metaKey: true });
    press({ code: 'KeyX', metaKey: true, shiftKey: true });
    press({ code: 'Equal', metaKey: true, ctrlKey: true });
    press({ code: 'NumpadSubtract', metaKey: true, ctrlKey: true });
    expect(vi.mocked(h.edit.toggleMark).mock.calls.map((c) => c[0])).toEqual([
      'bold',
      'italic',
      'underline',
      'strikethrough',
      'superscript',
      'subscript',
    ]);
    press({ code: 'Digit1', metaKey: true, altKey: true });
    press({ code: 'Numpad2', metaKey: true, altKey: true });
    expect(vi.mocked(h.view.showInspector).mock.calls.map((c) => c[0])).toEqual([
      'format',
      'organize',
    ]);
  });

  it('KEYS-06 HIER-06 ⌥⌘↓ and ⌥⌘→ add structure; ⌘] ⌘[ ⌥← ⌥→ reach the hierarchy actions with the selected cell, and stay unclaimed without them', () => {
    const inert = handlers();
    const { unmount } = render(<Host h={inert} />);
    press({ code: 'ArrowDown', metaKey: true, altKey: true });
    press({ code: 'ArrowRight', metaKey: true, altKey: true });
    expect(inert.table.addRow).toHaveBeenCalledTimes(1);
    expect(inert.table.addColumn).toHaveBeenCalledTimes(1);
    // Without hierarchy actions the chord is not claimed at all (a chord that does nothing is worse than none).
    expect(press({ code: 'BracketRight', metaKey: true })).toBe(true);
    unmount();
    const hierarchy = { nest: vi.fn(), promote: vi.fn(), collapse: vi.fn(), expand: vi.fn() };
    render(<Host h={handlers({ hierarchy })} />);
    expect(press({ code: 'BracketRight', metaKey: true })).toBe(false);
    press({ code: 'BracketLeft', metaKey: true });
    press({ code: 'ArrowLeft', altKey: true });
    press({ code: 'ArrowRight', altKey: true });
    expect(hierarchy.nest).toHaveBeenCalledWith(CELL);
    expect(hierarchy.promote).toHaveBeenCalledWith(CELL);
    expect(hierarchy.collapse).toHaveBeenCalledWith(CELL);
    expect(hierarchy.expand).toHaveBeenCalledWith(CELL);
  });

  it('KEYS-07 ⌘+ ⌘− ⌘0 ⇧⌘0 ⌥⌘I reach the view handlers, numpad included; ⌃⇥ ⌃⇧⇥ are the browser’s and are not claimed', () => {
    const h = handlers();
    render(<Host h={h} />);
    press({ code: 'Equal', metaKey: true });
    press({ code: 'Equal', metaKey: true, shiftKey: true }); // ⌘⇧= is how most layouts type ⌘+
    press({ code: 'NumpadAdd', metaKey: true });
    press({ code: 'Minus', metaKey: true });
    press({ code: 'Digit0', metaKey: true });
    press({ code: 'Numpad0', metaKey: true, shiftKey: true });
    press({ code: 'KeyI', metaKey: true, altKey: true });
    expect(press({ code: 'Tab', ctrlKey: true })).toBe(true);
    expect(press({ code: 'Tab', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(h.view.zoomIn).toHaveBeenCalledTimes(3);
    expect(h.view.zoomOut).toHaveBeenCalledTimes(1);
    expect(h.view.actualSize).toHaveBeenCalledTimes(1);
    expect(h.view.fit).toHaveBeenCalledTimes(1);
    expect(h.view.toggleInspector).toHaveBeenCalledTimes(1);
    // ADR-042 (#131): ⇧⌘→ / ⇧⌘← move to the next or previous object on the sheet.
    press({ code: 'ArrowRight', metaKey: true, shiftKey: true });
    press({ code: 'ArrowLeft', metaKey: true, shiftKey: true });
    expect(h.view.nextObject).toHaveBeenCalledTimes(1);
    expect(h.view.previousObject).toHaveBeenCalledTimes(1);
  });

  it('KEYS-05 KEYS-07 off Apple platforms Ctrl+= zooms and Ctrl+Alt+= is superscript — the two never fire together (#136, ADR 42)', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0) jsdom');
    const h = handlers();
    render(<Host h={h} />);
    press({ code: 'Equal', ctrlKey: true });
    expect(h.view.zoomIn).toHaveBeenCalledTimes(1);
    expect(h.edit.toggleMark).not.toHaveBeenCalled();
    press({ code: 'Equal', ctrlKey: true, altKey: true });
    press({ code: 'Minus', ctrlKey: true, altKey: true, shiftKey: true });
    expect(h.view.zoomIn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.edit.toggleMark).mock.calls.map((c) => c[0])).toEqual([
      'superscript',
      'subscript',
    ]);
  });

  it('KEYS-03 ADR-047 ⌫ and Delete branch on what is selected: the armed cell clears, a selected graph half is removed, a selected table is deleted; an edit in progress or nothing selected leaves the key alone', () => {
    // An armed cell (the default): clear, and the graph and table handlers stay quiet.
    const armed = handlers({ graph: graphSelected() });
    const first = render(<Host h={armed} />);
    press({ code: 'Backspace' });
    expect(armed.edit.clear).toHaveBeenCalledTimes(1);
    expect(armed.graph.remove).not.toHaveBeenCalled();
    expect(armed.edit.deleteTable).not.toHaveBeenCalled();
    first.unmount();
    // A graph half selected, no grid selection: the half goes.
    const graph = handlers({ cell: null, hasSelection: false, graph: graphSelected() });
    const second = render(<Host h={graph} />);
    expect(press({ code: 'Delete' })).toBe(false);
    expect(graph.graph.remove).toHaveBeenCalledTimes(1);
    expect(graph.edit.clear).not.toHaveBeenCalled();
    expect(graph.edit.deleteTable).not.toHaveBeenCalled();
    second.unmount();
    // Pointing mode owns the keyboard (Escape is its key): nothing is deleted.
    const pointing = handlers({
      cell: null,
      hasSelection: false,
      graph: { ...graphSelected(), pointing: true },
    });
    const pointingView = render(<Host h={pointing} />);
    expect(press({ code: 'Delete' })).toBe(true);
    expect(pointing.graph.remove).not.toHaveBeenCalled();
    pointingView.unmount();
    // The table selected (⌘A, or a press on its title), no cell armed: the table goes.
    const table = handlers({ cell: null, hasSelection: true });
    const third = render(<Host h={table} />);
    expect(press({ code: 'Backspace' })).toBe(false);
    expect(table.edit.deleteTable).toHaveBeenCalledTimes(1);
    expect(table.edit.clear).not.toHaveBeenCalled();
    third.unmount();
    // Editing: the editor owns the key; the binding does not claim it.
    const editing = handlers({ editing: true });
    const fourth = render(<Host h={editing} />);
    expect(press({ code: 'Backspace' })).toBe(true);
    expect(editing.edit.clear).not.toHaveBeenCalled();
    expect(editing.edit.deleteTable).not.toHaveBeenCalled();
    fourth.unmount();
    // Nothing selected: not claimed either.
    const none = handlers({ cell: null, hasSelection: false });
    render(<Host h={none} />);
    expect(press({ code: 'Delete' })).toBe(true);
    expect(none.edit.deleteTable).not.toHaveBeenCalled();
    expect(none.graph.remove).not.toHaveBeenCalled();
  });

  it('KEYS-08 HIER-06 ADR-047 ⌥← / ⌥→ collapse or expand the selected graph half when no cell is armed, the selected row when one is, and nothing otherwise — the same physical chords, by `event.code`', () => {
    // Nothing selected: not claimed.
    const none = handlers({ cell: null, hasSelection: false });
    const first = render(<Host h={none} />);
    expect(press({ code: 'ArrowLeft', altKey: true })).toBe(true);
    expect(none.graph.collapse).not.toHaveBeenCalled();
    first.unmount();
    // A half selected: collapse and expand go to it, and the row handlers stay quiet.
    const hierarchy = { nest: vi.fn(), promote: vi.fn(), collapse: vi.fn(), expand: vi.fn() };
    const graph = handlers({ cell: null, hasSelection: false, graph: graphSelected(), hierarchy });
    const second = render(<Host h={graph} />);
    expect(press({ code: 'ArrowLeft', altKey: true })).toBe(false);
    expect(press({ code: 'ArrowRight', altKey: true })).toBe(false);
    expect(graph.graph.collapse).toHaveBeenCalledTimes(1);
    expect(graph.graph.expand).toHaveBeenCalledTimes(1);
    expect(hierarchy.collapse).not.toHaveBeenCalled();
    expect(hierarchy.expand).not.toHaveBeenCalled();
    // A modified arrow that is someone else's chord (⇧⌘→) is not a collapse.
    expect(press({ code: 'ArrowRight', metaKey: true, shiftKey: true })).toBe(false);
    expect(graph.graph.expand).toHaveBeenCalledTimes(1);
    second.unmount();
    // A cell armed: the row's, as before (HIER-06), even with a half marked selected.
    const cell = handlers({ graph: graphSelected(), hierarchy });
    render(<Host h={cell} />);
    press({ code: 'ArrowLeft', altKey: true });
    expect(hierarchy.collapse).toHaveBeenCalledWith(CELL);
    expect(cell.graph.collapse).not.toHaveBeenCalled();
  });

  it('GRID-03 Escape clears the selection only while no layered surface is open', () => {
    const closed = handlers();
    const { unmount } = render(<Host h={closed} />);
    expect(press({ code: 'Escape' })).toBe(false);
    expect(closed.edit.clearSelection).toHaveBeenCalledTimes(1);
    unmount();
    const layered = handlers({ layerOpen: true });
    render(<Host h={layered} />);
    expect(press({ code: 'Escape' })).toBe(true);
    expect(layered.edit.clearSelection).not.toHaveBeenCalled();
  });

  it('I18N-01 RESP-02 nothing fires while an IME composes; on phone the inspector and find-replace chords are off; view-only drops the edits', () => {
    const h = handlers({ phone: true, editable: false });
    render(<Host h={h} />);
    press({ code: 'KeyZ', metaKey: true, isComposing: true });
    press({ code: 'KeyI', metaKey: true, altKey: true });
    press({ code: 'KeyF', metaKey: true, altKey: true });
    press({ code: 'KeyZ', metaKey: true });
    press({ code: 'KeyB', metaKey: true });
    expect(h.view.toggleInspector).not.toHaveBeenCalled();
    expect(h.find.show).not.toHaveBeenCalled();
    expect(h.edit.undo).not.toHaveBeenCalled();
    expect(h.edit.toggleMark).not.toHaveBeenCalled();
  });
});
