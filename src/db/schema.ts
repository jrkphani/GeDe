import { type AnyPgColumn, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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
  contextId: text('context_id'), // FK lands with the contexts table (issue 004)
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
