// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableChainProvider, InlineEdit, PhantomInput } from './inline-editor'

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

// Issue 082 Phase 1, test-first plan item 3 — the rail's keyboard model must
// match EditableGrid's (Enter down, Tab across, Tab-from-phantom continues
// into the new row, Esc reverts). A minimal two-field-plus-phantom chain
// stands in for "dimension name -> its parameter names -> its own phantom".
describe('EditableChainProvider — commit-and-advance grammar (issue 082)', () => {
  function Chain({ onCreate }: { onCreate: (name: string) => void }) {
    const [rows, setRows] = useState<string[]>(['Alpha', 'Beta'])
    const order = [...rows.map((_, i) => `row:${i}`), 'phantom']
    return (
      <EditableChainProvider order={order}>
        {rows.map((value, i) => (
          <InlineEdit
            key={i}
            chainId={`row:${i}`}
            value={value}
            onCommit={(next) => {
              setRows((prev) => prev.map((v, idx) => (idx === i ? next : v)))
            }}
            display={value}
            displayClassName={`row-${i}`}
          />
        ))}
        <PhantomInput
          placeholder="Type to add"
          chainId="phantom"
          onSubmit={(name) => {
            onCreate(name)
            setRows((prev) => [...prev, name])
          }}
        />
      </EditableChainProvider>
    )
  }

  it('Enter commits and moves editing down to the next field', async () => {
    const user = userEvent.setup()
    render(<Chain onCreate={() => {}} />)
    await user.click(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    await user.clear(input)
    await user.type(input, 'Value')
    await user.keyboard('{Enter}')
    // Editing moved to the next field (Beta) rather than closing entirely.
    expect(await screen.findByDisplayValue('Beta')).toHaveFocus()
    expect(await screen.findByText('Value')).toBeInTheDocument()
  })

  it('Tab commits and moves right; Shift+Tab moves left', async () => {
    const user = userEvent.setup()
    render(<Chain onCreate={() => {}} />)
    await user.click(screen.getByText('Alpha'))
    await user.keyboard('{Tab}')
    expect(await screen.findByDisplayValue('Beta')).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(await screen.findByDisplayValue('Alpha')).toHaveFocus()
  })

  it('Esc reverts the draft without committing or advancing', async () => {
    const user = userEvent.setup()
    render(<Chain onCreate={() => {}} />)
    await user.click(screen.getByText('Alpha'))
    await user.type(screen.getByDisplayValue('Alpha'), 'xyz')
    await user.keyboard('{Escape}')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    // Only the phantom's own (always-mounted) input remains — row 0's editor
    // unmounted without committing "xyz" and without advancing anywhere.
    expect(screen.queryByDisplayValue('xyzAlpha')).toBeNull()
    expect(screen.queryByDisplayValue('Alphaxyz')).toBeNull()
  })

  it('Tab from the phantom (with content) creates a row and continues into it', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<Chain onCreate={onCreate} />)
    const phantom = screen.getByPlaceholderText('Type to add')
    await user.type(phantom, 'Gamma')
    await user.keyboard('{Tab}')
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Gamma')
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    // The default Tab-from-phantom behavior (no onTabSubmit override) is
    // EditableGrid's own single-column phantom fallback: create + self-refocus.
    expect(phantom).toHaveFocus()
  })

  it('arrow-key nav on a focused (non-editing) display moves to the next/previous field', async () => {
    const user = userEvent.setup()
    render(<Chain onCreate={() => {}} />)
    screen.getByText('Alpha').focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByText('Beta')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByText('Alpha')).toHaveFocus()
  })
})
