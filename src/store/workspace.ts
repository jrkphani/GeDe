import { useEffect } from 'react'
import { create } from 'zustand'
import { uuidv7 } from 'uuidv7'
import { requireDatabase } from './database'
import { useAuthStore } from './auth'
import { useProjectsStore } from './projects'
import { useSyncStore } from './sync'
import {
  getWorkspace as dbGetWorkspace,
  listMembers as dbListMembers,
  removeWorkspaceMember as dbRemoveMember,
  setWorkspaceMemberRole as dbSetRole,
  type WorkspaceMemberRow,
} from '../db/workspaces'
import {
  acceptInvitation as dbAcceptInvitation,
  createInvitation as dbCreateInvitation,
  listInvitations as dbListInvitations,
  listPendingInvitationsForEmail as dbListPendingInvitationsForEmail,
  resendInvitation as dbResendInvitation,
  revokeInvitation as dbRevokeInvitation,
  type InvitationRow,
} from '../db/invitations'
import { resolveEffectiveRole, type WorkspaceRole } from '../domain/workspaceRole'

// Issue 060 — the invitee's own view of a pending invitation: the raw row
// plus a best-effort workspace name (dbGetWorkspace returns null when this
// local PGlite has never synced that workspace's row — see that function's
// own doc comment), so the accept/decline surface can show SOME context
// ("Acme workspace — editor") instead of a bare, unreadable workspace id.
export interface MyInvitationView extends InvitationRow {
  workspaceName: string | null
}

// Issue 035 — the granting UX's store: member list + pending invitations for
// the currently-open workspace, and the signed-in caller's own effective role
// in it (src/domain/workspaceRole.ts's resolveEffectiveRole — a UI affordance
// signal, NOT the enforcement boundary; see that function's own doc comment).
// Mirrors every other store's convention (component → store → db layer,
// never the reverse) and workspaces.ts/invitations.ts's own doc comments for
// why RLS, not this store, is what actually keeps a viewer from writing.
//
// Unlike tier1.ts/tier2.ts this store intentionally has NO undo/redo command-
// log entries: membership changes are inherently multi-party (they affect
// someone else's access), so "undo" reads as a false promise of a purely
// local, single-user action — the UI instead offers direct, explicit revoke/
// change-role controls per row.

interface WorkspaceState {
  workspaceId: string | null
  members: WorkspaceMemberRow[]
  invitations: InvitationRow[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  role: WorkspaceRole
  // Issue 060 — pending invitations addressed to the SIGNED-IN user's own
  // email, independent of `workspaceId`/`members`/`invitations` above (those
  // are scoped to whichever workspace's owner panel is currently open; an
  // invitee may have no workspace open — or none at all — yet still have
  // invites waiting).
  myInvitations: MyInvitationView[]
  load: (workspaceId: string) => Promise<void>
  invite: (email: string, role: WorkspaceRole) => Promise<InvitationRow>
  changeRole: (userSub: string, role: WorkspaceRole) => Promise<void>
  removeMember: (userSub: string) => Promise<void>
  revokeInvitation: (invitationId: string) => Promise<void>
  resendInvitation: (invitationId: string) => Promise<void>
  acceptInvitation: (invitationId: string) => Promise<void>
  // The invitee's own lookup: pending invitations addressed to the signed-in
  // user's email (src/db/invitations.ts's listPendingInvitationsForEmail, the
  // by-email RLS SELECT migration 0009 already supports). A no-op (empty
  // list) when signed out — mirrors every other store's signed-out gate.
  loadMyInvitations: () => Promise<void>
  // Revoke/dismiss from the INVITEE's side (mirrors the owner-side
  // `revokeInvitation` above — same db call, same sync-enqueue shape as of
  // issue 066, scoped via an explicit workspaceId override since the
  // invitee's own panel is never "open" for the inviter's workspace) then
  // refreshes `myInvitations`.
  declineInvitation: (invitationId: string) => Promise<void>
}

function computeRole(members: WorkspaceMemberRow[]): WorkspaceRole {
  const { user, configured } = useAuthStore.getState()
  return resolveEffectiveRole(members, user?.sub ?? null, configured)
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspaceId: null,
  members: [],
  invitations: [],
  status: 'idle',
  role: 'owner',
  myInvitations: [],

  async load(workspaceId) {
    set({ workspaceId, status: 'loading' })
    const db = requireDatabase()
    // A non-owner's `listInvitations` naturally comes back empty under real
    // RLS (invitations_select is owner-or-invitee-by-email) — never an error
    // here, since this app's own PGlite connection is always the table owner
    // (migration 0008/0009 header) and never actually rejects locally.
    const [members, invitations] = await Promise.all([
      dbListMembers(db, workspaceId),
      dbListInvitations(db, workspaceId),
    ])
    if (get().workspaceId !== workspaceId) return // superseded by a later load
    set({ members, invitations, status: 'ready', role: computeRole(members) })
  },

  async invite(email, role) {
    const { workspaceId } = get()
    if (!workspaceId) throw new Error('No workspace is open')
    const invitedBySub = useAuthStore.getState().user?.sub
    if (!invitedBySub) throw new Error('Sign in to invite collaborators')
    const db = requireDatabase()
    const invitation = await dbCreateInvitation(db, workspaceId, email, role, invitedBySub)
    set({ invitations: await dbListInvitations(db, workspaceId) })
    // Issue 056 (055's Cause 1 fix) — push through the sync/write-path,
    // mirroring createProject's own signed-in gate exactly (src/store/
    // projects.ts:106-127): useSyncStore's `workspaceId` is only set once
    // signed in (src/store/auth.ts's applyWorkspaceScope), so signed-out /
    // sync-off stays local-only, byte-for-byte unchanged.
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'invitations',
        rowId: invitation.id,
        op: 'upsert',
        row: invitation,
        optimisticUpdatedAt: invitation.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
    return invitation
  },

  async changeRole(userSub, role) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    const updated = await dbSetRole(db, workspaceId, userSub, role)
    const members = await dbListMembers(db, workspaceId)
    set({ members, role: computeRole(members) })
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'workspace_members',
        rowId: updated.id,
        op: 'upsert',
        row: updated,
        optimisticUpdatedAt: updated.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
  },

