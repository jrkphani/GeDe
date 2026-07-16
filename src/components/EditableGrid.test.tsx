// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableGrid, PHANTOM_ROW_ID, nextEditableCell, type GridColumn, type GridNav } from './EditableGrid'

// Generic domain, deliberately unrelated to contexts/dimensions — proves
// EditableGrid carries zero register-specific logic (acceptance criterion 4).
interface Task {
  id: string
  title: string
  priority: string
  category: string | null
}

const rows: Task[] = [
  { id: '1', title: 'Alpha', priority: 'P1', category: null },
  { id: '2', title: 'Beta', priority: 'P2', category: null },
]

function makeColumns(
  onTitleCommit: (row: Task, v: string) => void = vi.fn(),
  onCategoryCommit: (row: Task, v: string | null) => void = vi.fn(),
): GridColumn<Task>[] {
  return [
    {
      id: 'title',
      header: 'Title',
      cell: {
        kind: 'text',
        getValue: (t) => t.title,
        onCommit: (t, v) => {
          onTitleCommit(t, v)
        },
      },
    },
    {
      id: 'priority',
      header: 'Priority',
      cell: { kind: 'mono', getValue: (t) => t.priority, onCommit: () => {} },
    },
    {
      id: 'category',
      header: 'Category',
      cell: {
        kind: 'combobox',
        getValue: (t) => t.category,
        getOptions: () => [
          { value: 'work', label: 'Work' },
          { value: 'home', label: 'Home' },
        ],
        onCommit: (t, v) => {
          onCategoryCommit(t, v)
        },
      },
    },
  ]
}

describe('EditableGrid', () => {
  it('click/Enter edits a text cell; Enter commits and opens the cell below for editing (022)', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByDisplayValue('Alpha')).toHaveFocus()
    await user.keyboard('Zed{Enter}')
    expect(onCommit).toHaveBeenCalledWith(rows[0], 'Zed')
    // The cell below is now an editor with focus (not a display cell) — 022.
    expect(screen.getByDisplayValue('Beta')).toHaveFocus()
  })

  it('Esc reverts an in-progress edit without committing', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    await user.keyboard('Zed{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
  })

  it('Tab/Shift-Tab traverse cells in DOM order', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    await user.tab()
    expect(screen.getByText('Alpha')).toHaveFocus()
    await user.tab()
    expect(screen.getByText('P1')).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByText('Alpha')).toHaveFocus()
  })

  it('arrow keys move focus between cells when not editing', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    await user.tab()
    expect(screen.getByText('Alpha')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByText('Beta')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByText('P2')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByText('P1')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByText('Alpha')).toHaveFocus()
  })

  it('renders one header per column — columns are dynamic', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
  })

  it('combobox lists only the options given for that column and commits on select', async () => {
    const onCategoryCommit = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid rows={rows} columns={makeColumns(vi.fn(), onCategoryCommit)} getRowId={(r) => r.id} />,
    )
    const buttons = screen.getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Home')).toBeInTheDocument()
    await user.click(screen.getByText('Work'))
    expect(onCategoryCommit).toHaveBeenCalledWith(rows[0], 'work')
  })

  it('type-ahead filters the option list to the typed query', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    const buttons = screen.getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.type(screen.getByPlaceholderText('Type to filter…'), 'Wo')
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Home')).not.toBeInTheDocument()
  })

  it('phantom row: Enter creates via onCreate and clears + refocuses for the next entry', async () => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate }}
      />,
    )
    const phantomInput = screen.getByPlaceholderText('New task')
    await user.type(phantomInput, 'Gamma')
    await user.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('Gamma')
    expect(phantomInput).toHaveValue('')
    expect(phantomInput).toHaveFocus()
  })

  it('renders the row id as a data attribute for external row navigation', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    expect(document.querySelector('[data-row-id="1"]')).toContainElement(screen.getByText('Alpha'))
  })
})

describe('EditableGrid — multiline cell', () => {
  interface Note {
    id: string
    body: string
  }

  const noteRows: Note[] = [{ id: 'n1', body: 'A short justification' }]

  function makeNoteColumns(onCommit: (row: Note, v: string) => void = vi.fn()): GridColumn<Note>[] {
    return [
      {
        id: 'body',
        header: 'Body',
        cell: {
          kind: 'multiline',
          getValue: (n) => n.body,
          onCommit: (n, v) => {
            onCommit(n, v)
          },
        },
      },
    ]
  }

  it('shows the full value as a title attribute for hover/focus, truncated display otherwise', () => {
    render(<EditableGrid rows={noteRows} columns={makeNoteColumns()} getRowId={(r) => r.id} />)
    expect(screen.getByText('A short justification').closest('.grid-cell--multiline')).toHaveAttribute(
      'title',
      'A short justification',
    )
  })

  it('click/Enter edits via a textarea and commits the full text on Enter', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={noteRows} columns={makeNoteColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('A short justification'))
    const textarea = screen.getByDisplayValue('A short justification')
    expect(textarea.tagName).toBe('TEXTAREA')
    await user.clear(textarea)
    await user.type(textarea, 'Reflects the primary beneficiaries')
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledWith(noteRows[0], 'Reflects the primary beneficiaries')
  })

  it('Esc reverts without committing', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={noteRows} columns={makeNoteColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('A short justification'))
    await user.keyboard('changed{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(await screen.findByText('A short justification')).toBeInTheDocument()
  })
})

