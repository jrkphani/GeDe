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
  projects: {},
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
