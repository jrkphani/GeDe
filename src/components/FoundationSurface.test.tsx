// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addTier1Prop, createProject } from '../db/mutations'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetTier1Store } from '../store/tier1'
import { FoundationSurface } from './FoundationSurface'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier1Store()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
})

describe('FoundationSurface', () => {
  it('renders the 1st-tier header microcopy', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('1st Tier · Foundation')).toBeInTheDocument()
  })

  it('shows ghost purpose copy when the project has no purpose yet', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('What is this system for?')).toBeInTheDocument()
  })

  it('reuses EditableGrid — the propositions render in an .editable-grid table', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    const { container } = render(<FoundationSurface projectId={projectId} />)
    await waitFor(() => {
      expect(container.querySelector('table.editable-grid')).toBeInTheDocument()
    })
    expect(await screen.findByText('Seating-status comfort')).toBeInTheDocument()
  })

  it('renders degree notation 1° 2° from integer ranks', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    await addTier1Prop(db, projectId, 'Mobility fluidity')
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('1°')).toBeInTheDocument()
    expect(await screen.findByText('2°')).toBeInTheDocument()
  })

  it('offers a phantom row to name a value proposition', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByPlaceholderText('Name a value proposition')).toBeInTheDocument()
  })

  it('typing in the phantom row creates a proposition through the store', async () => {
    const user = userEvent.setup()
    render(<FoundationSurface projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText('Name a value proposition')
    await user.type(phantom, 'Age-spectrum compatibility')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Age-spectrum compatibility')).toBeInTheDocument()
    expect(await screen.findByText('1°')).toBeInTheDocument()
  })
})
