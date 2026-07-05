import {
  type AnyPgColumn,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// SPEC.md §3 — every row: UUIDv7 id, created_at/updated_at (LWW), deleted_at (soft delete).
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})

// SPEC.md §3 — context_id null = root canvas; a context's child canvas gets its
// own rows (issue 011). Dimension count is pure row data: nothing encodes "3".
export const dimensions = pgTable('dimensions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  contextId: text('context_id').references((): AnyPgColumn => contexts.id),
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
// current-state pointer, not a history-bearing entity: rebinding upserts,
// unbinding hard-deletes — no deleted_at (unlike every other table).
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
  },
  (table) => [uniqueIndex('bindings_context_dimension_idx').on(table.contextId, table.dimensionId)],
)
