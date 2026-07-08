// SPEC §3 (sync-ready data model) + ADR-0010 (Tier-2 write authority) + issue
// 043's own charge: "043 defines the protocol that queue replays into —
// ordering, idempotency via UUIDv7, and the rollback-on-reject contract."
//
// This is the WIRE VOCABULARY between the client's optimistic-write queue
// (issue 032, not yet built at the time this file was authored) and the
// server write-path API (this issue). It is pure and dependency-free so it
// can be imported by both a browser bundle and a Lambda bundle without
// pulling either runtime's I/O along with it.
//
// Every table in src/db/schema.ts already carries a UUIDv7 `id`, `updatedAt`,
// and (mostly) `deletedAt` — SPEC §3. The mutation envelope below reuses that
// shape rather than inventing a parallel one: `entityId` IS the row's primary
// key (client-generated UUIDv7, same id that lands in Postgres), so a
// replayed INSERT is naturally idempotent via `ON CONFLICT (id) DO NOTHING`.
// `id` on the envelope itself is a SEPARATE UUIDv7 (the mutation's own
// identity, distinct from the entity it targets) — this is what the
// idempotency ledger (src/server/writeApi/store.ts) keys on, so a replayed
// UPDATE/DELETE is also a safe no-op even though "set the same field twice"
// would otherwise look like two legitimate writes.

/**
 * The tables a write-path mutation may target — mirrors src/db/schema.ts.
 *
 * Issue 056 (055's Cause 2 fix) — `invitations`/`workspaceMembers` were added
 * so a sharing/role/removal write can be represented and routed at all;
 * before this, the union was a fixed 9-table project-content list with no
 * membership tables. Deliberately NOT added to `ENVELOPE_TABLE_NAMES`
 * (src/domain/projectEnvelope.ts) — that registry is the portable
 * project-EXPORT format (project-scoped content), while these two are
 * workspace-scoped membership state. See src/domain/syncDelta.ts's own
 * `TableName` for the parallel sync-layer registry these two also had to
 * join (snake_case there, camelCase here — the same split that already
 * existed for the original nine, per src/sync/writeTransport.ts's own doc
 * comment).
 */
export type MutationTable =
  | 'projects'
  | 'tier1Purpose'
  | 'tier1Props'
  | 'tier2Tables'
  | 'tier2Entries'
  | 'dimensions'
  | 'parameters'
  | 'contexts'
  | 'bindings'
  | 'invitations'
  | 'workspaceMembers'

export type MutationOp = 'insert' | 'update' | 'delete'

/**
 * One queued client edit, replayed to the write-path API. `id` is the
 * mutation's own UUIDv7 (idempotency key); `entityId` is the row being
 * written (also UUIDv7, and for `insert` is the new row's own primary key).
 * `clientUpdatedAt` is the client's local `updated_at` at the moment it
 * queued the edit — the LWW candidate timestamp this mutation is offering.
 */
export interface MutationEnvelope {
  readonly id: string
  readonly workspaceId: string
  readonly table: MutationTable
  readonly op: MutationOp
  readonly entityId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly clientUpdatedAt: string
}

// UUIDv7 layout: xxxxxxxx-xxxx-7xxx-Nxxx-xxxxxxxxxxxx where N is the RFC 4122
// variant nibble (8, 9, a, or b). This is a format check only — it does not
// (and cannot) verify monotonicity, only that the version/variant nibbles
// are what a UUIDv7 generator (this repo's `uuidv7` dependency) produces.
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidv7(value: string): boolean {
  return UUIDV7_PATTERN.test(value)
}

/**
 * Structural validation of an envelope before any auth/tenancy/invariant
 * check runs — a malformed envelope (non-UUIDv7 id, empty workspace) is
 * rejected outright rather than reaching the database at all.
 */
export function isWellFormedEnvelope(mutation: MutationEnvelope): boolean {
  return (
    isUuidv7(mutation.id) &&
    isUuidv7(mutation.entityId) &&
    mutation.workspaceId.trim() !== '' &&
    mutation.clientUpdatedAt.trim() !== '' &&
    !Number.isNaN(Date.parse(mutation.clientUpdatedAt))
  )
}

export type LwwDecision = 'apply' | 'stale'

/**
 * Conflict resolution authority (ADR-0010: "LWW authority lives here, not in
 * 032"). `currentUpdatedAt` is the authoritative row's `updated_at` as it
 * stands in Postgres right now (`null` = the row doesn't exist yet, e.g. a
 * fresh insert). The incoming mutation applies iff it is strictly newer —
 * ties favor the existing row so two replays of the exact same accepted
 * mutation never re-apply (the idempotency ledger is the primary guard for
 * that; this tie-break is a second, cheap line of defense).
 */
export function resolveLastWriteWins(
  currentUpdatedAt: string | null,
  mutation: Pick<MutationEnvelope, 'clientUpdatedAt'>,
): LwwDecision {
  if (currentUpdatedAt === null) return 'apply'
  const current = Date.parse(currentUpdatedAt)
  const incoming = Date.parse(mutation.clientUpdatedAt)
  return incoming > current ? 'apply' : 'stale'
}

/** Idempotency: has this exact mutation (by its own id) already landed? */
export function isReplay(seenMutationIds: ReadonlySet<string>, mutation: Pick<MutationEnvelope, 'id'>): boolean {
  return seenMutationIds.has(mutation.id)
}

/** The outcome of processing one mutation through the write-path API. */
export type MutationOutcome =
  | { readonly mutationId: string; readonly status: 'applied' }
  | { readonly mutationId: string; readonly status: 'noop' }
  | { readonly mutationId: string; readonly status: 'rejected'; readonly reason: string; readonly message: string }
