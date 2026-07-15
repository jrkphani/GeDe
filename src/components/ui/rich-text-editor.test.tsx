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
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { RICH_TEXT_NODES } from '../../domain/richText'
import { RichTextEditor } from './rich-text-editor'

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

  it('two toolbar edits before a single blur produce exactly one commit, carrying both formats', async () => {
    const onCommit = vi.fn()
    renderEditor(onCommit, plainTextEditorStateJson('Comfort, on demand.'))
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
    // Still zero commits — neither toolbar click blurred the editor (each
    // button preventDefaults its own mousedown) or committed on its own;
    // commits happen on blur only (081 design brief).
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
    const paragraph = parsed.root.children[0]
    const textNode = paragraph?.children[0]
    if (!textNode) throw new Error('expected a text node in the committed editor state')
    expect(textNode.format & 1).toBe(1) // IS_BOLD
    expect(textNode.format & 2).toBe(2) // IS_ITALIC
  })

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

describe('RichTextEditor — toolbar (test-first plan item 8)', () => {
  it('is a role="toolbar" group of icon-only, aria-labeled buttons', () => {
    renderEditor()
    const toolbar = screen.getByRole('toolbar', { name: 'Existing scenario formatting' })
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

  it('roving tabindex: only one button is tabbable at a time; ArrowRight moves it', () => {
    renderEditor()
    const bold = screen.getByRole('button', { name: 'Bold' })
    const italic = screen.getByRole('button', { name: 'Italic' })
    expect(bold).toHaveAttribute('tabindex', '0')
    expect(italic).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(bold, { key: 'ArrowRight' })
    expect(italic).toHaveAttribute('tabindex', '0')
    expect(bold).toHaveAttribute('tabindex', '-1')
  })

  it('clicking Bold on a selection toggles aria-pressed and wraps the selection in <strong>', async () => {
    renderEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
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

  it('Cmd/Ctrl+B applies the same bold command as the toolbar button', async () => {
    renderEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')
    const bold = screen.getByRole('button', { name: 'Bold' })

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'b', ctrlKey: true })

    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'))
    expect(editable.querySelector('strong')).toBeInTheDocument()
  })

  it('clicking Underline toggles aria-pressed', async () => {
    renderEditor(vi.fn(), plainTextEditorStateJson('Comfort, on demand.'))
    const editable = screen.getByLabelText('Existing scenario')
    await screen.findByText('Comfort, on demand.')
    const underline = screen.getByRole('button', { name: 'Underline' })

    fireEvent.focus(editable)
    selectAllTextIn(editable)
    await userEvent.click(underline)

    await waitFor(() => expect(underline).toHaveAttribute('aria-pressed', 'true'))
  })

  it('clicking Bulleted list produces a <ul>; clicking again removes it', async () => {
    renderEditor()
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
    renderEditor()
    const user = userEvent.setup()
    const editable = screen.getByLabelText('Existing scenario')
    const numberedButton = screen.getByRole('button', { name: 'Numbered list' })

    editable.focus()
    await user.click(numberedButton)
    await waitFor(() => expect(editable.querySelector('ol')).toBeInTheDocument())
    expect(numberedButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Indent increases the block indent (paddingInlineStart becomes non-empty)', async () => {
    renderEditor()
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
})

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
