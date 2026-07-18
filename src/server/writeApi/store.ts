// The write-path's persistence port (issue 043). `WriteStore` is the seam
// between the pure request-handling logic in handler.ts and whatever
// actually holds the shared rows. Two implementations:
//
//  - `InMemoryWriteStore` — a Map-based fake, used by every vitest in this
//    directory. No live Postgres is reachable in tests (HANDOFF).
//  - `PgWriteStore` — the real implementation (node-postgres), wired at
//    deploy time. It is reviewed here but NOT exercised against a live
//    database by any test in this repo; see pgWriteStore.contract.test.ts
//    for what IS verified without one (the tenant-context/transaction
//    wiring order, via a fake `pg`-shaped client).
import type { Pool, PoolClient } from 'pg'
import type { MutationEnvelope, MutationTable } from '../../domain/mutationProtocol'
import type { WorkspaceScopeResolver } from './tenancy'
import { provisionWorkspace, type ProvisionExecutor } from '../provisionWorkspace/handler'
import { workspaceIdForSub } from '../../domain/workspaceId'

export interface StoredRow {
  readonly id: string
  readonly workspaceId: string
  readonly table: MutationTable
  readonly data: Readonly<Record<string, unknown>>
  readonly updatedAt: string
  readonly deletedAt: string | null
}

/**
 * Issue 056 risk note ("workspaceId FK target ambiguity") — `invitations`/
 * `workspaceMembers` are the first FK_SCHEMA entries whose target
 * (`workspaces`) is NOT itself a mutable `MutationTable`: workspaces are
 * provisioned server-side by 050's PostConfirmation trigger, never via
 * `/write`. Rather than loosen `MutationTable` itself (which would make
 * every OTHER FK_SCHEMA/SQL_TABLE_NAMES entry think `workspaces` is a valid
 * mutation target too), this widens only the FK-TARGET type to a strict
 * superset, and `resolveForeignKeys`/`WriteStore.workspaceExists` below
 * handle `'workspaces'` as its own, dedicated (non-mutable) case.
 */
export type FkReferenceTable = MutationTable | 'workspaces'

/**
 * The foreign-key edges the write-path pre-validates (a friendly mirror of
 * the real FK constraints already declared in src/db/schema.ts — those are
 * the Tier-3 backstop; this is the Tier-2 friendly pre-check, ADR-0010).
 * Each entry: payload column name -> the table it must resolve against.
 */
export const FK_SCHEMA: Readonly<Record<MutationTable, Readonly<Record<string, FkReferenceTable>>>> = {
  // Issue 037 — `adoptedIntoProjectId` is a real self-referential FK
  // (schema.ts: `references((): AnyPgColumn => projects.id)`, the local→cloud
  // on-ramp). Declared here so it is BOTH existence-checked (resolveForeignKeys)
  // AND tenancy-checked (resolveForeignKeyTenancy, issue 098) — mirroring the
  // other self-referential FKs below (tier2Entries.parentId, parameters.
  // parentParamId, contexts.parentId). The legit client never sends this column
  // via /write, so the nullable-FK skip means the check only fires on a crafted
  // payload attempting a cross-tenant plant.
  projects: { adoptedIntoProjectId: 'projects' },
  // Issue 090 — `parentContextId` is the nullable half of the canvases↔contexts
  // FK cycle (a child canvas points at its parent context); `projectId` is the
  // NOT-NULL project owner. `dimensions`/`contexts` gain `canvasId` (their
  // NOT-NULL membership FK) below so the pre-check accepts a client canvas write.
  canvases: { projectId: 'projects', parentContextId: 'contexts' },
  tier1Purpose: { projectId: 'projects' },
  tier1Props: { projectId: 'projects' },
  tier2Tables: { projectId: 'projects' },
  tier2Entries: { tableId: 'tier2Tables', parentId: 'tier2Entries' },
  dimensions: { projectId: 'projects', canvasId: 'canvases', contextId: 'contexts', sourceParamId: 'parameters' },
  parameters: { dimensionId: 'dimensions', parentParamId: 'parameters', sourceEntryId: 'tier2Entries' },
  contexts: { projectId: 'projects', canvasId: 'canvases', parentId: 'contexts' },
  bindings: { contextId: 'contexts', dimensionId: 'dimensions', parameterId: 'parameters' },
  // Issue 056 — both point OUTWARD at `workspaces` (never at each other or
  // at another mutable table), matching src/db/schema.ts:31-45,59-75.
  invitations: { workspaceId: 'workspaces' },
  workspaceMembers: { workspaceId: 'workspaces' },
}

