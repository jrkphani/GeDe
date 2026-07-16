// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addTier2Entry, addTier2Table, createProject } from '../db/mutations'
import { addWorkspaceMember } from '../db/workspaces'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { useProjectsStore } from '../store/projects'
import { resetSyncStore, useSyncStore } from '../store/sync'
import { resetTier2Store } from '../store/tier2'
import { resetWorkspaceStore } from '../store/workspace'
import { ArchitectureSurface } from './ArchitectureSurface'

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
    // No raw pixel literal — indentation derives from the --space-5 (24px) token.
    expect(rootTree.style.paddingLeft).toBe('calc(var(--space-5) * 0)')
    expect(childTree.style.paddingLeft).toBe('calc(var(--space-5) * 1)')
  })

  it('promote selection spans nesting levels and previews the parameter count', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    // Select a top-level row and a nested row (selection spans levels).
    await user.click(await screen.findByRole('button', { name: 'Select Buyers' }))
    await user.click(await screen.findByRole('button', { name: 'Select Superstars' }))

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

  it('renders the promoted source badge on a linked entry', async () => {
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
    expect(within(row).getByText('→ Stake')).toBeInTheDocument()
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
    await user.click(await screen.findByRole('button', { name: 'Select Entry 1' }))

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
    await user.click(await screen.findByRole('button', { name: 'Select Buyers' }))
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

    expect(screen.queryByRole('button', { name: 'Select Buyers' })).not.toBeInTheDocument()
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

    expect(await screen.findByRole('button', { name: 'Select Buyers' })).toBeInTheDocument()
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
    await screen.findByText('Stakeholders')
    expect(screen.queryByText(/No tables yet/i)).not.toBeInTheDocument()
    // The add-row never relocates — still present above the tables.
    expect(screen.getByPlaceholderText('Name a table')).toBeInTheDocument()
  })
})

describe('ArchitectureSurface — single add grammar (issue 084 finding 2)', () => {
  it('has exactly one create path and no second focus-only "Add table" control', async () => {
    await addTier2Table(db, projectId, 'Stakeholders')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Stakeholders')
    // The old context-bar focus-only pseudo-button (labeled "Add table") is gone.
    expect(screen.queryByRole('button', { name: 'Add table' })).not.toBeInTheDocument()
    // Exactly one typed create input for tables.
    expect(screen.getAllByPlaceholderText('Name a table')).toHaveLength(1)
  })
})

describe('ArchitectureSurface — typed add-child (issue 084 finding 4)', () => {
  it('opens a typed phantom instead of inserting a literal "New entry" row', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Buyers')

    await user.click(await screen.findByRole('button', { name: 'Add child to Buyers' }))
    const childField = await screen.findByPlaceholderText('Name a child of Buyers')
    await user.type(childField, 'Superstars')
    await user.keyboard('{Enter}')

    await screen.findByText('Superstars')
    // The literal placeholder row is never created.
    expect(screen.queryByText('New entry')).not.toBeInTheDocument()
  })
})

describe('ArchitectureSurface — quiet-text Remove + rehomed resolution (issue 084)', () => {
  it('deletes an unlinked entry via a quiet-text "Remove" action, with no trash icon in the meta cell', async () => {
    const user = userEvent.setup()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Entry(db, table.id, null, 'Buyers')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)

    const removeBtn = await screen.findByRole('button', { name: 'Remove Buyers' })
    expect(removeBtn).toHaveTextContent('Remove')
    // No per-row icon (Trash2/Plus rendered <svg>) survives in the meta strip.
    expect(container.querySelector('.t2-meta svg')).toBeNull()

    await user.click(removeBtn)
    await waitFor(() => expect(screen.queryByText('Buyers')).not.toBeInTheDocument())
  })

  it('routes a promoted entry through the resolution flow (never a silent cascade)', async () => {
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

    await user.click(await screen.findByRole('button', { name: 'Remove Users' }))
    // The linked-parameter resolution surfaces instead of a silent delete.
    expect(await screen.findByText(/Keep parameter as unlinked copy/)).toBeInTheDocument()
    expect(screen.getByText(/It is linked to/)).toBeInTheDocument()
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
