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

export function resetDatabase(): void {
  handle = null
}
