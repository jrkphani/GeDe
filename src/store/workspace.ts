import { useEffect } from 'react'
import { create } from 'zustand'
import { requireDatabase } from './database'
import { useAuthStore } from './auth'
import { useProjectsStore } from './projects'
import {
  listMembers as dbListMembers,
  removeWorkspaceMember as dbRemoveMember,
  setWorkspaceMemberRole as dbSetRole,
  type WorkspaceMemberRow,
} from '../db/workspaces'
import {
  acceptInvitation as dbAcceptInvitation,
  createInvitation as dbCreateInvitation,
  listInvitations as dbListInvitations,
  resendInvitation as dbResendInvitation,
  revokeInvitation as dbRevokeInvitation,
  type InvitationRow,
} from '../db/invitations'
import { resolveEffectiveRole, type WorkspaceRole } from '../domain/workspaceRole'

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
  load: (workspaceId: string) => Promise<void>
  invite: (email: string, role: WorkspaceRole) => Promise<InvitationRow>
  changeRole: (userSub: string, role: WorkspaceRole) => Promise<void>
  removeMember: (userSub: string) => Promise<void>
  revokeInvitation: (invitationId: string) => Promise<void>
  resendInvitation: (invitationId: string) => Promise<void>
  acceptInvitation: (invitationId: string) => Promise<void>
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
    return invitation
  },

  async changeRole(userSub, role) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    await dbSetRole(db, workspaceId, userSub, role)
    const members = await dbListMembers(db, workspaceId)
    set({ members, role: computeRole(members) })
  },

  async removeMember(userSub) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    await dbRemoveMember(db, workspaceId, userSub)
    const members = await dbListMembers(db, workspaceId)
    set({ members, role: computeRole(members) })
  },

  async revokeInvitation(invitationId) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    await dbRevokeInvitation(db, invitationId)
    set({ invitations: await dbListInvitations(db, workspaceId) })
  },

  async resendInvitation(invitationId) {
    const { workspaceId } = get()
    if (!workspaceId) return
    const db = requireDatabase()
    await dbResendInvitation(db, invitationId)
    set({ invitations: await dbListInvitations(db, workspaceId) })
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
  },
}))

/** Client-side selector: the effective role for a given project, computed
 *  from its workspace's membership. Loads/refreshes the workspace store's
 *  member list as a side effect when the workspace changes — callers (design/
 *  foundation/architecture surfaces) get back just `{ role, workspaceId }`. */
export function useWorkspaceRole(projectId: string): { role: WorkspaceRole; workspaceId: string | null } {
  const workspaceId = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.workspaceId ?? null)
  const role = useWorkspaceStore((s) => s.role)
  // Mirrors every other surface's own store-load effect (tier1/tier2/contexts/
  // dimensions) — a render-phase side effect would violate React's render
  // purity, so the (re)load is kicked off here, not inline above.
  useEffect(() => {
    if (workspaceId) void useWorkspaceStore.getState().load(workspaceId)
  }, [workspaceId])
  return { role: workspaceId ? role : 'owner', workspaceId }
}

export function resetWorkspaceStore(): void {
  useWorkspaceStore.setState({ workspaceId: null, members: [], invitations: [], status: 'idle', role: 'owner' })
}
