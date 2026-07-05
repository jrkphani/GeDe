import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// SPEC.md §3 — every row: UUIDv7 id, created_at/updated_at (LWW), deleted_at (soft delete).
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
})
