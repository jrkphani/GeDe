import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
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
