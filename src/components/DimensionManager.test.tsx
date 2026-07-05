// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { setDatabase } from '../store/database'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { DimensionManagerPanel } from './DimensionManager'

beforeEach(async () => {
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  resetDimensionsStore()
  const project = await createProject(db, { name: 'Tavalo' })
  await useDimensionsStore.getState().load(project.id)
})

async function addDimensions(count: number) {
  for (let i = 0; i < count; i++) await useDimensionsStore.getState().add()
  useDimensionsStore.getState().setEditing(null) // seeding, not a user gesture
}

describe('DimensionManagerPanel', () => {
  it('add creates "Dimension N" ready to edit', async () => {
    const user = userEvent.setup()
    render(<DimensionManagerPanel />)
    await user.click(screen.getByRole('button', { name: 'Add dimension' }))
    const input = await screen.findByDisplayValue('Dimension 1')
    expect(input).toHaveFocus()
    await user.keyboard('Value{Enter}') // focused select-all: typing replaces
    expect(useDimensionsStore.getState().dimensions[0]?.name).toBe('Value')
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
    const user = userEvent.setup()
    await addDimensions(2)
    const { rerender } = render(<DimensionManagerPanel />)
    const removeFirst = screen.getByRole('button', { name: 'Remove Dimension 1' })
    expect(removeFirst).toBeDisabled()
    expect(removeFirst).toHaveAttribute('title', 'A canvas needs at least 2 dimensions')

    await addDimensions(1)
    rerender(<DimensionManagerPanel />)
    const enabled = screen.getByRole('button', { name: 'Remove Dimension 1' })
    expect(enabled).toBeEnabled()
    await user.click(enabled)
    await waitFor(() =>
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual([
        'Dimension 2',
        'Dimension 3',
      ]),
    )
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
