// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addTier2Entry, addTier2Table, createProject, setTier2EntryDescription } from '../db/mutations'
import { addWorkspaceMember } from '../db/workspaces'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetFocusedEditor } from '../store/focusedEditor'
import { useProjectsStore } from '../store/projects'
import { resetSyncStore, useSyncStore } from '../store/sync'
import { resetTier2Store, useTier2Store } from '../store/tier2'
import { resetWorkspaceStore } from '../store/workspace'
import { ArchitectureSurface } from './ArchitectureSurface'

// Selects all text in a contentEditable via the real DOM Selection/Range APIs
// (mirrors ContextRegister.test.tsx) — jsdom can't process realistic keyboard
// input into a Lexical editor, so drive it through selection instead.
function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let workspaceId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier2Store()
  resetWorkspaceStore()
  resetAuthStoreForTests()
  resetSyncStore()
  resetFocusedEditor()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  workspaceId = project.workspaceId
  useProjectsStore.setState({ projects: [project], status: 'ready' })
})

describe('ArchitectureSurface', () => {
  it('renders the 2nd-tier header microcopy', async () => {
    render(<ArchitectureSurface projectId={projectId} />)
    expect(await screen.findByText('2nd Tier · Architecture')).toBeInTheDocument()
  })

  it('renders each architecture table as a panel with an EditableGrid', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await waitFor(() => {
      expect(container.querySelector('table.editable-grid')).toBeInTheDocument()
    })
    expect(await screen.findByText('Buyers')).toBeInTheDocument()
  })

  it('indents nested rows off a --space token per level (STYLE_GUIDE §11, issue 084 finding 6)', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    const rootTree = container.querySelector('[data-depth="0"]') as HTMLElement
    const childTree = container.querySelector('[data-depth="1"]') as HTMLElement
    // No raw pixel literal AND no inline calc in JSX: depth only feeds a --depth
    // custom property; base.css multiplies it by the --space-5 (24px) token
    // (asserted at the CSS layer below — jsdom doesn't cascade the stylesheet).
    expect(rootTree.style.paddingLeft).toBe('')
    expect(childTree.style.paddingLeft).toBe('')
    expect(rootTree.style.getPropertyValue('--depth')).toBe('0')
    expect(childTree.style.getPropertyValue('--depth')).toBe('1')
  })

  // Owner req ("indent child records to clearly show they are child entries"):
  // the leading tree/chevron column alone only steps the chevron right — the NAME
  // is a SEPARATE fixed-width column, so a child's name text column-aligns with
  // its parent's. The row must carry its --depth to the NAME cell too, so the
  // name steps right per level and the hierarchy reads at a glance.
  it('indents a child entry NAME cell per depth level, not only the leading tree column (owner req)', async () => {
    const table = await addTier2Table(db, projectId, 'Buyers')
    const superstars = await addTier2Entry(db, table.id, null, 'Superstars')
    const whales = await addTier2Entry(db, table.id, superstars.id, 'Whales')
    await addTier2Entry(db, table.id, whales.id, 'Krakens')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Krakens')

    // The entry <tr> carries its depth as the --depth custom property (fed via
    // EditableGrid's rowStyle seam), so the NAME cell — a separate column from
    // the tree/chevron column — insets per level off the same depth model.
    const rowDepth = (name: string) =>
      (screen.getByText(name).closest('tr') as HTMLElement).style.getPropertyValue('--depth')
    expect(rowDepth('Superstars')).toBe('0')
    expect(rowDepth('Whales')).toBe('1')
    expect(rowDepth('Krakens')).toBe('2')

    // The name cell is a targetable column so the depth-keyed inset lands on it.
    const nameCell = screen.getByText('Whales').closest('td') as HTMLElement
    expect(nameCell.className).toContain('t2-col--name')
  })

  // Issue 105 P4 — the surface exposes the tree hierarchy it lacked to assistive
  // tech via a parallel SR-only role="tree" (mirroring the promote listbox): each
  // visible entry is a role="treeitem" carrying `aria-level` (= depth + 1) and,
  // on rows that HAVE children, `aria-expanded` (true while open, flips to false
  // when collapsed). Kept off the <tr> because aria-level/aria-expanded on a
  // plain-table row is an axe aria-conditional-attr violation, and role="treegrid"
  // would remap every <td>→gridcell (breaking the cell-name grammar).
  it('105 P4: exposes tree semantics — a role="tree" of treeitems with aria-level + aria-expanded, flipping on collapse', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    const tree = screen.getByRole('tree', { name: 'Stakeholders entry tree' })
    const item = (name: string) => within(tree).getByRole('treeitem', { name })
    // Depth → 1-based aria-level.
    expect(item('Buyers').getAttribute('aria-level')).toBe('1')
    expect(item('Superstars').getAttribute('aria-level')).toBe('2')
    // A parent WITH children exposes aria-expanded (true while expanded); a leaf
    // carries none (only expandable rows do).
    expect(item('Buyers').getAttribute('aria-expanded')).toBe('true')
    expect(item('Superstars').getAttribute('aria-expanded')).toBeNull()

    // Collapsing the parent flips its treeitem's aria-expanded to false and drops
    // the now-hidden child from the flattened tree.
    await user.click(screen.getByLabelText('Collapse Buyers'))
    expect(item('Buyers').getAttribute('aria-expanded')).toBe('false')
    expect(within(tree).queryByRole('treeitem', { name: 'Superstars' })).not.toBeInTheDocument()
  })

  // Issue 105 P4 — quiet keyboard-hint chips teach the tree verbs (⏎ new sibling,
  // ⌘] make child, ⌘[ promote), reusing the 084-D3 P5 KeyHint pattern. The chips
  // are decorative (aria-hidden) — the real AT semantics ride on the aria-level/
  // aria-expanded above, so the hints add ZERO screen-reader noise.
  it('105 P4: teaches the tree verbs with quiet aria-hidden key-hint chips in the row gutter', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    const buyersRow = screen.getByText('Buyers').closest('tr') as HTMLElement
    const hints = buyersRow.querySelector('.t2-row-hints') as HTMLElement
    expect(hints).toBeTruthy()
    // Every hint is aria-hidden — zero SR noise.
    for (const h of hints.querySelectorAll('.key-hint')) {
      expect(h.getAttribute('aria-hidden')).toBe('true')
    }
    // The taught verbs: ⏎ = new sibling, ⌘] = make child, ⌘[ = promote.
    const caps = [...hints.querySelectorAll('.key-hint__cap')].map((c) => c.textContent)
    expect(caps).toContain('⏎')
    expect(caps).toContain('⌘')
    expect(caps).toContain(']')
    expect(caps).toContain('[')
  })

  it('promote selection spans nesting levels and previews the parameter count', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    // Select a top-level row and a nested row (selection spans levels).
    await user.click(await screen.findByRole('option', { name: 'Select Buyers' }))
    await user.click(await screen.findByRole('option', { name: 'Select Superstars' }))

    // The selection bar appears with a promote action.
    const bar = await screen.findByText(/2 selected/)
    expect(bar).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Use as dimension/ }))

    // Popover preview line names the parameter count.
    expect(await screen.findByText(/Creates 2 parameters/)).toBeInTheDocument()
  })

  it('adds a table via the single top add-row (type + Enter clears + refocuses)', async () => {
    const user = userEvent.setup()
    render(<ArchitectureSurface projectId={projectId} />)
    const addField = await screen.findByPlaceholderText('Name a table')
    await user.type(addField, 'Process')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getAllByText('Process').length).toBeGreaterThan(0))
    // One grammar: the input clears and keeps focus for the next table.
    expect(addField).toHaveValue('')
    expect(addField).toHaveFocus()
  })

  it('shows a decorative (aria-hidden) ⏎ hint on the add-table phantom (issue 084 D3 P5)', async () => {
    render(<ArchitectureSurface projectId={projectId} />)
    const addField = await screen.findByPlaceholderText('Name a table')
    // The chip lives beside the add-table input, present in the DOM (the
    // rest/reveal is CSS visibility on :focus-within), and out of the a11y tree.
    const addRow = addField.closest('.t2-add-table') as HTMLElement
    const chip = within(addRow).getByText('⏎')
    expect(chip.closest('[aria-hidden="true"]')).not.toBeNull()
    // The add control keeps its own accessible name — the chip adds no SR text.
    expect(addField).toHaveAttribute('aria-label', 'Add architecture table')
  })

  it('renders the promoted source badge INLINE within the Name cell, not a separate meta column (issue 084 test a)', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    // Promote via the store so the link exists before the surface loads.
    const { useTier2Store } = await import('../store/tier2')
    await useTier2Store.getState().load(projectId)
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    render(<ArchitectureSurface projectId={projectId} />)
    const row = (await screen.findByText('Users')).closest('tr') as HTMLElement
    const badge = within(row).getByText('→ Stake')
    expect(badge).toBeInTheDocument()
    // The badge sits inside the same Name cell as the entry text — inline
    // adornment, not its own data column.
    const nameCell = within(row).getByText('Users').closest('.grid-cell') as HTMLElement
    expect(nameCell).toContainElement(badge)
    // The meta data column is gone entirely.
    expect(row.querySelector('.t2-col--meta')).toBeNull()
    expect(row.querySelector('.t2-meta')).toBeNull()
  })
})