describe('text cell adornment (issue 084)', () => {
  const oneRow: Task[] = [{ id: '1', title: 'Alpha', priority: 'P1', category: null }]

  function adornedColumns(): GridColumn<Task>[] {
    return [
      {
        id: 'title',
        header: 'Title',
        cell: {
          kind: 'text',
          getValue: (t) => t.title,
          onCommit: () => {},
          adornment: (t) => <span data-testid="adorn">badge-{t.id}</span>,
        },
      },
    ]
  }

  it('renders the adornment inline in read mode, inside the value cell after the text', () => {
    render(<EditableGrid rows={oneRow} columns={adornedColumns()} getRowId={(r) => r.id} />)
    const cell = screen.getByText('Alpha').closest('.grid-cell') as HTMLElement
    expect(within(cell).getByTestId('adorn')).toHaveTextContent('badge-1')
  })

  it('does NOT render the adornment while the cell is being edited', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={oneRow} columns={adornedColumns()} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByDisplayValue('Alpha')).toHaveFocus()
    // The editor replaces the display cell — the adornment is gone while editing.
    expect(screen.queryByTestId('adorn')).not.toBeInTheDocument()
  })

  it('a text column WITHOUT adornment is unchanged (no adornment node injected)', () => {
    render(<EditableGrid rows={oneRow} columns={makeColumns()} getRowId={(r) => r.id} />)
    expect(screen.queryByTestId('adorn')).not.toBeInTheDocument()
    const cell = screen.getByText('Alpha').closest('.grid-cell') as HTMLElement
    // Only the value text node — no extra element beyond the (unused) placeholder path.
    expect(cell.querySelector('span:not(.grid-cell__placeholder)')).toBeNull()
  })
})

describe('onRowClick (issue 009)', () => {
  it('fires with the row data when any part of the row is clicked, alongside whatever that cell does', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onTitleCommit = vi.fn()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns(onTitleCommit)}
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
      />,
    )
    await user.click(screen.getByText('Alpha'))
    expect(onRowClick).toHaveBeenCalledExactlyOnceWith(rows[0])
  })

  it('is optional — omitting it changes nothing about existing row behavior', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByRole('textbox')).toHaveValue('Alpha')
  })
})

describe('onEditingChange (issue 038 — presence seam)', () => {
  it('fires with the cell opened for editing, then null when it closes', async () => {
    const user = userEvent.setup()
    const onEditingChange = vi.fn()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        onEditingChange={onEditingChange}
      />,
    )
    expect(onEditingChange).toHaveBeenLastCalledWith(null)
    await user.click(screen.getByText('Alpha'))
    expect(onEditingChange).toHaveBeenLastCalledWith({ rowId: '1', columnId: 'title' })
    await user.keyboard('{Escape}')
    expect(onEditingChange).toHaveBeenLastCalledWith(null)
  })

  it('is optional — omitting it changes nothing about existing behavior', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByDisplayValue('Alpha')).toHaveFocus()
  })
})

describe('accessible names & grid semantics (issue 021)', () => {
  it('an editing text cell has a name of "{column} for {row label}"', async () => {
    const user = userEvent.setup()
    render(
      <EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} getRowLabel={(r) => r.title} />,
    )
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByRole('textbox', { name: 'Title for Alpha' })).toHaveFocus()
  })

  it('a combobox trigger has a name including its selection state', () => {
    render(
      <EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} getRowLabel={(r) => r.title} />,
    )
    // rows[0].category is null → "unset"
    expect(screen.getByRole('button', { name: 'Category for Alpha: unset' })).toBeInTheDocument()
  })

  it('an empty text cell announces "empty" and hides the em-dash from assistive tech', () => {
    const emptyRows: Task[] = [{ id: 'x', title: '', priority: 'P1', category: null }]
    render(
      <EditableGrid rows={emptyRows} columns={makeColumns()} getRowId={(r) => r.id} getRowLabel={() => 'row X'} />,
    )
    const cell = screen.getByLabelText('Title for row X, empty')
    expect(cell).toBeInTheDocument()
    expect(cell.querySelector('.grid-cell__placeholder')).toHaveAttribute('aria-hidden', 'true')
  })

  it('every header is a scoped column header (native table semantics)', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(3)
    for (const h of headers) expect(h).toHaveAttribute('scope', 'col')
  })

  it('the phantom row input has a real accessible name (not placeholder-only)', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate: vi.fn() }}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'New task' })).toBeInTheDocument()
  })
})