export interface WriteStore extends WorkspaceScopeResolver {
  /** The row's current authoritative state, or `null` if it doesn't exist / is soft-deleted. */
  getRow(table: MutationTable, id: string): Promise<StoredRow | null>
  /** True iff a live (non-deleted) row with this id exists in this table — the FK pre-check primitive. */
  rowExists(table: MutationTable, id: string): Promise<boolean>
  /**
   * Issue 056 — the dedicated FK pre-check primitive for `workspaces`, which
   * is never itself a `MutationTable` (see `FkReferenceTable`'s doc comment
   * above): `invitations`/`workspaceMembers` are the only tables whose
   * FK_SCHEMA resolves against it.
   */
  workspaceExists(id: string): Promise<boolean>
  /**
   * Issue 057 — the membership-gated tenancy relaxation's primitive: true iff
   * `sub` has a live (non-soft-deleted) `workspace_members` row for
   * `workspaceId`. This is what `checkTenancy` (tenancy.ts) calls when a
   * mutation declares a workspace other than the caller's own — see that
   * module's `WorkspaceScopeResolver.isMember` doc comment for the full
   * authorization shape. `WriteStore extends WorkspaceScopeResolver`, so
   * this single method satisfies both.
   */
  isMember(workspaceId: string, sub: string): Promise<boolean>
  /**
   * Issue 071 — self-heals the CALLER's own workspace (never the mutation's
   * declared workspaceId) on every write, before any mutation in the batch
   * is processed. Provisioning is otherwise a one-shot Cognito
   * PostConfirmation trigger (`src/server/provisionWorkspace/handler.ts`)
   * with no self-heal (issue 050) — any account whose trigger never ran or
   * failed has a permanently unprovisioned workspace, so its first
   * `INSERT INTO projects` hits the real Postgres FK constraint
   * (`projects_workspace_id_workspaces_id_fk`, 23503) and 502s. Idempotent +
   * cheap: reuses `provisionWorkspace`'s two `ON CONFLICT DO NOTHING`
   * inserts, so every call after the first is a no-op. Sharing-safety
   * (056/057): keyed on the server-verified `sub` derivation
   * (`workspaceIdForSub`) only — an invitee writing into an owner's shared
   * workspace never touches/re-provisions the owner's row.
   */
  ensureOwnWorkspace(sub: string): Promise<void>
  /** Live dimension count for a canvas (project + context, null = root canvas) — the dimension-floor primitive. */
  countLiveDimensions(projectId: string, contextId: string | null): Promise<number>
  /** Live bindings already occupying a (context, dimension) pair, excluding `excludeBindingId` (a rebind of itself). */
  countLiveBindingsForPair(contextId: string, dimensionId: string, excludeBindingId?: string): Promise<number>
  /** Idempotency ledger check (mutation id, not entity id). */
  hasApplied(mutationId: string): Promise<boolean>
  /**
   * Atomically: if `mutationId` is already in the ledger, do nothing and
   * return `false` (caller reports `noop`); otherwise apply the mutation AND
   * record it in the ledger as one unit, returning `true` (caller reports
   * `applied`). Both writes commit or neither does — no split-brain between
   * "ledger says applied" and "the row was actually written". `actorSub` is
   * the verified Cognito `sub` (from the JWT, not the envelope) — it's what
   * the Postgres implementation stamps into the tenant-context GUC that
   * 034's RLS policies key off.
   */
  applyIfNew(mutation: MutationEnvelope, actorSub: string): Promise<boolean>
}

/** Resolves every FK column FK_SCHEMA declares for `table`, returning the ids that did NOT resolve. */
export async function resolveForeignKeys(
  table: MutationTable,
  payload: Readonly<Record<string, unknown>>,
  store: Pick<WriteStore, 'rowExists' | 'workspaceExists'>,
): Promise<string[]> {
  const edges = FK_SCHEMA[table]
  const unresolved: string[] = []
  for (const [column, refTable] of Object.entries(edges)) {
    const value = payload[column]
    if (value === null || value === undefined) continue // nullable FKs are legal absent
    if (typeof value !== 'string') {
      unresolved.push(`${column} (invalid reference type)`)
      continue
    }
    // `workspaces` is a resolvable FK TARGET but never a mutable MutationTable
    // (issue 056) — it gets its own dedicated existence check rather than
    // `rowExists`, which is typed over MutationTable only.
    const exists = refTable === 'workspaces' ? await store.workspaceExists(value) : await store.rowExists(refTable, value)
    if (!exists) unresolved.push(value)
  }
  return unresolved
}

/**
 * Issue 098 (SECURITY) — the FK-TENANCY pre-check that `resolveForeignKeys`
 * above deliberately does NOT do: that verifies a FK target EXISTS; this
 * verifies it BELONGS to the caller. For each FK edge FK_SCHEMA declares for
 * `table`, resolve the workspace the target row actually belongs to and return
 * the column names whose target belongs to a workspace OTHER than the
 * mutation's DECLARED (and already-authorized, by checkTenancy) one. An empty
 * list means every present FK is same-tenant.
 *
 * Without this, a caller authorized only for workspace A can `insert`/`update`
 * a row (e.g. tier1Purpose, dimensions, canvases, ...) whose `projectId` (or
 * any FK) points at a VICTIM's entity in workspace V — the FK is satisfied (the
 * project exists) and checkTenancy only authorized the declared workspace A, so
 * the row lands stamped workspace_id = A over the victim's parent. The API is
 * the sole authz boundary in prod (RLS is a no-op, ADR-0010).
 *
 * Co-located with FK_SCHEMA/resolveForeignKeys ON PURPOSE (not in tenancy.ts):
 * store.ts already imports `WorkspaceScopeResolver` FROM tenancy.ts, so putting
 * this there would create a circular import.
 *
 * Semantics per FK edge:
 *  - null/undefined value → skip (a nullable FK legally absent).
 *  - non-string value → skip (resolveForeignKeys already flags it as an
 *    invalid-reference type; not this function's concern).
 *  - target table is `workspaces` → the row's tenancy IS its own id, so flag
 *    iff `value !== declaredWorkspaceId`.
 *  - otherwise → resolve the target's workspace; flag iff it resolves to a
 *    workspace that is neither null NOR the declared one. A `null` resolution
 *    (missing / soft-deleted target) is SKIPPED, never flagged — it must fall
 *    through to resolveForeignKeys's existing `referential_integrity`
 *    rejection, so a genuinely missing FK never masquerades as cross_tenant.
 */
export async function resolveForeignKeyTenancy(
  table: MutationTable,
  payload: Readonly<Record<string, unknown>>,
  declaredWorkspaceId: string,
  resolver: Pick<WorkspaceScopeResolver, 'resolveWorkspaceForEntity'>,
): Promise<string[]> {
  const edges = FK_SCHEMA[table]
  const crossTenant: string[] = []
  for (const [column, refTable] of Object.entries(edges)) {
    const value = payload[column]
    if (value === null || value === undefined) continue // nullable FK legally absent
    if (typeof value !== 'string') continue // resolveForeignKeys owns the invalid-reference-type case
    if (refTable === 'workspaces') {
      // A `workspaces` FK target carries no workspace_id of its own — its
      // tenancy is its own id (issue 056). Anything but the declared workspace
      // is cross-tenant.
      if (value !== declaredWorkspaceId) crossTenant.push(column)
      continue
    }
    const targetWorkspace = await resolver.resolveWorkspaceForEntity(refTable, value)
    if (targetWorkspace !== null && targetWorkspace !== declaredWorkspaceId) crossTenant.push(column)
  }
  return crossTenant
}

// ── In-memory test double ───────────────────────────────────────────────────