// Issue 025 — the promote/selection bar must stay visible near the selection
// on a tall table instead of drifting to the end-of-list flow. Test-first
// plan items 1-2 (sticky container + progressive disclosure unchanged).
describe('ArchitectureSurface — selection bar placement (issue 025)', () => {
  it('hides the selection bar until a row is selected (progressive disclosure, unchanged)', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use as dimension/ })).not.toBeInTheDocument()
  })

  it('renders the selection bar as a sticky panel-level sibling of the grid, not a table row, on a tall table', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    // A "tall table" — enough rows that end-of-list flow would push the bar
    // far below the fold if it weren't sticky within the panel.
    const names = Array.from({ length: 25 }, (_, i) => `Entry ${i + 1}`)
    for (const name of names) await addTier2Entry(db, table.id, null, name)

    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    // Select near the top of the table, not the bottom.
    await user.click(await screen.findByRole('option', { name: 'Select Entry 1' }))

    const bar = container.querySelector('.t2-selection-bar') as HTMLElement
    expect(bar).toBeInTheDocument()
    // Not inside the grid's <table> (never end-of-list table flow).
    expect(bar.closest('table')).toBeNull()
    // A direct child of the panel section, which is what carries the sticky
    // CSS container (position: sticky is asserted against base.css below —
    // jsdom doesn't compute real layout/positioning).
    expect(bar.parentElement).toBe(container.querySelector('.t2-table'))
  })

  it('promote popover still opens from the sticky bar (regression, unchanged)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await user.click(await screen.findByRole('option', { name: 'Select Buyers' }))
    await user.click(await screen.findByRole('button', { name: /Use as dimension/ }))
    expect(await screen.findByLabelText('New dimension name')).toBeInTheDocument()
  })
})

