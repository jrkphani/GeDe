/**
 * The Postgres repository against a real PostgreSQL. Needs `DATABASE_URL`
 * (a superuser or CREATEDB role on any database, e.g.
 * `postgres://gede:gede@127.0.0.1:5432/postgres`); each run creates a
 * throwaway database, applies every migration to it and drops it afterwards.
 * Without `DATABASE_URL` the suite is skipped — the fakes cover the logic,
 * this covers the SQL.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pino from 'pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  createTable,
  encodeSeededDocument,
  listSheets,
  openDocument,
  setCellText,
  tableById,
} from '@gede/core';
import { applyMigrations, createDb } from '@gede/db';

import { projectDocument } from '../projection/project.js';
import { createPgRepo } from './pg.js';
import type { Repo } from './types.js';

const adminUrl = process.env.DATABASE_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/migrations/', import.meta.url));

let admin: pg.Client;
let pool: pg.Pool;
let repo: Repo;
let dbName: string;

describe.skipIf(adminUrl === undefined)('pg repo against PostgreSQL (DATABASE_URL)', () => {
  beforeAll(async () => {
    if (adminUrl === undefined) return;
    dbName = `gede_test_${randomBytes(4).toString('hex')}`;
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await applyMigrations(pool, MIGRATIONS);
    repo = createPgRepo(createDb(pool), pino({ level: 'silent' }));
  });

  afterAll(async () => {
    if (adminUrl === undefined) return;
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  async function user(sub: string): Promise<string> {
    return (await repo.users.upsertFromToken({ sub, email: null })).id;
  }

  async function createDoc(ownerId: string, title: string, id: string = crypto.randomUUID()) {
    const bytes = encodeSeededDocument({ title });
    return repo.documents.create({
      id,
      ownerId,
      title,
      snapshot: { seq: 1, s3Key: `docs/${id}/1.yjs`, sizeBytes: bytes.byteLength },
    });
  }

  test('DOC-03 create writes the row, its seed snapshot pointer, the snapshots row and the audit row in one transaction', async () => {
    const owner = await user('sub-create');
    const doc = await createDoc(owner, 'Everest trek');
    expect(doc).toMatchObject({ snapshotKey: `docs/${doc.id}/1.yjs`, snapshotSeq: 1 });
    const audit = await pool.query(
      'select user_id, action from audit_log where document_id = $1 order by id',
      [doc.id],
    );
    expect(audit.rows).toEqual([{ user_id: owner, action: 'document.create' }]);
    const snapshot = await pool.query('select seq, s3_key from snapshots where document_id = $1', [
      doc.id,
    ]);
    expect(snapshot.rows).toEqual([{ seq: '1', s3_key: `docs/${doc.id}/1.yjs` }]);
    // The first client update lands at seq 2.
    const range = await repo.updates.append(doc.id, [
      { update: new Uint8Array([0]), authorId: owner },
    ]);
    expect(range).toEqual({ firstSeq: 2, lastSeq: 2 });

    // A duplicate id rolls the whole transaction back: no second audit or snapshot row.
    await expect(createDoc(owner, 'again', doc.id)).rejects.toThrow();
    const after = await pool.query(
      'select count(*)::int as n from audit_log where document_id = $1',
      [doc.id],
    );
    expect(after.rows[0]).toEqual({ n: 1 });
  });

  test('LIB-08 purgeExpired deletes only documents past retention, any owner, cascading and auditing with the system actor', async () => {
    const alice = await user('sub-alice');
    const bob = await user('sub-bob');
    const old = await createDoc(alice, 'old');
    const older = await createDoc(bob, 'older');
    const recent = await createDoc(alice, 'recent');
    const live = await createDoc(bob, 'live');
    await pool.query(`update documents set deleted_at = now() - interval '31 days' where id = $1`, [
      old.id,
    ]);
    await pool.query(
      `update documents set deleted_at = now() - interval '400 days' where id = $1`,
      [older.id],
    );
    await pool.query(`update documents set deleted_at = now() - interval '29 days' where id = $1`, [
      recent.id,
    ]);
    await pool.query(
      `insert into shares (document_id, user_id, permission, invited_by) values ($1, $2, 'view', $3)`,
      [old.id, bob, alice],
    );

    const removed: string[] = [];
    const removeObjects = (doc: { id: string }) => {
      removed.push(doc.id);
      return Promise.resolve(true);
    };
    const first = await repo.documents.purgeExpired({ limit: 1, exclude: [], removeObjects });
    expect(first).toEqual({ purged: [{ id: older.id, title: 'older' }], failed: [] }); // oldest first
    // An S3 failure keeps the document: rows intact, no audit row, reported as failed.
    const refused = await repo.documents.purgeExpired({
      limit: 10,
      exclude: [],
      removeObjects: () => Promise.resolve(false),
    });
    expect(refused).toEqual({ purged: [], failed: [{ id: old.id, title: 'old' }] });
    expect((await repo.documents.get(old.id))?.deletedAt).not.toBeNull();
    // Excluded documents are skipped; the retry then takes it.
    expect(
      await repo.documents.purgeExpired({ limit: 10, exclude: [old.id], removeObjects }),
    ).toEqual({ purged: [], failed: [] });
    const second = await repo.documents.purgeExpired({ limit: 10, exclude: [], removeObjects });
    expect(second).toEqual({ purged: [{ id: old.id, title: 'old' }], failed: [] });
    expect(removed).toEqual([older.id, old.id]);

    const remaining = await pool.query('select id from documents where owner_id = any($1)', [
      [alice, bob],
    ]);
    expect(remaining.rows.map((r: { id: string }) => r.id).sort()).toEqual(
      [live.id, recent.id].sort(),
    );
    const shares = await pool.query(
      'select count(*)::int as n from shares where document_id = $1',
      [old.id],
    );
    expect(shares.rows[0]).toEqual({ n: 0 });
    const snapshots = await pool.query(
      'select count(*)::int as n from snapshots where document_id = any($1)',
      [[old.id, older.id]],
    );
    expect(snapshots.rows[0]).toEqual({ n: 0 });
    const purges = await pool.query(
      `select document_id, user_id, target from audit_log where action = 'document.purge' order by id`,
    );
    expect(purges.rows).toEqual([
      { document_id: older.id, user_id: null, target: 'older' },
      { document_id: old.id, user_id: null, target: 'old' },
    ]);
  });

  test('FIND-03 projection.replace materialises a document and search uses the tsvector expression; a second replace drops stale rows', async () => {
    const owner = await user('sub-search');
    const doc = await createDoc(owner, 'Gear list');
    const y = new Y.Doc();
    Y.applyUpdate(y, encodeSeededDocument({ title: 'Gear list' }));
    const gd = openDocument(y);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 2, rows: 2 });
    const table = tableById(gd, tableId);
    const [r1, r2] = table?.rows ?? [];
    const [c1, c2] = table?.columns.map((c) => c.id) ?? [];
    if (!r1 || !r2 || !c1 || !c2) throw new Error('ids');
    setCellText(gd, tableId, r1, c1, 'Down jacket, summit push');
    setCellText(gd, tableId, r1, c2, '=Sum(B2:B3)');
    setCellText(gd, tableId, r2, c1, 'Crampons for the icefall');

    await repo.projection.replace(projectDocument(y, doc.id));
    const stored = await pool.query(
      `select c.text_plain, c.formula, c.rich from cells c join rows r on r.id = c.row_id join tables t on t.id = r.table_id join sheets s on s.id = t.sheet_id where s.document_id = $1 order by r.ordinal, c.column_id`,
      [doc.id],
    );
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows.find((r: { formula: string | null }) => r.formula !== null)).toMatchObject({
      text_plain: '=Sum(B2:B3)',
      rich: null,
    });

    // Every word must match ('simple' dictionary: lowercased, no stemming).
    expect(await repo.projection.search(doc.id, 'SUMMIT jacket', 50)).toEqual([
      { sheetId, tableId, rowId: r1, columnId: c1, textPlain: 'Down jacket, summit push' },
    ]);
    expect(await repo.projection.search(doc.id, 'sum', 50)).toEqual([
      { sheetId, tableId, rowId: r1, columnId: c2, textPlain: '=Sum(B2:B3)' },
    ]);
    expect(await repo.projection.search(doc.id, 'jackets', 50)).toEqual([]);
    expect(await repo.projection.search(crypto.randomUUID(), 'jacket', 50)).toEqual([]);
    const two = await repo.projection.search(doc.id, 'the', 1);
    expect(two).toHaveLength(1);

    // Rebuild after the cell was cleared: the old row is gone, nothing dangles.
    setCellText(gd, tableId, r2, c1, '');
    await repo.projection.replace(projectDocument(y, doc.id));
    expect(await repo.projection.search(doc.id, 'crampons', 50)).toEqual([]);
    const counts = await pool.query(
      `select (select count(*) from sheets where document_id = $1)::int as sheets, (select count(*) from cells c join rows r on r.id = c.row_id where r.table_id = $2)::int as cells`,
      [doc.id, tableId],
    );
    expect(counts.rows[0]).toEqual({ sheets: 1, cells: 2 });

    expect(await repo.projection.liveDocumentIds()).toContain(doc.id);
    await repo.documents.softDelete(doc.id);
    expect(await repo.projection.liveDocumentIds()).not.toContain(doc.id);
  });
});