  async removeMember(userSub) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    const removed = await dbRemoveMember(db, workspaceId, userSub)
    const members = await dbListMembers(db, workspaceId)
    set({ members, role: computeRole(members) })
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'workspace_members',
        rowId: removed.id,
        op: 'delete',
        row: removed,
        optimisticUpdatedAt: removed.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
  },

  async revokeInvitation(invitationId) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    const revoked = await dbRevokeInvitation(db, invitationId)
    set({ invitations: await dbListInvitations(db, workspaceId) })
    // Issue 066 — mirrors invite/changeRole/removeMember's own signed-in gate
    // (useSyncStore's `workspaceId` is only set once signed in, src/store/
    // auth.ts's applyWorkspaceScope) so signed-out/sync-off stays local-only,
    // byte-for-byte unchanged. A `delete` op (not `upsert`) — the local write
    // is itself already a soft-delete tombstone (dbRevokeInvitation sets
    // `deletedAt`), exactly like removeMember's own `workspace_members`
    // delete mutation above; the write-path's delete branch (src/server/
    // writeApi/store.ts's applyIfNew) ignores the payload and just stamps
    // `deleted_at`/`updated_at` from `clientUpdatedAt`, so the row itself is
    // carried along for parity/debuggability rather than because it's read.
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'invitations',
        rowId: revoked.id,
        op: 'delete',
        row: revoked,
        optimisticUpdatedAt: revoked.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
  },

  async resendInvitation(invitationId) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    const resent = await dbResendInvitation(db, invitationId)
    set({ invitations: await dbListInvitations(db, workspaceId) })
    // Issue 066 — an `update` op (not `upsert`): this invitation row already
    // exists server-side (it was created via `invite`'s own `upsert`→`insert`
    // mutation earlier), so mapping it through `upsert` would round-trip as
    // an `INSERT ... ON CONFLICT (id) DO NOTHING` (src/sync/writeTransport.ts's
    // toMutationOp) and silently no-op the expiry bump. `update` maps
    // straight through to the wire protocol's own `update` op (src/sync/
    // writeTransport.ts), which the write-path applies as a bare
    // `UPDATE ... WHERE id` (src/server/writeApi/store.ts's applyIfNew).
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'invitations',
        rowId: resent.id,
        op: 'update',
        row: resent,
        optimisticUpdatedAt: resent.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
  },

  // The invitee's own side of the lifecycle — accepting binds THEIR identity
  // (not necessarily whatever workspace is currently loaded above), so this
  // reloads whichever workspace the invitation belonged to afterward only if
  // it happens to be the one currently open.
  async acceptInvitation(invitationId) {
    const user = useAuthStore.getState().user
    if (!user) throw new Error('Sign in to accept this invitation')
    const db = requireDatabase()
    const member = await dbAcceptInvitation(db, invitationId, user.sub, user.email ?? '')
    if (get().workspaceId === member.workspaceId) {
      const [members, invitations] = await Promise.all([
        dbListMembers(db, member.workspaceId),
        dbListInvitations(db, member.workspaceId),
      ])
      set({ members, invitations, role: computeRole(members) })
    }
    // Issue 057 (055's Cause 3 fix) — the write-path half of "an accepted
    // invitee can write into the INVITER's workspace": enqueue the seat row
    // itself as a sync mutation, mirroring invite/changeRole/removeMember's
    // own signed-in gate (useSyncStore.workspaceId truthy = sync configured
    // and this sub is authenticated). Unlike those three, this mutation's
    // target workspace is `member.workspaceId` (the INVITER's workspace,
    // already resolved server-side by dbAcceptInvitation from the
    // invitation row) — it is NEVER the accepting user's own
    // `workspaceIdForSub(sub)`, which is what useSyncStore.workspaceId
    // itself holds (auth.ts's applyWorkspaceScope). The explicit
    // `workspaceId` field on the QueuedMutation (domain/mutationQueue.ts,
    // issue 057) is what lets writeTransport.ts's toMutationEnvelope stamp
    // THIS mutation with the inviter's workspace instead of the flush-wide
    // default — see that module's doc comments for why a single global
    // `useSyncStore.workspaceId` can't express this on its own.
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'workspace_members',
        rowId: member.id,
        op: 'upsert',
        row: member,
        workspaceId: member.workspaceId,
        optimisticUpdatedAt: member.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
      // Issue 060 — best-effort: wait for the flush enqueueLocalMutation just
      // kicked off before restarting the read-path below, so the seat
      // mutation has a real chance to reach RDS BEFORE the shape proxy
      // (058) re-resolves this sub's memberships. flush() is itself
      // defensive (never throws, retries with backoff on failure) — this
      // narrows the race for the common online case but does not eliminate
      // it: a slow/offline flush still leaves the newly-shared project
      // undelivered until a later retry lands and a subsequent
      // refresh/reload picks it up (residual gap, docs/issues/060).
      await useSyncStore.getState().flush()
    }
    // Issue 060 — pick up the newly-joined workspace: reload the local
    // projects list and force a fresh read-path subscription (see
    // useProjectsStore.refreshProjects's own doc comment for why a restart,
    // not just a reload, is required) so the just-accepted project actually
    // streams in without a manual page reload.
    await useProjectsStore.getState().refreshProjects()
    // The accepted invite no longer belongs in the invitee's own pending
    // list (acceptInvitation marks it accepted → excluded by canAccept).
    await get().loadMyInvitations()
  },

  async loadMyInvitations() {
    const email = useAuthStore.getState().user?.email
    if (!email) {
      set({ myInvitations: [] })
      return
    }
    const db = requireDatabase()
    const rows = await dbListPendingInvitationsForEmail(db, email)
    const myInvitations = await Promise.all(
      rows.map(async (inv) => ({ ...inv, workspaceName: (await dbGetWorkspace(db, inv.workspaceId))?.name ?? null })),
    )
    set({ myInvitations })
  },

  async declineInvitation(invitationId) {
    const db = requireDatabase()
    const revoked = await dbRevokeInvitation(db, invitationId)
    // Issue 066 — same `delete` tombstone shape as the owner-side
    // `revokeInvitation` above, but scoped via the mutation's own explicit
    // `workspaceId` override (mirrors `acceptInvitation`'s own seat mutation,
    // issue 057's own doc comment on `QueuedMutation.workspaceId`): the
    // invitee's owner-panel `get().workspaceId` above is never the
    // inviter's workspace (it may be null, or a WHOLLY different workspace
    // the invitee happens to have open) — `useSyncStore.getState().workspaceId`
    // is the flush-wide default (the invitee's OWN personal workspace), which
    // would misroute this delete into the wrong tenant if used unscoped.
    if (useSyncStore.getState().workspaceId) {
      useSyncStore.getState().enqueueLocalMutation({
        id: uuidv7(),
        table: 'invitations',
        rowId: revoked.id,
        op: 'delete',
        row: revoked,
        workspaceId: revoked.workspaceId,
        optimisticUpdatedAt: revoked.updatedAt,
        enqueuedAt: new Date().toISOString(),
        status: 'pending',
      })
    }
    await get().loadMyInvitations()
  },
}))

