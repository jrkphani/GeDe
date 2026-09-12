/**
 * Relational schema — ARCHITECTURE-DIGEST §1.5, verbatim table set.
 *
 * Two layers. The *authoritative* tables hold identity, access control, the
 * Yjs update log and snapshot history. The *projection* tables are a
 * rebuildable materialisation of the CRDT for search, audit and reporting;
 * nothing in them is written by users directly.
 *
 * This file is the typed mirror of `migrations/*.sql`. The SQL is what runs;
 * never edit a database directly (root CLAUDE.md). Use `npm run generate` to
 * draft a migration after changing this file, then review it by hand.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom column types
// ---------------------------------------------------------------------------

/** Case-insensitive text (`citext` extension) for email addresses. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** Binary Yjs updates. `pg` returns `bytea` as a Node Buffer, which is a `Uint8Array`. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const linkAccess = pgEnum('link_access', ['none', 'view', 'edit']);
export const permission = pgEnum('permission', ['view', 'edit']);
export const columnFormat = pgEnum('column_format', ['auto', 'text', 'number', 'currency', 'date']);
export const graphKind = pgEnum('graph_kind', ['ring', 'coverage']);

export type LinkAccess = (typeof linkAccess.enumValues)[number];
export type Permission = (typeof permission.enumValues)[number];
export type ColumnFormat = (typeof columnFormat.enumValues)[number];
export type GraphKind = (typeof graphKind.enumValues)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// 5.1 Authoritative
// ---------------------------------------------------------------------------

/** Created on first sign-in from the JWT. No credentials stored. */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  cognitoSub: text('cognito_sub').notNull().unique(),
  /** Nullable: a Cognito *access* token carries no email claim; filled in when one is seen. */
  email: citext('email').unique(),
  displayName: text('display_name'),
  /** I18N-05 (migration 0001): BCP 47 tag from the supported set; null until the user chooses. */
  locale: text('locale'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  lastSeenAt: timestamptz('last_seen_at'),
});

/** One row per workbook. `snapshot_key` points into S3 `docs`. */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull().default('Untitled'),
    linkAccess: linkAccess('link_access').notNull().default('none'),
    linkToken: text('link_token').unique(),
    snapshotKey: text('snapshot_key'),
    snapshotSeq: bigint('snapshot_seq', { mode: 'number' }).notNull().default(0),
    /** LIB-02 (migration 0002). */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [index('documents_owner_id_idx').on(t.ownerId)],
);

/** The participant list in the share sheet. Owner is implicit edit. */
export const shares = pgTable(
  'shares',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: permission('permission').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.userId] }),
    index('shares_user_id_idx').on(t.userId),
  ],
);

/** For emails without an account yet; converts to a share on first sign-in (SHARE-02). */
export const invites = pgTable('invites', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  email: citext('email').notNull(),
  permission: permission('permission').notNull(),
  token: text('token').notNull().unique(),
  expiresAt: timestamptz('expires_at').notNull(),
  acceptedAt: timestamptz('accepted_at'),
});

/** Yjs update log since the last snapshot. Pruned after compaction. */
export const docUpdates = pgTable(
  'doc_updates',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    update: bytea('update').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.seq] })],
);

/** History of compactions; enables point-in-time restore of a document. */
export const snapshots = pgTable(
  'snapshots',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    s3Key: text('s3_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.seq] })],
);

// ---------------------------------------------------------------------------
// 5.2 Projection (rebuildable)
// ---------------------------------------------------------------------------

/** Child sheets record the graph context they were opened from. */
export const sheets = pgTable('sheets', {
  /** CRDT id (ULID). */
  id: text('id').primaryKey(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  label: text('label').notNull(),
  parentContext: text('parent_context'),
});

/** Lattice origin, so A1 addresses can be reconstructed server-side. */
export const tables = pgTable('tables', {
  id: text('id').primaryKey(),
  sheetId: text('sheet_id')
    .notNull()
    .references(() => sheets.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  gridCol: integer('grid_col').notNull(),
  gridRow: integer('grid_row').notNull(),
  outline: text('outline'),
  options: jsonb('options').notNull().default({}),
});

/** `derived` holds the method and arguments of a pipeline step. */
export const columns = pgTable('columns', {
  id: text('id').primaryKey(),
  tableId: text('table_id')
    .notNull()
    .references(() => tables.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  label: text('label').notNull(),
  widthUnits: integer('width_units').notNull(),
  format: columnFormat('format').notNull().default('auto'),
  formatOpts: jsonb('format_opts').notNull().default({}),
  derived: jsonb('derived'),
  hidden: boolean('hidden').notNull().default(false),
});

/** Hierarchy depth per PRD §4. */
export const rows = pgTable('rows', {
  id: text('id').primaryKey(),
  tableId: text('table_id')
    .notNull()
    .references(() => tables.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  depth: smallint('depth').notNull().default(0),
  collapsed: boolean('collapsed').notNull().default(false),
});

/**
 * Search and audit only; the CRDT remains the source of truth. The GIN index on
 * `to_tsvector('simple', text_plain)` is declared in `migrations/0000_init.sql`
 * (an expression index drizzle cannot express in the table builder).
 */
export const cells = pgTable(
  'cells',
  {
    rowId: text('row_id')
      .notNull()
      .references(() => rows.id, { onDelete: 'cascade' }),
    columnId: text('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    textPlain: text('text_plain').notNull().default(''),
    rich: jsonb('rich'),
    formula: text('formula'),
    refTarget: text('ref_target'),
    style: jsonb('style'),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.columnId] })],
);

/** One row per half of a pair; `slice` stores row/column axes and pins. */
export const graphs = pgTable('graphs', {
  id: text('id').primaryKey(),
  sheetId: text('sheet_id')
    .notNull()
    .references(() => sheets.id, { onDelete: 'cascade' }),
  pairId: text('pair_id').notNull(),
  kind: graphKind('kind').notNull(),
  tableId: text('table_id')
    .notNull()
    .references(() => tables.id, { onDelete: 'cascade' }),
  dimensionColumns: text('dimension_columns').array().notNull().default([]),
  gridCol: integer('grid_col').notNull(),
  gridRow: integer('grid_row').notNull(),
  widthUnits: integer('width_units').notNull(),
  heightUnits: integer('height_units').notNull(),
  slice: jsonb('slice'),
});

/**
 * Share changes, deletes, restores, purges. Partitioned monthly once volume warrants.
 * `document_id` deliberately has no foreign key (migration 0003): a
 * `document.purge` row must survive the row it describes.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id').notNull(),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    target: text('target'),
    at: timestamptz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_document_id_at_idx').on(t.documentId, t.at)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type DocUpdate = typeof docUpdates.$inferSelect;
export type NewDocUpdate = typeof docUpdates.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type Sheet = typeof sheets.$inferSelect;
export type Table = typeof tables.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type Row = typeof rows.$inferSelect;
export type Cell = typeof cells.$inferSelect;
export type Graph = typeof graphs.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
