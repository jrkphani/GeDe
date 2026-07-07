// Tier-2 write-path tenancy gate (issue 043, scope item 2: "Scopes to the
// caller's workspace/tenant (034) — rejects cross-tenant writes independent
// of RLS (defense-in-depth)").
//
// Issue 034 (workspaces/RLS) has not shipped in this worktree yet, so there
// is no `src/db/workspaces.ts` membership table to query. This module
// defines the seam 034 fills in: a `WorkspaceScopeResolver` that answers
// "which workspace does this row belong to". Until 034 lands, the write
// path's own `workspaceId` on every table row IS that answer trivially (a
// row belongs to whichever workspace inserted it) — 034 will likely back
// this resolver with a real join against its workspace-membership tables;
// the API-layer check below does not need to change when that happens.
import type { CognitoClaims } from './jwt'
import type { MutationEnvelope, MutationTable } from '../../domain/mutationProtocol'

export interface WorkspaceScopeResolver {
  /**
   * Resolves which workspace an existing row belongs to. Returns `null` if
   * the row doesn't exist (or is soft-deleted) — the caller treats that as
   * an `unknown_entity` rejection, not a pass.
   */
  resolveWorkspaceForEntity(table: MutationTable, entityId: string): Promise<string | null>
}

export type TenancyFailureReason = 'cross_tenant' | 'unknown_entity'

export type TenancyResult = { readonly ok: true } | { readonly ok: false; readonly reason: TenancyFailureReason }

/**
 * Test-first plan item 2: "a write targeting another workspace is rejected
 * even with a valid JWT (independent of RLS — the API refuses it)".
 *
 * - `insert`: the envelope declares the workspace the new row will belong
 *   to. It must match the caller's own workspace claim — a caller cannot
 *   mint a row into someone else's workspace.
 * - `update`/`delete`: the TARGET row's actual current workspace (resolved
 *   from the store, not trusted from the client's envelope) must match both
 *   the caller's claim and the envelope's claimed workspace — a client that
 *   lies about `workspaceId` in the envelope is still caught here.
 */
export async function checkTenancy(
  mutation: MutationEnvelope,
  claims: CognitoClaims,
  resolver: WorkspaceScopeResolver,
): Promise<TenancyResult> {
  if (mutation.workspaceId !== claims.workspaceId) {
    return { ok: false, reason: 'cross_tenant' }
  }

  if (mutation.op === 'insert') {
    return { ok: true }
  }

  const actualWorkspace = await resolver.resolveWorkspaceForEntity(mutation.table, mutation.entityId)
  if (actualWorkspace === null) {
    return { ok: false, reason: 'unknown_entity' }
  }
  if (actualWorkspace !== claims.workspaceId) {
    return { ok: false, reason: 'cross_tenant' }
  }
  return { ok: true }
}
