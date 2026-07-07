import { useState } from 'react'
import { canManageMembers, WORKSPACE_ROLES, type WorkspaceRole } from '../domain/workspaceRole'
import { invitationStatus, type InvitationStatus } from '../domain/invitation'
import { useAuthStore } from '../store/auth'
import { useWorkspaceRole, useWorkspaceStore } from '../store/workspace'
import { Button } from './ui/button'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// Issue 035 — the granting UX (SPEC §1, ADR-0009): a workspace owner invites
// by email + role, sees who's already in, and can change a role or revoke
// access; a non-owner member sees the same list read-only. This is deliberately
// gated to signed-in Cognito sessions only (AccountMenu's own gate, 033):
// sharing means inviting a real identity by email, which the local/solo mode
// (no auth configured) has no use for — see WorkspaceMembers below.

const ROLE_OPTIONS = WORKSPACE_ROLES.map((role) => ({ value: role, label: roleLabel(role) }))

function roleLabel(role: WorkspaceRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
}

function RoleCombobox({
  role,
  onChange,
  ariaLabel,
}: {
  role: WorkspaceRole
  onChange: (role: WorkspaceRole) => void
  ariaLabel: string
}) {
  return (
    <Combobox
      value={role}
      options={ROLE_OPTIONS}
      onChange={(next) => {
        if (next) onChange(next as WorkspaceRole)
      }}
      trigger={
        <Button variant="bare" className="ws-member__role" aria-label={ariaLabel}>
          {roleLabel(role)}
        </Button>
      }
    />
  )
}

export function WorkspaceMembersPanel({ projectId }: { projectId: string }) {
  const { role } = useWorkspaceRole(projectId)
  const canManage = canManageMembers(role)
  const members = useWorkspaceStore((s) => s.members)
  const invitations = useWorkspaceStore((s) => s.invitations)
  const invite = useWorkspaceStore((s) => s.invite)
  const changeRole = useWorkspaceStore((s) => s.changeRole)
  const removeMember = useWorkspaceStore((s) => s.removeMember)
  const revokeInvitation = useWorkspaceStore((s) => s.revokeInvitation)
  const resendInvitation = useWorkspaceStore((s) => s.resendInvitation)
  const currentSub = useAuthStore((s) => s.user?.sub ?? null)

  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('viewer')
  const [error, setError] = useState<string | null>(null)

  // Accepted invitations are already represented by the member they became —
  // showing both would double-count the same grant (design brief: quiet chrome).
  const visibleInvitations = invitations.filter((i) => invitationStatus(i) !== 'accepted')

  async function onInvite() {
    setError(null)
    const trimmed = email.trim()
    if (!trimmed) return
    try {
      await invite(trimmed, inviteRole)
      setEmail('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this invitation')
    }
  }

  return (
    <div className="ws-members">
      <h3 className="ws-members__heading">Members</h3>
      <ul className="ws-members__list">
        {members.map((m) => (
          <li key={m.id} className="ws-member">
            <span className="ws-member__identity">
              {m.userSub === currentSub ? `${m.userSub} (you)` : m.userSub}
            </span>
            {canManage ? (
              <RoleCombobox
                role={m.role}
                ariaLabel={`Role for ${m.userSub}`}
                onChange={(next) => void changeRole(m.userSub, next)}
              />
            ) : (
              <span className="ws-member__role ws-member__role--static">{roleLabel(m.role)}</span>
            )}
            {canManage && (
              <Button
                variant="rowAction"
                aria-label={`Remove ${m.userSub}`}
                onClick={() => void removeMember(m.userSub)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>

      {canManage && visibleInvitations.length > 0 && (
        <>
          <h3 className="ws-members__heading">Invitations</h3>
          <ul className="ws-members__list">
            {visibleInvitations.map((inv) => {
              const status = invitationStatus(inv)
              return (
                <li key={inv.id} className="ws-member">
                  <span className="ws-member__identity">{inv.email}</span>
                  <span className="ws-member__role ws-member__role--static">{roleLabel(inv.role)}</span>
                  <span className="ws-invite__status" data-status={status}>
                    {STATUS_LABEL[status]}
                  </span>
                  {(status === 'pending' || status === 'expired') && (
                    <>
                      <Button
                        variant="rowAction"
                        aria-label={`Resend invitation to ${inv.email}`}
                        onClick={() => void resendInvitation(inv.id)}
                      >
                        Resend
                      </Button>
                      <Button
                        variant="rowAction"
                        aria-label={`Revoke invitation to ${inv.email}`}
                        onClick={() => void revokeInvitation(inv.id)}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {canManage && (
        <div className="ws-invite-form">
          <Input
            className="inplace-input ws-invite-form__email"
            type="email"
            aria-label="Invite by email"
            placeholder="Invite by email…"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onInvite()
            }}
          />
          <RoleCombobox role={inviteRole} ariaLabel="Role to grant" onChange={setInviteRole} />
          <Button variant="command" onClick={() => void onInvite()}>
            Invite
          </Button>
        </div>
      )}

      {error !== null && (
        <p className="ws-invite-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// Account-gated (033/ADR-0009): sharing is meaningless without a real Cognito
// identity to invite, so this affordance is invisible in local/solo mode —
// exactly like AccountMenu itself hides when auth isn't configured.
export function WorkspaceMembers({ projectId }: { projectId: string }) {
  const configured = useAuthStore((s) => s.configured)
  const status = useAuthStore((s) => s.status)
  const [open, setOpen] = useState(false)

  if (!configured || status !== 'authenticated') return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="rowAction" aria-label="Share workspace" title="Share workspace">
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ws-members-popover">
        <WorkspaceMembersPanel projectId={projectId} />
      </PopoverContent>
    </Popover>
  )
}
