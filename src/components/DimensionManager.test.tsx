// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addParameter, bindParameter, createContext, createProject } from '../db/mutations'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetContextsStore, useContextsStore } from '../store/contexts'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { resetParametersStore } from '../store/parameters'
import { DimensionManagerPanel } from './DimensionManager'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetDimensionsStore()
  resetContextsStore()
  resetParametersStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  await useDimensionsStore.getState().load(projectId)
})

async function addDimensions(count: number) {
  for (let i = 0; i < count; i++) await useDimensionsStore.getState().add()
  useDimensionsStore.getState().setEditing(null) // seeding, not a user gesture
}

describe('DimensionManagerPanel', () => {
  // Issue 082 Phase 1, test-first plan item 2 — the "Add dimension" command
  // button is retired; adding a dimension is now the same phantom-row "type +
  // Enter" grammar parameters/contexts already use (STYLE_GUIDE §6).
  it('add is a phantom-row "type + Enter" that clears and refocuses for the next; no "Add dimension" button in the tree', async () => {
    const user = userEvent.setup()
    render(<DimensionManagerPanel />)
    expect(screen.queryByRole('button', { name: 'Add dimension' })).not.toBeInTheDocument()

    const phantom = screen.getByPlaceholderText('Type to add a dimension')
    await user.type(phantom, 'Value')
    await user.keyboard('{Enter}')

    expect(useDimensionsStore.getState().dimensions[0]?.name).toBe('Value')
    expect(await screen.findByText('Value')).toBeInTheDocument()
    const freshPhantom = screen.getByPlaceholderText('Type to add a dimension')
    expect(freshPhantom).toHaveValue('')
    expect(freshPhantom).toHaveFocus()
  })

  it('Tab from the phantom (with content) creates the dimension and continues into its own parameter phantom', async () => {
    const user = userEvent.setup()
    render(<DimensionManagerPanel />)
    const phantom = screen.getByPlaceholderText('Type to add a dimension')
    await user.type(phantom, 'Stake')
    await user.keyboard('{Tab}')

    expect(await screen.findByText('Stake')).toBeInTheDocument()
    const paramPhantoms = await screen.findAllByPlaceholderText('Type to add a parameter')
    expect(paramPhantoms).toHaveLength(1)
    expect(paramPhantoms[0]).toHaveFocus()
  })

  it('renames in place from the row label', async () => {
    const user = userEvent.setup()
    await addDimensions(2)
    render(<DimensionManagerPanel />)
    await user.click(screen.getByText('Dimension 2'))
    const input = screen.getByDisplayValue('Dimension 2')
    await user.keyboard('Stake{Enter}')
    expect(await screen.findByText('Stake')).toBeInTheDocument()
    expect(input).not.toBeInTheDocument()
  })

  it('remove is disabled at the floor and enabled above it', async () => {
    await addDimensions(2)
    const { rerender } = render(<DimensionManagerPanel />)
    const removeFirst = screen.getByRole('button', { name: 'Remove Dimension 1' })
    expect(removeFirst).toBeDisabled()
    expect(removeFirst).toHaveAttribute('title', 'A canvas needs at least 2 dimensions')

    await addDimensions(1)
    rerender(<DimensionManagerPanel />)
    expect(screen.getByRole('button', { name: 'Remove Dimension 1' })).toBeEnabled()
  })

  // "Remove Dimension 1? Deletes 0 bindings." is split across <strong>/<span>
  // elements (the mono count), so it can't be matched by a single getByText —
  // read the paragraph's full textContent instead.
  function confirmCopy(): string {
    return document.querySelector('.remove-dimension-confirm__copy')?.textContent ?? ''
  }

  it('remove opens a confirm popover with the impact count; cancel is a true no-op', async () => {
    const user = userEvent.setup()
    await addDimensions(3)
    render(<DimensionManagerPanel />)

    await user.click(screen.getByRole('button', { name: 'Remove Dimension 1' }))
    await waitFor(() => expect(confirmCopy()).toMatch(/Remove Dimension 1\? Deletes 0 bindings\./))

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual([
      'Dimension 1',
      'Dimension 2',
      'Dimension 3',
    ])
    expect(document.querySelector('.remove-dimension-confirm')).not.toBeInTheDocument()
  })

  it('confirming the popover removes the dimension (single undo step)', async () => {
    const user = userEvent.setup()
    await addDimensions(3)
    useCommandLogStore.getState().clear() // seeding isn't part of the gesture under test
    render(<DimensionManagerPanel />)

    await user.click(screen.getByRole('button', { name: 'Remove Dimension 1' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm remove Dimension 1' }))
    await waitFor(() =>
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual([
        'Dimension 2',
        'Dimension 3',
      ]),
    )
    expect(useCommandLogStore.getState().past).toHaveLength(1)
  })

  it('shows the exact number of bindings the removal will delete', async () => {
    const user = userEvent.setup()
    await addDimensions(3) // above the n=2 floor so Remove is enabled
    const dims = useDimensionsStore.getState().dimensions
    const first = dims[0] as { id: string; name: string }
    const param = await addParameter(db, first.id, 'Comfort')
    const ctx = await createContext(db, projectId)
    await bindParameter(db, ctx.id, first.id, param.id)
    await useContextsStore.getState().load(projectId)

    render(<DimensionManagerPanel />)
    await user.click(screen.getByRole('button', { name: `Remove ${first.name}` }))
    await waitFor(() => expect(confirmCopy()).toMatch(/Deletes 1 binding\./))
  })

  it('Alt+Arrow reorders the focused row', async () => {
    const user = userEvent.setup()
    await addDimensions(3)
    render(<DimensionManagerPanel />)
    const row = screen.getByText('Dimension 3').closest('.dim-row') as HTMLElement
    row.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() =>
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual([
        'Dimension 1',
        'Dimension 3',
        'Dimension 2',
      ]),
    )
  })

  it('palette picker sets a slot color and marks it pressed', async () => {
    const user = userEvent.setup()
    await addDimensions(2)
    render(<DimensionManagerPanel />)
    await user.click(screen.getByRole('button', { name: 'Color of Dimension 1' }))
    await user.click(screen.getByRole('button', { name: 'Use #3D6BD6' }))
    await waitFor(() =>
      expect(useDimensionsStore.getState().dimensions[0]?.color).toBe('#3D6BD6'),
    )
  })
})
