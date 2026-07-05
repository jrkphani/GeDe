/**
 * Return the first row or throw. Used at the mutation boundary where a
 * RETURNING/SELECT is known to yield exactly one row: it turns the
 * `noUncheckedIndexedAccess` `T | undefined` into a loud, sourced failure
 * instead of an `as` cast that silently lies to the type system (and produces
 * a confusing `undefined` crash far downstream).
 */
export function firstOrThrow<T>(rows: readonly T[], message = 'expected at least one row'): T {
  const first = rows[0]
  if (first === undefined) {
    throw new Error(message)
  }
  return first
}
