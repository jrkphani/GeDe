import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  docNode,
  fragmentToRich,
  paragraphNode,
  plainText,
  richFromText,
  richToFragment,
  textNode,
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

describe('RichCellEditor', () => {
  beforeEach(() => {
    // Apple chords (⌘) in every test; the code path is the same for Ctrl elsewhere.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('mounts a ProseMirror view drawn as the cell, focused, with the whole text selected', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('Edit B2');
    expect(el.getAttribute('role')).toBe('textbox');
    expect(document.activeElement).toBe(el);
    expect(el.textContent).toBe('hello');
    h.unmount();
  });

  test('KEYS-05 ⌘B ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− toggle marks by physical key and land in the fragment', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    fireEvent.keyDown(el, key('KeyB'));
    expect(fragmentToRich(h.fragment)).toEqual(
      docNode([paragraphNode([textNode('hello', [{ type: 'bold' }])])]),
    );
    fireEvent.keyDown(el, key('KeyI'));
    fireEvent.keyDown(el, key('KeyU'));
    fireEvent.keyDown(el, key('KeyX', { shiftKey: true }));
    fireEvent.keyDown(el, key('Equal', { ctrlKey: true }));
    let marks =
      fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks?.map((m) => m.type) ?? [];
    expect([...marks].sort()).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'superscript',
      'underline',
    ]);
    // ⌃⌘− replaces superscript with subscript: a character is one or the other.
    fireEvent.keyDown(el, key('Minus', { ctrlKey: true }));
    marks = fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks?.map((m) => m.type) ?? [];
    expect(marks).toContain('subscript');
    expect(marks).not.toContain('superscript');
    // Toggling again removes.
    fireEvent.keyDown(el, key('KeyB'));
    marks = fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks?.map((m) => m.type) ?? [];
    expect(marks).not.toContain('bold');
    h.unmount();
  });

  test('KEYS-05 I18N-02 the chord is the physical key: KeyB with a Tamil99 character still bolds', () => {
    const h = mount(richFromText('வணக்கம்'));
    fireEvent.keyDown(h.editable(), { code: 'KeyB', key: 'ஆ', metaKey: true });
    expect(fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    h.unmount();
  });

  test('GRID-06 (partial) Enter commits the plain text; marks are already in the fragment', () => {
    const h = mount(richFromText('hello'));
    fireEvent.keyDown(h.editable(), key('KeyB'));
    fireEvent.keyDown(h.editable(), { code: 'Enter', key: 'Enter' });
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit).toHaveBeenCalledWith('hello');
    expect(h.onCommitRich).not.toHaveBeenCalled();
    expect(fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    // A second Enter (or blur) after commit does nothing.
    fireEvent.keyDown(h.editable(), { code: 'Enter', key: 'Enter' });
    fireEvent.blur(h.editable());
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  test('GRID-04 (partial) Escape cancels: the fragment goes back to what it held when the editor opened', () => {
    const before = docNode([paragraphNode([textNode('keep', [{ type: 'italic' }])])]);
    const h = mount(before);
    fireEvent.keyDown(h.editable(), key('KeyB'));
    expect(fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks).toHaveLength(2);
    fireEvent.keyDown(h.editable(), { code: 'Escape', key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(fragmentToRich(h.fragment)).toEqual(before);
    h.unmount();
  });

  test('I18N-01 GRID-06 (partial) Enter, Escape and chords are ignored while an IME is composing', () => {
    const h = mount(richFromText('hello'));
    const el = h.editable();
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter', isComposing: true });
    fireEvent.keyDown(el, { code: 'Escape', key: 'Escape', isComposing: true });
    fireEvent.keyDown(el, { ...key('KeyB'), isComposing: true });
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter', keyCode: 229 });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.onCancel).not.toHaveBeenCalled();
    expect(fragmentToRich(h.fragment).content[0]?.content?.[0]?.marks).toBeUndefined();
    h.unmount();
  });

  test('GRID-06 (partial) Tab and blur commit', () => {
    const a = mount(richFromText('a'));
    fireEvent.keyDown(a.editable(), { code: 'Tab', key: 'Tab' });
    expect(a.onCommit).toHaveBeenCalledWith('a');
    a.unmount();
    const b = mount(richFromText('b'));
    fireEvent.blur(b.editable());
    expect(b.onCommit).toHaveBeenCalledWith('b');
    b.unmount();
  });

  test('GRID-06 (partial) unmounting mid-edit commits once, after a microtask', async () => {
    const h = mount(richFromText('draft'));
    h.unmount();
    expect(h.onCommit).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit).toHaveBeenCalledWith('draft');
  });

  test('without a fragment the editor works detached and reports the rich result on commit', () => {
    const onCommit = vi.fn();
    const onCommitRich = vi.fn();
    const utils = render(
      <RichCellEditor
        initial="=Sum(B2:B4)"
        address="B5"
        onCommit={onCommit}
        onCancel={vi.fn()}
        onCommitRich={onCommitRich}
      />,
    );
    const el = utils.container.querySelector<HTMLElement>('.gd-rich-editor')!;
    expect(el.textContent).toBe('=Sum(B2:B4)');
    fireEvent.keyDown(el, key('KeyB'));
    fireEvent.keyDown(el, { code: 'Enter', key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('=Sum(B2:B4)');
    expect(onCommitRich).toHaveBeenCalledWith(
      docNode([paragraphNode([textNode('=Sum(B2:B4)', [{ type: 'bold' }])])]),
    );
    utils.unmount();
  });

  test('INSP-06 (partial) onSelectionMarks reports the marks at the selection', () => {
    const onSelectionMarks = vi.fn();
    const h = mount(richFromText('hello'), { onSelectionMarks });
    expect(onSelectionMarks).toHaveBeenLastCalledWith(new Set());
    fireEvent.keyDown(h.editable(), key('KeyB'));
    expect(onSelectionMarks).toHaveBeenLastCalledWith(new Set(['bold']));
    h.unmount();
  });

  test('I18N-03 the editor carries lang for Indic text', () => {
    const h = mount(richFromText('नमस्ते'));
    expect(h.editable().getAttribute('lang')).toBe('hi');
    h.unmount();
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
