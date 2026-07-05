// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, createProject } from '../db/mutations'
import { setDatabase } from '../store/database'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { resetParametersStore } from '../store/parameters'
import { resetContextsStore } from '../store/contexts'
import { useStatusStore } from '../store/status'
import { ContextRegister } from './ContextRegister'

let projectId: string

beforeEach(async () => {
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  resetDimensionsStore()
  resetParametersStore()
  resetContextsStore()
  useStatusStore.setState({ message: null, action: null })
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  const value = await addDimension(db, project.id)
  const stake = await addDimension(db, project.id)
  await addParameter(db, value.id, 'Comfort')
  await addParameter(db, stake.id, 'Users')
  await useDimensionsStore.getState().load(project.id)
})

const FIRST_CONTEXT_PLACEHOLDER = /Type to create your first context/

describe('ContextRegister', () => {
  it('generates one column per dimension, in sort order — dynamic columns', async () => {
    render(<ContextRegister projectId={projectId} />)
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Symbol',
        'Documented',
        'Dimension 1',
        'Dimension 2',
        'Justification',
        'Children',
        'Duplicate',
      ])
    })
  })

  it('creating a context via the phantom row assigns the next symbol', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Rationale text')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('α')).toBeInTheDocument()
  })

  it('a context is a draft until every dimension is bound, then complete', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'x')
    await user.keyboard('{Enter}')
    await screen.findByText('α')

    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    expect(row).toHaveClass('grid-row--draft')

    const buttons = within(row).getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.click(screen.getByText('Comfort'))
    await user.click(buttons[1] as HTMLElement)
    await user.click(screen.getByText('Users'))

    await waitFor(() => expect(row).not.toHaveClass('grid-row--draft'))
  })

  it('rejects a symbol collision and announces the reason via the status bar', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = screen.getByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'a')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    await user.type(phantom, 'b')
    await user.keyboard('{Enter}')
    await screen.findByText('β')

    await user.click(screen.getByText('β'))
    screen.getByDisplayValue('β')
    await user.keyboard('α{Enter}')

    await waitFor(() => expect(useStatusStore.getState().message).toMatch(/already in use/))
    expect(screen.getByText('β')).toBeInTheDocument()
  })

  it('the documented dot reflects draft, complete-unjustified, and documented states', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement

    expect(within(row).getByTitle('Draft')).toHaveAttribute('data-status', 'draft')

    const buttons = within(row).getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Comfort' }))
    await user.click(buttons[1] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Users' }))

    await waitFor(() =>
      expect(within(row).getByTitle('Documented')).toHaveAttribute('data-status', 'documented'),
    )

    await user.click(within(row).getByText('Reason'))
    const textarea = screen.getByDisplayValue('Reason')
    await user.clear(textarea)
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(within(row).getByTitle('Complete — needs justification')).toHaveAttribute(
        'data-status',
        'complete',
      ),
    )
  })

  it('flags two contexts on the same tuple with a duplicate badge that clears when either rebinds away', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'first')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    await user.type(phantom, 'second')
    await user.keyboard('{Enter}')
    await screen.findByText('β')

    async function bindBoth(symbol: string) {
      const row = (await screen.findByText(symbol)).closest('tr') as HTMLElement
      const buttons = within(row).getAllByRole('button')
      await user.click(buttons[0] as HTMLElement)
      await user.click(screen.getByRole('option', { name: 'Comfort' }))
      await user.click(buttons[1] as HTMLElement)
      await user.click(screen.getByRole('option', { name: 'Users' }))
    }
    await bindBoth('α')
    await bindBoth('β')

    const rowAlpha = (await screen.findByText('α')).closest('tr') as HTMLElement
    const rowBeta = (await screen.findByText('β')).closest('tr') as HTMLElement

    await waitFor(() => {
      expect(within(rowAlpha).getByTitle(/Same tuple as/)).toBeInTheDocument()
      expect(within(rowBeta).getByTitle(/Same tuple as/)).toBeInTheDocument()
    })

    const betaButtons = within(rowBeta).getAllByRole('button')
    await user.click(betaButtons[0] as HTMLElement)
    await user.click(screen.getByText('— clear —'))

    await waitFor(() => {
      expect(within(rowAlpha).queryByTitle(/Same tuple as/)).not.toBeInTheDocument()
      expect(within(rowBeta).queryByTitle(/Same tuple as/)).not.toBeInTheDocument()
    })
  })
})
