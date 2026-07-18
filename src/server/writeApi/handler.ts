// The write-path API's core request handler (issue 043). This is the
// runtime-agnostic heart of the Lambda — pure orchestration over injected
// ports (JWT verifier, tenancy resolver, invariant store), so it is fully
// unit-testable without AWS/ALB/Postgres/Cognito (HANDOFF: "no live AWS/
// Electric/Cognito reachable in tests"). `albAdapter.ts` is the thin,
// AWS-event-shaped wrapper that calls into this from a real Lambda; nothing
// AWS-specific belongs in this file (ADR-0010: "thin, not fat").
import {
  isReplay,
  isWellFormedEnvelope,
  resolveLastWriteWins,
  type MutationEnvelope,
  type MutationOutcome,
} from '../../domain/mutationProtocol'
import {
  bindingUniquenessViolation,
  dimensionFloorViolation,
  referentialIntegrityViolation,
  violatesBindingUniqueness,
  violatesDimensionFloor,
  violatesReferentialIntegrity,
} from '../../domain/writeInvariants'
import { verifyBearerToken, type JwtVerifierConfig } from './jwt'
import { checkTenancy } from './tenancy'
import { resolveForeignKeys, resolveForeignKeyTenancy, type WriteStore } from './store'
import { rejection, type WriteRejection } from './rejection'

export interface WriteApiRequest {
  readonly authorizationHeader: string | undefined
  readonly mutations: readonly MutationEnvelope[]
}

export type WriteApiResult =
  | { readonly status: 401 | 403; readonly rejection: WriteRejection }
  | { readonly status: 200; readonly outcomes: readonly MutationOutcome[] }

export interface WriteApiDeps {
  readonly jwt: JwtVerifierConfig
  readonly store: WriteStore
}

/**
 * Test-first plan item 1 (auth gate): a batch with no/invalid/expired JWT is
 * rejected wholesale (401) before any mutation is inspected — the write path
 * never partially trusts an unauthenticated caller. A batch from a caller
 * whose workspace claim doesn't match is not possible to know before
 * per-mutation tenancy checks (item 2), which run per mutation below.
 */
