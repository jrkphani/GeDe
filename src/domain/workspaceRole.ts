// Issue 034 (ADR-0010, SPEC §1) — the workspace_role enum RLS reads directly
// off workspace_members (migration 0008). Defined here, pure and DB-free like
// every other domain module, so both a future client-side affordance (issue
// 035's granting UX — "disable the delete button for a viewer" — never
// re-derives the ordering) and this issue's own tests share one source of
// truth for "which role can do what."
//
// The DB is still the enforcing authority (RLS policies encode the identical
// owner/editor > viewer write cut directly in SQL) — this module only lets
// app-layer code *agree* with that cut instead of guessing it.
export type WorkspaceRole = 'owner' | 'editor' | 'viewer'

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
}

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'editor', 'viewer']

/** True when `role` is at least as privileged as `min` (owner > editor > viewer). */
export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

/** Mirrors migration 0008's `role IN ('owner', 'editor')` write-policy cut. */
export function canWrite(role: WorkspaceRole): boolean {
  return roleAtLeast(role, 'editor')
}

/** Mirrors migration 0008's owner-only workspace/membership-management cut. */
export function canManageMembers(role: WorkspaceRole): boolean {
  return roleAtLeast(role, 'owner')
}

// Issue 035 — the client-side role gate for read-only UI affordances
// (EditableGrid's phantom row/editing, Composer's pickers/justification,
// "New context"). IMPORTANT: this is a UX signal, not the enforcement
// boundary — this app's own PGlite connection is always the table OWNER
// (see migration 0008's header), so RLS is inert against it regardless of
// what this function returns. The actual boundary is server Postgres RLS
// (workspaceRls.test.ts/invitationRls.test.ts, exercised via `SET ROLE
// app_user`) enforced through 043's write-path API. This only decides what
// the UI *shows*, so a signed-in viewer isn't invited to edit something that
// would silently fail (or get overwritten) once their change tries to sync
// upstream — "read-only reads as calm, not broken" (design brief).
export function resolveEffectiveRole(
  members: readonly { userSub: string; role: WorkspaceRole }[],
  userSub: string | null,
  authConfigured: boolean,
): WorkspaceRole {
  // Solo/local mode (no Cognito configured, or signed out): the pre-035
  // single-user experience is untouched — always full control.
  if (!authConfigured || userSub === null) return 'owner'
  // A workspace with zero membership rows is exactly `getOrCreateDefaultWorkspace`'s
  // shape (034: created with no ownerSub) — legacy/local data, never actually
  // seated. Treat as owner rather than stranding it read-only.
  if (members.length === 0) return 'owner'
  const mine = members.find((m) => m.userSub === userSub)
  // Authenticated, other members exist, but the caller isn't among them:
  // least privilege, not a guess at ownership.
  return mine?.role ?? 'viewer'
}
