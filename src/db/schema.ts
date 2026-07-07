import {
  type AnyPgColumn,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Issue 034 (ADR-0010) — the tenancy unit. RLS policies (authored by hand in
// migration 0008, alongside this Drizzle-generated DDL) scope every
// workspace_id-bearing table below to the caller's memberships. See that
// migration file's header for exactly how PGlite stays permissive (table
// owner) while server Postgres enforces (a distinct, granted-not-owning
// `app_user` role).
export const workspaceRole = pgEnum('workspace_role', ['owner', 'editor', 'viewer'])

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// user_sub = the Cognito ID token's `sub` claim (ADR-0009) — the identity RLS
// keys off, not a local users table (there isn't one; Cognito is the identity
// store). Role is least-privilege (issue 035 grants it; defined here so RLS
// can read it now).
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userSub: text('user_sub').notNull(),
    role: workspaceRole('role').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [uniqueIndex('workspace_members_workspace_user_idx').on(table.workspaceId, table.userSub)],
)

// SPEC.md §3 — every row: UUIDv7 id, created_at/updated_at (LWW), deleted_at (soft delete).
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3/§4.6 — 1st Tier Foundation. A single purpose statement per
// project (one body row, enforced by the unique project_id index → setter
// upserts) plus ranked value-proposition rows. Table-based, mirroring the
// source Numbers document (issue 013); no linkage to tiers 2–3 in this slice.
export const tier1Purpose = pgTable(
  'tier1_purpose',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [uniqueIndex('tier1_purpose_project_idx').on(table.projectId)],
)

// SPEC.md §3/§4.6 — a ranked value proposition. `rank` is the 1-based priority
// rendered as degree notation (1°, 2°…, STYLE_GUIDE §3); `sort` is the 0-based
// storage order. In this tier they move together (drag re-ranks = reorders),
// but both columns are pinned by the SPEC data model. Re-rank / delete keep
// rank contiguous 1..k (issue 013 unit test).
export const tier1Props = pgTable('tier1_props', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  rank: integer('rank').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3/§4.6 — 2nd Tier UDS Architecture (issue 014). One table per
// intended dimension (the example ships Value / Stakeholders / Process; tables
// are addable/renamable). `sort` orders the tables on the page.
export const tier2Tables = pgTable('tier2_tables', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text('name').notNull(),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3/§4.6 — an architecture entry (row). Nests arbitrarily via a
// parent_id self-FK (null = a top-level row of its table); `sort` orders
// siblings within a parent. Selected entries promote into 3rd-Tier
// dimensions + parameters, each parameter keeping a source_entry_id
// back-reference (invariant 7 — tier linkage).
export const tier2Entries = pgTable('tier2_entries', {
  id: text('id').primaryKey(),
  tableId: text('table_id')
    .notNull()
    .references(() => tier2Tables.id),
  parentId: text('parent_id').references((): AnyPgColumn => tier2Entries.id),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3 — context_id null = root canvas; a context's child canvas gets its
// own rows (issue 011). Dimension count is pure row data: nothing encodes "3".
// source_param_id (issue 011) records which of the parent context's bound
// parameters seeded this child-canvas dimension — null on every root-canvas
// dimension, set on every seeded child one. It is how a re-drill maps a child
// dimension back to its parent binding (idempotent seeding) and how a parent
// re-bind is detected as stale (SPEC §3 data model, recursion rule invariant 3).
export const dimensions = pgTable('dimensions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  contextId: text('context_id').references((): AnyPgColumn => contexts.id),
  sourceParamId: text('source_param_id').references((): AnyPgColumn => parameters.id),
  name: text('name').notNull(),
  color: text('color').notNull(),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3 — an ordered point on a dimension. parent_param_id ships now so
// sub-parameters (recursion into a child canvas, issue 011) never need a
// migration later; there is no UI for it until that slice.
export const parameters = pgTable('parameters', {
  id: text('id').primaryKey(),
  dimensionId: text('dimension_id')
    .notNull()
    .references(() => dimensions.id),
  parentParamId: text('parent_param_id').references((): AnyPgColumn => parameters.id),
  // SPEC invariant 7 (issue 014) — the 2nd-Tier entry this parameter was
  // promoted from; null for parameters authored directly on the canvas. A
  // rename of the source entry propagates here; deleting the source requires
  // resolution (unlink → null, or delete this parameter). Never left dangling.
  sourceEntryId: text('source_entry_id').references(() => tier2Entries.id),
  name: text('name').notNull(),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3 — a design decision node. parent_id ships now (children live on
// the parent's child canvas, issue 011) but issue 004 only ever creates root
// contexts (parent_id null).
export const contexts = pgTable('contexts', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  parentId: text('parent_id').references((): AnyPgColumn => contexts.id),
  symbol: text('symbol').notNull(),
  name: text('name'),
  justification: text('justification'),
  sort: integer('sort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3 — the pair (context × dimension → parameter). A binding is a
// current-state pointer, not a history-bearing entity: rebinding upserts.
// Unbind (direct user action) still hard-deletes. Issue 032 (migration 0007)
// added `deleted_at` so the dimension-removal CASCADE specifically
// (`cascadeDeleteBindingsForDimension`, issue 007) could become a tombstone
// instead of a hard delete — sync (ElectricSQL) must be able to propagate a
// deletion as a row-delta, and a hard-deleted row emits no delta at all. See
// mutations.ts for exactly which paths tombstone vs. hard-delete.
// tuple_hash is denormalized onto every binding row of a context (all rows
// share the same value) so a duplicate-tuple lookup (invariant 2, issue 005+)
// is a single indexed scan; recomputed whenever any of the context's
// bindings change.
export const bindings = pgTable(
  'bindings',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id),
    dimensionId: text('dimension_id')
      .notNull()
      .references(() => dimensions.id),
    parameterId: text('parameter_id')
      .notNull()
      .references(() => parameters.id),
    tupleHash: text('tuple_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [uniqueIndex('bindings_context_dimension_idx').on(table.contextId, table.dimensionId)],
)
