import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellFragment,
  cellRich,
  createSheet,
  createTable,
  createUndoManager,
  docNode,
  fragmentToRich,
  openDocument,
  paragraphNode,
  plainText,
  richFromText,
  richToFragment,
  setCellText,
  tableById,
  tableMap,
  textNode,
  type GedeDoc,
  type RichDoc,
} from '@gede/core';

import { RichCellEditor, type RichCellEditorProps } from './RichCellEditor.js';

interface Harness {
  fragment: Y.XmlFragment;
  ydoc: Y.Doc;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  onCommitRich: ReturnType<typeof vi.fn>;
  editable: () => HTMLElement;
  unmount: () => void;
}

function mount(doc: RichDoc, overrides: Partial<RichCellEditorProps> = {}): Harness {
  const ydoc = new Y.Doc();
  const fragment = richToFragment(doc);
  ydoc.getMap('cells').set('k', fragment);
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onCommitRich = vi.fn();
  const utils = render(
    <RichCellEditor
      initial={plainText(doc)}
      seed={{ kind: 'existing' }}
      address="B2"
      onCommit={onCommit}
      onCancel={onCancel}
      onCommitRich={onCommitRich}
      fragment={fragment}
      {...overrides}
    />,
  );
  return {
    fragment,
    ydoc,
    onCommit,
    onCancel,
    onCommitRich,
    editable: () => utils.container.querySelector<HTMLElement>('.gd-rich-editor')!,
    unmount: utils.unmount,
  };
}

const key = (code: string, init: KeyboardEventInit = {}) => ({
  code,
  key: code.replace('Key', '').toLowerCase(),
  metaKey: true,
  ...init,
});

/**
 * Select the whole text. The editor opens with the caret at the end (as the
 * grid's editor does); `Mod-a` is ProseMirror's own `baseKeymap` binding, which
 * reads `navigator.platform` (empty under jsdom, so Ctrl).
 */
function selectAll(el: HTMLElement): void {
  fireEvent.keyDown(el, { code: 'KeyA', key: 'a', ctrlKey: true });
}

function marksOf(fragment: Y.XmlFragment): string[] {
  return fragmentToRich(fragment).content[0]?.content?.[0]?.marks?.map((m) => m.type) ?? [];
}

