// @vitest-environment jsdom
import { useState, type CSSProperties } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { RICH_TEXT_NODES } from '../domain/richText'
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

// Selects the full text content of `container` via the real DOM
// Selection/Range APIs (jsdom implements these; only realistic keyboard input
// is what Lexical can't process here — see rich-text-editor.test.tsx's header).
function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('EditableGrid — richtext cell (089 D1 Phase 3)', () => {
  interface Note {
    id: string
    body: string
  }

  // Lexical JSON for a "converted" cell, built via the same node set the editor
  // uses. A raw plain string stands in for a legacy, not-yet-converted cell.
  function richJson(text: string): string {
    const editor = createEditor({
      namespace: 'test',
      nodes: RICH_TEXT_NODES,
      onError: (e) => {
        throw e
      },
    })
    editor.update(
      () => {
        const p = $createParagraphNode()
        p.append($createTextNode(text))
        $getRoot().append(p)
      },
      { discrete: true },
    )
    return JSON.stringify(editor.getEditorState().toJSON())
  }

  function makeCols(onCommit: (row: Note, v: string) => void = vi.fn()): GridColumn<Note>[] {
    return [
      {
        id: 'body',
        header: 'Body',
        cell: {
          kind: 'richtext',
          placeholder: 'Add note…',
          getValue: (n) => n.body,
          onCommit: (n, v) => {
            onCommit(n, v)
          },
        },
      },
    ]
  }

  it('Cmd+Enter commits the value AND advances edit-focus DOWN to the next row', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    const noteRows: Note[] = [
      { id: 'r1', body: richJson('One') },
      { id: 'r2', body: richJson('Two') },
    ]
    render(<EditableGrid rows={noteRows} columns={makeCols(onCommit)} getRowId={(r) => r.id} />)

    // Idle → click swaps the read-mode display for a LIVE contentEditable.
    await user.click(screen.getByText('One'))
    const editable = await screen.findByLabelText('Body')
    expect(editable).toHaveAttribute('contenteditable', 'true')

    // A real edit jsdom can drive (select-all + Backspace empties the doc).
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))

    // Cmd+Enter commits, then advances DOWN into row 2's editor.
    fireEvent.keyDown(editable, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(noteRows[0], ''))
    await waitFor(() => {
      const next = screen.getByLabelText('Body')
      expect(next).toHaveAttribute('contenteditable', 'true')
      expect(next).toHaveFocus()
    })
  })

  it('Esc reverts the in-progress edit and lands focus on the read-mode display (not lost)', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    const noteRows: Note[] = [{ id: 'r1', body: richJson('One') }]
    render(<EditableGrid rows={noteRows} columns={makeCols(onCommit)} getRowId={(r) => r.id} />)

    await user.click(screen.getByText('One'))
    const editable = await screen.findByLabelText('Body')
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))

    fireEvent.keyDown(editable, { key: 'Escape' })

    // Reverted: nothing committed, original prose back in the read-mode display.
    expect(onCommit).not.toHaveBeenCalled()
    const display = await screen.findByText('One')
    expect(display.closest('.grid-cell')).toHaveFocus()
  })

  it('Tab from the read-mode display traverses to the next cell, NOT into the editor', async () => {
    const user = userEvent.setup()
    const noteRows: Note[] = [
      { id: 'r1', body: richJson('One') },
      { id: 'r2', body: richJson('Two') },
    ]
    render(<EditableGrid rows={noteRows} columns={makeCols()} getRowId={(r) => r.id} />)

    await user.tab()
    expect(screen.getByText('One').closest('.grid-cell')).toHaveFocus()
    // No live editor opened by focusing the display.
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()

    await user.tab()
    // Tab moved to the NEXT cell's display, not into row 1's editor.
    expect(screen.getByText('Two').closest('.grid-cell')).toHaveFocus()
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  })

  it('renders a legacy plain-string value visibly and does NOT persist it on view', () => {
    const onCommit = vi.fn()
    const noteRows: Note[] = [{ id: 'r1', body: 'Legacy plain justification' }]
    render(<EditableGrid rows={noteRows} columns={makeCols(onCommit)} getRowId={(r) => r.id} />)
    // Rendered (not blank) even though it is not Lexical JSON…
    expect(screen.getByText('Legacy plain justification')).toBeInTheDocument()
    // …and never re-persisted merely by rendering it (the editor never mounts).
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('an empty richtext cell shows its per-column placeholder, not "Add justification…"', async () => {
    const user = userEvent.setup()
    const noteRows: Note[] = [{ id: 'r1', body: '' }]
    render(<EditableGrid rows={noteRows} columns={makeCols()} getRowId={(r) => r.id} />)

    // Open the editor on the empty cell — the ghost renders inside it.
    await user.click(screen.getByLabelText('Body, empty'))
    expect(await screen.findByText('Add note…')).toBeInTheDocument()
    // Blocker 3 (089 D1): the hardcoded justification ghost must be gone for
    // non-justification (e.g. description) rich columns.
    expect(screen.queryByText('Add justification…')).toBeNull()
  })

  it('the phantom row on a richtext column stays a plain input and still creates', async () => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid
        rows={[]}
        columns={makeCols()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'body', placeholder: 'New note', onCreate }}
      />,
    )
    const phantom = screen.getByPlaceholderText('New note')
    // Typing prose into the phantom uses a plain input, never a rich editor.
    expect(phantom.tagName).toBe('INPUT')
    await user.type(phantom, 'Fresh')
    await user.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('Fresh')
  })
})

