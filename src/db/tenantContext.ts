import { sql } from 'drizzle-orm'
import type { Database } from './client'

// Issue 034 (ADR-0009/0010) — the client-side half of the identity seam RLS
// reads. Migration 0008's policies key off `app_current_user_sub()`, a SQL
// function reading the `app.current_user_sub` session GUC. This sets it.
//
// On PGlite, this app's own connection runs every query as the table OWNER,
// which Postgres exempts from RLS regardless of this setting (migration
// 0008's header) — so calling this locally is inert/harmless, not a special
// case. On server Postgres, the write-path API / sync connection (043/
// deploy, not built by this issue) runs as the granted-not-owning `app_user`
// role, where this is what makes RLS see the right identity per caller.
//
// `false` (not `true`) as set_config's third argument means this is a
// SESSION-level setting, not transaction-local — deliberate, since this
// app's PGlite connection is a long-lived singleton (src/db/client.ts) shared
// across many independent mutation calls, not one transaction per identity.
// Call this whenever the authenticated identity becomes known or changes
// (sign-in/out) so every subsequent query in this DB session carries it.
export async function setTenantContext(db: Database, userSub: string | null): Promise<void> {
  await db.execute(sql`SELECT set_config('app.current_user_sub', ${userSub ?? ''}, false)`)
}

// Reads back the currently-set identity — test/inspection helper mirroring
// the SQL function's own NULLIF-empty-string behavior.
export async function getTenantContext(db: Database): Promise<string | null> {
  const rows = await db.execute<{ sub: string | null }>(
    sql`SELECT NULLIF(current_setting('app.current_user_sub', true), '') AS sub`,
  )
  const row = (rows as unknown as { rows: { sub: string | null }[] }).rows[0]
  return row?.sub ?? null
}

// Issue 035 (ADR-0009) — the email half of the identity seam. Invitations
// (migration 0009) are keyed by email (the owner doesn't know the invitee's
// Cognito `sub` until they accept), so `app_current_user_email()`'s RLS
// policies need this GUC alongside the sub's. Additive: kept as its own
// function rather than widening `setTenantContext`'s signature so no
// existing call site (there are none yet in production code — this whole
// seam awaits 043's write-path wiring) needs to change.
export async function setTenantEmail(db: Database, email: string | null): Promise<void> {
  await db.execute(sql`SELECT set_config('app.current_user_email', ${email ?? ''}, false)`)
}

export async function getTenantEmail(db: Database): Promise<string | null> {
  const rows = await db.execute<{ email: string | null }>(
    sql`SELECT NULLIF(current_setting('app.current_user_email', true), '') AS email`,
  )
  const row = (rows as unknown as { rows: { email: string | null }[] }).rows[0]
  return row?.email ?? null
}