describe('ArchitectureSurface — viewer read-only affordance (issue 035)', () => {
  it('a viewer sees the tree read-only: no select/add-child/delete/promote/add-table, no phantom row', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-viewer', email: null } })

    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    expect(screen.queryByRole('option', { name: 'Select Buyers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add child to Buyers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Buyers' })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Name an entry')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Name a table')).not.toBeInTheDocument()
  })

  it('an editor still sees the full write surface', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    await addWorkspaceMember(db, workspaceId, 'sub-editor', 'editor')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-editor', email: null } })

    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    expect(await screen.findByRole('option', { name: 'Select Buyers' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Name an entry')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Name a table')).toBeInTheDocument()
  })
})

// Issue 083 — Cause A. `members` going non-empty (someone else's row
// streamed in) never guaranteed the signed-in caller's OWN workspace_members
// row arrived first (a 067-class materialization race). Before this fix,
// that snapshot alone collapsed `role` to a hard 'viewer', so a legitimate
// owner/editor lost the "Add table" affordance for as long as their own
// membership row hadn't yet streamed in — with no error and no visible
// cause. The surface must stay interactive while role is still resolving,
// not silently collapse to read-only.
describe('ArchitectureSurface — add-table affordance survives role-still-resolving (issue 083 Cause A)', () => {
  it('keeps the "Add table" affordance while the caller\'s own membership row has not yet streamed in', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-owner', 'owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-new-member', email: null } })
    // Sync is on, but workspace_members hasn't reported "up-to-date" yet —
    // exactly the window where the signed-in caller's own row may still be
    // in flight, indistinguishable from a single snapshot from "confirmed
    // not a member".
    useSyncStore.setState({ enabled: true, upToDateTables: new Set() })

    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('2nd Tier · Architecture')

    expect(await screen.findByPlaceholderText('Name a table')).toBeInTheDocument()
  })
})

// Issue 084 (2nd Tier — Architecture UX), Phase 1 — Direction 1: a stable top
// add-row, a real empty state, one add grammar, typed add-child, and a
// quiet-text Remove that still routes promoted entries through the resolution
// flow. Owner-approved slice; keyboard Tab-chain (Phase 2) is out of scope.
describe('ArchitectureSurface — empty-state guidance (issue 084 finding 1)', () => {
  it('shows a labeled add affordance AND orienting copy, not just a bare input', async () => {
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('2nd Tier · Architecture')
    // Labeled add affordance (the stable top add-row).
    expect(screen.getByPlaceholderText('Name a table')).toBeInTheDocument()
    // One orienting line naming example dimensions — the thing that was missing.
    expect(screen.getByText(/No tables yet/i)).toBeInTheDocument()
    expect(screen.getByText(/Stakeholders/)).toBeInTheDocument()
  })

  it('drops the orienting copy once a table exists, but keeps the stable add-row', async () => {
    await addTier2Table(db, projectId, 'Stakeholders')
    render(<ArchitectureSurface projectId={projectId} />)
    // 089 D2 P4 — the table name now also appears as a quick-jump button in the
    // lane header, so disambiguate to the table panel's own name display.
    await screen.findByText('Stakeholders', { selector: '.t2-table__name' })
    expect(screen.queryByText(/No tables yet/i)).not.toBeInTheDocument()
    // The add-row never relocates — still present above the tables.
    expect(screen.getByPlaceholderText('Name a table')).toBeInTheDocument()
  })
})

describe('ArchitectureSurface — single add grammar (issue 084 finding 2)', () => {
  it('has exactly one create path and no second focus-only "Add table" control', async () => {
    await addTier2Table(db, projectId, 'Stakeholders')
    render(<ArchitectureSurface projectId={projectId} />)
    // 089 D2 P4 — the table name now also appears as a quick-jump button in the
    // lane header, so disambiguate to the table panel's own name display.
    await screen.findByText('Stakeholders', { selector: '.t2-table__name' })
    // The old context-bar focus-only pseudo-button (labeled "Add table") is gone.
    expect(screen.queryByRole('button', { name: 'Add table' })).not.toBeInTheDocument()
    // Exactly one typed create input for tables.
    expect(screen.getAllByPlaceholderText('Name a table')).toHaveLength(1)
  })
})

describe('ArchitectureSurface — typed add-child in the trailing gutter (issue 084 finding 4, test b)', () => {
  it('opens a typed phantom from the trailing row action instead of inserting a literal "New entry" row', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    const buyersRow = (await screen.findByText('Buyers')).closest('tr') as HTMLElement

    // Add child is a trailing row action, not wedged between data columns: it
    // lives in the last cell (.t2-col--actions), after Name and Description.
    // (Looked up by aria-label within the cell — a role query here is fragile
    // against a pre-existing cross-file Radix-overlay leak that spuriously
    // marks the document aria-hidden; the button itself is correctly labeled.)
    const actionsCell = buyersRow.querySelector('.t2-col--actions') as HTMLElement
    const addChildBtn = within(actionsCell).getByLabelText('Add child to Buyers')
    expect(actionsCell).toContainElement(addChildBtn)

    await user.click(addChildBtn)
    const childField = await screen.findByPlaceholderText('Name a child of Buyers')
    await user.type(childField, 'Superstars')
    await user.keyboard('{Enter}')

    await screen.findByText('Superstars')
    // The literal placeholder row is never created.
    expect(screen.queryByText('New entry')).not.toBeInTheDocument()
  })
})

