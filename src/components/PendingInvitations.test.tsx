// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { createWorkspace } from '../db/workspaces'
import { createInvitation, getInvitation } from '../db/invitations'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { setDatabase } from '../store/database'
import { resetProjectsStore, useProjectsStore } from '../store/projects'
import { resetSyncStore, useSyncStore } from '../store/sync'
import { resetWorkspaceStore } from '../store/workspace'
import { PendingInvitations } from './PendingInvitations'

// Issue 060 — the invitee-facing counterpart to WorkspaceMembers.test.tsx:
// this surface is NOT gated on a project being open (an invitee may have no
// project yet at all), only on being signed in AND having ≥1 pending
// invitation addressed to their own email.

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let workspaceId: string

beforeEach(async () => {
  resetProjectsStore()
  resetSyncStore()
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetWorkspaceStore()
  resetAuthStoreForTests()
  await useProjectsStore.getState().init(db)
  const ws = await createWorkspace(db, 'Acme', 'sub-owner')
  workspaceId = ws.id
})

describe('PendingInvitations — gated to a signed-in user with ≥1 pending invite (issue 060)', () => {
  it('renders nothing when auth is not configured (solo/local mode)', () => {
    useAuthStore.setState({ configured: false, status: 'unauthenticated' })
    const { container } = render(<PendingInvitations />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when configured but signed out', () => {
    useAuthStore.setState({ configured: true, status: 'unauthenticated' })
    const { container } = render(<PendingInvitations />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when signed in with no pending invitations', async () => {
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
    const { container } = render(<PendingInvitations />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('renders an "Invitations" trigger once a pending invite addressed to the signed-in email exists', async () => {
    await createInvitation(db, workspaceId, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })

    render(<PendingInvitations />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Invitations/ })).toBeInTheDocument())
  })
})

describe('PendingInvitations — the invite list (issue 060)', () => {
  beforeEach(() => {
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
  })

  it('lists a pending invite with its role and Accept/Decline actions', async () => {
    await createInvitation(db, workspaceId, 'invitee@example.com', 'editor', 'sub-owner')
    const user = userEvent.setup()
    render(<PendingInvitations />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Invitations/ })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Invitations/ }))

    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Editor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Accept/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Decline/ })).toBeInTheDocument()
  })

  it('clicking Accept seats the invitee as a member and the invite disappears', async () => {
    const inv = await createInvitation(db, workspaceId, 'invitee@example.com', 'viewer', 'sub-owner')
    const user = userEvent.setup()
    render(<PendingInvitations />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Invitations/ })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Invitations/ }))
    await user.click(screen.getByRole('button', { name: /Accept/ }))

    await waitFor(async () => {
      const reloaded = await getInvitation(db, inv.id)
      expect(reloaded?.acceptedAt).not.toBeNull()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Invitations/ })).not.toBeInTheDocument())
  })

  it('clicking Decline revokes the invite and it disappears', async () => {
    const inv = await createInvitation(db, workspaceId, 'invitee@example.com', 'viewer', 'sub-owner')
    const user = userEvent.setup()
    render(<PendingInvitations />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Invitations/ })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Invitations/ }))
    await user.click(screen.getByRole('button', { name: /Decline/ }))

    await waitFor(async () => {
      const reloaded = await getInvitation(db, inv.id)
      expect(reloaded?.deletedAt).not.toBeNull()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Invitations/ })).not.toBeInTheDocument())
  })
})

// Issue 062 — the missing "badge updates without a manual reload" wiring: a
// fresh invitee's local PGlite has no invitation row at mount time (that's
// the whole bug); one only lands once the read-path streams it in, AFTER
// this component's mount effect already ran. Without re-subscribing to
// SOMETHING that changes when that happens, the badge would stay hidden
// until the next full page reload. useSyncStore's `invitationsAppliedAt`
// (src/store/sync.ts) is that signal — bumped by the SAME onApplied path
// every table's inbound delta already flows through.
describe('PendingInvitations — refreshes on an inbound invitation delta (issue 062)', () => {
  it('the "Invitations" badge appears once invitationsAppliedAt bumps, with no remount and no manual reload', async () => {
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })

    render(<PendingInvitations />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Invitations/ })).not.toBeInTheDocument())

    // Simulates the read-path landing a row locally mid-session (056's
    // applyInboundDeltas apply case) — this component never re-queries the
    // db on its own timer, so without the signal below the badge would stay
    // hidden until an unrelated re-render happened to fire the effect again.
    await createInvitation(db, workspaceId, 'invitee@example.com', 'editor', 'sub-owner')
    useSyncStore.setState({ invitationsAppliedAt: Date.now() })

    await waitFor(() => expect(screen.getByRole('button', { name: /Invitations/ })).toBeInTheDocument())
  })
})
