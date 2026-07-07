// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MultilineEdit } from './multiline-editor'

describe('MultilineEdit', () => {
  it('shows the display node until clicked, then edits with the current value', async () => {
    const user = userEvent.setup()
    render(<MultilineEdit value="Reason" onCommit={() => {}} display="Reason" displayClassName="just" />)
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByText('Reason'))
    expect(screen.getByRole('textbox')).toHaveValue('Reason')
  })

  it('Enter (no shift) commits a trimmed, changed value and exits to display', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />)
    await user.click(screen.getByText('Reason'))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), '  Better reason  ')
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Better reason')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits an emptied value (justification is nullable/clearable, unlike InlineEdit)', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />)
    await user.click(screen.getByText('Reason'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('')
  })

  it('does not commit an unchanged value', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />)
    await user.click(screen.getByText('Reason'))
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Shift+Enter inserts a newline instead of committing', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />)
    await user.click(screen.getByText('Reason'))
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('Escape and blur cancel without committing', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />)
    await user.click(screen.getByText('Reason'))
    await user.type(screen.getByRole('textbox'), 'x')
    await user.keyboard('{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('blur commits the trimmed draft', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(
      <>
        <MultilineEdit value="Reason" onCommit={onCommit} display="Reason" />
        <button>elsewhere</button>
      </>,
    )
    await user.click(screen.getByText('Reason'))
    await user.type(screen.getByRole('textbox'), '  more')
    await user.click(screen.getByText('elsewhere'))
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Reason  more')
  })

  it('readOnly: clicking the display never enters edit mode (issue 035)', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<MultilineEdit value="Reason" onCommit={onCommit} display="Reason" readOnly />)
    await user.click(screen.getByText('Reason'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
