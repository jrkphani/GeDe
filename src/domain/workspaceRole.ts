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
