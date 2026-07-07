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
import { resolveForeignKeys, type WriteStore } from './store'
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

    if (mutation.op !== 'insert') {
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

  if (mutation.table === 'bindings' && (mutation.op === 'insert' || mutation.op === 'update')) {
    const contextId = mutation.payload.contextId as string | undefined
    const dimensionId = mutation.payload.dimensionId as string | undefined
    if (contextId && dimensionId) {
      const excludeId = mutation.op === 'update' ? mutation.entityId : undefined
      const count = await store.countLiveBindingsForPair(contextId, dimensionId, excludeId)
      if (violatesBindingUniqueness(count)) return bindingUniquenessViolation()
    }
  }

  if (mutation.op === 'insert' || mutation.op === 'update') {
    const unresolved = await resolveForeignKeys(mutation.table, mutation.payload, store)
    if (violatesReferentialIntegrity(unresolved)) return referentialIntegrityViolation(unresolved)
  }

  return null
}

// isReplay is re-exported for callers that want to pre-filter a batch client-
// side (e.g. a future 032 integration test) without needing a live store.
export { isReplay }
