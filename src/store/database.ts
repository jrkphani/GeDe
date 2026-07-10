import type { Database } from '../db/client'

// One database handle shared by all stores. The projects store's init() sets
// it (from getDatabase() in the app, or an in-memory instance in tests).

let handle: Database | null = null

export function setDatabase(db: Database): void {
  handle = db
}

export function requireDatabase(): Database {
  if (handle === null) throw new Error('database not initialized — call projects init() first')
  return handle
}

/** Non-throwing counterpart to requireDatabase() — null when no database has
 *  been initialized yet. Issue 063's sign-out teardown needs "no database
 *  yet" (never signed in, or projects init() hasn't run) to be a normal,
 *  silent no-op rather than a thrown error. */
export function peekDatabase(): Database | null {
  return handle
}

export function resetDatabase(): void {
  handle = null
}