describe('RichCellEditor', () => {
  beforeEach(() => {
    // Apple chords (⌘) in every test; the code path is the same for Ctrl elsewhere.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('mounts a ProseMirror view drawn as the cell, focused, caret at the end', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('Edit B2');
    expect(el.getAttribute('role')).toBe('textbox');
    expect(document.activeElement).toBe(el);
    expect(el.textContent).toBe('hello');
    // A mark at a collapsed caret is a stored mark, not a change to the text.
    fireEvent.keyDown(el, key('KeyB'));
    expect(marksOf(h.fragment)).toEqual([]);
    h.unmount();
  });

  test('KEYS-05 (partial) ⌘B ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− toggle marks by physical key and land in the fragment', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    selectAll(el);
    fireEvent.keyDown(el, key('KeyB'));
    expect(fragmentToRich(h.fragment)).toEqual(
      docNode([paragraphNode([textNode('hello', [{ type: 'bold' }])])]),
    );
    fireEvent.keyDown(el, key('KeyI'));
    fireEvent.keyDown(el, key('KeyU'));
    fireEvent.keyDown(el, key('KeyX', { shiftKey: true }));
    fireEvent.keyDown(el, key('Equal', { ctrlKey: true }));
    expect([...marksOf(h.fragment)].sort()).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'superscript',
      'underline',
    ]);
    // ⌃⌘− replaces superscript with subscript: a character is one or the other.
    fireEvent.keyDown(el, key('Minus', { ctrlKey: true }));
    expect(marksOf(h.fragment)).toContain('subscript');
    expect(marksOf(h.fragment)).not.toContain('superscript');
    // Toggling again removes.
    fireEvent.keyDown(el, key('KeyB'));
    expect(marksOf(h.fragment)).not.toContain('bold');
    h.unmount();
  });

  test('KEYS-05 (partial) I18N-02 the chord is the physical key: KeyB with a Tamil99 character still bolds', () => {
    const h = mount(richFromText('வணக்கம்'));
    selectAll(h.editable());
    fireEvent.keyDown(h.editable(), { code: 'KeyB', key: 'ஆ', metaKey: true });
    expect(marksOf(h.fragment)).toEqual(['bold']);
    h.unmount();
  });

  test('GRID-06 (partial) Enter commits the plain text and moves down; marks are already in the fragment', () => {
    const h = mount(richFromText('hello'));
    selectAll(h.editable());
    fireEvent.keyDown(h.editable(), key('KeyB'));
    fireEvent.keyDown(h.editable(), { code: 'Enter', key: 'Enter' });
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit).toHaveBeenCalledWith('hello', 'down');
    expect(h.onCommitRich).not.toHaveBeenCalled();
    expect(marksOf(h.fragment)).toEqual(['bold']);
    // A second Enter (or blur) after commit does nothing.
    fireEvent.keyDown(h.editable(), { code: 'Enter', key: 'Enter' });
    fireEvent.blur(h.editable());
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  test('GRID-04 (partial) Escape cancels: the fragment goes back to what it held when the editor opened', () => {
    const before = docNode([paragraphNode([textNode('keep', [{ type: 'italic' }])])]);
    const h = mount(before);
    selectAll(h.editable());
    fireEvent.keyDown(h.editable(), key('KeyB'));
    expect(marksOf(h.fragment)).toHaveLength(2);
    fireEvent.keyDown(h.editable(), { code: 'Escape', key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(fragmentToRich(h.fragment)).toEqual(before);
    h.unmount();
  });

  test('GRID-04 (partial) an overwrite seed replaces the whole text with the typed character', () => {
    const h = mount(richFromText('old text'), { seed: { kind: 'overwrite', text: 'n' } });
    expect(h.editable().textContent).toBe('n');
    expect(plainText(fragmentToRich(h.fragment))).toBe('n');
    fireEvent.keyDown(h.editable(), { code: 'Escape', key: 'Escape' });
    expect(plainText(fragmentToRich(h.fragment))).toBe('old text');
    h.unmount();
  });

  test('GRID-06 (partial) arrows commit and move only when the edit began by typing', () => {
    const typed = mount(richFromText('x'), { seed: { kind: 'overwrite', text: 'y' } });
    fireEvent.keyDown(typed.editable(), { code: 'ArrowRight', key: 'ArrowRight' });
    expect(typed.onCommit).toHaveBeenCalledWith('y', 'right');
    typed.unmount();
    const existing = mount(richFromText('x'));
    fireEvent.keyDown(existing.editable(), { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(existing.onCommit).not.toHaveBeenCalled();
    existing.unmount();
  });

  test('I18N-01 GRID-06 (partial) Enter, Escape and chords are ignored while an IME is composing', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    selectAll(el);
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter', isComposing: true });
    fireEvent.keyDown(el, { code: 'Escape', key: 'Escape', isComposing: true });
    fireEvent.keyDown(el, { ...key('KeyB'), isComposing: true });
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter', keyCode: 229 });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.onCancel).not.toHaveBeenCalled();
    expect(marksOf(h.fragment)).toEqual([]);
    h.unmount();
  });

  test('I18N-01 GRID-06 (partial) a paragraph the browser inserts mid-composition does not commit (ProseMirror synthesises an Enter for it)', async () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // What a contenteditable does with an Enter the editor did not prevent: a new block.
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    el.appendChild(p);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.onCancel).not.toHaveBeenCalled();
    expect(plainText(fragmentToRich(h.fragment))).toBe('hello');
    // The block the browser added was discarded, not turned into a paragraph.
    expect(el.querySelectorAll('p')).toHaveLength(1);
    // (What follows compositionend is the e2e's: jsdom reports Safari's vendor, so
    // ProseMirror swallows the first keydown after a composition ends.)
    h.unmount();
  });

  test('GRID-06 (partial) Tab commits right, ⇧Tab left, blur in place', () => {
    const a = mount(richFromText('a'));
    fireEvent.keyDown(a.editable(), { code: 'Tab', key: 'Tab' });
    expect(a.onCommit).toHaveBeenCalledWith('a', 'right');
    a.unmount();
    const b = mount(richFromText('b'));
    fireEvent.keyDown(b.editable(), { code: 'Tab', key: 'Tab', shiftKey: true });
    expect(b.onCommit).toHaveBeenCalledWith('b', 'left');
    b.unmount();
    const c = mount(richFromText('c'));
    fireEvent.blur(c.editable());
    expect(c.onCommit).toHaveBeenCalledWith('c', null);
    c.unmount();
  });

  test('GRID-06 (partial) unmounting mid-edit commits once, after a microtask', async () => {
    const h = mount(richFromText('draft'));
    h.unmount();
    expect(h.onCommit).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit).toHaveBeenCalledWith('draft', null);
  });

  test('without a fragment the editor works detached and reports the rich result on commit', () => {
    const onCommit = vi.fn();
    const onCommitRich = vi.fn();
    const utils = render(
      <RichCellEditor
        initial="=Sum(B2:B4)"
        seed={{ kind: 'existing' }}
        address="B5"
        onCommit={onCommit}
        onCancel={vi.fn()}
        onCommitRich={onCommitRich}
      />,
    );
    const el = utils.container.querySelector<HTMLElement>('.gd-rich-editor')!;
    expect(el.textContent).toBe('=Sum(B2:B4)');
    selectAll(el);
    fireEvent.keyDown(el, key('KeyB'));
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('=Sum(B2:B4)', 'down');
    expect(onCommitRich).toHaveBeenCalledWith(
      docNode([paragraphNode([textNode('=Sum(B2:B4)', [{ type: 'bold' }])])]),
    );
    utils.unmount();
  });

  test('a detached overwrite seed starts from the typed character', () => {
    const onCommit = vi.fn();
    const utils = render(
      <RichCellEditor
        initial=""
        seed={{ kind: 'overwrite', text: 'q' }}
        address="A1"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    const el = utils.container.querySelector<HTMLElement>('.gd-rich-editor')!;
    expect(el.textContent).toBe('q');
    fireEvent.keyDown(el, { code: 'ArrowDown', key: 'ArrowDown' });
    expect(onCommit).toHaveBeenCalledWith('q', 'down');
    utils.unmount();
  });

  test('INSP-06 (partial) onSelectionMarks reports the marks at the selection', () => {
    const onSelectionMarks = vi.fn();
    const h = mount(richFromText('hello'), { onSelectionMarks });
    expect(onSelectionMarks).toHaveBeenLastCalledWith(new Set());
    selectAll(h.editable());
    fireEvent.keyDown(h.editable(), key('KeyB'));
    expect(onSelectionMarks).toHaveBeenLastCalledWith(new Set(['bold']));
    h.unmount();
  });

  test('I18N-03 the editor carries lang for Indic text, else the locale language, and follows what is typed', () => {
    const h = mount(richFromText('नमस्ते'), { locale: 'en-IN' });
    expect(h.editable().getAttribute('lang')).toBe('hi');
    h.unmount();
    const latin = mount(richFromText('hello'), { locale: 'ta-IN' });
    expect(latin.editable().getAttribute('lang')).toBe('ta');
    latin.unmount();
    const none = mount(richFromText('hello'));
    expect(none.editable().hasAttribute('lang')).toBe(false);
    none.unmount();
    // Typing Tamil into a Latin cell switches the editor to `ta` as the text arrives.
    const typed = mount(richFromText('hello'), {
      locale: 'en-US',
      seed: { kind: 'overwrite', text: 'த' },
    });
    expect(typed.editable().getAttribute('lang')).toBe('ta');
    typed.unmount();
  });

  test('keys do not reach the cell beneath; pointer down does not start a pan', () => {
    const outerKey = vi.fn();
    const outerPointer = vi.fn();
    const ydoc = new Y.Doc();
    const fragment = richToFragment(richFromText('x'));
    ydoc.getMap('cells').set('k', fragment);
    const utils = render(
      <div onKeyDown={outerKey} onPointerDown={outerPointer}>
        <RichCellEditor
          initial="x"
          seed={{ kind: 'existing' }}
          address="A1"
          onCommit={vi.fn()}
          onCancel={vi.fn()}
          fragment={fragment}
        />
      </div>,
    );
    const el = utils.container.querySelector<HTMLElement>('.gd-rich-editor')!;
    fireEvent.keyDown(el, { code: 'ArrowDown', key: 'ArrowDown' });
    fireEvent.pointerDown(el);
    expect(outerKey).not.toHaveBeenCalled();
    expect(outerPointer).not.toHaveBeenCalled();
    utils.unmount();
  });
});

