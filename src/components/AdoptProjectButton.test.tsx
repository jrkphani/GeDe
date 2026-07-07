// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { createWorkspace } from '../db/workspaces'
import { StatusBar } from '../shell/StatusBar'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { setDatabase } from '../store/database'
import { useProjectsStore } from '../store/projects'
import { resetSyncStore } from '../store/sync'
import { AdoptProjectButton } from './AdoptProjectButton'

// Issue 037 — the local→cloud on-ramp's row-level gesture. Mirrors
// WorkspaceMembers.test.tsx's account-gating pattern (issue 035): a Cognito
// session is faked directly on the auth store, never a live Cognito call.

async function bootStore() {
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  useProjectsStore.setState({ status: 'ready' })
  return db
}

beforeEach(() => {
  resetAuthStoreForTests()
  resetSyncStore()
})

describe('AdoptProjectButton — account gate', () => {
  it('renders nothing when auth is not configured (solo/local mode)', async () => {
    const db = await bootStore()
    const project = await createProject(db, { name: 'Tavalo' })
    useAuthStore.setState({ configured: false, status: 'unauthenticated' })
    const { container } = render(<AdoptProjectButton project={project} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when configured but signed out', async () => {
    const db = await bootStore()
    const project = await createProject(db, { name: 'Tavalo' })
    useAuthStore.setState({ configured: true, status: 'unauthenticated' })
    const { container } = render(<AdoptProjectButton project={project} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the "Move to workspace…" trigger once signed in', async () => {
    const db = await bootStore()
    const project = await createProject(db, { name: 'Tavalo' })
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-x', email: null } })
    render(<AdoptProjectButton project={project} />)
    expect(screen.getByRole('button', { name: 'Move Tavalo to workspace' })).toBeInTheDocument()
  })
})

describe('AdoptProjectButton — already adopted', () => {
  it('shows a static "In workspace" label instead of the picker', async () => {
    const db = await bootStore()
    const project = await createProject(db, { name: 'Tavalo' })
    const cloud = await createWorkspace(db, 'Cloud Workspace')
    await useProjectsStore.getState().init(db)
    await useProjectsStore.getState().adoptProject(project.id, cloud.id)
    const adoptedRow = useProjectsStore.getState().projects.find((p) => p.id === project.id)
    if (!adoptedRow) throw new Error('adopted row missing')

    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-x', email: null } })
    render(<AdoptProjectButton project={adoptedRow} />)

    expect(screen.getByText('In workspace')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Move .* to workspace/ })).not.toBeInTheDocument()
  })
})

describe('AdoptProjectButton — adopt flow', () => {
  it('moving a project into the chosen workspace announces success', async () => {
    const db = await bootStore()
    await useProjectsStore.getState().init(db)
    await useProjectsStore.getState().createProject('Tavalo')
    const project = useProjectsStore.getState().projects[0]
    if (!project) throw new Error('project missing')
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-x', email: null } })

    const user = userEvent.setup()
    render(
      <>
        <AdoptProjectButton project={project} />
        <StatusBar />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Move Tavalo to workspace' }))
    await waitFor(() => expect(screen.getByText('My Workspace')).toBeInTheDocument())
    await user.click(screen.getByText('My Workspace'))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Moved “Tavalo” to your workspace'),
    )
    expect(
      useProjectsStore.getState().projects.some((p) => p.name === 'Tavalo' && p.workspaceId !== project.workspaceId),
    ).toBe(true)
  })
})
