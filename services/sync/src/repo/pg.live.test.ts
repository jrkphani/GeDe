/**
 * The Postgres repository against a real PostgreSQL. Needs `DATABASE_URL`
 * (a superuser or CREATEDB+CREATEROLE role on any database, e.g.
 * `postgres://gede:gede@127.0.0.1:5432/postgres`); each run creates a
 * throwaway database, applies every migration to it and drops it afterwards.
 * Without `DATABASE_URL` the suite is skipped — the fakes cover the logic,
 * this covers the SQL.
 *
 * As in production (#36), the migrations run as the admin and bootstrap a
 * least-privilege role; `repo` and every query below then run as that role,
 * so a query that needs more than DML fails here before it fails in a task.
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
let appRole: { user: string; password: string };

describe.skipIf(adminUrl === undefined)('pg repo against PostgreSQL (DATABASE_URL)', () => {
  beforeAll(async () => {
    if (adminUrl === undefined) return;
    dbName = `gede_test_${randomBytes(4).toString('hex')}`;
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    appRole = { user: `${dbName}_app`, password: randomBytes(12).toString('hex') };
    const migrator = new pg.Pool({ connectionString: url.toString(), max: 1 });
    await applyMigrations(migrator, MIGRATIONS, { appRole });
    await migrator.end();
    url.username = appRole.user;
    url.password = appRole.password;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    repo = createPgRepo(createDb(pool), pino({ level: 'silent' }));
  });

  afterAll(async () => {
    if (adminUrl === undefined) return;
    await pool.end();
    // The role's default privileges live in the database; drop that first.
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole.user}`);
    await admin.end();
  });

  test('SHARE-03 the runtime role is DML-only: no DDL, no TRUNCATE, no ledger writes, no superuser attributes (#36)', async () => {
    const attrs = await pool.query<Record<string, boolean>>(
      'select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(attrs.rows[0]).toEqual({
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    for (const statement of [
      'create table live_probe (id int)',
      'alter table users add column live_probe int',
      'truncate audit_log',
      "insert into __migrations (name) values ('live_probe')",
      'drop table doc_updates',
    ]) {
      await expect(pool.query(statement), statement).rejects.toThrow(
        /permission denied|must be owner/,
      );
    }
    // Read-only on the ledger is still readable.
    const ledger = await pool.query<{ n: number }>('select count(*)::int as n from __migrations');
    expect(ledger.rows[0]?.n).toBeGreaterThanOrEqual(6);
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

  test('LOAD-06 commitSnapshot is monotonic under the row lock: a stale commit is refused and prunes nothing (#39)', async () => {
    const owner = await user('sub-monotonic');
    const doc = await createDoc(owner, 'Two tasks');
    await repo.updates.append(
      doc.id,
      [2, 3, 4, 5].map((n) => ({ update: new Uint8Array([n]), authorId: owner })),
    );
    expect(
      await repo.updates.commitSnapshot({
        documentId: doc.id,
        seq: 5,
        s3Key: 'k5',
        sizeBytes: 1,
        coversFrom: 1,
        appended: 4,
      }),
    ).toBe(true);
    expect(
      await repo.updates.commitSnapshot({
        documentId: doc.id,
        seq: 3,
        s3Key: 'k3',
        sizeBytes: 1,
        coversFrom: 1,
        appended: 2,
      }),
    ).toBe(false);
    expect(
      await repo.updates.commitSnapshot({
        documentId: doc.id,
        seq: 5,
        s3Key: 'k5b',
        sizeBytes: 1,
        coversFrom: 1,
        appended: 4,
      }),
    ).toBe(false);
    const row = await pool.query('select snapshot_key, snapshot_seq from documents where id = $1', [
      doc.id,
    ]);
    expect(row.rows[0]).toEqual({ snapshot_key: 'k5', snapshot_seq: '5' });
    const snaps = await pool.query(
      'select seq from snapshots where document_id = $1 order by seq',
      [doc.id],
    );
    expect(snaps.rows.map((r: { seq: string }) => r.seq)).toEqual(['1', '5']);

    // In the other order the log above the newest snapshot survives the older commit.
    const other = await createDoc(owner, 'Other order');
    await repo.updates.append(
      other.id,
      [2, 3, 4, 5].map((n) => ({ update: new Uint8Array([n]), authorId: owner })),
    );
    await repo.updates.commitSnapshot({
      documentId: other.id,
      seq: 3,
      s3Key: 'o3',
      sizeBytes: 1,
      coversFrom: 1,
      appended: 2,
    });
    const tail = await repo.updates.loadState(other.id);
    expect(tail.updates.map((u) => u.seq)).toEqual([4, 5]);
  });

  test('LOAD-06 two tasks committing at once serialise on the row lock: the newer snapshot wins whichever order the lock hands out (#39)', async () => {
    const owner = await user('sub-concurrent');
    const doc = await createDoc(owner, 'Deploy overlap');
    await repo.updates.append(
      doc.id,
      [2, 3, 4, 5].map((n) => ({ update: new Uint8Array([n]), authorId: owner })),
    );
    // A third session holds the document row so both commits are open and
    // waiting at the same time; releasing it lets PostgreSQL pick the order.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [doc.id]);
    // Task A appended 2..5 (loaded at the seed, seq 1); task B loaded when the
    // log reached 3 and appended nothing since.
    const newer = repo.updates.commitSnapshot({
      documentId: doc.id,
      seq: 5,
      s3Key: 'c5',
      sizeBytes: 1,
      coversFrom: 1,
      appended: 4,
    });
    const older = repo.updates.commitSnapshot({
      documentId: doc.id,
      seq: 3,
      s3Key: 'c3',
      sizeBytes: 1,
      coversFrom: 3,
      appended: 0,
    });
    // Both transactions are blocked on the row before the holder lets go.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiting = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'",
    );
    expect(waiting.rows[0]).toEqual({ n: 2 });
    await holder.query('COMMIT');
    holder.release();
    const [newerCommitted, olderCommitted] = await Promise.all([newer, older]);

    // Exactly one commit lands, whichever the lock handed out first: if A's
    // (seq 5) went first, B's is stale; if B's (seq 3) went first, A's is
    // refused because a snapshot it never saw now covers rows it would
    // supersede (#39 residual) — A's room reloads rather than prune blind.
    expect(newerCommitted).not.toBe(olderCommitted);
    const winner = newerCommitted ? { key: 'c5', seq: '5' } : { key: 'c3', seq: '3' };
    const row = await pool.query('select snapshot_key, snapshot_seq from documents where id = $1', [
      doc.id,
    ]);
    expect(row.rows[0]).toEqual({ snapshot_key: winner.key, snapshot_seq: winner.seq });
    const snaps = await pool.query(
      'select seq from snapshots where document_id = $1 order by seq',
      [doc.id],
    );
    expect(snaps.rows.map((r: { seq: string }) => r.seq)).toEqual(['1', winner.seq]);
    // The log is pruned to the winner and nothing above it is lost.
    expect((await repo.updates.loadState(doc.id)).updates.map((u) => u.seq)).toEqual(
      newerCommitted ? [] : [4, 5],
    );
  });

  test('LIB-08 recover honours the 30-day window; recover-all audits every document it recovers (#42)', async () => {
    const owner = await user('sub-recover');
    const fresh = await createDoc(owner, 'fresh');
    const stale = await createDoc(owner, 'stale');
    const other = await createDoc(owner, 'other');
    await pool.query(`update documents set deleted_at = now() - interval '2 days' where id = $1`, [
      fresh.id,
    ]);
    await pool.query(`update documents set deleted_at = now() - interval '31 days' where id = $1`, [
      stale.id,
    ]);
    await pool.query(`update documents set deleted_at = now() - interval '3 days' where id = $1`, [
      other.id,
    ]);
    expect(await repo.documents.recover(stale.id)).toBeUndefined();
    expect((await repo.documents.recover(fresh.id))?.deletedAt).toBeNull();

    const recovered = await repo.documents.recoverAllDeleted(owner, owner);
    expect(recovered.map((d) => d.id)).toEqual([other.id]);
    const audit = await pool.query(
      `select document_id, user_id from audit_log where action = 'document.recover' and document_id = any($1) order by id`,
      [[fresh.id, stale.id, other.id]],
    );
    // recover() leaves the audit row to the route; recover-all writes its own in the transaction.
    expect(audit.rows).toEqual([{ document_id: other.id, user_id: owner }]);
    const still = await pool.query<{ deleted_at: Date | null }>(
      'select deleted_at from documents where id = $1',
      [stale.id],
    );
    expect(still.rows[0]?.deleted_at).not.toBeNull();
    // Leave nothing past retention behind for the purge test below.
    await pool.query('delete from documents where id = $1', [stale.id]);
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