/** Client-side selector: the effective role for a given project, computed
 *  from its workspace's membership. Loads/refreshes the workspace store's
 *  member list as a side effect when the workspace changes — callers (design/
 *  foundation/architecture surfaces) get back just `{ role, workspaceId }`. */
export function useWorkspaceRole(projectId: string): { role: WorkspaceRole; workspaceId: string | null } {
  const workspaceId = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.workspaceId ?? null)
  const role = useWorkspaceStore((s) => s.role)
  // Issue 067 — `workspace_members` now streams (src/domain/syncScope.ts),
  // so a member add/role-change/removal made by ANOTHER client can land in
  // this device's local PGlite mid-session, well after the effect below
  // last ran on a workspaceId change. Without also depending on this
  // signal, WorkspaceMembers.tsx's shared Members list — and this hook's own
  // `role` — would only ever reflect whatever this device's local db
  // happened to contain at the last workspaceId change, exactly the
  // per-client divergence this issue exists to close. Mirrors 062's
  // `invitationsAppliedAt` → PendingInvitations.tsx wiring.
  const membersAppliedAt = useSyncStore((s) => s.membersAppliedAt)
  // Mirrors every other surface's own store-load effect (tier1/tier2/contexts/
  // dimensions) — a render-phase side effect would violate React's render
  // purity, so the (re)load is kicked off here, not inline above.
  useEffect(() => {
    if (workspaceId) void useWorkspaceStore.getState().load(workspaceId)
  }, [workspaceId, membersAppliedAt])
  return { role: workspaceId ? role : 'owner', workspaceId }
}

export function resetWorkspaceStore(): void {
  useWorkspaceStore.setState({
    workspaceId: null,
    members: [],
    invitations: [],
    status: 'idle',
    role: 'owner',
    myInvitations: [],
  })
}