export class InMemoryWriteStore implements WriteStore {
  private readonly rows = new Map<string, StoredRow>() // key: `${table}:${id}`
  private readonly appliedMutationIds = new Set<string>()
  // Issue 056 — `workspaces` rows tracked separately from `rows` above:
  // `StoredRow.table` is a `MutationTable`, and `workspaces` deliberately
  // is not one (see `FkReferenceTable`'s doc comment).
  private readonly workspaceIds = new Set<string>()
  // Issue 057 — seeded `workspace_members` rows, keyed `${workspaceId}:${sub}`
  // (mirrors `key()`'s convention below, one level up). A fake, not a real
  // table: tests seed exactly the membership tuples a scenario needs via
  // `seedMembership`, mirroring `seedWorkspace`'s own minimal-fake shape.
  private readonly memberships = new Set<string>()

  private key(table: MutationTable, id: string): string {
    return `${table}:${id}`
  }

  private membershipKey(workspaceId: string, sub: string): string {
    return `${workspaceId}:${sub}`
  }

  /** Test/setup helper — seeds a row as if a prior mutation had already landed. */
  seed(row: StoredRow): void {
    this.rows.set(this.key(row.table, row.id), row)
  }

  /** Test/setup helper — seeds a `workspaces` row (see `workspaceIds` above). */
  seedWorkspace(id: string): void {
    this.workspaceIds.add(id)
  }

  /**
   * Issue 057 — test/setup helper mirroring `seedWorkspace`: seeds a live
   * `workspace_members` row for `(workspaceId, sub)`, exactly what
   * `isMember` below reads. Tests deliberately do NOT seed this to exercise
   * the "no membership → still cross_tenant" half of the relaxation.
   */
  seedMembership(workspaceId: string, sub: string): void {
    this.memberships.add(this.membershipKey(workspaceId, sub))
  }

  workspaceExists(id: string): Promise<boolean> {
    return Promise.resolve(this.workspaceIds.has(id))
  }

  isMember(workspaceId: string, sub: string): Promise<boolean> {
    return Promise.resolve(this.memberships.has(this.membershipKey(workspaceId, sub)))
  }

  /**
   * Issue 071 — mirrors `PgWriteStore.ensureOwnWorkspace`'s effect (a
   * provisioned workspace + owner membership row for `sub`) against this
   * fake's own `workspaceIds`/`memberships` sets, so `handler.test.ts` can
   * assert the orchestration (called once, with the caller's own sub, before
   * the mutation loop) without a live Postgres. `Set.add` is naturally
   * idempotent — no extra bookkeeping needed.
   */
  ensureOwnWorkspace(sub: string): Promise<void> {
    const workspaceId = workspaceIdForSub(sub)
    this.workspaceIds.add(workspaceId)
    this.memberships.add(this.membershipKey(workspaceId, sub))
    return Promise.resolve()
  }

  getRow(table: MutationTable, id: string): Promise<StoredRow | null> {
    const row = this.rows.get(this.key(table, id))
    if (row?.deletedAt !== null) return Promise.resolve(null)
    return Promise.resolve(row)
  }

  rowExists(table: MutationTable, id: string): Promise<boolean> {
    const row = this.rows.get(this.key(table, id))
    return Promise.resolve(row?.deletedAt === null)
  }

  resolveWorkspaceForEntity(table: MutationTable, entityId: string): Promise<string | null> {
    const row = this.rows.get(this.key(table, entityId))
    if (row?.deletedAt !== null) return Promise.resolve(null)
    return Promise.resolve(row.workspaceId)
  }

  // Issue 094 (revival gap) — the twin that does NOT filter `deletedAt`: returns
  // the row's workspaceId even when tombstoned, null only when truly absent.
  // `checkTenancy`'s revive branch uses this to range-check a tombstoned target.
  resolveWorkspaceForEntityIncludingDeleted(table: MutationTable, entityId: string): Promise<string | null> {
    const row = this.rows.get(this.key(table, entityId))
    return Promise.resolve(row ? row.workspaceId : null)
  }

  // Issue 091 — the natural-key fallback (see WorkspaceScopeResolver's doc
  // comment). Scans for a LIVE row of the mutation's table whose natural-key
  // column value matches the payload's; returns its workspaceId, or null for a
  // non-natural-key table / missing key / no such row.
  resolveWorkspaceForNaturalKey(mutation: MutationEnvelope): Promise<string | null> {
    const natural = naturalKeyOf(mutation)
    if (natural === null) return Promise.resolve(null)
    for (const row of this.rows.values()) {
      if (row.table !== mutation.table || row.deletedAt !== null) continue
      if (row.data[natural.jsKey] === natural.value) return Promise.resolve(row.workspaceId)
    }
    return Promise.resolve(null)
  }

