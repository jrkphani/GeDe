// The Cognito PostConfirmation trigger's pure core (issue 050 — closing the
// last mile of the M11 write loop). Mirrors src/server/writeApi/handler.ts /
// src/server/debugApi/handler.ts's "thin AWS adapter, pure injectable core"
// split (ADR-0010): this file never touches Secrets Manager, a live `pg`
// connection, or the Cognito event shape — `albAdapter.ts` is the ONLY file
// in this directory that does, and it is (deliberately, like the other two
// albAdapter.ts files) reviewed but not exercised by any test in this repo
// (HANDOFF: "no live AWS/Electric/Cognito reachable in tests").
//
// Server-authoritative provisioning (issue 034/050 design brief): the client
// cannot be trusted to create tenancy rows, and the write path
// (src/server/writeApi/store.ts's FK_SCHEMA) deliberately excludes
// `workspaces`/`workspace_members` from what it will ever write. A Cognito
// trigger is the natural server hook that runs exactly once per confirmed
// user, in-VPC, with least-privilege intent (even though — see albAdapter.ts
// — it connects as the DB-secret OWNER role, mirroring the migration
// runner's owner-exemption from RLS, because bootstrapping a user's very
// first membership row is exactly the kind of write RLS's own policies
// would otherwise block: there's no existing membership yet to authorize it).
//
// Idempotent by construction (mirrors src/db/workspaces.ts's
// `getOrCreateUserWorkspace`, lifted server-side): `id = workspaceIdForSub(sub)`
// is the SAME id on every invocation for a given sub (src/domain/workspaceId.ts),
// so `ON CONFLICT DO NOTHING` on both inserts makes a re-confirm/replay a
// pure no-op rather than a duplicate workspace or membership row.
import { uuidv7 } from 'uuidv7'
import { workspaceIdForSub } from '../../domain/workspaceId'

export interface ProvisionExecutor {
  // Same shape as src/server/debugApi/operations.ts's `QueryExecutor` — an
  // arrow-typed property (not a method), since tests reference it directly
  // (`expect(executor.query).toHaveBeenCalled()`), which a method-shorthand
  // declaration would flag as an unbound-method risk.
  readonly query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>
}

export interface ProvisionResult {
  readonly workspaceId: string
}

/**
 * Idempotently ensures `sub` has a personal workspace + an owner membership
 * row. `ON CONFLICT (id) DO NOTHING` on `workspaces` and
 * `ON CONFLICT (workspace_id, user_sub) DO NOTHING` on `workspace_members`
 * (the same unique index migration 0008 declares,
 * `workspace_members_workspace_user_idx`) make every field of this function
 * safe to call any number of times for the same sub.
 */
export async function provisionWorkspace(sub: string, executor: ProvisionExecutor): Promise<ProvisionResult> {
  const workspaceId = workspaceIdForSub(sub)

  await executor.query(
    'INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [workspaceId, 'My Workspace'],
  )

  await executor.query(
    'INSERT INTO workspace_members (id, workspace_id, user_sub, role) VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (workspace_id, user_sub) DO NOTHING',
    [uuidv7(), workspaceId, sub, 'owner'],
  )

  return { workspaceId }
}