export async function handleWriteRequest(request: WriteApiRequest, deps: WriteApiDeps): Promise<WriteApiResult> {
  const auth = await verifyBearerToken(request.authorizationHeader, deps.jwt)
  if (!auth.ok) {
    const reason = auth.reason === 'expired_token' ? 'expired_token' : auth.reason
    return {
      status: 401,
      rejection: rejection('*', reason, 'Your session has expired or is invalid — sign in again to keep editing.'),
    }
  }

  // Issue 071 — self-heal the CALLER's own workspace before touching any
  // mutation. Keyed on the server-verified `auth.claims.sub` ONLY — never a
  // mutation's declared `workspaceId` — so an invitee writing into a shared
  // workspace (056/057) never re-provisions the owner's row (see
  // `WriteStore.ensureOwnWorkspace`'s doc comment for the full rationale).
  await deps.store.ensureOwnWorkspace(auth.claims.sub)

  const outcomes: MutationOutcome[] = []
  // Ordering (issue 043 scope: "the replay protocol... owns ordering") —
  // mutations are applied strictly in the order the client queued them, one
  // at a time, never reordered or parallelized. A later mutation in the same
  // batch can legally depend on an earlier one in the same batch having
  // already landed (e.g. insert a dimension, then bind to it).
  for (const mutation of request.mutations) {
    if (!isWellFormedEnvelope(mutation)) {
      outcomes.push({
        mutationId: mutation.id,
        status: 'rejected',
        reason: 'malformed_mutation',
        message: 'This edit could not be understood and was not saved.',
      })
      continue
    }

    if (await deps.store.hasApplied(mutation.id)) {
      // Test-first plan item 4: replaying an already-applied mutation id is
      // a no-op, not an error and not a duplicate write.
      outcomes.push({ mutationId: mutation.id, status: 'noop' })
      continue
    }

    const tenancy = await checkTenancy(mutation, auth.claims, deps.store)
    if (!tenancy.ok) {
      // Issue 091 — PERMANENT tenancy-rejection observability (kept, not a
      // temporary diagnostic): the handler otherwise only returns the outcome
      // to the client, so a `cross_tenant`/`unknown_entity` rejection would
      // never appear in CloudWatch. Structured, identifiers only (no prose/PII):
      // table/op/entityId/reason/declaredWorkspaceId. This log is what captured
      // the live 091 repro (a diverged-id tier1_purpose update rejected
      // unknown_entity); with 091 now fixed via natural-key resolution it stays
      // as ongoing tenancy-rejection observability (sibling to the [098] log
      // below), not a diagnostic to be removed.
      console.warn(
        `[writeApi][091] tenancy rejection ${JSON.stringify({
          reason: tenancy.reason,
          table: mutation.table,
          op: mutation.op,
          entityId: mutation.entityId,
          mutationId: mutation.id,
          declaredWorkspaceId: mutation.workspaceId,
        })}`,
      )
      outcomes.push({
        mutationId: mutation.id,
        status: 'rejected',
        reason: tenancy.reason,
        message:
          tenancy.reason === 'cross_tenant'
            ? 'That change is outside your workspace and was not saved.'
            : 'The item you tried to change no longer exists.',
      })
      continue
    }

    // Issue 098 (SECURITY) — checkTenancy above only authorized the DECLARED
    // workspace; it never asks WHOSE workspace the row's FK targets belong to.
    // For insert/update, verify every present FK target is same-tenant, so a
    // caller authorized for their own workspace cannot create/re-point a row
    // whose projectId (etc.) references a VICTIM's entity in another workspace
    // (the FK exists, so resolveForeignKeys/checkInvariants would let it pass).
    // Runs BEFORE checkInvariants so an EXISTING cross-tenant FK yields
    // cross_tenant, while a genuinely MISSING FK still yields
    // referential_integrity from checkInvariants (resolveForeignKeyTenancy
    // skips null resolutions). Does NOT touch tier1_purpose's natural-key
    // upsert (issue 091/095) — this is the insert/update FK-tenancy gate only.
    // Issue 094 — `revive` writes FK columns exactly like insert/update (its
    // payload can carry a projectId/canvasId/etc.), so it MUST run this gate too:
    // otherwise a revive could plant a cross-tenant FK the same way an insert
    // could. Mirrors the insert/update handling.
    if (mutation.op === 'insert' || mutation.op === 'update' || mutation.op === 'revive') {
      const crossTenantFks = await resolveForeignKeyTenancy(
        mutation.table,
        mutation.payload,
        mutation.workspaceId,
        deps.store,
      )
      if (crossTenantFks.length > 0) {
        // Diagnostic (mirrors the 091 tenancy-rejection log shape): structured,
        // identifiers only — table/op/entityId/mutationId/declaredWorkspaceId
        // and the offending FK columns. No prose/PII, and never the FK VALUES
        // (a victim's entity ids) — only which columns were cross-tenant.
        console.warn(
          `[writeApi][098] cross-tenant FK ${JSON.stringify({
            table: mutation.table,
            op: mutation.op,
            entityId: mutation.entityId,
            mutationId: mutation.id,
            declaredWorkspaceId: mutation.workspaceId,
            columns: crossTenantFks,
          })}`,
        )
        outcomes.push({
          mutationId: mutation.id,
          status: 'rejected',
          reason: 'cross_tenant',
          message: 'That change is outside your workspace and was not saved.',
        })
        continue
      }
    }

    const invariantViolation = await checkInvariants(mutation, deps.store)
    if (invariantViolation) {
      outcomes.push({
        mutationId: mutation.id,
        status: 'rejected',
        reason: invariantViolation.reason,
        message: invariantViolation.message,
      })
      continue
    }

    // Issue 094 — the LWW stale gate runs ONLY for `update`/`delete`. `insert`
    // skipped it from the start (a fresh row has no prior state to lose to), and
    // `revive` skips it for the same reason a fresh insert does AND because a
    // revive is an INTENTIONAL resurrection: the row it targets is tombstoned,
    // so its stored updated_at is the DELETE's timestamp — running LWW would let
    // that delete "win" and reject the revive as stale, which is exactly the
    // un-revivable behavior this op exists to fix. Also, getRow filters
    // `deleted_at IS NULL`, so a tombstoned target resolves to null here anyway.
    if (mutation.op === 'update' || mutation.op === 'delete') {
      const currentRow = await deps.store.getRow(mutation.table, mutation.entityId)
      const decision = resolveLastWriteWins(currentRow?.updatedAt ?? null, mutation)
      if (decision === 'stale') {
        outcomes.push({
          mutationId: mutation.id,
          status: 'rejected',
          reason: 'stale_conflict',
          message: 'Someone else\'s more recent change already landed — yours was not applied.',
        })
        continue
      }
    }

    const applied = await deps.store.applyIfNew(mutation, auth.claims.sub)
    outcomes.push({ mutationId: mutation.id, status: applied ? 'applied' : 'noop' })
  }

  return { status: 200, outcomes }
}