  countLiveDimensions(projectId: string, contextId: string | null): Promise<number> {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.table !== 'dimensions' || row.deletedAt !== null) continue
      if (row.data.projectId === projectId && (row.data.contextId ?? null) === contextId) count++
    }
    return Promise.resolve(count)
  }

  countLiveBindingsForPair(contextId: string, dimensionId: string, excludeBindingId?: string): Promise<number> {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.table !== 'bindings' || row.deletedAt !== null) continue
      if (row.id === excludeBindingId) continue
      if (row.data.contextId === contextId && row.data.dimensionId === dimensionId) count++
    }
    return Promise.resolve(count)
  }

  hasApplied(mutationId: string): Promise<boolean> {
    return Promise.resolve(this.appliedMutationIds.has(mutationId))
  }

  // No tenant-context GUC to set for the in-memory fake — `actorSub` matters
  // only to PgWriteStore (it stamps the Postgres session for RLS).
  applyIfNew(mutation: MutationEnvelope): Promise<boolean> {
    if (this.appliedMutationIds.has(mutation.id)) return Promise.resolve(false)
    this.appliedMutationIds.add(mutation.id)

    // The persisted `updated_at` is the CLIENT's declared timestamp
    // (`clientUpdatedAt`), not the server's receipt wall-clock — LWW only
    // makes sense across a distributed set of clients if the compared
    // timestamp is each edit's own origin time, not when it happened to
    // arrive at the server (network delay would otherwise let a genuinely
    // earlier edit look "newer" just for arriving late).
    if (mutation.op === 'delete') {
      const existing = this.rows.get(this.key(mutation.table, mutation.entityId))
      if (existing) {
        this.rows.set(this.key(mutation.table, mutation.entityId), {
          ...existing,
          deletedAt: mutation.clientUpdatedAt,
          updatedAt: mutation.clientUpdatedAt,
        })
      }
      return Promise.resolve(true)
    }

    // Issue 091 — a NATURAL-KEY table's UPDATE addresses the LIVE row by its
    // natural key (project_id from the payload), not the client-minted
    // `entityId`, which may have diverged from the server row's id after 095's
    // insert-path reconciliation. This updates the existing row IN PLACE
    // (keeping its own id), mirroring PgWriteStore's natural-key UPDATE branch
    // below. The `row.workspaceId === mutation.workspaceId` guard is
    // defense-in-depth (mirrors 097/095 and Pg's `AND workspace_id = $3`): a
    // cross-tenant natural-key row is a silent no-op, never overwritten. Only
    // `update` takes this path; `insert` keeps the plain entityId-keyed upsert.
    if (mutation.op === 'update') {
      const natural = naturalKeyOf(mutation)
      if (natural !== null) {
        for (const [rowKey, row] of this.rows.entries()) {
          if (row.table !== mutation.table || row.deletedAt !== null) continue
          if (row.data[natural.jsKey] !== natural.value) continue
          if (row.workspaceId === mutation.workspaceId) {
            this.rows.set(rowKey, {
              ...row,
              data: { ...row.data, ...mutation.payload },
              updatedAt: mutation.clientUpdatedAt,
            })
          }
          // Matched a natural-key row (same- or cross-tenant) — addressed by
          // natural key, never by the diverged id. Done either way.
          return Promise.resolve(true)
        }
        // No live natural-key row matched — fall through to the id-keyed path
        // (defensive; in practice tenancy resolves to the id row when it does).
      }
    }

    // Issue 094 follow-up (adversarial review) — a NATURAL-KEY table's REVIVE
    // reconciles onto the existing singleton row by its natural key (project_id),
    // LIVE OR TOMBSTONED, keeping that row's own id and clearing any tombstone —
    // mirroring PgWriteStore's natural-key revive branch and the 091 update
    // handling above. Without this, a diverged-id revive would mint a SECOND row
    // under the client's fresh id here (in-memory) while live Postgres 23505s on
    // the natural-key index — exactly the in-memory-hides-live-divergence trap
    // that 094 exists to close. Unlike the 091 update block, this deliberately
    // does NOT skip tombstoned rows — un-tombstoning one is the whole point.
    if (mutation.op === 'revive') {
      const naturalRevive = naturalKeyOf(mutation)
      if (naturalRevive !== null) {
        for (const [rowKey, row] of this.rows.entries()) {
          if (row.table !== mutation.table) continue
          if (row.data[naturalRevive.jsKey] !== naturalRevive.value) continue
          if (row.workspaceId === mutation.workspaceId) {
            this.rows.set(rowKey, {
              ...row,
              data: { ...row.data, ...mutation.payload },
              updatedAt: mutation.clientUpdatedAt,
              deletedAt: null,
            })
          }
          // Matched a natural-key row (same- or cross-tenant) — addressed by
          // natural key, never the diverged id; a cross-tenant match is a silent
          // no-op (never un-tombstoned/overwritten), mirroring Pg's workspace
          // guard. Done either way (no second row minted under the fresh id).
          return Promise.resolve(true)
        }
        // No natural-key row (live or tombstoned) matched — a genuinely fresh
        // singleton; fall through to the id-keyed insert-live merge below.
      }
    }

    // The non-delete merge path: `insert`, `update` (non-natural-key), AND
    // Issue 094's `revive` (non-natural-key, or a fresh-singleton fall-through).
    // It unconditionally sets `deletedAt: null`, so reviving a tombstoned row
    // here naturally un-tombstones it and merges the payload; reviving an absent
    // row inserts it live — the two revive semantics fall out of the same merge
    // for free (the PgWriteStore needs a dedicated branch because SQL can't
    // un-tombstone that cheaply — see its revive SQL).
    const existing = this.rows.get(this.key(mutation.table, mutation.entityId))
    const merged: StoredRow = {
      id: mutation.entityId,
      workspaceId: mutation.workspaceId,
      table: mutation.table,
      data: { ...(existing?.data ?? {}), ...mutation.payload },
      updatedAt: mutation.clientUpdatedAt,
      deletedAt: null,
    }
    this.rows.set(this.key(mutation.table, mutation.entityId), merged)
    return Promise.resolve(true)
  }
}

// ── Real (Postgres) implementation ──────────────────────────────────────────

/** Snake-cased table names, matching src/db/schema.ts's `pgTable(...)` first argument. */
const SQL_TABLE_NAMES: Readonly<Record<MutationTable, string>> = {
  projects: 'projects',
  canvases: 'canvases',
  tier1Purpose: 'tier1_purpose',
  tier1Props: 'tier1_props',
  tier2Tables: 'tier2_tables',
  tier2Entries: 'tier2_entries',
  dimensions: 'dimensions',
  parameters: 'parameters',
  contexts: 'contexts',
  bindings: 'bindings',
  invitations: 'invitations',
  workspaceMembers: 'workspace_members',
}

// Issue 095 — tables whose meaningful NATURAL key is a non-`id` UNIQUE index, so
// the insert path must reconcile on that key, not the `id` PK. A signed-in client
// whose local mirror lacks the row mints a FRESH `id` and enqueues an 'upsert'
// (→ 'insert'): a plain `ON CONFLICT (id) DO NOTHING` can't see the natural-key
// collision, so Postgres 23505s on the secondary unique index → 500 → silent
// data-loss. Listed tables upsert on the natural key instead (`DO UPDATE`,
// persisting the edit LWW-by-arrival like the update branch). ONLY tier1_purpose
// is covered here (a project singleton, `tier1_purpose_project_idx`) — the bug
// reproduced live for it. The other secondary-unique tables (`bindings` on
// (context_id, dimension_id); `workspace_members` on (workspace_id, user_sub);
// `canvases` on (parent/context)) share the theoretical exposure but were NOT
// reproduced and want DIFFERENT conflict semantics (e.g. a binding is an
// idempotent link → `DO NOTHING`, not `DO UPDATE`), so they are deliberately left
// for a scoped follow-up rather than a blanket change — see docs/issues/095.
const NATURAL_KEY_CONFLICT: Partial<Record<MutationTable, string>> = {
  tier1Purpose: 'project_id',
}

