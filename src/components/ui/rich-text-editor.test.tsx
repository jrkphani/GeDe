// @vitest-environment jsdom
// Issue 081 test-first plan item 8 — the rich-text editor primitive's own
// formatting commands, ARIA state, and commit contract, independent of
// FoundationSurface (that integration is covered by FoundationSurface.test.tsx,
// test-first plan item 9).
//
// Driving real character-by-character typing through Lexical's contentEditable
// in plain jsdom is unreliable (jsdom's Selection/Range API exists, but
// Lexical's native-input path needs the browser's real caret/composition
// behavior, which jsdom does not implement — this is a known limitation
// shared by every contentEditable-based rich-text library, not specific to
// this component). Tests below instead: (a) mount the editor with pre-built
// content via the `value` prop (parsing is real, exercised end-to-end), and
// (b) drive formatting through Lexical's own command dispatch (toolbar clicks
// / keyboard shortcuts) against a DOM Selection set directly via the real
// Range/Selection APIs jsdom DOES implement — both are the actual code paths
// a user exercises, just without simulating the keystrokes that build the
// initial text.
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { RICH_TEXT_NODES } from '../../domain/richText'
import { RichTextEditor } from './rich-text-editor'
import { resetFocusedEditor, useFocusedEditorStore } from '../../store/focusedEditor'

function plainTextEditorStateJson(text: string): string {
  const editor = createEditor({
    namespace: 'test',
    nodes: RICH_TEXT_NODES,
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode(text))
      $getRoot().append(paragraph)
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

function renderEditor(onCommit = vi.fn(), value: string | null = null) {
  render(
    <RichTextEditor
      value={value}
      onCommit={onCommit}
      ariaLabel="Existing scenario"
      placeholder="Describe the existing scenario…"
    />,
  )
  return { onCommit }
}

// Selects the full text content of `container` via the real DOM
// Selection/Range APIs (jsdom implements these; it's only realistic keyboard
// input Lexical can't process here) and lets Lexical's selectionchange
// listener (LexicalEvents.ts) sync it into $getSelection().
function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('RichTextEditor — mounts pre-existing content (parse path)', () => {
  it('renders text supplied via the value prop', async () => {
    renderEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    expect(await screen.findByText('Comfort, on demand.')).toBeInTheDocument()
  })

  it('shows ghost placeholder text when empty', async () => {
    renderEditor()
    expect(await screen.findByText('Describe the existing scenario…')).toBeInTheDocument()
  })
})

describe('RichTextEditor — commit granularity (test-first plan item 8/9)', () => {
  it('blurring without any change never commits', async () => {
    const onCommit = vi.fn()
    renderEditor(onCommit, plainTextEditorStateJson('Comfort, on demand.'))
    const editable = await screen.findByText('Comfort, on demand.')

    fireEvent.focus(editable)
    fireEvent.blur(editable)
    expect(onCommit).not.toHaveBeenCalled()
  })

  // NOTE (089 D1 P1): the "two edits before one blur = one commit" assertion
  // now lives in FormatStrip.test.tsx — its edits are driven through the
  // detached global strip. The commit-on-blur contract it verifies is the
  // same; only the toolbar's mount site moved.

  it('emptying the content and blurring commits null (the schema’s "not written yet" state)', async () => {
    const onCommit = vi.fn()
    renderEditor(onCommit, plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))

    fireEvent.blur(editable)
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onCommit).toHaveBeenCalledWith(null)
  })
})

