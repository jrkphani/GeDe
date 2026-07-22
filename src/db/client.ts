import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { runMigrations } from './migrate'
import * as schema from './schema'

export type Database = ReturnType<typeof drizzle<typeof schema>>

// The transaction handle drizzle hands its callback. `Querier` is the seam a
// mutation shares between the top-level db and an open transaction so its
// read/write helpers accept either — `Database` is assignable to it, so every
// existing caller keeps working. (105 P1 — atomic multi-write mutations.)
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type Querier = Database | Tx

// Browser default persists to IndexedDB; tests pass 'memory://' for a fresh engine.
export async function openDatabase(dataDir = 'idb://gede') {
  const pg = new PGlite(dataDir)
  await runMigrations(pg)
  return { pg, db: drizzle(pg, { schema }) }
}

// The app-wide database is a singleton: two concurrent PGlite instances on the
// same IndexedDB directory deadlock on the storage lock (and StrictMode's
// double-mounted effects would otherwise create exactly that in dev).
let appDatabase: ReturnType<typeof openDatabase> | null = null

export function getDatabase() {
  appDatabase ??= openDatabase()
  return appDatabase
}
