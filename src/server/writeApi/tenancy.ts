// Tier-2 write-path tenancy gate (issue 043, scope item 2: "Scopes to the
// caller's workspace/tenant (034) — rejects cross-tenant writes independent
// of RLS (defense-in-depth)").
//
// 034 shipped `src/db/workspaces.ts`'s `workspace_members` table/RLS. This
// module's `WorkspaceScopeResolver` answers two questions: "which workspace
// does this row belong to" (`resolveWorkspaceForEntity`, 034/043) and, as of
// issue 057, "is this sub a member of that workspace" (`isMember`) — the
// primitive that breaks the original one-sub-one-workspace assumption baked
// into `claims.workspaceId` (jwt.ts, `workspaceIdForSub`). See `checkTenancy`
// below for the full authorization shape this enables: an invited, accepted
// collaborator can now write into a workspace they don't own, gated strictly
// on a real membership row (never a blanket relaxation).
import type { CognitoClaims } from './jwt'
import type { MutationEnvelope, MutationTable } from '../../domain/mutationProtocol'

export interface WorkspaceScopeResolver {
  /**
   * Resolves which workspace an existing row belongs to. Returns `null` if
   * the row doesn't exist (or is soft-deleted) — the caller treats that as
   * an `unknown_entity` rejection, not a pass.
   */
  resolveWorkspaceForEntity(table: MutationTable, entityId: string): Promise<string | null>
  /**
   * Issue 057 — the membership-gated relaxation of the single-workspace-per-
   * sub invariant: true iff `sub` has a real, live (non-soft-deleted)
   * `workspace_members` row for `workspaceId`. `checkTenancy` below calls
   * this ONLY when the mutation's declared workspace differs from the
   * caller's own (`claims.workspaceId`) — an own-workspace mutation never
   * pays for a membership lookup. Backed by `PgWriteStore`
   * (`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND
   * user_sub = $2 AND deleted_at IS NULL`) and, in tests, by
   * `InMemoryWriteStore`'s seeded membership set.
   */
  isMember(workspaceId: string, sub: string): Promise<boolean>
}

export type TenancyFailureReason = 'cross_tenant' | 'unknown_entity'

export type TenancyResult = { readonly ok: true } | { readonly ok: false; readonly reason: TenancyFailureReason }

/**
 * Test-first plan item 2: "a write targeting another workspace is rejected
 * even with a valid JWT (independent of RLS — the API refuses it)".
 *
 * Issue 057 relaxes the single-workspace-per-sub invariant this module used
 * to enforce unconditionally: `claims.workspaceId` (jwt.ts's
 * `workspaceIdForSub(sub)`) remains the caller's OWN, personal workspace —
 * that comparison still short-circuits for the common case and costs no
 * store lookup. But a mutation declaring a DIFFERENT workspace is no longer
 * an automatic reject: it's now conditionally accepted if-and-only-if
 * `resolver.isMember(mutation.workspaceId, claims.sub)` proves a real
 * `workspace_members` row exists. This is the ENTIRE API-layer defense
 * against cross-tenant writes (RLS is the backstop, ADR-0010) — treat any
 * change here with the same scrutiny as the RLS policies themselves.
 *
 * - `insert`: the envelope declares the workspace the new row will belong
 *   to. It must be the caller's own workspace OR a workspace they are a
 *   verified member of.
 * - `update`/`delete`: the TARGET row's actual current workspace (resolved
 *   from the store, not trusted from the client's envelope) must match the
 *   envelope's DECLARED workspace (which was itself just authorized above)
 *   — a client that lies about `workspaceId` in the envelope, or a member of
 *   workspace A who tries to edit a row that actually belongs to workspace
 *   B by merely declaring A, is still caught here. This is why the entity-
 *   scope check compares against `mutation.workspaceId`, not
 *   `claims.workspaceId`: for a member acting in a non-own workspace, those
 *   two are deliberately different.
 */
export async function checkTenancy(
  mutation: MutationEnvelope,
  claims: CognitoClaims,
  resolver: WorkspaceScopeResolver,
): Promise<TenancyResult> {
  if (mutation.workspaceId !== claims.workspaceId) {
    const isMember = await resolver.isMember(mutation.workspaceId, claims.sub)
    if (!isMember) {
      return { ok: false, reason: 'cross_tenant' }
    }
  }

  if (mutation.op === 'insert') {
    return { ok: true }
  }

  const actualWorkspace = await resolver.resolveWorkspaceForEntity(mutation.table, mutation.entityId)
  if (actualWorkspace === null) {
    return { ok: false, reason: 'unknown_entity' }
  }
  if (actualWorkspace !== mutation.workspaceId) {
    return { ok: false, reason: 'cross_tenant' }
  }
  return { ok: true }
}
