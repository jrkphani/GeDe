// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import type { ProjectRow } from '../db/mutations'
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
  localStorage.clear()
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

  it('renames via the revealed rename control: click, edit, Enter commits', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Old name')
    render(<ProjectsList onOpen={noop} />)
    await user.click(screen.getByRole('button', { name: 'Rename Old name' }))
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
    await user.click(screen.getByRole('button', { name: 'Rename Keep me' }))
    const input = screen.getByDisplayValue('Keep me')
    await user.clear(input)
    await user.type(input, 'Discard{Escape}')
    expect(await screen.findByText('Keep me')).toBeInTheDocument()
    expect(useProjectsStore.getState().projects[0]?.name).toBe('Keep me')
  })

  it('clicking the project row (name text) opens it, not renames it (issue 065)', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    const opened: string[] = []
    render(<ProjectsList onOpen={(id) => opened.push(id)} />)
    await user.click(screen.getByText('Tavalo'))
    expect(opened).toEqual([useProjectsStore.getState().projects[0]?.id])
    // Clicking the name must not have entered rename mode.
    expect(screen.queryByDisplayValue('Tavalo')).not.toBeInTheDocument()
  })

  it('opens a project with Space on the focused row', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    const opened: string[] = []
    render(<ProjectsList onOpen={(id) => opened.push(id)} />)
    const row = screen.getByRole('button', { name: /Open Tavalo/ })
    row.focus()
    await user.keyboard(' ')
    expect(opened).toEqual([useProjectsStore.getState().projects[0]?.id])
  })

  it('F2 on the row enters rename without a mouse', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    render(<ProjectsList onOpen={noop} />)
    const row = screen.getByRole('button', { name: /Open Tavalo/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'F2' })
    expect(await screen.findByDisplayValue('Tavalo')).toBeInTheDocument()
  })

  it('activating the rename control via keyboard does not open the project', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    const opened: string[] = []
    render(<ProjectsList onOpen={(id) => opened.push(id)} />)
    const renameBtn = screen.getByRole('button', { name: 'Rename Tavalo' })
    renameBtn.focus()
    await user.keyboard('{Enter}')
    expect(opened).toEqual([])
    expect(screen.getByDisplayValue('Tavalo')).toBeInTheDocument()
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

describe('ProjectsList — export/import (issue 015)', () => {
  it('shows the first-visit backup note and remembers dismissal', async () => {
    const user = userEvent.setup()
    render(<ProjectsList onOpen={noop} />)
    expect(screen.getByText('Projects live in this browser. Export to back up.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }))
    expect(
      screen.queryByText('Projects live in this browser. Export to back up.'),
    ).not.toBeInTheDocument()
    expect(localStorage.getItem('gede-backup-note-dismissed')).toBe('dismissed')
  })

  it('highlights the drop panel while a file is dragged over it', () => {
    render(<ProjectsList onOpen={noop} />)
    const panel = screen.getByLabelText('Projects')
    expect(panel).not.toHaveAttribute('data-dragging')
    fireEvent.dragOver(panel)
    expect(panel).toHaveAttribute('data-dragging')
  })

  it('renders a calm, specific error in the panel when a non-GeDe file is dropped', async () => {
    render(<ProjectsList onOpen={noop} />)
    const panel = screen.getByLabelText('Projects')
    const file = new File(['this is not json'], 'photo.json', { type: 'application/json' })
    fireEvent.drop(panel, { dataTransfer: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a GeDe export')
    // Nothing was added.
    expect(useProjectsStore.getState().projects).toHaveLength(0)
  })

  it('imports a dropped GeDe export as a new project and narrates', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    const { json } = await useProjectsStore.getState().exportProject(id)

    render(
      <>
        <ProjectsList onOpen={noop} />
        <StatusBar />
      </>,
    )
    const panel = screen.getByLabelText('Projects')
    const file = new File([json], 'Tavalo.gede.json', { type: 'application/json' })
    fireEvent.drop(panel, { dataTransfer: { files: [file] } })

    await waitFor(() =>
      expect(useProjectsStore.getState().projects.filter((p) => p.name === 'Tavalo')).toHaveLength(2),
    )
    // Empty project → just the root canvas, no contexts.
    expect(screen.getByRole('status')).toHaveTextContent(/Imported Tavalo — 1 canvas, 0 contexts/)
  })
})

describe('ProjectsList — duplicate row defense (issue 069)', () => {
  it('dedupes rows by id even if the store holds a duplicated entry', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const row: ProjectRow = useProjectsStore.getState().projects[0] as ProjectRow
    // Simulate the upstream duplication this issue found (two identical rows
    // in store state) — the render layer must still show exactly one row,
    // as defense-in-depth regardless of how a dup got into `projects`.
    useProjectsStore.setState({ projects: [row, row] })
    render(<ProjectsList onOpen={noop} />)
    expect(screen.getAllByText('Tavalo')).toHaveLength(1)
  })
})

describe('ProjectsList — archived projects view (issue 070, fixes #9)', () => {
  it('toggles to the archived view via the toolbar affordance and back', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    render(<ProjectsList onOpen={noop} />)

    await user.click(screen.getByRole('button', { name: 'Archived projects' }))
    expect(screen.getByRole('region', { name: 'Archived projects' })).toBeInTheDocument()
    expect(screen.queryByText('Tavalo')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to projects' }))
    expect(await screen.findByText('Tavalo')).toBeInTheDocument()
  })

  it('shows a calm placeholder when nothing is archived', async () => {
    const user = userEvent.setup()
    render(<ProjectsList onOpen={noop} />)
    await user.click(screen.getByRole('button', { name: 'Archived projects' }))
    expect(await screen.findByText('No archived projects.')).toBeInTheDocument()
  })

  it('lists an archived project with a Restore control that restores it and narrates via the status bar', async () => {
    const user = userEvent.setup()
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().archiveProject(id)

    render(
      <>
        <ProjectsList onOpen={noop} />
        <StatusBar />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Archived projects' }))
    expect(await screen.findByText('Tavalo')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Restore Tavalo' }))

    await waitFor(() => expect(screen.queryByText('Tavalo')).not.toBeInTheDocument())
    expect(useProjectsStore.getState().archivedProjects).toEqual([])
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([id])
    expect(screen.getByRole('status')).toHaveTextContent('Restored “Tavalo”')
  })
})

describe('ProjectsList — row affordance (issue 065)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  it('the row reads as clickable: pointer cursor at rest', () => {
    const match = /\.project-row\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    expect((match as RegExpMatchArray)[1]).toMatch(/cursor:\s*pointer/)
  })

  it('hover/focus paints a calm background via a design token, not a hardcoded color', () => {
    const match = /\.project-row:hover,\s*\n\.project-row:focus-visible\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1]
    expect(body).toMatch(/background:\s*var\(--[\w-]+\)/)
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/rgba?\(/)
  })
})
