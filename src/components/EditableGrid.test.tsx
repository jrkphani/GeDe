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
})
