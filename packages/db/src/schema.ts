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
  check,
  customType,
  index,
  uniqueIndex,
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
/** Migration 0007: how a share came to be (SHARE-01 link access). */
export const shareSource = pgEnum('share_source', ['invite', 'link']);

export type LinkAccess = (typeof linkAccess.enumValues)[number];
export type Permission = (typeof permission.enumValues)[number];
export type ColumnFormat = (typeof columnFormat.enumValues)[number];
export type GraphKind = (typeof graphKind.enumValues)[number];
export type ShareSource = (typeof shareSource.enumValues)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// 5.1 Authoritative
// ---------------------------------------------------------------------------

/** Created on first sign-in from the JWT. No credentials stored. */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cognitoSub: text('cognito_sub').notNull().unique('users_cognito_sub_key'),
    /**
     * Nullable: a Cognito *access* token carries no email claim; filled in when one is seen.
     * The constraint name is PostgreSQL's default for the inline UNIQUE in 0000 and is what
     * `services/sync/src/repo/pg.ts` matches on a collision (#42) — keep it explicit here.
     */
    email: citext('email').unique('users_email_key'),
    displayName: text('display_name'),
    /** I18N-05 (migration 0001): BCP 47 tag from the supported set; null until the user chooses. */
    locale: text('locale'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at'),
    /**
     * ONB-03 (migration 0009): when the account completed or skipped the guided tour; null
     * until then and again after Replay (ONB-08). Per account, never per device.
     */
    tourDoneAt: timestamptz('tour_done_at'),
    /**
     * Migration 0010 (#111, ADR-038): set by account erasure. The row stays as a tombstone —
     * email, display name, locale, tour and last-seen nulled — so the foreign keys that point at
     * it still resolve and the Cognito `sub` cannot come back as a fresh account.
     */
    deletedAt: timestamptz('deleted_at'),
    /**
     * LIB-05 (migration 0011, #133): the Browse / Shared sort the account chose, `name` or
     * `date` (`users_library_sort_check`); null until chosen. Per account, never per device.
     */
    librarySort: text('library_sort'),
  },
  (t) => [
    /** Migration 0011: the two library sorts and nothing else. */
    check(
      'users_library_sort_check',
      sql`${t.librarySort} IS NULL OR ${t.librarySort} IN ('name', 'date')`,
    ),
  ],
);

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
    /** LIB-D6 (migration 0008): archived by the owner; never expires. Never set with `deleted_at`. */
    archivedAt: timestamptz('archived_at'),
    /**
     * LIB-D2/D4 (migration 0008): true while the document has a participant or its link is on
     * (once it had one). Maintained by `services/sync` inside the share transactions; Delete is
     * refused while it is true.
     */
    everShared: boolean('ever_shared').notNull().default(false),
    /** LIB-D10 (migration 0008): the guided sample; exempt from Delete and Archive. */
    sample: boolean('sample').notNull().default(false),
  },
  (t) => [
    index('documents_owner_id_idx').on(t.ownerId),
    /** Migration 0008: the Archived view. */
    index('documents_archived_owner_idx')
      .on(t.ownerId)
      .where(sql`archived_at IS NOT NULL`),
    /** Migration 0009: one guided sample per owner (ONB-01); the seed is `ON CONFLICT DO NOTHING`. */
    uniqueIndex('documents_owner_sample_key')
      .on(t.ownerId)
      .where(sql`sample`),
    /** Migration 0008: archived or deleted, never both. */
    check('documents_archived_or_deleted_check', sql`archived_at IS NULL OR deleted_at IS NULL`),
    /** Migration 0010 (#114): the guided sample is never in the trash. */
    check('documents_sample_not_deleted_check', sql`NOT sample OR deleted_at IS NULL`),
  ],
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
    /** Migration 0007: `link` shares go when the link is switched off or re-minted. */
    source: shareSource('source').notNull().default('invite'),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.userId] }),
    index('shares_user_id_idx').on(t.userId),
  ],
);

/** For emails without an account yet; converts to a share on first sign-in (SHARE-02). */
export const invites = pgTable(
  'invites',
  {
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
    /** Migration 0006: who sent it; null on rows from before, converted as the owner. */
    invitedBy: uuid('invited_by').references(() => users.id),
    /** Migration 0006. */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    /** Migration 0004: the cascade from `documents` walks this index, not the table. */
    index('invites_document_id_idx').on(t.documentId),
    /** Migration 0006: the conversion on first sign-in looks invitations up by address. */
    index('invites_email_idx').on(t.email),
    /** Migration 0007: one pending invitation per address per document (idempotent POST). */
    uniqueIndex('invites_pending_key')
      .on(t.documentId, t.email)
      .where(sql`accepted_at IS NULL`),
  ],
);

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
export const sheets = pgTable(
  'sheets',
  {
    /** CRDT id (ULID). */
    id: text('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label').notNull(),
    parentContext: text('parent_context'),
  },
  /** Migration 0004: the projection is replaced per document, and search filters by it. */
  (t) => [index('sheets_document_id_idx').on(t.documentId)],
);

/** Lattice origin, so A1 addresses can be reconstructed server-side. */
export const tables = pgTable(
  'tables',
  {
    id: text('id').primaryKey(),
    sheetId: text('sheet_id')
      .notNull()
      .references(() => sheets.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    gridCol: integer('grid_col').notNull(),
    gridRow: integer('grid_row').notNull(),
    outline: text('outline'),
    options: jsonb('options').notNull().default({}),
  },
  (t) => [index('tables_sheet_id_idx').on(t.sheetId)],
);

/** `derived` holds the method and arguments of a pipeline step. */
export const columns = pgTable(
  'columns',
  {
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
  },
  (t) => [index('columns_table_id_idx').on(t.tableId)],
);

/** Hierarchy depth per PRD §4. */
export const rows = pgTable(
  'rows',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    depth: smallint('depth').notNull().default(0),
    collapsed: boolean('collapsed').notNull().default(false),
  },
  (t) => [index('rows_table_id_idx').on(t.tableId)],
);

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
  (t) => [
    primaryKey({ columns: [t.rowId, t.columnId] }),
    /** Migration 0004: `row_id` leads the primary key; the column cascade needs its own index. */
    index('cells_column_id_idx').on(t.columnId),
  ],
);

/** One row per half of a pair; `slice` stores row/column axes and pins. */
export const graphs = pgTable(
  'graphs',
  {
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
  },
  (t) => [index('graphs_sheet_id_idx').on(t.sheetId), index('graphs_table_id_idx').on(t.tableId)],
);

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