// Issue 105 P0 (review HIGH 4) — the Tab seam is OPT-IN. Only when the host
// passes `onTabAdvance` (Architecture's grid-embedded description cell) does Tab
// commit + hand off to the host; without it (Design's justification, Foundation's
// description, the standalone existing_scenario editor) Tab is NEVER intercepted
// here → native traversal, byte-identical.
describe('RichTextEditor — Tab seam (issue 105 P0, opt-in)', () => {
  it('with onTabAdvance: Tab commits the current value and advances forward', async () => {
    const onCommit = vi.fn()
    const onTabAdvance = vi.fn()
    render(
      <RichTextEditor
        value={plainTextEditorStateJson('Comfort')}
        onCommit={onCommit}
        onTabAdvance={onTabAdvance}
        ariaLabel="Justification"
        placeholder="Add justification…"
      />,
    )
    const editable = screen.getByLabelText('Justification')
    await screen.findByText('Comfort')
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))

    fireEvent.keyDown(editable, { key: 'Tab' })
    expect(onTabAdvance).toHaveBeenCalledWith('forward')
    // Committed on Tab (same path as ⌘⏎ / blur): emptied → null.
    expect(onCommit).toHaveBeenCalledWith(null)
  })

  it('with onTabAdvance: Shift+Tab advances backward', () => {
    const onTabAdvance = vi.fn()
    render(
      <RichTextEditor
        value={null}
        onCommit={vi.fn()}
        onTabAdvance={onTabAdvance}
        ariaLabel="Justification"
        placeholder="Add justification…"
      />,
    )
    const editable = screen.getByLabelText('Justification')
    fireEvent.focus(editable)
    fireEvent.keyDown(editable, { key: 'Tab', shiftKey: true })
    expect(onTabAdvance).toHaveBeenCalledWith('backward')
  })

  it('WITHOUT onTabAdvance (Design/Foundation richtext): Tab is native — no commit, no advance', async () => {
    const onCommit = vi.fn()
    const onCommitAndAdvance = vi.fn()
    // Mirrors a Design/Foundation grid richtext cell: Cmd+Enter/Esc seams wired,
    // but the Tab opt-in is OFF (richTextTabAdvances not set on that grid).
    render(
      <RichTextEditor
        value={plainTextEditorStateJson('Comfort')}
        onCommit={onCommit}
        onCommitAndAdvance={onCommitAndAdvance}
        onEscape={vi.fn()}
        ariaLabel="Justification"
        placeholder="Add justification…"
      />,
    )
    const editable = screen.getByLabelText('Justification')
    await screen.findByText('Comfort')
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))

    fireEvent.keyDown(editable, { key: 'Tab' })
    // Native Tab: the editor never commits or advances on Tab.
    expect(onCommitAndAdvance).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// The in-editor "toolbar" describe (role=toolbar buttons, roving tabindex,
// Bold/Underline/list/indent commands, Cmd+B) was RELOCATED to
// FormatStrip.test.tsx: the toolbar is no longer rendered inside RichTextEditor
// — it lives once in the shell context bar (089 D1 P1) and binds to the focused
// editor. The command set and ARIA pattern are unchanged there.

describe('RichTextEditor — readOnly (issue 035 precedent)', () => {
  it('renders no toolbar and a non-editable region', () => {
    render(
      <RichTextEditor
        value={null}
        onCommit={vi.fn()}
        ariaLabel="Existing scenario"
        placeholder="Describe the existing scenario…"
        readOnly
      />,
    )
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Existing scenario')).toHaveAttribute('contenteditable', 'false')
  })

  it('still renders previously-written formatted content for a viewer', async () => {
    render(
      <RichTextEditor
        value={plainTextEditorStateJson('Comfort, on demand.')}
        onCommit={vi.fn()}
        ariaLabel="Existing scenario"
        placeholder="Describe the existing scenario…"
        readOnly
      />,
    )
    expect(await screen.findByText('Comfort, on demand.')).toBeInTheDocument()
  })
})

// Regression guard (089 D1 pre-push blocker 1): the real end-to-end shape of
// the bug. A rich grid cell mounts its editor with autoFocus; that fires
// focusin → setFocused BEFORE the register effect runs. The global FormatStrip
// binds off `activeEditor`, so it MUST be non-null right after mount — no
// manual blur+refocus. This failed before the store's register-reconciliation.
describe('RichTextEditor — autoFocus binds the global FormatStrip (blocker 1)', () => {
  beforeEach(() => resetFocusedEditor())

  it('mounting with autoFocus makes this editor the active (strip-bound) editor', async () => {
    render(
      <RichTextEditor
        value={null}
        onCommit={vi.fn()}
        ariaLabel="Justification"
        placeholder="Add justification…"
        autoFocus
      />,
    )
    // The strip reads activeEditor; without a manual re-focus it must be bound.
    await waitFor(() => {
      expect(useFocusedEditorStore.getState().activeEditor).not.toBeNull()
    })
  })
})

// Regression guard (089 D2): a grid rich cell mounts its editor with autoFocus.
// Under React StrictMode's dev double-invoke (the same shape as any Offscreen
// passive-effect reconnect), the mount effects run twice: pass-1 binds, the
// cleanup's `unregister` clears focusedId, then pass-2's focus() is a no-op on
// the already-focused root (fires NO focusin, so handleFocus never re-runs
// setFocused) and register's `focusedId === id` reconcile misses. Result before
// the fix: the FormatStrip stays UNBOUND on the first autoFocus, no manual
// re-focus. The autoFocus effect now asserts the binding directly, so it
// survives the double-invoke. (The full-stack repro lives in canvas-compose.spec.)
describe('RichTextEditor — autoFocus binds under StrictMode double-invoke (089 D2)', () => {
  beforeEach(() => resetFocusedEditor())

  it('an autoFocus editor stays strip-bound through the mount double-invoke', async () => {
    render(
      <StrictMode>
        <RichTextEditor
          value={null}
          onCommit={vi.fn()}
          ariaLabel="Justification"
          placeholder="Add justification…"
          autoFocus
        />
      </StrictMode>,
    )
    await waitFor(() => {
      expect(useFocusedEditorStore.getState().activeEditor).not.toBeNull()
    })
  })
})
