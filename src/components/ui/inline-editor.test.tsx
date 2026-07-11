// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineEdit, PhantomInput } from './inline-editor'

describe('InlineEdit', () => {
  it('shows the display node until clicked, then edits with the current value', async () => {
    const user = userEvent.setup()
    render(<InlineEdit value="Alpha" onCommit={() => {}} display="Alpha" displayClassName="name" />)
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByRole('textbox')).toHaveValue('Alpha')
  })

  it('Enter commits a trimmed, changed value and exits to display', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<InlineEdit value="Alpha" onCommit={onCommit} display="Alpha" />)
    await user.click(screen.getByText('Alpha'))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), '  Beta  ')
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Beta')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not commit an unchanged value', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<InlineEdit value="Alpha" onCommit={onCommit} display="Alpha" />)
    await user.click(screen.getByText('Alpha'))
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not commit an emptied value', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<InlineEdit value="Alpha" onCommit={onCommit} display="Alpha" />)
    await user.click(screen.getByText('Alpha'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Escape and blur cancel without committing', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<InlineEdit value="Alpha" onCommit={onCommit} display="Alpha" />)
    await user.click(screen.getByText('Alpha'))
    await user.type(screen.getByRole('textbox'), 'x')
    await user.keyboard('{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('controlled: `editing` prop drives the input; onEditingChange fires on exit', async () => {
    const user = userEvent.setup()
    const onEditingChange = vi.fn()
    const onCommit = vi.fn()
    const { rerender } = render(
      <InlineEdit
        value="Alpha"
        onCommit={onCommit}
        display="Alpha"
        editing={false}
        onEditingChange={onEditingChange}
      />,
    )
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByText('Alpha'))
    expect(onEditingChange).toHaveBeenCalledExactlyOnceWith(true)

    // Parent applies the state; now the input shows and commits close it.
    rerender(
      <InlineEdit
        value="Alpha"
        onCommit={onCommit}
        display="Alpha"
        editing
        onEditingChange={onEditingChange}
      />,
    )
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'Gamma')
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Gamma')
    expect(onEditingChange).toHaveBeenLastCalledWith(false)
  })

  it('readOnly: clicking the display never enters edit mode (issue 035)', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<InlineEdit value="Alpha" onCommit={onCommit} display="Alpha" readOnly />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('PhantomInput', () => {
  it('Enter submits a trimmed value, then clears and keeps focus', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<PhantomInput placeholder="Type to add" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('Type to add')
    await user.type(input, '  Buyers  ')
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Buyers')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('ignores Enter on an empty or whitespace draft', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<PhantomInput placeholder="Type to add" onSubmit={onSubmit} />)
    await user.type(screen.getByPlaceholderText('Type to add'), '   ')
    await user.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Escape clears the draft', async () => {
    const user = userEvent.setup()
    render(<PhantomInput placeholder="Type to add" onSubmit={() => {}} />)
    const input = screen.getByPlaceholderText('Type to add')
    await user.type(input, 'draft')
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('')
  })

  // Issue 069 — an impatient double-Enter before the first submit's async
  // work (e.g. createProject's DB insert) settles must not fire onSubmit
  // twice; that's how a duplicate project row gets created.
  it('ignores a second Enter while a promise-returning onSubmit is still pending', async () => {
    const user = userEvent.setup()
    let resolveSubmit: () => void = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    render(<PhantomInput placeholder="Type to add" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('Type to add')
    await user.type(input, 'Tavalo')
    await user.keyboard('{Enter}')
    expect(input).toHaveValue('')

    await user.type(input, 'Tavalo')
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)

    resolveSubmit()
  })
})
