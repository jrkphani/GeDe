// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addDimension, createProject } from '../db/mutations'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetParametersStore, useParametersStore } from '../store/parameters'
import { ParameterList } from './ParameterList'

let dimensionId: string

beforeEach(async () => {
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  resetParametersStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  const dimension = await addDimension(db, project.id)
  dimensionId = dimension.id
  await useParametersStore.getState().load(dimensionId)
})

describe('ParameterList', () => {
  it('phantom row: typing materializes the row, Enter commits and focuses a fresh phantom', async () => {
    const user = userEvent.setup()
    render(<ParameterList dimensionId={dimensionId} />)
    const phantom = screen.getByPlaceholderText('Type to add a parameter')
    await user.type(phantom, 'Buyers')
    expect(phantom).toHaveValue('Buyers')
    await user.keyboard('{Enter}')

    expect(await screen.findByText('Buyers')).toBeInTheDocument()
    const freshPhantom = screen.getByPlaceholderText('Type to add a parameter')
    expect(freshPhantom).toHaveValue('')
    expect(freshPhantom).toHaveFocus()
  })

  it('Esc on an empty phantom is a no-op', async () => {
    const user = userEvent.setup()
    render(<ParameterList dimensionId={dimensionId} />)
    const phantom = screen.getByPlaceholderText('Type to add a parameter')
    await user.click(phantom)
    await user.keyboard('{Escape}')
    expect(phantom).toHaveValue('')
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('Esc mid-edit reverts the phantom draft', async () => {
    const user = userEvent.setup()
    render(<ParameterList dimensionId={dimensionId} />)
    const phantom = screen.getByPlaceholderText('Type to add a parameter')
    await user.type(phantom, 'Draft text')
    await user.keyboard('{Escape}')
    expect(phantom).toHaveValue('')
  })

  it('shows a muted mono position index before each parameter name', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    await useParametersStore.getState().add(dimensionId, 'Maintainer')
    render(<ParameterList dimensionId={dimensionId} />)
    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renames in place from the row label', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    const user = userEvent.setup()
    render(<ParameterList dimensionId={dimensionId} />)
    await user.click(await screen.findByText('Buyers'))
    const input = screen.getByDisplayValue('Buyers')
    await user.keyboard('Purchasers{Enter}')
    expect(await screen.findByText('Purchasers')).toBeInTheDocument()
    expect(input).not.toBeInTheDocument()
  })

  it('remove deletes the parameter — no floor, unlike dimensions', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    const user = userEvent.setup()
    render(<ParameterList dimensionId={dimensionId} />)
    const removeButton = await screen.findByRole('button', { name: 'Remove Buyers' })
    expect(removeButton).toBeEnabled()
    await user.click(removeButton)
    expect(screen.queryByText('Buyers')).not.toBeInTheDocument()
  })
})
