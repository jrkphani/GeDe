import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';

import * as schema from './schema.js';

const dir = new URL('../migrations', import.meta.url).pathname;
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const allSql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

/** Strip SQL comments so a word inside a comment cannot satisfy or fail a check. */
function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

describe('migrations', () => {
  test('LOAD-06 files are numbered, ordered and non-empty', () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((name, i) => {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(name.startsWith(String(i).padStart(4, '0'))).toBe(true);
      expect(readFileSync(join(dir, name), 'utf8').trim().length).toBeGreaterThan(0);
    });
  });

  test('LOAD-06 no migration drops data: a constraint may go, nothing that holds rows may', () => {
    for (const name of files) {
      const body = stripComments(readFileSync(join(dir, name), 'utf8'));
      expect(body, name).not.toMatch(/\bDROP\s+(?!CONSTRAINT\b)/i);
      expect(body, name).not.toMatch(/\bTRUNCATE\b/i);
      expect(body, name).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  test('LIB-08 0001, 0002 and 0003 follow 0000 and carry the library columns and the audit fix', () => {
    expect(files.slice(0, 4)).toEqual([
      '0000_init.sql',
      '0001_users_locale.sql',
      '0002_documents_created_at.sql',
      '0003_audit_log_keeps_purged.sql',
    ]);
    const locale = stripComments(readFileSync(join(dir, '0001_users_locale.sql'), 'utf8'));
    expect(locale).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text/);
    const created = stripComments(readFileSync(join(dir, '0002_documents_created_at.sql'), 'utf8'));
    expect(created).toMatch(
      /ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now\(\)/,
    );
    const audit = stripComments(readFileSync(join(dir, '0003_audit_log_keeps_purged.sql'), 'utf8'));
    expect(audit).toMatch(
      /ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_document_id_fkey/,
    );
    // 0000 is shipped and must stay byte-for-byte what production ran: it still
    // declares the cascade that 0003 removes.
    const init = stripComments(readFileSync(join(dir, '0000_init.sql'), 'utf8'));
    const auditTable = /CREATE TABLE IF NOT EXISTS audit_log \(([^;]*)\);/s.exec(init)?.[1] ?? '';
    expect(auditTable).toMatch(
      /document_id uuid NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/,
    );
  });

  test('LOAD-06 0000_init creates the ledger, the citext extension and every enum', () => {
    const init = stripComments(readFileSync(join(dir, '0000_init.sql'), 'utf8'));
    expect(init).toMatch(/CREATE TABLE IF NOT EXISTS __migrations/);
    expect(init).toMatch(/CREATE EXTENSION IF NOT EXISTS citext/);
    for (const e of [schema.linkAccess, schema.permission, schema.columnFormat, schema.graphKind]) {
      const values = e.enumValues.map((v) => `'${v}'`).join(', ');
      expect(init).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${values})`);
    }
  });

  test('LOAD-06 every table and column in schema.ts exists in the migrations', () => {
    const tables: PgTable[] = [
      schema.users,
      schema.documents,
      schema.shares,
      schema.invites,
      schema.docUpdates,
      schema.snapshots,
      schema.sheets,
      schema.tables,
      schema.columns,
      schema.rows,
      schema.cells,
      schema.graphs,
      schema.auditLog,
      schema.mailEvents,
      schema.mailSuppressions,
    ];
    const sql = stripComments(allSql);
    for (const table of tables) {
      const name = getTableName(table);
      const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([^;]*)\\);`, 's').exec(sql);
      expect(match, `table ${name}`).not.toBeNull();
      const body = match?.[1] ?? '';
      // A column is declared either in the CREATE TABLE body (0000) or by a
      // later `ALTER TABLE <name> ADD COLUMN IF NOT EXISTS <column>` (0001+).
      const added = [
        ...sql.matchAll(new RegExp(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS (\\w+)\\s`, 'g')),
      ].map((m) => m[1]);
      for (const column of Object.values(getTableColumns(table))) {
        const inBody = new RegExp(`^\\s*${column.name}\\s`, 'm').test(body);
        expect(inBody || added.includes(column.name), `${name}.${column.name}`).toBe(true);
      }
    }
  });

  test('LOAD-06 0004 indexes every cascading foreign key and 0005 adds the ledger checksum (#42)', () => {
    expect(files.slice(4, 6)).toEqual(['0004_fk_indexes.sql', '0005_migrations_checksum.sql']);
    const fk = stripComments(readFileSync(join(dir, '0004_fk_indexes.sql'), 'utf8'));
    for (const [idx, table, column] of [
      ['invites_document_id_idx', 'invites', 'document_id'],
      ['sheets_document_id_idx', 'sheets', 'document_id'],
      ['tables_sheet_id_idx', 'tables', 'sheet_id'],
      ['columns_table_id_idx', 'columns', 'table_id'],
      ['rows_table_id_idx', 'rows', 'table_id'],
      ['cells_column_id_idx', 'cells', 'column_id'],
      ['graphs_sheet_id_idx', 'graphs', 'sheet_id'],
      ['graphs_table_id_idx', 'graphs', 'table_id'],
    ]) {
      expect(fk).toContain(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table} (${column})`);
    }
    const checksum = stripComments(readFileSync(join(dir, '0005_migrations_checksum.sql'), 'utf8'));
    expect(checksum).toMatch(/ALTER TABLE __migrations ADD COLUMN IF NOT EXISTS checksum text/);
  });

  test('SHARE-02 0006 records the inviter and the send time on invites and indexes the address the conversion looks up', () => {
    expect(files[6]).toBe('0006_invites_inviter.sql');
    const sql = stripComments(readFileSync(join(dir, '0006_invites_inviter.sql'), 'utf8'));
    expect(sql).toMatch(
      /ALTER TABLE invites ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users\(id\)/,
    );
    expect(sql).toMatch(
      /ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now\(\)/,
    );
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS invites_email_idx ON invites (email)');
  });

  test('SHARE-01 0007 adds shares.source (invite | link) and one pending invitation per address per document', () => {
    expect(files[7]).toBe('0007_share_source_invite_pending_key.sql');
    const sql = stripComments(
      readFileSync(join(dir, '0007_share_source_invite_pending_key.sql'), 'utf8'),
    );
    expect(sql).toMatch(/CREATE TYPE share_source AS ENUM \('invite', 'link'\)/);
    expect(sql).toMatch(
      /ALTER TABLE shares ADD COLUMN IF NOT EXISTS source share_source NOT NULL DEFAULT 'invite'/,
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS invites_pending_key ON invites (document_id, email) WHERE accepted_at IS NULL',
    );
  });

  test('LIB-D11 LIB-D10 0008 makes archive and trash document states: archived_at, ever_shared, sample, never both archived and deleted, and backfills ever_shared from shares and the link', () => {
    expect(files[8]).toBe('0008_documents_archive_ever_shared_sample.sql');
    const sql = stripComments(
      readFileSync(join(dir, '0008_documents_archive_ever_shared_sample.sql'), 'utf8'),
    );
    expect(sql).toMatch(/ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at timestamptz/);
    expect(sql).toMatch(
      /ALTER TABLE documents ADD COLUMN IF NOT EXISTS ever_shared boolean NOT NULL DEFAULT false/,
    );
    expect(sql).toMatch(
      /ALTER TABLE documents ADD COLUMN IF NOT EXISTS sample boolean NOT NULL DEFAULT false/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT documents_archived_or_deleted_check\s+CHECK \(archived_at IS NULL OR deleted_at IS NULL\)/,
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS documents_archived_owner_idx ON documents (owner_id) WHERE archived_at IS NOT NULL',
    );
    // The backfill sets the flag; it never clears one and never touches other columns.
    expect(sql).toMatch(/UPDATE documents d\s+SET ever_shared = true/);
    expect(sql).toMatch(/link_access <> 'none'/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM shares s WHERE s\.document_id = d\.id\)/);
    expect(sql).not.toMatch(/SET ever_shared = false/);
  });

  test('ONB-03 ONB-01 0009 adds users.tour_done_at and one guided sample per owner', () => {
    expect(files[9]).toBe('0009_users_tour_done_at_sample_key.sql');
    const sql = stripComments(
      readFileSync(join(dir, '0009_users_tour_done_at_sample_key.sql'), 'utf8'),
    );
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_done_at timestamptz/);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_sample_key ON documents (owner_id) WHERE sample',
    );
    // Additive only: nothing about existing rows changes.
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });

  test('LIB-D10 SHARE-01 0010 forbids a sample in the trash (recovering any first), adds users.deleted_at for erasure, and makes link-chain shares link shares', () => {
    expect(files[10]).toBe('0010_sample_never_deleted_users_deleted_at_link_chain.sql');
    const sql = stripComments(
      readFileSync(join(dir, '0010_sample_never_deleted_users_deleted_at_link_chain.sql'), 'utf8'),
    );
    // Recover before the CHECK: the migration must never fail on a row it could fix.
    expect(sql.indexOf('SET deleted_at = NULL')).toBeLessThan(
      sql.indexOf('documents_sample_not_deleted_check'),
    );
    expect(sql).toMatch(/WHERE sample AND deleted_at IS NOT NULL/);
    expect(sql).toMatch(
      /ADD CONSTRAINT documents_sample_not_deleted_check\s+CHECK \(NOT sample OR deleted_at IS NULL\)/,
    );
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
    // The chain walk starts at link shares and follows invited_by; it only ever promotes to link.
    expect(sql).toMatch(/WITH RECURSIVE chain AS/);
    expect(sql).toMatch(/WHERE s\.source = 'link'/);
    expect(sql).toMatch(/s\.invited_by = c\.user_id/);
    expect(sql).toMatch(/SET source = 'link'/);
    expect(sql).not.toMatch(/SET source = 'invite'/);
    // Both CHECKs are declared in schema.ts under the names the SQL uses.
    const checks = getTableConfig(schema.documents).checks.map((c) => c.name);
    expect(checks).toEqual(
      expect.arrayContaining([
        'documents_archived_or_deleted_check',
        'documents_sample_not_deleted_check',
      ]),
    );
  });

  test('LIB-05 SHARE-02 0011 adds users.library_sort, checked to name or date, and invites.mail_sent_at, additively; the CHECK is declared in schema.ts (#133, #121)', () => {
    expect(files[11]).toBe('0011_users_library_sort_invites_mail_sent_at.sql');
    const sql = stripComments(
      readFileSync(join(dir, '0011_users_library_sort_invites_mail_sent_at.sql'), 'utf8'),
    );
    expect(sql).toMatch(/ALTER TABLE invites ADD COLUMN IF NOT EXISTS mail_sent_at timestamptz/);
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS library_sort text/);
    expect(sql).toMatch(
      /ADD CONSTRAINT users_library_sort_check\s+CHECK \(library_sort IS NULL OR library_sort IN \('name', 'date'\)\)/,
    );
    expect(sql).not.toMatch(/\bUPDATE\b/);
    expect(getTableConfig(schema.users).checks.map((c) => c.name)).toEqual([
      'users_library_sort_check',
    ]);
  });

  test('SHARE-02 0012 adds mail_events (one row per SES message id and recipient, kinds checked) and mail_suppressions (citext address, reason checked), additively; both CHECKs are declared in schema.ts (ADR-046)', () => {
    expect(files[12]).toBe('0012_mail_events_suppressions.sql');
    const sql = stripComments(readFileSync(join(dir, '0012_mail_events_suppressions.sql'), 'utf8'));
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS mail_events \(/);
    expect(sql).toMatch(/PRIMARY KEY \(message_id, email\)/);
    expect(sql).toMatch(/email\s+citext\s+NOT NULL/);
    expect(sql).toMatch(
      /CONSTRAINT mail_events_kind_check\s+CHECK \(kind IN \('bounce_permanent', 'bounce_transient', 'complaint', 'reject'\)\)/,
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS mail_events_email_at_idx ON mail_events (email, at)',
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS mail_suppressions \(/);
    expect(sql).toMatch(/email\s+citext\s+PRIMARY KEY/);
    expect(sql).toMatch(
      /CONSTRAINT mail_suppressions_reason_check CHECK \(reason IN \('bounce', 'complaint'\)\)/,
    );
    expect(sql).not.toMatch(/\bUPDATE\b/);
    expect(sql).not.toMatch(/\bALTER TABLE\b/);
    expect(getTableConfig(schema.mailEvents).checks.map((c) => c.name)).toEqual([
      'mail_events_kind_check',
    ]);
    expect(getTableConfig(schema.mailSuppressions).checks.map((c) => c.name)).toEqual([
      'mail_suppressions_reason_check',
    ]);
    // The kinds and reasons the service writes are the ones the CHECKs admit.
    expect([...schema.MAIL_EVENT_KINDS]).toEqual([
      'bounce_permanent',
      'bounce_transient',
      'complaint',
      'reject',
    ]);
    expect([...schema.MAIL_SUPPRESSION_REASONS]).toEqual(['bounce', 'complaint']);
  });

  test('LOAD-06 every index declared in schema.ts exists in the migrations', () => {
    const sql = stripComments(allSql);
    const declared = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
      (m) => m[1],
    );
    for (const table of [
      schema.documents,
      schema.shares,
      schema.invites,
      schema.sheets,
      schema.tables,
      schema.columns,
      schema.rows,
      schema.cells,
      schema.graphs,
      schema.auditLog,
      schema.mailEvents,
      schema.mailSuppressions,
    ]) {
      const config = getTableConfig(table);
      for (const idx of config.indexes) {
        expect(declared, `${config.name}.${idx.config.name ?? '?'}`).toContain(idx.config.name);
      }
    }
    // The unique constraints pg.ts relies on by name (#42).
    const users = getTableColumns(schema.users);
    expect(users.email.uniqueName).toBe('users_email_key');
    expect(users.cognitoSub.uniqueName).toBe('users_cognito_sub_key');
  });

  test('LOAD-06 the required indexes are declared', () => {
    const sql = stripComments(allSql);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS documents_owner_id_idx ON documents \(owner_id\)/,
    );
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS shares_user_id_idx ON shares \(user_id\)/);
    expect(sql).toMatch(/PRIMARY KEY \(document_id, seq\)/);
    expect(sql).toMatch(/USING GIN \(to_tsvector\('simple', text_plain\)\)/);
    expect(sql).toMatch(/audit_log_document_id_at_idx ON audit_log \(document_id, at\)/);
  });
});