describe('onExitBoundary (089-D3 P3.0 — cross-node Tab handoff seam)', () => {
  it('fires forward when Tab leaves the forward boundary (empty phantom, forward Tab)', () => {
    const onExitBoundary = vi.fn()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate: vi.fn() }}
        onExitBoundary={onExitBoundary}
      />,
    )
    const phantom = screen.getByPlaceholderText('New task')
    phantom.focus()
    fireEvent.keyDown(phantom, { key: 'Tab' })
    expect(onExitBoundary).toHaveBeenCalledExactlyOnceWith('forward')
  })

  it('does NOT fire forward when the phantom has content (Tab creates-and-continues, not an exit)', async () => {
    const onExitBoundary = vi.fn()
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate }}
        onExitBoundary={onExitBoundary}
      />,
    )
    const phantom = screen.getByPlaceholderText('New task')
    await user.type(phantom, 'Gamma')
    fireEvent.keyDown(phantom, { key: 'Tab' })
    expect(onCreate).toHaveBeenCalledWith('Gamma')
    expect(onExitBoundary).not.toHaveBeenCalled()
  })

  it('fires backward on Shift+Tab from a DISPLAY cell at the first editable cell', async () => {
    const onExitBoundary = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} onExitBoundary={onExitBoundary} />,
    )
    await user.tab()
    expect(screen.getByText('Alpha')).toHaveFocus()
    fireEvent.keyDown(screen.getByText('Alpha'), { key: 'Tab', shiftKey: true })
    expect(onExitBoundary).toHaveBeenCalledExactlyOnceWith('backward')
  })

  it('does NOT fire backward on Shift+Tab from a NON-boundary cell (there is a previous editable cell)', async () => {
    const onExitBoundary = vi.fn()
    const user = userEvent.setup()
    render(
      <EditableGrid rows={rows} columns={makeColumns()} getRowId={(r) => r.id} onExitBoundary={onExitBoundary} />,
    )
    await user.tab()
    await user.tab()
    expect(screen.getByText('P1')).toHaveFocus()
    fireEvent.keyDown(screen.getByText('P1'), { key: 'Tab', shiftKey: true })
    expect(onExitBoundary).not.toHaveBeenCalled()
  })

  it('fires backward from an ACTIVELY-EDITING first cell AFTER committing the in-flight edit (no lost edit)', async () => {
    const order: string[] = []
    const onExitBoundary = vi.fn(() => order.push('exit'))
    const onTitleCommit = vi.fn(() => order.push('commit'))
    const user = userEvent.setup()
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns(onTitleCommit)}
        getRowId={(r) => r.id}
        onExitBoundary={onExitBoundary}
      />,
    )
    await user.click(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    await user.clear(input)
    await user.type(input, 'Xed')
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(onExitBoundary).toHaveBeenCalledWith('backward'))
    // The in-flight edit was committed, not lost…
    expect(onTitleCommit).toHaveBeenCalledWith(rows[0], 'Xed')
    // …and committed BEFORE the boundary signal (commit-then-signal).
    expect(order).toEqual(['commit', 'exit'])
  })

  it('without onExitBoundary, empty-phantom forward Tab falls through to native (unchanged, no throw)', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(r) => r.id}
        phantom={{ columnId: 'title', placeholder: 'New task', onCreate: vi.fn() }}
      />,
    )
    const phantom = screen.getByPlaceholderText('New task')
    phantom.focus()
    fireEvent.keyDown(phantom, { key: 'Tab' })
    expect(phantom).toBeInTheDocument()
  })

  it('without onExitBoundary, Shift+Tab from an editing first cell keeps the current stay-put behavior', async () => {
    const onTitleCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditableGrid rows={rows} columns={makeColumns(onTitleCommit)} getRowId={(r) => r.id} />)
    await user.click(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    // Current behavior: commit-and-advance(null) → focus lands back on the origin display cell, never <body>.
    await waitFor(() => expect(screen.getByText('Alpha')).toHaveFocus())
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

// Issue 084 Direction 3 P3 — the additive `inlineRow` seam: a caller-supplied
// transient row injected immediately after a named data row (Architecture's
// inline typed add-child phantom under its parent). Tier-agnostic (the grid owns
// the <tr>/<td>, the caller owns each column's content) and default-off, so every
// existing caller stays byte-identical.
describe('inlineRow (issue 084 D3 P3 — per-parent inline row seam)', () => {
  it('renders a caller-supplied transient row immediately after the named data row', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(t) => t.id}
        inlineRow={{
          afterRowId: '1',
          className: 'inline-after',
          cell: (columnId) => (columnId === 'title' ? <input placeholder="inline child" /> : null),
        }}
      />,
    )
    const injected = screen.getByPlaceholderText('inline child')
    const injectedRow = injected.closest('tr') as HTMLTableRowElement
    expect(injectedRow).toHaveClass('inline-after')
    // Positioned right after row '1' (Alpha), before row '2' (Beta).
    const bodyRows = [...(injectedRow.closest('tbody') as HTMLElement).querySelectorAll('tr')]
    const alphaRow = screen.getByText('Alpha').closest('tr') as HTMLTableRowElement
    const betaRow = screen.getByText('Beta').closest('tr') as HTMLTableRowElement
    expect(bodyRows.indexOf(alphaRow)).toBeLessThan(bodyRows.indexOf(injectedRow))
    expect(bodyRows.indexOf(injectedRow)).toBeLessThan(bodyRows.indexOf(betaRow))
  })

  it('renders no transient row when inlineRow is absent (byte-identical default-off)', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(t) => t.id} />)
    expect(screen.queryByPlaceholderText('inline child')).toBeNull()
  })

  it('never renders the inline row when readOnly (gated like the phantom)', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(t) => t.id}
        readOnly
        inlineRow={{ afterRowId: '1', cell: () => <input placeholder="inline child" /> }}
      />,
    )
    expect(screen.queryByPlaceholderText('inline child')).toBeNull()
  })
})

