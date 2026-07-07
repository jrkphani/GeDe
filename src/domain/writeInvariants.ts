// SPEC.md §2 core invariants, enforced a second time here at the Tier-2
// write-path boundary (ADR-0010: "the client's pure invariant predicates
// should be the shared source the server validates with, so client and
// server enforce identical rules" — issue 043's implementation notes).
//
// These are PURE predicates — no db/store/React import — so the exact same
// function can run in the browser bundle (src/db/mutations.ts, guarding the
// client's optimistic local write) and in the write-path Lambda bundle
// (src/server/writeApi/handler.ts, guarding the shared write). They are the
// single source of truth; nothing else should hardcode these numbers.

/** SPEC invariant 1: a canvas needs at least this many dimensions. */
export const MIN_DIMENSIONS = 2

/**
 * True if removing one dimension would leave the canvas below the floor.
 * `liveDimensionCount` is the count of live (non-deleted) dimensions on the
 * canvas *before* the removal (mirrors src/db/mutations.ts's `removeDimension`,
 * which historically inlined this as `rows.length <= 2`).
 */
export function violatesDimensionFloor(liveDimensionCount: number): boolean {
  return liveDimensionCount <= MIN_DIMENSIONS
}

/**
 * SPEC invariant 1 ("one parameter per dimension per context") is already a
 * hard DB constraint (`bindings_context_dimension_idx`, src/db/schema.ts) —
 * this mirrors it as a friendly pre-check so the API can reject with a typed
 * error instead of surfacing a raw unique-violation. `existingCountForPair`
 * excludes the binding being replaced (a rebind of the *same* context+
 * dimension pair is legal — it's an upsert, not a duplicate).
 */
export function violatesBindingUniqueness(existingCountForPair: number): boolean {
  return existingCountForPair > 0
}

/**
 * SPEC invariant 4 / issue 007: removing a dimension cascades its bindings.
 * A mutation that deletes a dimension WITHOUT the client having queued the
 * matching binding deletes is not itself illegal (the server is expected to
 * cascade, mirroring src/db/mutations.ts's `cascadeDeleteBindingsForDimension`)
 * — but a mutation that tries to delete a dimension or context that a *live*
 * binding still references, via an `update`/insert that ignores the cascade,
 * is a referential-integrity violation. This predicate checks the general
 * FK-legality shape: does every id this mutation's payload points at
 * (foreign keys) resolve to a live row? `unresolvedForeignKeys` is supplied
 * by the caller (it already has the row-existence answers from the store).
 */
export function violatesReferentialIntegrity(unresolvedForeignKeys: readonly string[]): boolean {
  return unresolvedForeignKeys.length > 0
}

export type InvariantViolationReason =
  | 'dimension_floor'
  | 'binding_uniqueness'
  | 'referential_integrity'

export interface InvariantViolation {
  readonly reason: InvariantViolationReason
  readonly message: string
}

export function dimensionFloorViolation(): InvariantViolation {
  return {
    reason: 'dimension_floor',
    message: `A canvas needs at least ${MIN_DIMENSIONS} dimensions.`,
  }
}

export function bindingUniquenessViolation(): InvariantViolation {
  return {
    reason: 'binding_uniqueness',
    message: 'This context already has a parameter bound on that dimension.',
  }
}

export function referentialIntegrityViolation(unresolvedForeignKeys: readonly string[]): InvariantViolation {
  return {
    reason: 'referential_integrity',
    message: `Referenced row(s) do not exist or were deleted: ${unresolvedForeignKeys.join(', ')}.`,
  }
}