// Issue 084 Direction 3, Phase 3 — the add-child popover becomes an INLINE
// typed child phantom ROW directly under the parent (at depth+1), matching the
// trailing add-table/add-entry phantom grammar (finding 4: lower interaction
// cost, one type-first grammar). Type + Enter creates the child (named on
// create, no 'New entry' literal); Esc cancels the phantom.
describe('ArchitectureSurface — D3 P3 inline typed add-child (issue 084 Direction 3)', () => {
  it('reveals an inline phantom ROW under the parent (not a popover) at depth = parent.depth + 1', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByLabelText('Add child to Buyers'))
    const childField = await screen.findByPlaceholderText('Name a child of Buyers')

    // Inline grid ROW, not a floating popover: no dialog, and the input lives
    // inside the table's own EditableGrid (not a portaled popover surface).
    expect(screen.queryByRole('dialog')).toBeNull()
    const phantomRow = childField.closest('tr') as HTMLElement
    expect(phantomRow).not.toBeNull()
    expect(childField.closest('table.editable-grid')).toBe(
      container.querySelector('table.editable-grid'),
    )
    // Indented one level below the parent (Buyers is depth 0 → child phantom 1).
    const treeCell = phantomRow.querySelector('[data-depth]') as HTMLElement
    expect(treeCell.style.getPropertyValue('--depth')).toBe('1')
  })

  it('type + Enter creates a child with THAT name under the parent (no "New entry" literal)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByLabelText('Add child to Buyers'))
    const childField = await screen.findByPlaceholderText('Name a child of Buyers')
    await user.type(childField, 'Superstars')
    await user.keyboard('{Enter}')

    // Created under Buyers with the typed name — addEntry(tableId, parentId, name).
    await waitFor(() => {
      const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
      const child = entries.find((e) => e.name === 'Superstars')
      expect(child?.parentId).toBe(buyers.id)
    })
    // Rendered indented under the parent, and no literal placeholder ever created.
    const superRow = (await screen.findByText('Superstars')).closest('tr') as HTMLElement
    const superTree = superRow.querySelector('[data-depth]') as HTMLElement
    expect(superTree.getAttribute('data-depth')).toBe('1')
    expect(screen.queryByText('New entry')).not.toBeInTheDocument()
  })

  it('Esc cancels the inline phantom without creating', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByLabelText('Add child to Buyers'))
    const childField = await screen.findByPlaceholderText('Name a child of Buyers')
    await user.type(childField, 'Discarded')
    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Name a child of Buyers')).not.toBeInTheDocument(),
    )
    const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
    expect(entries.some((e) => e.name === 'Discarded')).toBe(false)
  })
})

