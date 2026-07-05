// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableGrid, type GridColumn } from './EditableGrid'

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
  it('click/Enter edits a text cell; Enter commits and moves focus to the cell below', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns(onCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    expect(screen.getByDisplayValue('Alpha')).toHaveFocus()
    await user.keyboard('Zed{Enter}')
    expect(onCommit).toHaveBeenCalledWith(rows[0], 'Zed')
    expect(screen.getByText('Beta')).toHaveFocus()
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
    expect(screen.getByText('A short justification').closest('[role="gridcell"]')).toHaveAttribute(
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
