import { getTableName, sql } from 'drizzle-orm'
import type { Database } from './client'
import {
  appliedMutations,
  bindings,
  contexts,
  dimensions,
  invitations,
  parameters,
  projects,
  tier1Props,
  tier1Purpose,
  tier2Entries,
  tier2Tables,
  workspaceMembers,
  workspaces,
} from './schema'

// Issue 063 — clear-on-sign-out's data-layer half: every table this local
// PGlite instance owns, truncated in one statement. Table identifiers are
// read off the real Drizzle table objects (getTableName), never hand-typed
// strings, so a future schema addition can't silently escape the wipe by
// drifting out of sync with this list — sql.raw is safe here because every
// identifier comes from our own compiled schema, never from user input.
// CASCADE is defensive rather than load-bearing: every table with a
// cross-table FK is already listed here, so a single multi-table TRUNCATE
// would satisfy Postgres on its own — CASCADE just means a table someone
// forgets to add here later still gets swept instead of raising an FK error.
const ALL_TABLES = [
  workspaces,
  workspaceMembers,
  invitations,
  projects,
  tier1Purpose,
  tier1Props,
  tier2Tables,
  tier2Entries,
  dimensions,
  parameters,
  contexts,
  bindings,
  appliedMutations,
]

/** Wipes every row from every app table this browser's local PGlite holds —
 *  the "shared browser starts clean" half of sign-out teardown (issue 063).
 *  Leaves the schema (and __migrations bookkeeping) untouched, so the SAME
 *  connection stays immediately usable for a fresh, empty local-first
 *  session — no re-open/re-migrate round trip needed. */
export async function wipeAllLocalData(db: Database): Promise<void> {
  const names = ALL_TABLES.map((table) => `"${getTableName(table)}"`).join(', ')
  await db.execute(sql.raw(`TRUNCATE TABLE ${names} CASCADE`))
}
