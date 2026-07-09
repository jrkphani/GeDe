import { useEffect } from 'react'
import { WORKSPACE_ROLES } from '../domain/workspaceRole'
import type { WorkspaceRole } from '../domain/workspaceRole'
import { useAuthStore } from '../store/auth'
import { useProjectsStore } from '../store/projects'
import { useWorkspaceStore, type MyInvitationView } from '../store/workspace'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// Issue 060 — the missing invitee half of the sharing fix (055/#8): the
// owner's WorkspaceMembers panel lists invitations THEY sent; nothing showed
// an invitee THEIR OWN pending invites, so acceptInvitation (057) was never
// reachable from any UI and an invited collaborator could never actually get
// seated. Deliberately NOT gated on a project being open (WorkspaceMembers
// IS, via its `projectId` prop) — a brand-new invitee may have no project of
// their own yet, only an invite waiting.

function roleLabel(role: WorkspaceRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

// Defensive against a row whose role somehow isn't one of the known values
// (schema drift) — falls back to the raw string rather than throwing.
function safeRoleLabel(role: string): string {
  return (WORKSPACE_ROLES as readonly string[]).includes(role) ? roleLabel(role as WorkspaceRole) : role
}

function InvitationRow({ invitation }: { invitation: MyInvitationView }) {
  const acceptInvitation = useWorkspaceStore((s) => s.acceptInvitation)
  const declineInvitation = useWorkspaceStore((s) => s.declineInvitation)
  const context = invitation.workspaceName ?? 'a shared workspace'

  return (
    <li className="ws-member invitation-row">
      <span className="ws-member__identity">{context}</span>
      <span className="ws-member__role ws-member__role--static">{safeRoleLabel(invitation.role)}</span>
      <Button variant="command" onClick={() => void acceptInvitation(invitation.id)}>
        Accept
      </Button>
      <Button variant="rowAction" onClick={() => void declineInvitation(invitation.id)}>
        Decline
      </Button>
    </li>
  )
}

// Account-gated exactly like WorkspaceMembers (033/ADR-0009): pending
// invitations are a Cognito-identity concept, meaningless in local/solo mode.
export function PendingInvitations() {
  const configured = useAuthStore((s) => s.configured)
  const status = useAuthStore((s) => s.status)
  const email = useAuthStore((s) => s.user?.email ?? null)
  // This surface mounts unconditionally in AppShell (no `projectId` gate),
  // so — unlike WorkspaceMembers/useWorkspaceRole, which only ever load once
  // a project is open and useProjectsStore.init() has therefore already
  // resolved — it can render before the local db finishes booting: App.tsx
  // fires init() and auth's hydrate() in parallel ("session ≠ sync"), so a
  // fast cached session can flip `status` to 'authenticated' before
  // requireDatabase() has anything to return. Gate on the db being ready too
  // (and re-fire once it flips), rather than letting loadMyInvitations()
  // throw into an unhandled rejection.
  const dbReady = useProjectsStore((s) => s.status === 'ready')
  const myInvitations = useWorkspaceStore((s) => s.myInvitations)
  const loadMyInvitations = useWorkspaceStore((s) => s.loadMyInvitations)

  // Reloads whenever the signed-in identity (or db readiness) changes —
  // mirrors useWorkspaceRole's own store-load effect (src/store/workspace.ts)
  // rather than a render-phase side effect.
  useEffect(() => {
    if (configured && status === 'authenticated' && email && dbReady) {
      void loadMyInvitations()
    }
  }, [configured, status, email, dbReady, loadMyInvitations])

  if (!configured || status !== 'authenticated' || myInvitations.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="rowAction"
          aria-label={`Invitations (${myInvitations.length})`}
          title="Pending invitations"
        >
          Invitations · {myInvitations.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ws-members-popover">
        <h3 className="ws-members__heading">Invitations</h3>
        <ul className="ws-members__list">
          {myInvitations.map((inv) => (
            <InvitationRow key={inv.id} invitation={inv} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