/** snake_case SQL column → Drizzle camelCase JS payload key (`project_id` → `projectId`) — the inverse of `applyIfNew`'s `toSqlColumn`. */
const toJsKey = (sqlColumn: string): string => sqlColumn.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * Issue 091 — for a NATURAL-KEY table (`NATURAL_KEY_CONFLICT`) whose mutation
 * payload carries the natural-key value, returns `{ sqlColumn, jsKey, value }`;
 * otherwise `null` (non-natural-key table, or the payload omits the key). The
 * single place the sql-column ↔ js-key ↔ payload-value derivation lives, shared
 * by `resolveWorkspaceForNaturalKey` (both stores) and PgWriteStore's update
 * branch, so they can never disagree about which column/value addresses the row.
 */
function naturalKeyOf(
  mutation: Pick<MutationEnvelope, 'table' | 'payload'>,
): { sqlColumn: string; jsKey: string; value: string } | null {
  const sqlColumn = NATURAL_KEY_CONFLICT[mutation.table]
  if (sqlColumn === undefined) return null
  const jsKey = toJsKey(sqlColumn)
  const value = mutation.payload[jsKey]
  if (typeof value !== 'string') return null
  return { sqlColumn, jsKey, value }
}

export interface PgWriteStoreConfig {
  readonly pool: Pool
}

/**
 * Real Postgres-backed WriteStore. Every write runs inside one transaction
 * that (a) sets the session's tenant-context GUCs so 034's RLS policies
 * apply (defense-in-depth alongside the API-layer tenancy check, ADR-0010),
 * and (b) atomically checks-and-inserts the idempotency ledger row alongside
 * the actual mutation, so a crash between the two can never happen.
 *
 * `SELECT set_config($1, $2, true)` (not a literal `SET LOCAL <name> = <val>`)
 * is used deliberately — `SET LOCAL` doesn't accept bind parameters, and
 * string-interpolating the workspace/user id into SQL would be an injection
 * risk; `set_config` is the parameterized equivalent, scoped to the current
 * transaction (`is_local = true`) exactly like `SET LOCAL`.
 *
 * Issue 034's `src/db/tenantContext.ts` (not yet built in this worktree)
 * should become the single source of this SET-context pattern; when it
 * lands, swap the two `set_config` calls below for its exported helper
 * rather than forking the logic.
 */
export class PgWriteStore implements WriteStore {
  constructor(private readonly config: PgWriteStoreConfig) {}

