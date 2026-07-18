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
   * Issue 094 (revival gap) — the twin of `resolveWorkspaceForEntity` that does
   * NOT filter `deleted_at`: resolves which workspace a row belongs to even when
   * it is soft-deleted (tombstoned), returning `null` ONLY when the row is truly
   * absent. `resolveWorkspaceForEntity` (which filters `deleted_at IS NULL`)
   * cannot answer this — a tombstoned row resolves to null there, which is why a
   * revive-update was rejected `unknown_entity` before this op existed. The
   * `revive` tenancy branch (checkTenancy below) uses this so a present-but-
   * tombstoned row is still range-checked against the declared workspace (a
   * cross-tenant revive is caught), while a genuinely absent row is allowed
   * through as a fresh insert (the FK-tenancy gate in handler.ts guards THAT).
   */
  resolveWorkspaceForEntityIncludingDeleted(table: MutationTable, entityId: string): Promise<string | null>
  /**
   * Issue 091 — the NATURAL-KEY fallback resolver for the update/delete path.
   * `tier1_purpose` is a project singleton (unique on `project_id`); a
   * cold-mirror client mints a FRESH `id` for it, so after 095's insert-path
   * reconciliation the client's minted id still diverges from the server row's
   * id. The NEXT edit enqueues an `update` for that minted id, which
   * `resolveWorkspaceForEntity` (keyed on the row's `id`) cannot resolve →
   * `unknown_entity` → the "item no longer exists" note + a dropped edit.
   *
   * For a table in store.ts's `NATURAL_KEY_CONFLICT` whose payload carries the
   * natural-key value (for `tier1Purpose` that's `payload.projectId`), this
   * resolves the LIVE row by that natural key and returns its `workspace_id`;
   * for any other table, or when the payload lacks the natural key, it returns
   * `null`. `checkTenancy` calls it ONLY as a fallback when the by-id
   * resolution already returned `null`, so the common path is untouched — and
   * crucially it STILL yields `cross_tenant` (never a silent pass) when the
   * natural-key row belongs to a workspace other than the declared one.
   */
  resolveWorkspaceForNaturalKey(mutation: MutationEnvelope): Promise<string | null>
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

  // Issue 094 (revival gap) — `revive` resolves the target row's workspace
  // WITHOUT filtering `deleted_at` (a tombstoned row is exactly what a revive
  // targets; `resolveWorkspaceForEntity` filters it out and would 404 it). Two
  // legal shapes, mirroring the op's dual semantics:
  //   - row present (live OR tombstoned) → range-check its workspace against the
  //     declared (already-authorized) one; a mismatch is `cross_tenant`. This is
  //     the SECURITY-sensitive path: reviving resolves DELETED rows, so a
  //     tombstoned row belonging to a victim must NOT be revivable by an
  //     attacker declaring their own workspace.
  //   - row truly absent (`null`) → ALLOW: a revive of an absent id is a fresh
  //     insert, so it must not be rejected `unknown_entity` here. The FK-tenancy
  //     gate (handler.ts, issue 098, which runs for revive) still catches a
  //     cross-tenant FK planted in that insert's payload.
  // Deliberately does NOT use the natural-key fallback below (that is the
  // diverged-id update/delete rescue for tier1_purpose, issue 091); a revive is
  // addressed by its own id.
  if (mutation.op === 'revive') {
    const reviveWorkspace = await resolver.resolveWorkspaceForEntityIncludingDeleted(
      mutation.table,
      mutation.entityId,
    )
    if (reviveWorkspace === null) return { ok: true }
    if (reviveWorkspace !== mutation.workspaceId) return { ok: false, reason: 'cross_tenant' }
    return { ok: true }
  }

  let actualWorkspace = await resolver.resolveWorkspaceForEntity(mutation.table, mutation.entityId)
  // Issue 091 — when the by-id resolution fails (`null`), fall back to
  // resolving the row by its NATURAL key. `tier1_purpose` is a project
  // singleton whose client-minted id diverges from the server row's id after
  // 095's insert-path reconciliation; the NEXT edit's `update` targets that
  // minted id, which has no server row → `null` here. The `??=` (evaluated
  // ONLY on a by-id miss) resolves the LIVE row by its natural key (project_id
  // from the payload) instead — `null` for every non-natural-key table or when
  // the payload lacks the key, so this is purely additive: it rescues the
  // diverged-id update rather than dropping it as unknown_entity, and — because
  // the resolved workspace is still range-checked below — a caller declaring
  // workspace A whose natural-key row belongs to victim V is STILL rejected
  // `cross_tenant`, never papered over.
  actualWorkspace ??= await resolver.resolveWorkspaceForNaturalKey(mutation)
  if (actualWorkspace === null) {
    return { ok: false, reason: 'unknown_entity' }
  }
  if (actualWorkspace !== mutation.workspaceId) {
    return { ok: false, reason: 'cross_tenant' }
  }
  return { ok: true }
}
