import { create } from 'zustand'
import type { LexicalEditor } from 'lexical'

// Issue 089 D1 P1 — the focused-editor registry. The rich-text Toolbar was
// detached from each editor into ONE persistent FormatStrip in the shell
// context bar (SITEMAP §2); that strip binds to whichever rich editor is
// focused. Each RichTextEditor registers itself here on mount and reports
// focus/blur; the strip reads `activeEditor` to drive useToolbarState and to
// dispatch its (editor-agnostic) formatting commands.
//
// Mirrors status.ts / commandRegistry.ts: a small shell-owned Zustand slice
// features depend on, never the reverse. Semantics: last-focused wins; blur
// (setFocused(null)) clears; unregistering the active id clears it too.
interface FocusedEditorState {
  // id -> editor. A single-instance app today (existing_scenario), but keyed so
  // multiple rich editors (P3/P5) can coexist behind one strip.
  editors: Record<string, LexicalEditor>
  inlineOnlyById: Record<string, boolean>
  focusedId: string | null
  // Derived-but-stored so subscribers (the strip) re-render on focus changes:
  // editors[focusedId] ?? null.
  activeEditor: LexicalEditor | null
  activeInlineOnly: boolean
  register: (id: string, editor: LexicalEditor, inlineOnly?: boolean) => void
  unregister: (id: string) => void
  setFocused: (id: string | null) => void
}

export const useFocusedEditorStore = create<FocusedEditorState>()((set) => ({
  editors: {},
  inlineOnlyById: {},
  focusedId: null,
  activeEditor: null,
  activeInlineOnly: false,

  register(id, editor, inlineOnly = false) {
    set((s) => ({
      editors: { ...s.editors, [id]: editor },
      inlineOnlyById: { ...s.inlineOnlyById, [id]: inlineOnly },
      // Order-independent binding (089 D1 pre-push blocker 1): the autoFocus
      // path fires focusin → setFocused(id) BEFORE this register effect runs,
      // so setFocused resolved activeEditor to null (editors[id] was absent).
      // Reconcile here: a register that lands after setFocused for the same id
      // still binds the FormatStrip. Non-focused ids never hijack activeEditor.
      ...(s.focusedId === id ? { activeEditor: editor, activeInlineOnly: inlineOnly } : {}),
    }))
  },

  unregister(id) {
    set((s) => {
      if (!(id in s.editors)) return s
      const editors = Object.fromEntries(
        Object.entries(s.editors).filter(([key]) => key !== id),
      )
      const inlineOnlyById = Object.fromEntries(
        Object.entries(s.inlineOnlyById).filter(([key]) => key !== id),
      )
      // Unregistering the currently-focused editor (e.g. it unmounted, or a
      // viewer's read-only instance dropped out) clears the active binding —
      // the strip must not point at a gone editor.
      if (s.focusedId === id) {
        return { editors, inlineOnlyById, focusedId: null, activeEditor: null, activeInlineOnly: false }
      }
      return { editors, inlineOnlyById }
    })
  },

  setFocused(id) {
    set((s) => ({
      focusedId: id,
      activeEditor: id === null ? null : (s.editors[id] ?? null),
      activeInlineOnly: id === null ? false : (s.inlineOnlyById[id] ?? false),
    }))
  },
}))

// Session-scoped test/reset seam, mirroring resetCommandRegistry.
export function resetFocusedEditor(): void {
  useFocusedEditorStore.setState({
    editors: {},
    inlineOnlyById: {},
    focusedId: null,
    activeEditor: null,
    activeInlineOnly: false,
  })
}