// Issue 105 P1 + adversarial-review HIGH 1/2/3 — the keyboard "new sibling"
// series. Pressing Enter in a committed name arms an inline type-to-create
// sibling phantom (reusing PhantomInput) at the row's OWN depth. Nothing is
// persisted until a non-empty commit (no orphan empty rows — HIGH 1), the
// issue-069 submit guard blocks a double-Enter double-create (HIGH 2), and the
// bottom add-entry phantom is decoupled — it always creates top-level (HIGH 3).
describe('ArchitectureSurface — 105 P1 keyboard sibling series', () => {
  it('Enter on a name opens a same-depth sibling phantom that creates a SIBLING, not a child', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars') // depth 1
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    // Edit Superstars' name, Enter → sibling phantom under Buyers, at depth 1.
    await user.click(screen.getByText('Superstars'))
    const nameInput = await screen.findByDisplayValue('Superstars')
    await user.type(nameInput, '{Enter}')

    const sibField = await screen.findByPlaceholderText('Name a sibling under Buyers')
    const phantomTree = (sibField.closest('tr') as HTMLElement).querySelector(
      '[data-depth]',
    ) as HTMLElement
    expect(phantomTree.style.getPropertyValue('--depth')).toBe('1')

    // Type + Enter creates a SIBLING (parent = Buyers), NOT a child of Superstars.
    await user.type(sibField, 'Whales')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
      expect(entries.find((e) => e.name === 'Whales')?.parentId).toBe(buyers.id)
    })
  })

  it('HIGH 1 — abandoning an empty sibling phantom (Esc) creates NO row and pushes NO undo step', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    const undoDepthBefore = useCommandLogStore.getState().past.length
    await user.click(screen.getByText('Buyers'))
    const nameInput = await screen.findByDisplayValue('Buyers')
    await user.type(nameInput, '{Enter}')
    const sibField = await screen.findByPlaceholderText('Name a sibling')
    await user.type(sibField, '{Escape}')

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Name a sibling')).not.toBeInTheDocument(),
    )
    const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
    // Only Buyers — no orphaned empty ("") row was persisted.
    expect(entries).toHaveLength(1)
    expect(entries.every((e) => e.name !== '')).toBe(true)
    // Clean undo: the abandoned series pushed nothing onto the command log.
    expect(useCommandLogStore.getState().past.length).toBe(undoDepthBefore)
  })

  it('HIGH 2 — a double-Enter in the sibling phantom does not double-create (issue-069 guard)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    await user.click(screen.getByText('Superstars'))
    const nameInput = await screen.findByDisplayValue('Superstars')
    await user.type(nameInput, '{Enter}')
    const sibField = await screen.findByPlaceholderText('Name a sibling under Buyers')
    await user.type(sibField, 'Whales')

    // Two synchronous Enters before the async create settles: the second is a
    // no-op (submittingRef guard), so exactly ONE "Whales" is created.
    fireEvent.keyDown(sibField, { key: 'Enter' })
    fireEvent.keyDown(sibField, { key: 'Enter' })
    await waitFor(() => {
      const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
      expect(entries.filter((e) => e.name === 'Whales')).toHaveLength(1)
    })
    // Give any (blocked) second create a chance to appear, then re-assert.
    await new Promise((r) => setTimeout(r, 50))
    const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
    expect(entries.filter((e) => e.name === 'Whales')).toHaveLength(1)
  })

  it('HIGH 3 — the bottom add-entry phantom creates TOP-LEVEL even after a sibling series', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    // Run a depth-1 sibling series under Buyers.
    await user.click(screen.getByText('Superstars'))
    const nameInput = await screen.findByDisplayValue('Superstars')
    await user.type(nameInput, '{Enter}')
    const sibField = await screen.findByPlaceholderText('Name a sibling under Buyers')
    await user.type(sibField, 'Whales')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByText('Whales')).toBeInTheDocument())
    await user.keyboard('{Escape}')

    // The bottom phantom must still create a TOP-LEVEL entry (parentId null),
    // NOT inherit the series' depth.
    const bottom = screen.getByPlaceholderText('Name an entry')
    await user.type(bottom, 'Topline')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
      expect(entries.find((e) => e.name === 'Topline')?.parentId).toBeNull()
    })
  })

  it('review fix — arming Add-child while a sibling series is open clears it (no resurface)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    // Arm a sibling series under Buyers.
    await user.click(screen.getByText('Superstars'))
    await user.type(await screen.findByDisplayValue('Superstars'), '{Enter}')
    await screen.findByPlaceholderText('Name a sibling under Buyers')

    // Click "Add child" on Superstars → the add-child phantom takes over AND the
    // sibling state is cleared (bidirectional exclusivity), not merely hidden.
    await user.click(await screen.findByLabelText('Add child to Superstars'))
    await screen.findByPlaceholderText('Name a child of Superstars')
    expect(screen.queryByPlaceholderText('Name a sibling under Buyers')).not.toBeInTheDocument()

    // Dismiss the add-child phantom (Esc) → NEITHER phantom resurfaces.
    await user.type(screen.getByPlaceholderText('Name a child of Superstars'), '{Escape}')
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Name a child of Superstars')).not.toBeInTheDocument(),
    )
    expect(screen.queryByPlaceholderText('Name a sibling under Buyers')).not.toBeInTheDocument()
  })
})

describe('ArchitectureSurface source — inline add-child, no popover literal (issue 084 D3 P3)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/ArchitectureSurface.tsx'), 'utf8')

  it('drives add-child through the grid inlineRow seam, never a literal name', () => {
    expect(source).toMatch(/inlineRow/)
    // No hardcoded child name anywhere (finding 4 — type-first, never a literal).
    expect(source).not.toMatch(/New entry/)
  })
})

describe('ArchitectureSurface — Remove moved to the selection bar (issue 084, tests c/d/e)', () => {
  it('has NO per-row "Remove" button in the row (test c)', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    const buyersRow = (await screen.findByText('Buyers')).closest('tr') as HTMLElement
    // The old per-row verb is gone — no row-scoped Remove affordance of any kind
    // (structural checks, immune to the aria-hidden overlay-leak flake).
    expect(within(buyersRow).queryByText('Remove')).toBeNull()
    expect(buyersRow.querySelector('[aria-label^="Remove"]')).toBeNull()
    // And with nothing selected, no selection bar (hence no Remove) exists at all.
    expect(container.querySelector('.t2-selection-bar')).toBeNull()
  })

  it('selecting a row surfaces a "Remove" control in the selection bar that deletes the entry (test d)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByLabelText('Select Buyers'))
    // The Remove control lives in the selection bar, not in a table row.
    const bar = (await screen.findByText(/1 selected/)).closest('.t2-selection-bar') as HTMLElement
    expect(bar).toBe(container.querySelector('.t2-selection-bar'))
    const removeBtn = within(bar).getByText('Remove')
    expect(removeBtn.closest('table')).toBeNull()

    await user.click(removeBtn)
    await waitFor(() => expect(screen.queryByText('Buyers')).not.toBeInTheDocument())
    // A clean sweep clears the selection, so the bar disappears.
    await waitFor(() => expect(screen.queryByText(/1 selected/)).not.toBeInTheDocument())
  })

  it('removing a PROMOTED selected entry still surfaces the resolution popover — never a silent cascade (test e)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const { useTier2Store } = await import('../store/tier2')
    await useTier2Store.getState().load(projectId)
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Users')

    await user.click(await screen.findByLabelText('Select Users'))
    const bar = (await screen.findByText(/1 selected/)).closest('.t2-selection-bar') as HTMLElement
    await user.click(within(bar).getByText('Remove'))
    // The linked-parameter resolution surfaces instead of a silent delete.
    expect(await screen.findByText(/Keep parameter as unlinked copy/)).toBeInTheDocument()
    expect(screen.getByText(/It is linked to/)).toBeInTheDocument()
  })
})

