// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { StatusBar } from '../shell/StatusBar'
import { useCommandLogStore } from '../store/commandLog'
import { resetProjectsStore, useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { ProjectsList } from './ProjectsList'

async function bootStore() {
  const { db } = await openDatabase('memory://')
  resetProjectsStore()
  await useProjectsStore.getState().init(db)
}

beforeEach(async () => {
  await bootStore()
  useStatusStore.setState({ message: null, action: null })
  useCommandLogStore.getState().clear()
})

const noop = () => undefined

describe('ProjectsList', () => {
  it('shows the first-run phantom row and creates a project by typing', async () => {
    const user = userEvent.setup()
    render(<ProjectsList onOpen={noop} />)
    const phantom = screen.getByPlaceholderText('Name your first project')
    await user.type(phantom, 'Tavalo{Enter}')
    expect(await screen.findByText('Tavalo')).toBeInTheDocument()
    expect(useProjectsStore.getState().projects.map((p) => p.name)).toEqual(['Tavalo'])
    // phantom placeholder changes once a project exists
    expect(screen.getByPlaceholderText('New project')).toHaveValue('')
  })

  it('renames in place: click name, edit, Enter commits', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Old name')
    render(<ProjectsList onOpen={noop} />)
    await user.click(screen.getByText('Old name'))
    const input = screen.getByDisplayValue('Old name')
    await user.clear(input)
    await user.type(input, 'New name{Enter}')
    expect(await screen.findByText('New name')).toBeInTheDocument()
    expect(useProjectsStore.getState().projects[0]?.name).toBe('New name')
  })

  it('rename Esc reverts without committing', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Keep me')
    render(<ProjectsList onOpen={noop} />)
    await user.click(screen.getByText('Keep me'))
    const input = screen.getByDisplayValue('Keep me')
    await user.clear(input)
    await user.type(input, 'Discard{Escape}')
    expect(await screen.findByText('Keep me')).toBeInTheDocument()
    expect(useProjectsStore.getState().projects[0]?.name).toBe('Keep me')
  })

  it('archive hides the row and narrates via the status bar with an Undo that restores', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    render(
      <>
        <ProjectsList onOpen={noop} />
        <StatusBar />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Archive Tavalo' }))
    await waitFor(() => expect(screen.queryByText('Tavalo')).not.toBeInTheDocument())

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Archived “Tavalo”')
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Tavalo')).toBeInTheDocument()
    expect(useProjectsStore.getState().projects).toHaveLength(1)
  })

  it('opens a project with Enter on the focused row', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    const opened: string[] = []
    render(<ProjectsList onOpen={(id) => opened.push(id)} />)
    const row = screen.getByRole('button', { name: /Open Tavalo/ })
    row.focus()
    await user.keyboard('{Enter}')
    expect(opened).toEqual([useProjectsStore.getState().projects[0]?.id])
  })
})
