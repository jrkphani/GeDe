// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addTier2Entry, addTier2Table, createProject } from '../db/mutations'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetTier2Store } from '../store/tier2'
import { ArchitectureSurface } from './ArchitectureSurface'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier2Store()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
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

  it('indents nested rows by 24px per level (STYLE_GUIDE §6)', async () => {
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    const { container } = render(<ArchitectureSurface projectId={projectId} />)
    await screen.findByText('Superstars')

    const rootTree = container.querySelector('[data-depth="0"]') as HTMLElement
    const childTree = container.querySelector('[data-depth="1"]') as HTMLElement
    expect(rootTree.style.paddingLeft).toBe('0px')
    expect(childTree.style.paddingLeft).toBe('24px')
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

  it('adds a new table via the ghost "Add table" affordance', async () => {
    const user = userEvent.setup()
    render(<ArchitectureSurface projectId={projectId} />)
    const addField = await screen.findByPlaceholderText('Add table')
    await user.type(addField, 'Process')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getAllByText('Process').length).toBeGreaterThan(0))
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