// Issue 084 Direction 3, Phase 4 — the promote multi-select is now a LABELED
// LISTBOX (decision 4). The per-row select control moved from an `aria-pressed`
// toggle button to a `role="option"` + `aria-selected` control inside a labeled
// `role="listbox"` (`aria-multiselectable`). Screen readers announce
// "selected"/"not selected" and multi-selectability; the existing shift-range
// select + promote flow are unchanged.
describe('ArchitectureSurface — D3 P4 listbox selection a11y (issue 084 Direction 3)', () => {
  it('exposes a labeled, multi-selectable listbox for the selection region', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true')
    // Named so an AT user knows what the multi-select is for.
    expect(listbox.getAttribute('aria-label')).toMatch(/Stakeholders/)
  })

  it('renders each selectable row as role=option with aria-selected — toggling flips it, not aria-pressed', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    const opt = screen.getByRole('option', { name: 'Select Buyers' })
    // The old aria-pressed toggle semantics are gone (decision 4).
    expect(opt).not.toHaveAttribute('aria-pressed')
    expect(opt).toHaveAttribute('aria-selected', 'false')

    await user.click(opt)
    expect(opt).toHaveAttribute('aria-selected', 'true')

    await user.click(opt)
    expect(opt).toHaveAttribute('aria-selected', 'false')
  })

  it('preserves shift-range select across the listbox (select A, shift-click C → A,B,C selected)', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Alpha')
    await addTier2Entry(db, table.id, null, 'Bravo')
    await addTier2Entry(db, table.id, null, 'Charlie')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Charlie')

    const alpha = screen.getByRole('option', { name: 'Select Alpha' })
    const bravo = screen.getByRole('option', { name: 'Select Bravo' })
    const charlie = screen.getByRole('option', { name: 'Select Charlie' })

    // Anchor on Alpha, then shift-click Charlie — the range in between fills.
    await user.click(alpha)
    fireEvent.click(charlie, { shiftKey: true })

    expect(alpha).toHaveAttribute('aria-selected', 'true')
    expect(bravo).toHaveAttribute('aria-selected', 'true')
    expect(charlie).toHaveAttribute('aria-selected', 'true')
    // The promote flow still reads the full selected set.
    expect(screen.getByText(/3 selected/)).toBeInTheDocument()
  })
})

// Issue 084 Direction 3, Phase 4 — the selection-bar Remove aligns to the Design
// route's QUIET rowAction verb weight (decision 8), matching ParameterList's
// per-row Remove, instead of the always-on `command` chrome. The delete +
// panel-anchored resolution flow are unchanged (still covered by tests c/d/e).
describe('ArchitectureSurface — D3 P4 quiet Remove verb weight (issue 084 Direction 3)', () => {
  it('renders the selection-bar Remove at the quiet rowAction weight, not command chrome', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByRole('option', { name: 'Select Buyers' }))
    const bar = container.querySelector('.t2-selection-bar') as HTMLElement
    const removeBtn = within(bar).getByText('Remove')
    // Quiet row-action chrome (STYLE_GUIDE §2.2), never the always-on command chrome.
    expect(removeBtn).toHaveClass('row-action')
    expect(removeBtn).not.toHaveClass('command-button')
  })
})

// Issue 084 Direction 3, Phase 1 — the structural mount + visual hierarchy.
// One outer EditableChainProvider threads the stacked tables; the add-table
// affordance relocates from a top standalone row to a single TRAILING phantom
// that is the chain's terminal node (`t2phantom`). Cross-table Tab is P2 — this
// phase only mounts the seam and lands the indentation/weight hierarchy.
describe('ArchitectureSurface — D3 P1 trailing add-table (issue 084 Direction 3)', () => {
  it('renders the add-table as a single TRAILING phantom after all table panels', async () => {
    await addTier2Table(db, projectId, 'Stakeholders')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Stakeholders', { selector: '.t2-table__name' })

    // One add grammar: exactly one typed create input for tables.
    expect(screen.getAllByPlaceholderText('Name a table')).toHaveLength(1)
    // The old top standalone add-table (above the panels) is gone: the add-row
    // now trails the last table panel in document order.
    const addRow = container.querySelector('.t2-add-table') as HTMLElement
    const lastTable = [...container.querySelectorAll('.t2-table')].pop() as HTMLElement
    expect(addRow).not.toBeNull()
    expect(lastTable.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still creates a table from the trailing phantom (type + Enter clears + refocuses)', async () => {
    const user = userEvent.setup()
    render(<ArchitectureSurface projectId={projectId} />)
    const addField = await screen.findByPlaceholderText('Name a table')
    await user.type(addField, 'Process')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getAllByText('Process').length).toBeGreaterThan(0))
    expect(addField).toHaveValue('')
    expect(addField).toHaveFocus()
  })

  it('preserves per-entry --depth and carries the table→entry inset class on the section', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    const root = container.querySelector('[data-depth="0"]') as HTMLElement
    const child = container.querySelector('[data-depth="1"]') as HTMLElement
    // Per-entry depth preserved: a child's --depth exceeds its parent's.
    expect(Number(child.style.getPropertyValue('--depth'))).toBeGreaterThan(
      Number(root.style.getPropertyValue('--depth')),
    )
    // The table section now carries the new table→entry inset class.
    expect(container.querySelector('.t2-table.t2-table--indent')).not.toBeNull()
  })
})

