// @vitest-environment jsdom
// Issue 089 D1 P1 — the global rich-text FormatStrip. These assertions were
// RELOCATED from rich-text-editor.test.tsx's in-editor "toolbar" describe
// (the toolbar is no longer rendered inside RichTextEditor; it now lives once
// in the shell context bar and binds to whichever rich editor is focused).
// The command dispatches are identical — only the active-editor indirection
// (focusedEditor store) is new. Driving real keystrokes through Lexical's
// contentEditable is unreliable in jsdom (see rich-text-editor.test.tsx's
// header), so text is seeded via the value prop and formatting is driven
// through the strip's own command dispatch against a DOM Selection set with
// the real Range/Selection APIs jsdom implements.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { RICH_TEXT_NODES } from '../domain/richText'
import { RichTextEditor } from './ui/rich-text-editor'
import { FormatStrip } from './FormatStrip'
import { resetFocusedEditor } from '../store/focusedEditor'

beforeEach(() => resetFocusedEditor())

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

function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

// The strip + one focusable editor, the real P1 composition (existing_scenario).
function renderStripWithEditor(onCommit = vi.fn(), value: string | null = null) {
  render(
    <>
      <FormatStrip />
      <RichTextEditor
        value={value}
        onCommit={onCommit}
        ariaLabel="Existing scenario"
        placeholder="Describe the existing scenario…"
      />
    </>,
  )
  return { onCommit }
}

describe('FormatStrip — structure', () => {
  it('is a role="toolbar" group of icon-only, aria-labeled buttons', () => {
    render(<FormatStrip />)
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(toolbar).toBeInTheDocument()
    for (const label of [
      'Bold',
      'Italic',
      'Underline',
      'Bulleted list',
      'Numbered list',
      'Indent',
      'Outdent',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('renders disabled, non-tabbable buttons when no rich editor is focused', () => {
    render(<FormatStrip />)
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(toolbar).toHaveAttribute('aria-disabled', 'true')
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-disabled', 'true')
    expect(bold).toHaveAttribute('tabindex', '-1')
  })
})

describe('FormatStrip — binds to the focused editor', () => {
  it('focusing a mounted RichTextEditor lights the strip (buttons enabled)', async () => {
    renderStripWithEditor()
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-disabled', 'true')

    const editable = screen.getByLabelText('Existing scenario')
    fireEvent.focus(editable)

    await waitFor(() => expect(bold).not.toHaveAttribute('aria-disabled'))
    expect(bold).toHaveAttribute('tabindex', '0')
  })

  it('roving tabindex once active: one button tabbable; ArrowRight moves it', () => {
    renderStripWithEditor()
    const editable = screen.getByLabelText('Existing scenario')
    fireEvent.focus(editable)

    const bold = screen.getByRole('button', { name: 'Bold' })
    const italic = screen.getByRole('button', { name: 'Italic' })
    expect(bold).toHaveAttribute('tabindex', '0')
    expect(italic).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(bold, { key: 'ArrowRight' })
    expect(italic).toHaveAttribute('tabindex', '0')
    expect(bold).toHaveAttribute('tabindex', '-1')
  })

  it('clicking Bold on a selection wraps it in <strong> and toggles aria-pressed', async () => {
    renderStripWithEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-pressed', 'false')

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    await userEvent.click(bold)

    await waitFor(() => expect(editable.querySelector('strong')).toBeInTheDocument())
    expect(bold).toHaveAttribute('aria-pressed', 'true')
    expect(editable.querySelector('strong')?.textContent).toBe('Comfort, on demand.')
  })

  it('clicking Underline toggles aria-pressed', async () => {
    renderStripWithEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')
    const underline = screen.getByRole('button', { name: 'Underline' })

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    await userEvent.click(underline)

    await waitFor(() => expect(underline).toHaveAttribute('aria-pressed', 'true'))
  })

  it('clicking Bulleted list produces a <ul>; clicking again removes it', async () => {
    renderStripWithEditor()
    const user = userEvent.setup()
    const editable = screen.getByLabelText('Existing scenario')
    const bulletButton = screen.getByRole('button', { name: 'Bulleted list' })

    editable.focus()
    await user.click(bulletButton)
    await waitFor(() => expect(editable.querySelector('ul')).toBeInTheDocument())
    expect(bulletButton).toHaveAttribute('aria-pressed', 'true')

    await user.click(bulletButton)
    await waitFor(() => expect(editable.querySelector('ul')).not.toBeInTheDocument())
  })

  it('clicking Numbered list produces an <ol>', async () => {
    renderStripWithEditor()
    const user = userEvent.setup()
    const editable = screen.getByLabelText('Existing scenario')
    const numberedButton = screen.getByRole('button', { name: 'Numbered list' })

    editable.focus()
    await user.click(numberedButton)
    await waitFor(() => expect(editable.querySelector('ol')).toBeInTheDocument())
    expect(numberedButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Indent increases the block indent (paddingInlineStart becomes non-empty)', async () => {
    renderStripWithEditor()
    const user = userEvent.setup()
    const editable = screen.getByLabelText('Existing scenario')
    const indentButton = screen.getByRole('button', { name: 'Indent' })

    editable.focus()
    expect(editable.querySelector('p')?.style.paddingInlineStart ?? '').toBe('')

    await user.click(indentButton)
    await waitFor(() => {
      expect(editable.querySelector('p')?.style.paddingInlineStart).not.toBe('')
    })
  })

  it('Cmd/Ctrl+B (per-editor ShortcutsPlugin) applies the same bold command', async () => {
    renderStripWithEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')
    const bold = screen.getByRole('button', { name: 'Bold' })

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'b', ctrlKey: true })

    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'))
    expect(editable.querySelector('strong')).toBeInTheDocument()
  })
})

describe('FormatStrip — commit-on-blur is preserved (081 contract)', () => {
  it('two strip edits before a single blur produce exactly one commit, carrying both formats', async () => {
    const onCommit = vi.fn()
    renderStripWithEditor(onCommit, plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')

    fireEvent.focus(editable)
    selectAllTextIn(editable)

    const bold = screen.getByRole('button', { name: 'Bold' })
    const italic = screen.getByRole('button', { name: 'Italic' })
    await userEvent.click(bold)
    await userEvent.click(italic)
    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'))
    expect(italic).toHaveAttribute('aria-pressed', 'true')
    // Still zero commits — each strip button preventDefaults its own mousedown,
    // so the editor never blurs (and never steals selection); commits happen on
    // blur only (081 design brief).
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(editable)
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    const committed = onCommit.mock.calls[0]?.[0] as string
    interface MinimalTextNode {
      format: number
    }
    interface MinimalEditorStateJson {
      root: { children: { children: MinimalTextNode[] }[] }
    }
    const parsed = JSON.parse(committed) as MinimalEditorStateJson
    const textNode = parsed.root.children[0]?.children[0]
    if (!textNode) throw new Error('expected a text node in the committed editor state')
    expect(textNode.format & 1).toBe(1) // IS_BOLD
    expect(textNode.format & 2).toBe(2) // IS_ITALIC
  })
})