  private async withTenantContext<T>(
    userId: string,
    workspaceId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.config.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
      await client.query('SELECT set_config($1, $2, true)', ['app.current_workspace_id', workspaceId])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getRow(table: MutationTable, id: string): Promise<StoredRow | null> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${SQL_TABLE_NAMES[table]} WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        id,
        workspaceId: (row.workspace_id as string | undefined) ?? '',
        table,
        data: row,
        updatedAt: row.updated_at as string,
        deletedAt: (row.deleted_at as string | null) ?? null,
      }
    } finally {
      client.release()
    }
  }

  async rowExists(table: MutationTable, id: string): Promise<boolean> {
    return (await this.getRow(table, id)) !== null
  }

  // Issue 056 — `workspaces` is never a `MutationTable` (see
  // `FkReferenceTable`'s doc comment), so it needs its own query rather than
  // going through `getRow`/`SQL_TABLE_NAMES`, which are typed over
  // `MutationTable` only.
  async workspaceExists(id: string): Promise<boolean> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query('SELECT 1 FROM workspaces WHERE id = $1 AND deleted_at IS NULL', [id])
      return result.rows.length > 0
    } finally {
      client.release()
    }
  }

  resolveWorkspaceForEntity(table: MutationTable, entityId: string): Promise<string | null> {
    return this.getRow(table, entityId).then((row) => row?.workspaceId ?? null)
  }

  // Issue 094 (revival gap) — resolves the row's workspace_id WITHOUT the
  // `deleted_at IS NULL` filter `getRow` applies, so a tombstoned row (exactly
  // what a revive targets) still resolves; null only when the id is truly absent.
  // Its own connection/query (not via getRow, which filters tombstones out) —
  // runs BEFORE tenancy is decided, like resolveWorkspaceForNaturalKey/isMember,
  // so no tenant-context GUC is set here.
  async resolveWorkspaceForEntityIncludingDeleted(table: MutationTable, entityId: string): Promise<string | null> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ${SQL_TABLE_NAMES[table]} WHERE id = $1`,
        [entityId],
      )
      return result.rows[0]?.workspace_id ?? null
    } finally {
      client.release()
    }
  }

  // Issue 091 — the natural-key fallback (see WorkspaceScopeResolver's doc
  // comment). Resolves the LIVE row by its natural-key column (project_id from
  // the payload) rather than the client-minted id, returning its workspace_id;
  // null for a non-natural-key table, a missing key, or no such row. `sqlColumn`
  // comes from the fixed `NATURAL_KEY_CONFLICT` map (never client input), so
  // interpolating it into the query is not an injection vector — the value is
  // still bound as $1.
  async resolveWorkspaceForNaturalKey(mutation: MutationEnvelope): Promise<string | null> {
    const natural = naturalKeyOf(mutation)
    if (natural === null) return null
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ${SQL_TABLE_NAMES[mutation.table]} WHERE ${natural.sqlColumn} = $1 AND deleted_at IS NULL`,
        [natural.value],
      )
      return result.rows[0]?.workspace_id ?? null
    } finally {
      client.release()
    }
  }

  // Issue 057 — the real membership check backing `checkTenancy`'s
  // relaxation. Deliberately its own connection/query (not folded into
  // `withTenantContext`): this runs BEFORE tenancy is decided, so there is no
  // tenant-context GUC to set yet — `applyIfNew` is the only method that
  // stamps that context, once a mutation has already been authorized.
  async isMember(workspaceId: string, sub: string): Promise<boolean> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_sub = $2 AND deleted_at IS NULL',
        [workspaceId, sub],
      )
      return result.rows.length > 0
    } finally {
      client.release()
    }
  }

  /**
   * Issue 071 — reuses `provisionWorkspace` (`../provisionWorkspace/handler`)
   * rather than duplicating its two `ON CONFLICT DO NOTHING` INSERTs: a
   * checked-out client is wrapped in a `ProvisionExecutor` exactly like
   * `provisionWorkspace/albAdapter.ts` wraps its own pool, so both the
   * one-shot PostConfirmation trigger and this per-write self-heal share one
   * source of the provisioning SQL. Goes through `pool.connect()`/`release()`
   * like every other method on this class (`getRow`, `workspaceExists`,
   * `isMember`, ...) rather than a bare `pool.query` — no ambient
   * tenant-context GUCs need setting here (mirrors `isMember`'s own comment:
   * this runs before any tenant context is relevant). `client.query`'s
   * `QueryResult.rows` is a mutable array typed by the caller's generic —
   * cast to the executor's `{ rows: readonly Record<string, unknown>[] }`
   * shape, mirroring the albAdapter's own adapter closure.
   */
  async ensureOwnWorkspace(sub: string): Promise<void> {
    const client = await this.config.pool.connect()
    try {
      const executor: ProvisionExecutor = {
        query: async (sql, params) => {
          const result = await client.query(sql, params as unknown[] | undefined)
          return { rows: result.rows as Record<string, unknown>[] }
        },
      }
      await provisionWorkspace(sub, executor)
    } finally {
      client.release()
    }
  }

  async countLiveDimensions(projectId: string, contextId: string | null): Promise<number> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<{ count: string }>(
        contextId === null
          ? 'SELECT count(*) FROM dimensions WHERE project_id = $1 AND context_id IS NULL AND deleted_at IS NULL'
          : 'SELECT count(*) FROM dimensions WHERE project_id = $1 AND context_id = $2 AND deleted_at IS NULL',
        contextId === null ? [projectId] : [projectId, contextId],
      )
      return Number(result.rows[0]?.count ?? 0)
    } finally {
      client.release()
    }
  }

  async countLiveBindingsForPair(contextId: string, dimensionId: string, excludeBindingId?: string): Promise<number> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<{ count: string }>(
        excludeBindingId
          ? 'SELECT count(*) FROM bindings WHERE context_id = $1 AND dimension_id = $2 AND id != $3'
          : 'SELECT count(*) FROM bindings WHERE context_id = $1 AND dimension_id = $2',
        excludeBindingId ? [contextId, dimensionId, excludeBindingId] : [contextId, dimensionId],
      )
      return Number(result.rows[0]?.count ?? 0)
    } finally {
      client.release()
    }
  }

  async hasApplied(mutationId: string): Promise<boolean> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query('SELECT 1 FROM applied_mutations WHERE mutation_id = $1', [mutationId])
      return result.rows.length > 0
    } finally {
      client.release()
    }
  }

  async applyIfNew(mutation: MutationEnvelope, actorSub: string): Promise<boolean> {
    return this.withTenantContext(actorSub, mutation.workspaceId, async (client) => {
      const ledger = await client.query(
        'INSERT INTO applied_mutations (mutation_id, workspace_id, applied_at) VALUES ($1, $2, now()) ON CONFLICT (mutation_id) DO NOTHING RETURNING mutation_id',
        [mutation.id, mutation.workspaceId],
      )
      if (ledger.rows.length === 0) return false // already applied — noop

      const table = SQL_TABLE_NAMES[mutation.table]
      // `updated_at`/`deleted_at` are stamped with the mutation's OWN
      // `clientUpdatedAt` (the LWW candidate timestamp), not the server's
      // receipt wall-clock — see the InMemoryWriteStore doc comment for why.
      if (mutation.op === 'delete') {
        // Issue 091 KNOWN FAST-FOLLOW (comment only — behavior deliberately
        // unchanged): the natural-key resolution the update branch below gained
        // is NOT mirrored here. A diverged-id delete for a NATURAL_KEY_CONFLICT
        // table (tier1_purpose) would address a non-existent id and phantom
        // no-op (0 rows). This is currently UNREACHABLE — tier1_purpose is a
        // project singleton that is never enqueued as a 'delete' (it is only
        // ever upserted/updated). If a tier1_purpose (or any natural-key table)
        // delete is ever enabled, mirror the `WHERE <naturalKeyCol> = … AND
        // workspace_id = <declared>` addressing here, or add a loud guard —
        // otherwise the tombstone would silently miss the real row.
        await client.query(`UPDATE ${table} SET deleted_at = $2, updated_at = $2 WHERE id = $1`, [
          mutation.entityId,
          mutation.clientUpdatedAt,
        ])
        return true
      }

      // Client payloads use Drizzle's camelCase JS field names (the vocabulary
      // electricProtocol.ts's SQL_TO_JS_COLUMNS maps); the DB columns are
      // snake_case. Convert each key to its SQL column name, and drop the
      // server-stamped columns (id/updated_at/deleted_at/workspace_id — set
      // explicitly via $1/$2/$3 and the delete branch) AFTER conversion so
      // `updatedAt`/`workspaceId` are caught too. Every synced-table column
      // follows the regular camel↔snake pattern (workspace_id↔workspaceId,
      // source_param_id↔sourceParamId, ...). This PgWriteStore path was never
      // run against a live DB before (043's contract test uses a fake pg
      // client that does not parse SQL), so both the duplicate-id and
      // camel/snake mismatches only surfaced in the 050 live write test.
      //
      // Issue 078 step 2 — `workspace_id` joined SERVER_STAMPED alongside
      // `id`/`updated_at`/`deleted_at`, closing a latent gap: it used to be
      // just another payload column, trusted verbatim from whatever the
      // client sent — which could differ from (or omit) `mutation.workspaceId`,
      // the value checkTenancy already authorized (tenancy.ts) before
      // applyIfNew ever runs. Every MutationTable now carries a real
      // workspace_id column (tier2Entries/parameters/bindings gained theirs
      // via migration 0015, the same one that let src/domain/syncScope.ts
      // drop the experimental allow_subqueries read-path scoping), so this
      // stamp applies unconditionally, on both insert and update.
      const SERVER_STAMPED = new Set(['id', 'updated_at', 'deleted_at', 'workspace_id'])
      const toSqlColumn = (jsKey: string): string => jsKey.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
      const entries = Object.entries(mutation.payload)
        .map(([jsKey, value]) => [toSqlColumn(jsKey), value] as const)
        .filter(([col]) => !SERVER_STAMPED.has(col))
      const columns = entries.map(([col]) => col)
      const values = entries.map(([, value]) => value)

      // Issue 094 (revival gap) — un-tombstone a soft-deleted row, or insert it
      // live if absent; idempotent; cross-tenant safe. Implemented as two
      // statements, NOT the `ON CONFLICT (id) DO UPDATE SET deleted_at = NULL …`
      // an upsert would suggest: a real-Postgres probe proved that ON CONFLICT
      // form FAILS with a NOT NULL violation on the target table's other
      // required columns (project_id, canvas_id, …) whenever the revive payload
      // omits them — because Postgres evaluates NOT NULL on the tentative INSERT
      // tuple BEFORE the conflict arbiter fires, so the DO UPDATE never runs and
      // the row stays tombstoned. (This is exactly the InMemory-passes/live-fails
      // class 094 exists to close.) Instead:
      //   1. UPDATE the row live (clear deleted_at + apply fields) ONLY when it
      //      exists AND already belongs to the declared (already-authorized)
      //      workspace — the `AND workspace_id = $3` guard mirrors 097/095/091's
      //      no-clobber defense-in-depth: a cross-tenant tombstoned row is a
      //      0-row no-op, never resurrected or re-tenanted.
      //   2. INSERT live ONLY when NO row exists at all. The `WHERE NOT EXISTS`
      //      guard means the tentative INSERT tuple is never formed when the row
      //      already exists, so a partial-payload revive against an existing row
      //      never trips the NOT NULL check that broke the ON CONFLICT form. A
      //      cross-tenant collision therefore no-ops in BOTH statements (step 1's
      //      workspace guard + step 2's existence guard) → the victim row is
      //      untouched. An absent revive is semantically an insert, so its
      //      payload must carry the NOT NULL columns exactly as a plain insert
      //      would (the client's restore/redo path sends the full row).
      // A NATURAL_KEY_CONFLICT table (tier1_purpose) splits off FIRST and
      // addresses both statements by its natural key (project_id), not the
      // client-minted id — otherwise a diverged-id revive 23505s on the natural-
      // key unique index (the 091/095 diverged-id class). See the inner comments.
      if (mutation.op === 'revive') {
        // Issue 094 follow-up (adversarial review) — a NATURAL-KEY table's revive
        // must reconcile by its natural key, EXACTLY like the 091 update / 095
        // insert paths, not by the client-minted `entityId`. For `tier1_purpose`
        // (a project singleton, unique on `project_id`), a cold-mirror client
        // mints a FRESH/diverged id; a revive whose payload `projectId` matches an
        // already-live singleton would, under the id-keyed form below, (a) MISS
        // the existing row in the UPDATE and (b) then 23505 on
        // `tier1_purpose_project_idx` in the INSERT (the PK `NOT EXISTS` guard
        // only guards the id, not the natural-key unique index) → an UNHANDLED
        // duplicate-key error out of applyIfNew → albAdapter 500, with earlier
        // batch mutations already committed (each applyIfNew is its own tx). This
        // is the 091/095 diverged-id class, and it must be PREVENTED (address by
        // natural key), never caught. `naturalKeyOf` is the same helper 091/095
        // share, so all three paths agree on which column/value addresses the row.
        const naturalRevive = naturalKeyOf(mutation)
        if (naturalRevive !== null) {
          // Step 1 — un-tombstone + apply fields on the EXISTING singleton,
          // addressed by natural key (project_id), keeping the server row's own
          // id (id is SERVER_STAMPED, never in the SET). Matches a live OR
          // tombstoned row (revive un-tombstones, so — unlike the 091 update —
          // it deliberately does not filter `deleted_at`). The trailing
          // `AND workspace_id = $2` guard is the 097/095/091 no-clobber defense:
          // a cross-tenant singleton is a 0-row no-op, never resurrected/re-
          // tenanted. Param layout mirrors the 091 update branch (no unused $1 —
          // the diverged entityId is dropped here): $1 updated_at, $2 workspace_id
          // (SET + guard), $3.. columns, trailing the natural-key value.
          const nkSetClause = columns.map((c, i) => `${c} = $${i + 3}`).join(', ')
          await client.query(
            `UPDATE ${table} SET deleted_at = NULL, workspace_id = $2, ${nkSetClause}, updated_at = $1 WHERE ${naturalRevive.sqlColumn} = $${values.length + 3} AND workspace_id = $2`,
            [mutation.clientUpdatedAt, mutation.workspaceId, ...values, naturalRevive.value],
          )
          // Step 2 — insert live ONLY if NO row for that NATURAL KEY exists (not
          // the id): guards the actual unique index the 23505 fires on. The
          // trailing `ON CONFLICT (${naturalRevive.sqlColumn}) DO NOTHING` is the
          // concurrency backstop — if a concurrent tx committed the singleton
          // between this snapshot's `NOT EXISTS` and the insert, the loser
          // no-ops on the natural-key arbiter instead of 23505'ing. (Naming the
          // natural-key arbiter, not `id`, is what actually catches THIS table's
          // duplicate-key race; a same-id race for a UUIDv7 singleton is not a
          // real scenario.)
          const columnListNk = columns.length > 0 ? `, ${columns.join(', ')}` : ''
          const selectValsNk = values.map((_, i) => `$${i + 4}`).join(', ')
          const selectValsListNk = selectValsNk.length > 0 ? `, ${selectValsNk}` : ''
          await client.query(
            `INSERT INTO ${table} (id, updated_at, workspace_id${columnListNk}) SELECT $1, $2, $3${selectValsListNk} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${naturalRevive.sqlColumn} = $${values.length + 4}) ON CONFLICT (${naturalRevive.sqlColumn}) DO NOTHING`,
            [mutation.entityId, mutation.clientUpdatedAt, mutation.workspaceId, ...values, naturalRevive.value],
          )
          return true
        }

        // Non-natural-key table — address by the row's own id (the common
        // revive: dimensions, projects, invitations, ...). See this branch's
        // header comment (above the `if`) for why it is UPDATE-first +
        // NOT-EXISTS-guarded INSERT rather than `ON CONFLICT (id) DO UPDATE`
        // (the NOT NULL-before-arbiter landmine). The `ON CONFLICT (id) DO
        // NOTHING` backstop makes two concurrent reviving of the same fresh
        // absent id race to a no-op instead of a 23505.
        const setClause = ['deleted_at = NULL', 'updated_at = $2', 'workspace_id = $3']
          .concat(columns.map((c, i) => `${c} = $${i + 4}`))
          .join(', ')
        await client.query(`UPDATE ${table} SET ${setClause} WHERE id = $1 AND workspace_id = $3`, [
          mutation.entityId,
          mutation.clientUpdatedAt,
          mutation.workspaceId,
          ...values,
        ])
        const columnList = columns.length > 0 ? `, ${columns.join(', ')}` : ''
        const selectVals = values.map((_, i) => `$${i + 4}`).join(', ')
        const selectValsList = selectVals.length > 0 ? `, ${selectVals}` : ''
        await client.query(
          `INSERT INTO ${table} (id, updated_at, workspace_id${columnList}) SELECT $1, $2, $3${selectValsList} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE id = $1) ON CONFLICT (id) DO NOTHING`,
          [mutation.entityId, mutation.clientUpdatedAt, mutation.workspaceId, ...values],
        )
        return true
      }

      if (mutation.op === 'insert') {
        const placeholders = values.map((_, i) => `$${i + 4}`).join(', ')
        const insertHead = `INSERT INTO ${table} (id, updated_at, workspace_id, ${columns.join(', ')}) VALUES ($1, $2, $3, ${placeholders})`
        const insertParams = [mutation.entityId, mutation.clientUpdatedAt, mutation.workspaceId, ...values]
        const naturalKey = NATURAL_KEY_CONFLICT[mutation.table]
        if (naturalKey !== undefined) {
          // Issue 095 — a project-singleton table: upsert on the NATURAL key so a
          // cold-mirror client's fresh `id` reconciles onto the existing row and
          // the edit persists (LWW-by-arrival, the same unconditional semantics as
          // the update branch below), instead of 23505-ing on the secondary
          // unique index under a plain `ON CONFLICT (id) DO NOTHING`. Every
          // supplied column is re-set from EXCLUDED so the incoming edit wins.
          //
          // SECURITY (095 follow-up): because this DO UPDATE reconciles onto an
          // EXISTING row by the natural key (not the id), it could otherwise let a
          // caller overwrite ANOTHER tenant's row — the `insert` tenancy branch
          // (checkTenancy) only authorizes the DECLARED workspace, never the
          // target row's, and RLS is a no-op in prod. The
          // `WHERE <table>.workspace_id = EXCLUDED.workspace_id` guard makes a
          // cross-tenant collision a silent no-op (0 rows, no error): the update
          // only applies when the existing row already belongs to the declared
          // (already-authorized) workspace, so workspace_id can never be flipped
          // and no other tenant's singleton can be clobbered. Same-tenant edits
          // are unaffected (the predicate holds). The plain `ON CONFLICT (id)`
          // path below never had this exposure (a colliding id was DO NOTHING).
          const setClause = ['updated_at = EXCLUDED.updated_at', 'workspace_id = EXCLUDED.workspace_id']
            .concat(columns.map((c) => `${c} = EXCLUDED.${c}`))
            .join(', ')
          await client.query(
            `${insertHead} ON CONFLICT (${naturalKey}) DO UPDATE SET ${setClause} WHERE ${table}.workspace_id = EXCLUDED.workspace_id`,
            insertParams,
          )
          return true
        }
        await client.query(`${insertHead} ON CONFLICT (id) DO NOTHING`, insertParams)
        return true
      }

      // update
      const setClause = columns.map((c, i) => `${c} = $${i + 4}`).join(', ')
      // Issue 091 — for a NATURAL-KEY table (tier1_purpose) whose payload
      // carries the natural-key value, address the row by that natural key
      // (project_id), not the client-minted `id`, which may have diverged from
      // the server row's id after 095's insert-path reconciliation. Addressing
      // by `id` would UPDATE zero rows (the id isn't on the server) → the edit
      // is silently lost; addressing by project_id hits the real row. The
      // trailing `AND workspace_id = <declared>` guard is defense-in-depth
      // (mirrors 097's guard): even if tenancy were bypassed, a cross-tenant
      // row can never be overwritten (0 rows). `id` (the PK) is never in the
      // SET clause (SERVER_STAMPED drops it), so the server row keeps its own id.
      const natural = naturalKeyOf(mutation)
      if (natural !== null) {
        // Own parameter numbering (no unused `$1`): Postgres cannot infer the
        // type of a bind parameter that never appears in the SQL text, so the
        // client-minted `entityId` is dropped entirely here (the row is
        // addressed by its natural key, not its id). $1 updated_at, $2
        // workspace_id (SET + guard), $3.. the payload columns, and the trailing
        // param the natural-key value.
        const nkSetClause = columns.map((c, i) => `${c} = $${i + 3}`).join(', ')
        await client.query(
          `UPDATE ${table} SET workspace_id = $2, ${nkSetClause}, updated_at = $1 WHERE ${natural.sqlColumn} = $${values.length + 3} AND workspace_id = $2`,
          [mutation.clientUpdatedAt, mutation.workspaceId, ...values, natural.value],
        )
        return true
      }
      // Non-natural-key table (or the payload lacks the natural key) — address
      // by the row's `id` exactly as before.
      await client.query(`UPDATE ${table} SET workspace_id = $3, ${setClause}, updated_at = $2 WHERE id = $1`, [
        mutation.entityId,
        mutation.clientUpdatedAt,
        mutation.workspaceId,
        ...values,
      ])
      return true
    })
  }
}