describe('keyboard editing grammar (issue 022)', () => {
  it('Tab commits and opens the next editable cell for editing', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    await user.keyboard('Xed{Tab}')
    expect(onCommit).toHaveBeenCalledWith(rows[0], 'Xed')
    // The next editable cell (priority/mono) is now an editor with focus.
    expect(screen.getByDisplayValue('P1')).toHaveFocus()
  })

  it('Enter on the last data row never strands focus on <body>', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Beta'))
    await user.keyboard('{Enter}')
    expect(document.body).not.toHaveFocus()
    // Focus rests on the just-committed cell (display), not lost.
    expect(screen.getByText('Beta')).toHaveFocus()
  })

  it('Tab from the phantom creates the row and opens its next editable cell', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [data, setData] = useState<Task[]>([])
      return (
        <EditableGrid
          rows={data}
          columns={makeColumns()}
          getRowId={(r) => r.id}
          phantom={{
            columnId: 'title',
            placeholder: 'New task',
            // The new row lands with a recognizable priority so we can assert
            // its (next-editable) priority cell is the one now being edited.
            onCreate: (title) =>
              setData((d) => [...d, { id: `r${d.length + 1}`, title, priority: 'NEW', category: null }]),
          }}
        />
      )
    }
    render(<Harness />)
    await user.type(screen.getByPlaceholderText('New task'), 'Gamma')
    await user.keyboard('{Tab}')
    // The row was created; Tab continued into its next editable cell (priority).
    expect(await screen.findByDisplayValue('NEW')).toHaveFocus()
  })

  it('Shift+Enter inserts a newline in a multiline cell and does not advance', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    const noteRows = [{ id: 'n1', body: 'A short justification' }]
    const cols: GridColumn<(typeof noteRows)[number]>[] = [
      {
        id: 'body',
        header: 'Body',
        cell: {
          kind: 'multiline',
          getValue: (n) => n.body,
          onCommit: (n, v) => {
            onCommit(n, v)
          },
        },
      },
    ]
    render(<EditableGrid rows={noteRows} columns={cols} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('A short justification'))
    const textarea = screen.getByRole('textbox')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(textarea).toHaveFocus()
  })
})

describe('nextEditableCell — pure boundary logic (issue 022)', () => {
  const nav: GridNav = {
    rowIds: ['r1', 'r2', PHANTOM_ROW_ID],
    columnIds: ['a', 'b', 'c'],
    columnKindById: { a: 'text', b: 'static', c: 'combobox' },
    phantomColumnId: 'a',
  }

  it('right skips static columns within the row', () => {
    expect(nextEditableCell(nav, 'r1', 'a', 'right')).toEqual({ rowId: 'r1', columnId: 'c' })
  })

  it('right wraps to the next row’s first editable cell', () => {
    expect(nextEditableCell(nav, 'r1', 'c', 'right')).toEqual({ rowId: 'r2', columnId: 'a' })
  })

  it('left wraps back to the previous row’s last editable cell', () => {
    expect(nextEditableCell(nav, 'r2', 'a', 'left')).toEqual({ rowId: 'r1', columnId: 'c' })
  })

  it('down walks the column', () => {
    expect(nextEditableCell(nav, 'r1', 'a', 'down')).toEqual({ rowId: 'r2', columnId: 'a' })
  })

  it('down enters the phantom row only for the phantom column, else null', () => {
    expect(nextEditableCell(nav, 'r2', 'a', 'down')).toEqual({ rowId: PHANTOM_ROW_ID, columnId: 'a' })
    expect(nextEditableCell(nav, 'r2', 'c', 'down')).toBeNull()
  })

  it('returns null at the far boundary rather than stranding', () => {
    expect(nextEditableCell(nav, PHANTOM_ROW_ID, 'a', 'right')).toBeNull()
  })
})

describe('readOnly (issue 035 — viewer role affordance)', () => {
  it('renders no phantom row, regardless of what the caller passes as `phantom`', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(t) => t.id}
        readOnly
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate: vi.fn() }}
      />,
    )
    expect(screen.queryByPlaceholderText('New task')).not.toBeInTheDocument()
  })

  it('a text/mono cell click does not open an editor', async () => {
    const user = userEvent.setup()
    const onTitleCommit = vi.fn()
    render(<EditableGrid rows={rows} columns={makeColumns(onTitleCommit)} getRowId={(t) => t.id} readOnly />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('a combobox cell renders a plain display, not an interactive trigger', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(t) => t.id} readOnly />)
    expect(screen.queryAllByRole('button', { name: /Category/ })).toHaveLength(0)
    expect(screen.queryByPlaceholderText('Type to filter…')).not.toBeInTheDocument()
  })

  it('is false by default — every existing caller keeps full read/write behavior unchanged', async () => {
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(t) => t.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