// Issue 084 Direction 3 refinement — the additive `rowStyle` seam: a caller may
// feed a per-row inline style (Architecture uses it to carry each entry's --depth
// so the NAME cell steps right per level). Default-off: absent → no style attr →
// every existing caller (Foundation, ContextRegister, the ?d3rf canvas at depth
// 0) stays byte-identical.
describe('rowStyle (issue 084 D3 — per-row style seam)', () => {
  it('applies a caller-supplied inline style (e.g. --depth) to the data row', () => {
    render(
      <EditableGrid
        rows={rows}
        columns={makeColumns()}
        getRowId={(t) => t.id}
        rowStyle={(t) => ({ '--depth': t.id === '2' ? 1 : 0 }) as CSSProperties}
      />,
    )
    const beta = screen.getByText('Beta').closest('tr') as HTMLTableRowElement
    const alpha = screen.getByText('Alpha').closest('tr') as HTMLTableRowElement
    expect(beta.style.getPropertyValue('--depth')).toBe('1')
    expect(alpha.style.getPropertyValue('--depth')).toBe('0')
  })

  it('sets no style attribute when rowStyle is absent (byte-identical default-off)', () => {
    render(<EditableGrid rows={rows} columns={makeColumns()} getRowId={(t) => t.id} />)
    const alpha = screen.getByText('Alpha').closest('tr') as HTMLTableRowElement
    expect(alpha.getAttribute('style')).toBeNull()
  })
})
