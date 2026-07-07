// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { addWorkspaceMember, createWorkspace } from '../db/workspaces'
import { createInvitation } from '../db/invitations'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { setDatabase } from '../store/database'
import { useProjectsStore } from '../store/projects'
import { resetWorkspaceStore } from '../store/workspace'
import { WorkspaceMembers, WorkspaceMembersPanel } from './WorkspaceMembers'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let workspaceId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetWorkspaceStore()
  resetAuthStoreForTests()
  const ws = await createWorkspace(db, 'Acme', 'sub-owner')
  workspaceId = ws.id
  const project = await createProject(db, { name: 'Tavalo', workspaceId: ws.id })
  projectId = project.id
  useProjectsStore.setState({ projects: [project], status: 'ready' })
})

describe('WorkspaceMembers (trigger) — gated to a signed-in Cognito session (issue 035)', () => {
  it('renders nothing when auth is not configured (solo/local mode)', () => {
    useAuthStore.setState({ configured: false, status: 'unauthenticated' })
    const { container } = render(<WorkspaceMembers projectId={projectId} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when configured but signed out', () => {
    useAuthStore.setState({ configured: true, status: 'unauthenticated' })
    const { container } = render(<WorkspaceMembers projectId={projectId} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a "Share" trigger once signed in', () => {
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-owner', email: null } })
    render(<WorkspaceMembers projectId={projectId} />)
    expect(screen.getByRole('button', { name: 'Share workspace' })).toBeInTheDocument()
  })
})

describe('WorkspaceMembersPanel — owner view', () => {
  beforeEach(() => {
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-owner', email: 'owner@example.com' } })
  })

  it('lists members with a role picker and a remove action', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('sub-owner (you)')).toBeInTheDocument())
    expect(screen.getByText('sub-viewer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Role for sub-viewer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove sub-viewer' })).toBeInTheDocument()
  })

  it('invites by email + role, clearing the field on success', async () => {
    const user = userEvent.setup()
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('sub-owner (you)')).toBeInTheDocument())

    const emailField = screen.getByPlaceholderText('Invite by email…')
    await user.type(emailField, 'New@Example.com')
    await user.click(screen.getByRole('button', { name: 'Invite' }))

    await waitFor(() => expect(screen.getByText('new@example.com')).toBeInTheDocument())
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(emailField).toHaveValue('')
  })

  it('changing a member’s role updates the picker', async () => {
    const user = userEvent.setup()
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Role for sub-viewer' })).toHaveTextContent('Viewer'))

    await user.click(screen.getByRole('button', { name: 'Role for sub-viewer' }))
    await user.click(screen.getByText('Editor'))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Role for sub-viewer' })).toHaveTextContent('Editor'))
  })

  it('removing a member drops them from the list', async () => {
    const user = userEvent.setup()
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('sub-viewer')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Remove sub-viewer' }))

    await waitFor(() => expect(screen.queryByText('sub-viewer')).not.toBeInTheDocument())
  })

  it('revoking a pending invitation marks it revoked', async () => {
    const user = userEvent.setup()
    await createInvitation(db, workspaceId, 'invitee@example.com', 'viewer', 'sub-owner')
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('invitee@example.com')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Revoke invitation to invitee@example.com' }))

    await waitFor(() => expect(screen.getByText('Revoked')).toBeInTheDocument())
  })

  it('resending an invitation keeps it pending', async () => {
    const user = userEvent.setup()
    await createInvitation(db, workspaceId, 'invitee@example.com', 'viewer', 'sub-owner')
    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('invitee@example.com')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Resend invitation to invitee@example.com' }))

    await waitFor(() => expect(screen.getByText('Pending')).toBeInTheDocument())
  })
})

describe('WorkspaceMembersPanel — non-owner view', () => {
  it('a viewer sees the member list read-only, no invite form or management actions', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-viewer', email: null } })

    render(<WorkspaceMembersPanel projectId={projectId} />)
    await waitFor(() => expect(screen.getByText('sub-viewer (you)')).toBeInTheDocument())

    expect(screen.queryByPlaceholderText('Invite by email…')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Role for/ })).not.toBeInTheDocument()
  })
})