interface CheckedViolation {
  readonly reason: 'dimension_floor' | 'binding_uniqueness' | 'referential_integrity'
  readonly message: string
}

/**
 * Test-first plan item 3: mirrors the client's domain invariants
 * server-side. Reuses the exact predicates from src/domain/writeInvariants.ts
 * (the same module src/db/mutations.ts's client-side checks now import) so
 * client and server cannot drift (ADR-0010, issue 043 implementation notes).
 */
async function checkInvariants(mutation: MutationEnvelope, store: WriteStore): Promise<CheckedViolation | null> {
  if (mutation.table === 'dimensions' && mutation.op === 'delete') {
    const existing = await store.getRow('dimensions', mutation.entityId)
    const projectId = existing?.data.projectId as string | undefined
    if (existing && projectId) {
      const contextId = (existing.data.contextId as string | null | undefined) ?? null
      const liveCount = await store.countLiveDimensions(projectId, contextId)
      if (violatesDimensionFloor(liveCount)) return dimensionFloorViolation()
    }
  }

  // Issue 094 — `revive` can re-add a binding for a (context, dimension) pair,
  // so it must be uniqueness-checked exactly like insert/update (mirror the
  // insert handling). It excludes its OWN entityId from the count (like update),
  // so re-reviving a binding into the slot it already occupies never self-
  // conflicts — only a DIFFERENT live binding on the pair rejects it.
  if (mutation.table === 'bindings' && (mutation.op === 'insert' || mutation.op === 'update' || mutation.op === 'revive')) {
    const contextId = mutation.payload.contextId as string | undefined
    const dimensionId = mutation.payload.dimensionId as string | undefined
    if (contextId && dimensionId) {
      const excludeId = mutation.op === 'insert' ? undefined : mutation.entityId
      const count = await store.countLiveBindingsForPair(contextId, dimensionId, excludeId)
      if (violatesBindingUniqueness(count)) return bindingUniquenessViolation()
    }
  }

  // Issue 094 — `revive` writes FK columns like insert/update (its payload
  // carries projectId/dimensionId/etc.), so the referential-integrity pre-check
  // must run for it too — a revive must not resurrect/insert a row pointing at a
  // non-existent parent. Mirrors the insert/update handling.
  if (mutation.op === 'insert' || mutation.op === 'update' || mutation.op === 'revive') {
    const unresolved = await resolveForeignKeys(mutation.table, mutation.payload, store)
    if (violatesReferentialIntegrity(unresolved)) return referentialIntegrityViolation(unresolved)
  }

  return null
}

// isReplay is re-exported for callers that want to pre-filter a batch client-
// side (e.g. a future 032 integration test) without needing a live store.
export { isReplay }
