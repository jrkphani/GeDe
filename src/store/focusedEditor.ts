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
  focusedId: string | null
  // Derived-but-stored so subscribers (the strip) re-render on focus changes:
  // editors[focusedId] ?? null.
  activeEditor: LexicalEditor | null
  register: (id: string, editor: LexicalEditor) => void
  unregister: (id: string) => void
  setFocused: (id: string | null) => void
}

export const useFocusedEditorStore = create<FocusedEditorState>()((set) => ({
  editors: {},
  focusedId: null,
  activeEditor: null,

  register(id, editor) {
    set((s) => ({ editors: { ...s.editors, [id]: editor } }))
  },

  unregister(id) {
    set((s) => {
      if (!(id in s.editors)) return s
      const editors = Object.fromEntries(
        Object.entries(s.editors).filter(([key]) => key !== id),
      )
      // Unregistering the currently-focused editor (e.g. it unmounted, or a
      // viewer's read-only instance dropped out) clears the active binding —
      // the strip must not point at a gone editor.
      if (s.focusedId === id) return { editors, focusedId: null, activeEditor: null }
      return { editors }
    })
  },

  setFocused(id) {
    set((s) => ({
      focusedId: id,
      activeEditor: id === null ? null : (s.editors[id] ?? null),
    }))
  },
}))

// Session-scoped test/reset seam, mirroring resetCommandRegistry.
export function resetFocusedEditor(): void {
  useFocusedEditorStore.setState({ editors: {}, focusedId: null, activeEditor: null })
}
