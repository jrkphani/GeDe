// Issue 089 D1 P1 — the focused-editor registry that binds the global
// rich-text FormatStrip to whichever rich editor is focused. Mirrors the
// status.ts / commandRegistry.ts slice precedent: register/unregister editors,
// track the focused id, expose the active LexicalEditor. Last-focused wins;
// blur clears; unregistering the active id clears the active editor too.
import { beforeEach, describe, expect, it } from 'vitest'
import { createEditor, type LexicalEditor } from 'lexical'
import { RICH_TEXT_NODES } from '../domain/richText'
import { resetFocusedEditor, useFocusedEditorStore } from './focusedEditor'

function makeEditor(): LexicalEditor {
  return createEditor({
    namespace: 'test',
    nodes: RICH_TEXT_NODES,
    onError: (error) => {
      throw error
    },
  })
}

beforeEach(() => resetFocusedEditor())

describe('focusedEditor store', () => {
  it('registering an editor does not by itself make it active', () => {
    const a = makeEditor()
    useFocusedEditorStore.getState().register('a', a)
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
  })

  it('setFocused after register exposes that editor as active', () => {
    const a = makeEditor()
    useFocusedEditorStore.getState().register('a', a)
    useFocusedEditorStore.getState().setFocused('a')
    expect(useFocusedEditorStore.getState().activeEditor).toBe(a)
  })

  it('focusing A then B makes B active (last-focused wins)', () => {
    const a = makeEditor()
    const b = makeEditor()
    const store = useFocusedEditorStore.getState()
    store.register('a', a)
    store.register('b', b)
    store.setFocused('a')
    store.setFocused('b')
    expect(useFocusedEditorStore.getState().activeEditor).toBe(b)
  })

  it('blur (setFocused(null)) clears the active editor', () => {
    const a = makeEditor()
    useFocusedEditorStore.getState().register('a', a)
    useFocusedEditorStore.getState().setFocused('a')
    useFocusedEditorStore.getState().setFocused(null)
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
  })

  it('unregistering the active id clears the active editor', () => {
    const a = makeEditor()
    useFocusedEditorStore.getState().register('a', a)
    useFocusedEditorStore.getState().setFocused('a')
    useFocusedEditorStore.getState().unregister('a')
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
    expect(useFocusedEditorStore.getState().focusedId).toBeNull()
  })

  it('unregistering a non-active id leaves the active editor untouched', () => {
    const a = makeEditor()
    const b = makeEditor()
    const store = useFocusedEditorStore.getState()
    store.register('a', a)
    store.register('b', b)
    store.setFocused('a')
    store.unregister('b')
    expect(useFocusedEditorStore.getState().activeEditor).toBe(a)
  })

  it('focusing an id that was never registered yields a null active editor', () => {
    useFocusedEditorStore.getState().setFocused('ghost')
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
  })

  // Regression (089 D1 pre-push blocker 1): the autoFocus path fires focusin →
  // setFocused(id) BEFORE the register effect has put this editor into
  // `editors[id]`, so setFocused resolves activeEditor to null. A register that
  // lands AFTER setFocused must reconcile — otherwise the global FormatStrip
  // never binds to a grid rich cell (count stays 0) until a manual blur+refocus.
  it('registering the already-focused id reconciles it as the active editor', () => {
    const a = makeEditor()
    const store = useFocusedEditorStore.getState()
    store.setFocused('a')
    // Nothing registered yet — active is null, exactly the autoFocus race.
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
    store.register('a', a)
    // The late register reconciles the pending focus.
    expect(useFocusedEditorStore.getState().activeEditor).toBe(a)
    expect(useFocusedEditorStore.getState().focusedId).toBe('a')
  })

  it('registering a non-focused id does not become active', () => {
    const a = makeEditor()
    const b = makeEditor()
    const store = useFocusedEditorStore.getState()
    store.setFocused('a')
    store.register('b', b)
    // b is not the focused id — it must not hijack the active binding.
    expect(useFocusedEditorStore.getState().activeEditor).toBeNull()
    store.register('a', a)
    expect(useFocusedEditorStore.getState().activeEditor).toBe(a)
  })
})
