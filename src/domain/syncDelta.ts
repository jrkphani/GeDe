// Sync read-path merge engine (issue 032, ADR-0008/0010). Pure and DB/store-free,
// like coverage.ts/composeMode.ts — this module owns the CLIENT-SIDE merge of
// inbound row-deltas (ElectricSQL shapes → PGlite), not the transport (that's
// src/sync/electricProtocol.ts) or the actual PGlite write (src/db/sync.ts).
//
// A "row-delta" here is a full row snapshot (not a diff) carrying the row's own
// `updatedAt` — exactly what an Electric shape message delivers (the current
// materialized value of a row, LWW-stamped). Applying a set of deltas is a
// last-writer-wins REGISTER MERGE per (table, id): a semilattice join
// (associative, commutative, idempotent), so folding any permutation of the
// same delta set over the same starting state reaches the same final state —
// the convergence property (SPEC §1, issue 032 test-first plan #2). The
// *actual* LWW winner for a genuine concurrent edit is decided server-side
// (ADR-0010, issue 043); this client only needs its own merge to be
// deterministic, which the tie-break below guarantees even in the (should be
// rare) case two deltas for the same row carry an identical `updatedAt`.
//
// Soft-delete is not a separate delta shape: a tombstone is just a row whose
// `deletedAt` is set (SPEC §3), so `deletedAt` sails through the merge exactly
// like every other column — no bespoke "delete op" to model or test.
import { tableColumns, type TableName } from './projectEnvelope'

export type { TableName }

export interface RowDelta {
  readonly table: TableName
  readonly id: string
  // Full current-value snapshot of the row (Electric's shape semantics), keyed
  // by the SAME camelCase field names as schema.ts/projectEnvelope.ts.
  readonly row: Readonly<Record<string, unknown>>
  // ISO-8601 `updated_at` — the LWW clock this merge keys on.
  readonly updatedAt: string
}

// Test-first plan #4 (derived-state guard, ADR-0005): a delta may only carry
// base-table columns. Canvas positions, completeness, coverage, duplicates —
// every derived projection — are recomputed locally from synced rows and must
// NEVER travel on the wire.
export class DerivedColumnInDeltaError extends Error {
  constructor(
    public readonly table: TableName,
    public readonly column: string,
  ) {
    super(
      `"${column}" is not a base-table column of "${table}" — derived state ` +
        '(layout, coverage, completeness…) must never travel on a sync delta (ADR-0005)',
    )
    this.name = 'DerivedColumnInDeltaError'
  }
}

export function assertBaseColumnsOnly(delta: RowDelta): void {
  const allowed = new Set(tableColumns(delta.table))
  for (const column of Object.keys(delta.row)) {
    if (!allowed.has(column)) throw new DerivedColumnInDeltaError(delta.table, column)
  }
}

export interface SyncEntry {
  readonly row: Readonly<Record<string, unknown>>
  readonly updatedAt: string
}

// id -> current merged entry, per table. Read-only from the outside; every
// transition goes through applyRowDelta/applyRowDeltas.
export type SyncState = Readonly<Record<TableName, Readonly<Record<string, SyncEntry>>>>

const NO_ENTRIES: Readonly<Record<string, SyncEntry>> = {}

export function emptySyncState(): SyncState {
  return {
    projects: NO_ENTRIES,
    tier1_purpose: NO_ENTRIES,
    tier1_props: NO_ENTRIES,
    tier2_tables: NO_ENTRIES,
    tier2_entries: NO_ENTRIES,
    dimensions: NO_ENTRIES,
    parameters: NO_ENTRIES,
    contexts: NO_ENTRIES,
    bindings: NO_ENTRIES,
  }
}

// Deterministic total order over "does `candidate` replace `incumbent`":
// updatedAt first (ISO-8601 strings sort lexicographically = chronologically),
// then a canonical-JSON tie-break so the merge is a true join regardless of
// arrival order — see the module doc for why this matters for convergence.
function candidateWins(candidate: RowDelta, incumbent: SyncEntry): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) return candidate.updatedAt > incumbent.updatedAt
  const candidateKey = JSON.stringify(candidate.row)
  const incumbentKey = JSON.stringify(incumbent.row)
  if (candidateKey !== incumbentKey) return candidateKey > incumbentKey
  return false // byte-identical re-delivery — idempotent no-op.
}

// Merge one delta into state. Pure: returns a new SyncState, never mutates.
export function applyRowDelta(state: SyncState, delta: RowDelta): SyncState {
  assertBaseColumnsOnly(delta)
  const table = state[delta.table]
  const incumbent = table[delta.id]
  if (incumbent && !candidateWins(delta, incumbent)) return state
  return {
    ...state,
    [delta.table]: { ...table, [delta.id]: { row: delta.row, updatedAt: delta.updatedAt } },
  }
}

// Fold a batch — order-independent by construction (test-first plan #2).
export function applyRowDeltas(state: SyncState, deltas: readonly RowDelta[]): SyncState {
  return deltas.reduce(applyRowDelta, state)
}

// The live (non-tombstoned) rows of one table, id -> row — what a read model
// (e.g. the PGlite apply layer, src/db/sync.ts) consumes. `deletedAt` on the
// row itself is the tombstone marker, mirroring every soft-deleted domain
// table (SPEC §3) — there is no separate "delete op" to filter on.
export function liveRows(
  state: SyncState,
  table: TableName,
): Record<string, Readonly<Record<string, unknown>>> {
  const out: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const [id, entry] of Object.entries(state[table])) {
    if (entry.row.deletedAt == null) out[id] = entry.row
  }
  return out
}