describe('RichCellEditor with the document undo manager (KEYS-03)', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function documentCell(text: string): {
    gd: GedeDoc;
    undo: Y.UndoManager;
    fragment: Y.XmlFragment;
    rich: () => RichDoc;
  } {
    const gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    const record = tableById(gd, tableId)!;
    const rowId = record.rows[0]!;
    const colId = record.columns[0]!.id;
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setCellText(gd, tableId, rowId, colId, text);
    undo.stopCapturing();
    const table = tableMap(gd, tableId)!;
    return {
      gd,
      undo,
      fragment: cellFragment(table, rowId, colId)!,
      rich: () => cellRich(table, rowId, colId),
    };
  }

  function mountShared(
    cell: ReturnType<typeof documentCell>,
    seed: RichCellEditorProps['seed'] = { kind: 'existing' },
  ) {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <RichCellEditor
        initial={plainText(cell.rich())}
        seed={seed}
        address="A1"
        onCommit={onCommit}
        onCancel={onCancel}
        fragment={cell.fragment}
        undoManager={cell.undo}
      />,
    );
    return {
      onCommit,
      onCancel,
      el: utils.container.querySelector<HTMLElement>('.gd-rich-editor')!,
      unmount: utils.unmount,
    };
  }

  test('KEYS-03 a committed rich edit is one step on the document stack; ⌘Z after commit reverts it', () => {
    const cell = documentCell('hello');
    expect(cell.undo.undoStack).toHaveLength(1);
    const h = mountShared(cell);
    selectAll(h.el);
    fireEvent.keyDown(h.el, key('KeyB'));
    fireEvent.keyDown(h.el, key('KeyI'));
    fireEvent.keyDown(h.el, { code: 'Enter', key: 'Enter' });
    expect(h.onCommit).toHaveBeenCalledWith('hello', 'down');
    expect(marksOf(cell.fragment).sort()).toEqual(['bold', 'italic']);
    // Two mark toggles, one undo step.
    expect(cell.undo.undoStack).toHaveLength(2);
    cell.undo.undo();
    expect(marksOf(cell.fragment)).toEqual([]);
    expect(plainText(cell.rich())).toBe('hello');
    cell.undo.redo();
    expect(marksOf(cell.fragment).sort()).toEqual(['bold', 'italic']);
    // The editor's origin is no longer tracked once it closed; the capture timeout is restored.
    expect(cell.undo.captureTimeout).toBe(0);
    h.unmount();
  });

  test('KEYS-03 an overwrite edit committed from typing is one step too', () => {
    const cell = documentCell('old');
    const h = mountShared(cell, { kind: 'overwrite', text: 'n' });
    expect(plainText(cell.rich())).toBe('n');
    fireEvent.keyDown(h.el, { code: 'Tab', key: 'Tab' });
    expect(cell.undo.undoStack).toHaveLength(2);
    cell.undo.undo();
    expect(plainText(cell.rich())).toBe('old');
    h.unmount();
  });

  test('KEYS-03 Escape undoes back to the depth at open and leaves nothing to redo', () => {
    const cell = documentCell('keep');
    const h = mountShared(cell);
    selectAll(h.el);
    fireEvent.keyDown(h.el, key('KeyB'));
    fireEvent.keyDown(h.el, key('KeyU'));
    fireEvent.keyDown(h.el, { code: 'Escape', key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(cell.rich()).toEqual(richFromText('keep'));
    expect(cell.undo.undoStack).toHaveLength(1);
    expect(cell.undo.redoStack).toHaveLength(0);
    // The step from before the editor opened is still there to undo.
    cell.undo.undo();
    expect(plainText(cell.rich())).toBe('');
    h.unmount();
  });

  test('KEYS-03 ⌘Z inside the editor undoes this edit and stops at the depth at open', () => {
    const cell = documentCell('hello');
    const h = mountShared(cell);
    selectAll(h.el);
    fireEvent.keyDown(h.el, key('KeyB'));
    expect(marksOf(cell.fragment)).toEqual(['bold']);
    fireEvent.keyDown(h.el, key('KeyZ'));
    expect(marksOf(cell.fragment)).toEqual([]);
    // Nothing of this edit left: ⌘Z does not reach into what came before the editor opened.
    fireEvent.keyDown(h.el, key('KeyZ'));
    expect(plainText(cell.rich())).toBe('hello');
    expect(cell.undo.undoStack).toHaveLength(1);
    fireEvent.keyDown(h.el, key('KeyZ', { shiftKey: true }));
    expect(marksOf(cell.fragment)).toEqual(['bold']);
    h.unmount();
  });
});