// The outer chain seam + terminal add-table node are asserted at the source
// layer (jsdom mounts the provider but P1 wires no cross-table registrations —
// that is P2 — so behavior alone can't yet prove the mount).
describe('ArchitectureSurface source — D3 outer EditableChainProvider (issue 084 Direction 3 P1)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/ArchitectureSurface.tsx'), 'utf8')

  it('wraps the stacked tables in an EditableChainProvider ordered by chainOrder(tables)', () => {
    expect(source).toMatch(/EditableChainProvider/)
    expect(source).toMatch(/order=\{chainOrder\(tables\)\}/)
  })

  it('gives the trailing add-table phantom the terminal chain id CHAIN_PHANTOM_ID', () => {
    expect(source).toMatch(/chainId=\{CHAIN_PHANTOM_ID\}/)
  })
})

// Issue 084 Direction 3, Phase 2 — cross-table Tab via the shared seam (the
// CORE-RISK phase). The outer EditableChainProvider now threads real per-table
// boundary registrations: each table contributes an `:in` (first editable cell)
// and `:out` (its add-entry phantom); the grid's frozen `onExitBoundary(dir)`
// seam advances across tables through the chain, and the add-table phantom is
// the terminal node that continues focus into a freshly-created table.
describe('ArchitectureSurface — D3 P2 cross-table Tab (issue 084 Direction 3)', () => {
  async function twoTables() {
    const a = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, a.id, null, 'Buyers')
    const b = await addTier2Table(db, projectId, 'Value')
    await addTier2Entry(db, b.id, null, 'Comfort')
    return { a, b }
  }

  it('Tab from a table’s add-entry phantom lands focus in the next table’s first cell', async () => {
    const user = userEvent.setup()
    const { b } = await twoTables()
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')
    await screen.findByText('Comfort')

    // A's add-entry phantom is the first "Name an entry" input in document order.
    const phantomA = screen.getAllByPlaceholderText('Name an entry')[0] as HTMLInputElement
    phantomA.focus()
    expect(phantomA).toHaveFocus()

    await user.tab()

    // Focus crossed into table B's first editable cell (its entry Name cell).
    const bSection = document.getElementById(`t2-table-${b.id}`) as HTMLElement
    const bFirstCell = within(bSection).getByText('Comfort').closest('.grid-cell') as HTMLElement
    expect(bFirstCell).toHaveFocus()
  })

  it('Shift+Tab from a table’s first cell lands focus on the previous table’s add-entry phantom', async () => {
    const user = userEvent.setup()
    const { b } = await twoTables()
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')
    await screen.findByText('Comfort')

    const bSection = document.getElementById(`t2-table-${b.id}`) as HTMLElement
    const bFirstCell = within(bSection).getByText('Comfort').closest('.grid-cell') as HTMLElement
    bFirstCell.focus()
    expect(bFirstCell).toHaveFocus()

    await user.tab({ shift: true })

    // Backward off B's `:in` lands on A's `:out` — A's add-entry phantom (the
    // first "Name an entry" input in document order).
    const phantomA = screen.getAllByPlaceholderText('Name an entry')[0] as HTMLInputElement
    expect(phantomA).toHaveFocus()
  })

  it('Tab from the LAST table’s add-entry phantom lands focus on the terminal add-table phantom', async () => {
    const user = userEvent.setup()
    await twoTables()
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')
    await screen.findByText('Comfort')

    // B is the last table; its add-entry phantom is the last "Name an entry".
    const phantoms = screen.getAllByPlaceholderText('Name an entry')
    const phantomB = phantoms[phantoms.length - 1] as HTMLInputElement
    phantomB.focus()
    expect(phantomB).toHaveFocus()

    await user.tab()

    // Forward off the last table's `:out` lands on the terminal `t2phantom`.
    expect(screen.getByPlaceholderText('Name a table')).toHaveFocus()
  })

  it('typing a table name in the add-table phantom + Tab creates the table AND continues focus into its first cell', async () => {
    const user = userEvent.setup()
    await twoTables()
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')
    await screen.findByText('Comfort')

    const addField = screen.getByPlaceholderText('Name a table')
    addField.focus()
    await user.type(addField, 'Process')
    await user.tab()

    // The table was created…
    await waitFor(() => {
      expect(useTier2Store.getState().tables.some((t) => t.name === 'Process')).toBe(true)
    })
    // …and focus continued into the new (empty) table's first editable position —
    // its own add-entry phantom — via focusWhenReady's pending mechanism.
    await waitFor(() => {
      const created = useTier2Store.getState().tables.find((t) => t.name === 'Process')
      const section = document.getElementById(`t2-table-${created?.id}`) as HTMLElement
      const firstPos = section.querySelector('.grid-row--phantom input') as HTMLElement
      expect(firstPos).toHaveFocus()
    })
  })
})

