// Normalizes ElectricSQL's shape-stream wire protocol into this app's own
// RowDelta (src/domain/syncDelta.ts). This is the ONLY module that knows
// Electric's message shape — everything downstream (the merge engine, the
// mutation queue, the PGlite apply layer, src/db/sync.ts) is Electric-agnostic
// and drives entirely off RowDelta, so a future engine swap (031's revisit
// trigger, ADR-0008) only touches this file + syncEngine.ts's subscription
// wiring.
//
// Modeled against `@electric-sql/client` (a real dependency of this package,
// not guessed): a `ChangeMessage` carries `{ key, value, headers: {
// operation } }` where `value` is the row's CURRENT full snapshot, keyed by
// the table's actual SQL (snake_case) column names — Electric streams
// Postgres rows verbatim, it does not know about Drizzle's camelCase JS
// naming. A `ControlMessage` (`up-to-date`, `must-refetch`, …) carries no row
// and is filtered out here (syncEngine.ts owns reacting to those).
//
// No live Electric server is reachable in this repo's tests (HANDOFF) — this
// module is exercised entirely with fixtures modeling that real wire shape
// (electricProtocol.test.ts), never a live connection.
import type { RowDelta, TableName } from '../domain/syncDelta'

export type ElectricOperation = 'insert' | 'update' | 'delete'

// A minimal structural subset of @electric-sql/client's `ChangeMessage` /
// `ControlMessage` union (`Message<T>`) — only the fields this module reads.
// Defined locally rather than importing the library's generic type so the
// normalizer's input stays simple to construct in tests.
export interface ElectricChangeMessage {
  readonly key: string
  readonly value: Readonly<Record<string, unknown>>
  readonly headers: { readonly operation: ElectricOperation }
}

export interface ElectricControlMessage {
  readonly headers: {
    readonly control: 'up-to-date' | 'must-refetch' | 'snapshot-end' | 'subset-end'
  }
}

export type ElectricMessage = ElectricChangeMessage | ElectricControlMessage

export function isElectricChangeMessage(message: ElectricMessage): message is ElectricChangeMessage {
  return 'operation' in message.headers
}

// Every schema.ts column, SQL (snake_case) name -> the camelCase JS field name
// Drizzle infers — mirrors schema.ts column-for-column, the same convention
// src/domain/projectEnvelope.ts already follows for its own row shapes (a
// third independent mirror is the established pattern here, not a DRY
// violation by this repo's own standard — see projectEnvelope.ts's header).
const SQL_TO_JS_COLUMNS: Record<TableName, Record<string, string>> = {
  projects: {
    id: 'id',
    workspace_id: 'workspaceId',
    name: 'name',
    description: 'description',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  tier1_purpose: {
    id: 'id',
    project_id: 'projectId',
    workspace_id: 'workspaceId',
    body: 'body',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  tier1_props: {
    id: 'id',
    project_id: 'projectId',
    workspace_id: 'workspaceId',
    rank: 'rank',
    name: 'name',
    description: 'description',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  tier2_tables: {
    id: 'id',
    project_id: 'projectId',
    workspace_id: 'workspaceId',
    name: 'name',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  tier2_entries: {
    id: 'id',
    table_id: 'tableId',
    parent_id: 'parentId',
    name: 'name',
    description: 'description',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  dimensions: {
    id: 'id',
    project_id: 'projectId',
    workspace_id: 'workspaceId',
    context_id: 'contextId',
    source_param_id: 'sourceParamId',
    name: 'name',
    color: 'color',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  parameters: {
    id: 'id',
    dimension_id: 'dimensionId',
    parent_param_id: 'parentParamId',
    source_entry_id: 'sourceEntryId',
    name: 'name',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  contexts: {
    id: 'id',
    project_id: 'projectId',
    workspace_id: 'workspaceId',
    parent_id: 'parentId',
    symbol: 'symbol',
    name: 'name',
    justification: 'justification',
    sort: 'sort',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  bindings: {
    id: 'id',
    context_id: 'contextId',
    dimension_id: 'dimensionId',
    parameter_id: 'parameterId',
    tuple_hash: 'tupleHash',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  // Issue 056 filled these in ahead of subscription so TableName's map stays
  // exhaustive (src/domain/syncDelta.ts). `invitations` joined SYNCED_TABLES
  // for real in issue 062 (the email-scoped invitee-discovery fix) and now
  // uses this mapping on every inbound delta; `workspace_members` remains
  // unsubscribed (058/062's own scope note — the shape-proxy resolves
  // memberships via a direct query instead, see src/server/shapeProxy/
  // albAdapter.ts), so its entry here stays exercised only by direct unit
  // tests, not live traffic.
  invitations: {
    id: 'id',
    workspace_id: 'workspaceId',
    email: 'email',
    role: 'role',
    invited_by_sub: 'invitedBySub',
    expires_at: 'expiresAt',
    accepted_at: 'acceptedAt',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
  workspace_members: {
    id: 'id',
    workspace_id: 'workspaceId',
    user_sub: 'userSub',
    role: 'role',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    deleted_at: 'deletedAt',
  },
}

export class MalformedElectricMessageError extends Error {
  constructor(reason: string) {
    super(`Malformed Electric change message: ${reason}`)
    this.name = 'MalformedElectricMessageError'
  }
}

function toCamelRow(table: TableName, sqlRow: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const map = SQL_TO_JS_COLUMNS[table]
  const out: Record<string, unknown> = {}
  for (const [sqlKey, value] of Object.entries(sqlRow)) {
    const jsKey = map[sqlKey]
    // Unknown columns are dropped, not thrown on — Electric may add
    // protocol-internal columns over time; the derived-state guard
    // (syncDelta.ts's assertBaseColumnsOnly) is the one place that must
    // reject an unexpected column, and only for columns that made it into
    // OUR camelCase vocabulary, not Electric's wire vocabulary.
    if (jsKey) out[jsKey] = value
  }
  return out
}

// Normalize one Electric message for a known table into a RowDelta, or null
// for a control message (nothing to apply — `up-to-date` etc. only advance
// the stream's own "caught up" bookkeeping, owned by syncEngine.ts).
export function toRowDelta(table: TableName, message: ElectricMessage): RowDelta | null {
  if (!isElectricChangeMessage(message)) return null
  const row = toCamelRow(table, message.value)
  const { id, updatedAt } = row
  if (typeof id !== 'string') {
    throw new MalformedElectricMessageError(`row ${message.key} on "${table}" has no "id"`)
  }
  if (typeof updatedAt !== 'string') {
    throw new MalformedElectricMessageError(`row ${message.key} on "${table}" has no "updated_at"`)
  }
  return { table, id, row, updatedAt }
}

export function toRowDeltas(table: TableName, messages: readonly ElectricMessage[]): RowDelta[] {
  const deltas: RowDelta[] = []
  for (const message of messages) {
    const delta = toRowDelta(table, message)
    if (delta) deltas.push(delta)
  }
  return deltas
}