// Owner UX requirement (issue 084 Direction 3): a table→entry indent level plus
// a parent-heavier font-weight step, both token-driven (jsdom doesn't cascade
// base.css, so assert the CSS/token layer directly).
describe('.t2-table CSS — table→entry inset + weight hierarchy (issue 084 Direction 3 P1)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')
  const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

  it('insets a table\'s entries under its header via a --space token, no raw px', () => {
    const match = /\.t2-table--indent[^{]*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1] as string
    expect(body).toMatch(/var\(--space-\d\)/)
    expect(body).not.toMatch(/\d+px/)
  })

  it('makes the parent (table name) heavier than child entries via font-weight tokens', () => {
    // Parent record: the table name resolves to the strong weight token.
    const nameMatch = /\.t2-table__name\s*\{([^}]*)\}/.exec(css)
    expect((nameMatch as RegExpMatchArray)[1]).toMatch(/font-weight:\s*var\(--font-weight-strong\)/)
    // Child records: entry name cells resolve to the lighter (normal) token.
    expect(css).toMatch(/font-weight:\s*var\(--font-weight-normal\)/)
    // Tokens: the parent weight is numerically heavier than the child weight.
    const strong = Number(/--font-weight-strong:\s*(\d+)/.exec(tokens)?.[1])
    const normal = Number(/--font-weight-normal:\s*(\d+)/.exec(tokens)?.[1])
    expect(strong).toBeGreaterThan(normal)
  })
})

// Issue 084 finding 6 (STYLE_GUIDE §11) — the nested-row indent must be
// token-driven at the CSS layer, not a raw pixel literal or an inline calc in
// JSX. base.css computes it from the per-row --depth custom property times the
// --space-5 (24px) step, so the visual indent (24px/level) is unchanged.
describe('.t2-tree CSS — token-driven nested indent (issue 084 finding 6)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  it('computes padding-left from --depth × the --space-5 token, no raw px', () => {
    const match = /\.t2-tree\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1] as string
    expect(body).toMatch(/padding-left:\s*calc\(var\(--depth[^)]*\)\s*\*\s*var\(--space-5\)\)/)
    // Guard against a raw pixel literal creeping back into the indent.
    expect(body).not.toMatch(/padding-left:\s*[^;]*\d+px/)
  })
})

// Owner req refinement (issue 084 Direction 3) — the child NAME cell must also
// step right per depth level (the tree column alone only indents the chevron).
// The inset is token-driven off the SAME per-row --depth model the tree uses
// (× the --space-5 step), so depth 0 → 0 inset → flat tables/other grids
// unchanged. Asserted at the CSS layer (jsdom doesn't cascade base.css).
describe('.t2-col--name CSS — depth-keyed NAME indent (issue 084 Direction 3)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  it('insets the name cell by --depth × the --space-5 token, no raw px', () => {
    const match = /\.t2-col--name\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1] as string
    expect(body).toMatch(
      /padding-inline-start:\s*calc\(var\(--depth[^)]*\)\s*\*\s*var\(--space-5\)\)/,
    )
    expect(body).not.toMatch(/\d+px/)
  })
})

// Issue 084 finding 7 (STYLE_GUIDE §10) — focus is React-managed, never a
// DOM reach. The old context-bar "Add table" button used
// `addTableRef.current?.querySelector('input')?.focus()`; that whole affordance
// was removed (the add-table PhantomInput is the single create path and is
// role-gated, asserted by the viewer test above). This guards the regression.
describe('ArchitectureSurface source — no querySelector focus reach (issue 084 finding 7)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/ArchitectureSurface.tsx'), 'utf8')

  it('never reaches into the DOM with querySelector to move focus', () => {
    expect(source).not.toMatch(/querySelector/)
  })
})

describe('.t2-selection-bar CSS — sticky within the panel (issue 025)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  it('sticks to the panel scroll viewport instead of end-of-list flow', () => {
    const match = /\.t2-selection-bar\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1] as string
    expect(body).toMatch(/position:\s*sticky/)
    expect(body).toMatch(/bottom:\s*0/)
    // An opaque fill so grid rows scrolling underneath the pinned bar don't
    // show through (it now floats over content instead of sitting in flow).
    expect(body).toMatch(/background:\s*var\(--panel\)/)
  })
})

// Issue 089 D1 Phase 5 — the entry Description becomes a rich grid cell (like
// the justification column, P3), mirroring the two other prose descriptions.
describe('ArchitectureSurface — entry Description is a rich cell (issue 089 D1 Phase 5)', () => {
  it('renders a legacy plain description, swaps to the rich editor on click, and commits via Cmd+Enter', async () => {
    const table = await addTier2Table(db, projectId, 'Value')
    const entry = await addTier2Entry(db, table.id, null, 'Comfort')
    await setTier2EntryDescription(db, entry.id, 'The rider stays comfortable.')
    const user = userEvent.setup()
    render(<ArchitectureSurface projectId={projectId} />)

    const row = (await screen.findByText('Comfort')).closest('tr') as HTMLElement
    // Legacy plain string renders as a clamped read-mode summary.
    const summary = within(row).getByText('The rider stays comfortable.')
    expect(summary).toHaveClass('grid-cell__clamp')

    // Click swaps to a live Lexical contentEditable (NOT a textarea).
    await user.click(summary)
    const editable = within(row).getByLabelText('Description')
    expect(editable).toHaveAttribute('contenteditable', 'true')
    expect(editable).toHaveTextContent('The rider stays comfortable.')

    // Empty it and commit with Cmd/Ctrl+Enter — persisted via setEntryDescription,
    // and the cell collapses back to read mode.
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))
    fireEvent.keyDown(editable, { key: 'Enter', metaKey: true })

    await waitFor(() => {
      const entries = useTier2Store.getState().entriesByTable[table.id] ?? []
      expect(entries.find((e) => e.id === entry.id)?.description ?? '').toBe('')
    })
    await waitFor(() => expect(within(row).queryByLabelText('Description')).not.toBeInTheDocument())
  })
})
