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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pino from 'pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  createGraphPair,
  createTable,
  encodeSampleWorkscape,
  encodeSeededDocument,
  listSheets,
  openDocument,
  SAMPLE_TITLE,
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

    // GRAPH-01: a bound pair projects into `graphs`, one row per half.
    const pair = createGraphPair(gd, { sheetId, tableId });

    await repo.projection.replace(projectDocument(y, doc.id));
    const stored = await pool.query(
      `select c.text_plain, c.formula, c.rich from cells c join rows r on r.id = c.row_id join tables t on t.id = r.table_id join sheets s on s.id = t.sheet_id where s.document_id = $1 order by r.ordinal, c.column_id`,
      [doc.id],
    );
    expect(stored.rows).toHaveLength(3);
    const storedGraphs = await pool.query(
      `select id, pair_id, kind, table_id, dimension_columns, slice from graphs where sheet_id = $1 order by id`,
      [sheetId],
    );
    expect(storedGraphs.rows).toEqual([
      {
        id: pair.ringId,
        pair_id: pair.pairId,
        kind: 'ring',
        table_id: tableId,
        dimension_columns: [c1, c2],
        slice: { rowAxis: null, colAxis: null, pins: {} },
      },
      {
        id: pair.coverageId,
        pair_id: pair.pairId,
        kind: 'coverage',
        table_id: tableId,
        dimension_columns: [c1, c2],
        slice: { rowAxis: null, colAxis: null, pins: {} },
      },
    ]);
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

  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  async function inviteRow(input: {
    documentId: string;
    email: string;
    permission: 'view' | 'edit';
    token: string;
    invitedBy: string;
    expiresAt?: Date;
  }) {
    return repo.invites.create({ expiresAt: inDays(14), ...input });
  }

  test('SHARE-01 SHARE-03 shares: add once, change permission, remove, stop sharing — each with its audit row, as the app role', async () => {
    const owner = await user('sub-share-owner');
    const editor = await user('sub-share-editor');
    const viewer = await user('sub-share-viewer');
    const doc = await createDoc(owner, 'Shared trek');

    expect(
      await repo.shares.add({
        documentId: doc.id,
        userId: editor,
        permission: 'edit',
        invitedBy: owner,
        actorId: owner,
      }),
    ).toBe(true);
    // A second add for the same person changes nothing (the route answers 409).
    expect(
      await repo.shares.add({
        documentId: doc.id,
        userId: editor,
        permission: 'view',
        invitedBy: owner,
        actorId: owner,
      }),
    ).toBe(false);
    expect(await repo.documents.sharePermission(doc.id, editor)).toBe('edit');
    await repo.shares.add({
      documentId: doc.id,
      userId: viewer,
      permission: 'view',
      invitedBy: editor,
      actorId: editor,
    });

    expect(
      await repo.shares.setPermission({
        documentId: doc.id,
        userId: viewer,
        permission: 'edit',
        actorId: owner,
      }),
    ).toBe(true);
    expect(
      await repo.shares.setPermission({
        documentId: doc.id,
        userId: crypto.randomUUID(),
        permission: 'edit',
        actorId: owner,
      }),
    ).toBe(false);
    expect(await repo.shares.remove({ documentId: doc.id, userId: viewer, actorId: owner })).toBe(
      true,
    );
    expect(await repo.shares.remove({ documentId: doc.id, userId: viewer, actorId: owner })).toBe(
      false,
    );

    const list = await repo.documents.participants(doc.id);
    expect(list?.participants.map((p) => [p.userId, p.permission, p.invitedBy, p.source])).toEqual([
      [editor, 'edit', owner, 'invite'],
    ]);

    await inviteRow({
      documentId: doc.id,
      email: 'pending@example.com',
      permission: 'view',
      token: 'tok-stop',
      invitedBy: owner,
    });
    expect(await repo.shares.stop({ documentId: doc.id, actorId: owner })).toEqual([editor]);
    const after = await repo.documents.participants(doc.id);
    expect(after?.participants).toEqual([]);
    expect(after?.invites).toEqual([]);
    expect(after?.linkAccess).toBe('none');

    const audit = await pool.query<{ action: string; target: string | null }>(
      'select action, target from audit_log where document_id = $1 order by id',
      [doc.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'document.create',
      'share.add',
      'share.add',
      'share.permission',
      'share.remove',
      'share.invite',
      'share.stop',
    ]);
    expect(audit.rows[3]).toEqual({ action: 'share.permission', target: `${viewer}:edit` });
    // The stop row names who lost access (review of #76).
    expect(JSON.parse(audit.rows[6]?.target ?? '{}')).toEqual({
      users: [editor],
      invites: ['pending@example.com'],
    });
  });

  test('SHARE-01 link access: a fresh token on every level the link is switched to, link shares labelled and revoked with the link, an explicit share never lowered (review of #76)', async () => {
    const owner = await user('sub-link-owner');
    const guest = await user('sub-link-guest');
    const editor = await user('sub-link-editor');
    const doc = await createDoc(owner, 'Linked trek');
    let minted = 0;
    const mintToken = () => `link-${String(++minted)}`;
    const setLink = (access: 'none' | 'view' | 'edit') =>
      repo.shares.setLinkAccess({ documentId: doc.id, access, actorId: owner, mintToken });

    const on = await setLink('view');
    expect(on?.document).toMatchObject({ linkAccess: 'view', linkToken: 'link-1' });
    expect(on?.revoked).toEqual([]);
    expect(
      await repo.shares.setLinkAccess({
        documentId: crypto.randomUUID(),
        access: 'edit',
        actorId: owner,
        mintToken,
      }),
    ).toBeUndefined();

    // A wrong token grants nothing; the right one grants the link's level once, as a `link` share.
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-9' }),
    ).toBeUndefined();
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-1' }),
    ).toBe('view');
    expect(await repo.documents.sharePermission(doc.id, guest)).toBe('view');
    expect(
      (await repo.documents.participants(doc.id))?.participants.map((p) => [p.userId, p.source]),
    ).toEqual([[guest, 'link']]);
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: owner, token: 'link-1' }),
    ).toBe('view');
    expect(await repo.documents.sharePermission(doc.id, owner)).toBeUndefined();

    // view → edit re-mints: the distributed view link never becomes an edit
    // link, and whoever came in through it is no longer a participant.
    await repo.shares.add({
      documentId: doc.id,
      userId: editor,
      permission: 'edit',
      invitedBy: owner,
      actorId: owner,
    });
    const raised = await setLink('edit');
    expect(raised?.document.linkToken).toBe('link-2');
    expect(raised?.revoked).toEqual([guest]);
    expect(await repo.documents.sharePermission(doc.id, guest)).toBeUndefined();
    expect(await repo.documents.sharePermission(doc.id, editor)).toBe('edit');
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-1' }),
    ).toBeUndefined();
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-2' }),
    ).toBe('edit');
    // Setting the same level again changes nothing and revokes nobody.
    const same = await setLink('edit');
    expect(same?.document.linkToken).toBe('link-2');
    expect(same?.revoked).toEqual([]);
    expect(await repo.documents.sharePermission(doc.id, guest)).toBe('edit');

    // The link at `view` never lowers an explicit editor.
    const lowered = await setLink('view');
    expect(lowered?.document.linkToken).toBe('link-3');
    expect(lowered?.revoked).toEqual([guest]);
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: editor, token: 'link-3' }),
    ).toBe('edit');
    await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-3' });

    // Off: link shares go, invited ones stay, the old token is dead.
    const off = await setLink('none');
    expect(off?.revoked).toEqual([guest]);
    expect(await repo.documents.sharePermission(doc.id, guest)).toBeUndefined();
    expect(await repo.documents.sharePermission(doc.id, editor)).toBe('edit');
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: guest, token: 'link-3' }),
    ).toBeUndefined();
    const again = await setLink('view');
    expect(again?.document.linkToken).toBe('link-4');
    const list = await repo.documents.participants(doc.id);
    expect(list).toMatchObject({ linkAccess: 'view', linkToken: 'link-4' });
    const audit = await pool.query<{ action: string; target: string | null; user_id: string }>(
      "select action, target, user_id from audit_log where document_id = $1 and action like 'share.link%' order by id",
      [doc.id],
    );
    expect(audit.rows).toEqual([
      { action: 'share.link', target: 'view', user_id: owner },
      { action: 'share.link_redeem', target: 'view', user_id: guest },
      { action: 'share.link', target: 'edit', user_id: owner },
      { action: 'share.link_revoke', target: guest, user_id: owner },
      { action: 'share.link_redeem', target: 'edit', user_id: guest },
      { action: 'share.link', target: 'edit', user_id: owner },
      { action: 'share.link', target: 'view', user_id: owner },
      { action: 'share.link_revoke', target: guest, user_id: owner },
      { action: 'share.link_redeem', target: 'view', user_id: guest },
      { action: 'share.link', target: 'none', user_id: owner },
      { action: 'share.link_revoke', target: guest, user_id: owner },
      { action: 'share.link', target: 'view', user_id: owner },
    ]);
  });

  test('SHARE-02 an invitation converts to a share when the address is bound — by the ID-token path (bindEmail) and by a token that carries the email — and expires after 14 days', async () => {
    const owner = await user('sub-invite-owner');
    const doc = await createDoc(owner, 'Invited trek');
    const other = await createDoc(owner, 'Second trek');

    const first = await inviteRow({
      documentId: doc.id,
      email: 'Sembian@Example.com',
      permission: 'edit',
      token: 'tok-1',
      invitedBy: owner,
    });
    expect(first.created).toBe(true);
    expect(first.invite).toMatchObject({ email: 'Sembian@Example.com', permission: 'edit' });
    // Idempotent per (document, address), case-insensitively (review of #76):
    // a repeated invite returns the one that stands — same row, same token,
    // the first permission — and writes nothing.
    const again = await inviteRow({
      documentId: doc.id,
      email: 'sembian@example.com',
      permission: 'view',
      token: 'tok-2',
      invitedBy: owner,
    });
    expect(again.created).toBe(false);
    expect(again.invite).toMatchObject({ id: first.invite.id, token: 'tok-1', permission: 'edit' });
    expect(await repo.invites.byToken('tok-2')).toBeUndefined();
    const pending = await repo.documents.participants(doc.id);
    expect(pending?.invites.map((i) => [i.email, i.permission, i.invitedBy])).toEqual([
      ['Sembian@Example.com', 'edit', owner],
    ]);
    // `invites_pending_key` refuses a second pending row for the pair outright.
    await expect(
      pool.query(
        "insert into invites (document_id, email, permission, token, expires_at, invited_by) values ($1, 'SEMBIAN@example.com', 'view', 'tok-dup', now() + interval '1 day', $2)",
        [doc.id, owner],
      ),
    ).rejects.toThrow(/invites_pending_key/);
    // An expired invitation is neither listed nor converted, and a fresh one replaces it.
    const stale = await inviteRow({
      documentId: other.id,
      email: 'sembian@example.com',
      permission: 'edit',
      token: 'tok-expired',
      expiresAt: new Date(Date.now() - 1000),
      invitedBy: owner,
    });
    expect(stale.created).toBe(true);
    expect((await repo.documents.participants(other.id))?.invites).toEqual([]);

    // First sign-in: the access token carries no email (this pool), the row is
    // created without one, then the ID token binds it — and the share appears.
    const sembian = await repo.users.upsertFromToken({ sub: 'sub-sembian', email: null });
    expect(sembian.email).toBeNull();
    expect(await repo.documents.sharePermission(doc.id, sembian.id)).toBeUndefined();
    const bound = await repo.users.bindEmail(sembian.id, 'SEMBIAN@example.com');
    expect(bound?.user.email).toBe('SEMBIAN@example.com');
    expect(bound?.converted).toEqual([{ documentId: doc.id, permission: 'edit' }]);
    expect(await repo.documents.sharePermission(doc.id, sembian.id)).toBe('edit');
    expect(await repo.documents.sharePermission(other.id, sembian.id)).toBeUndefined();
    const share = await pool.query<{ invited_by: string; source: string }>(
      'select invited_by, source from shares where document_id = $1 and user_id = $2',
      [doc.id, sembian.id],
    );
    expect(share.rows[0]).toEqual({ invited_by: owner, source: 'invite' });
    expect((await repo.invites.byToken('tok-1'))?.acceptedAt).toBeInstanceOf(Date);
    // Binding again is a no-op that converts nothing new; a different address is left as is.
    expect((await repo.users.bindEmail(sembian.id, 'sembian@example.com'))?.converted).toEqual([]);
    const kept = await repo.users.bindEmail(sembian.id, 'else@example.com');
    expect(kept?.user.email).toBe('SEMBIAN@example.com');
    expect(await repo.users.bindEmail(crypto.randomUUID(), 'x@example.com')).toBeUndefined();
    // The email lookup (the invite route's "already an account?") reads the same
    // columns, sample id included (ONB-01), case-insensitively.
    expect(await repo.users.findByEmail('sembian@EXAMPLE.com')).toMatchObject({
      id: sembian.id,
      sampleDocumentId: null,
    });
    // `users_email_key`: the address cannot be bound to a second account.
    const rival = await repo.users.upsertFromToken({ sub: 'sub-rival', email: null });
    await expect(repo.users.bindEmail(rival.id, 'sembian@example.com')).rejects.toThrow(
      'email already registered',
    );
    expect((await repo.users.findByEmail('sembian@EXAMPLE.com'))?.id).toBe(sembian.id);

    // The other path: a token that carries the verified address converts on upsert
    // (the expired row for this address went when the fresh one was inserted).
    const fresh = await inviteRow({
      documentId: other.id,
      email: 'meena@example.com',
      permission: 'edit',
      token: 'tok-3',
      invitedBy: owner,
    });
    expect(fresh.created).toBe(true);
    const meena = await repo.users.upsertFromToken({
      sub: 'sub-meena',
      email: 'meena@example.com',
    });
    expect(await repo.documents.sharePermission(other.id, meena.id)).toBe('edit');
    // And the explicit accept-by-token path, for the invitation link, refuses another account.
    await inviteRow({
      documentId: doc.id,
      email: 'meena@example.com',
      permission: 'view',
      token: 'tok-4',
      invitedBy: owner,
    });
    const tok4 = await repo.invites.byToken('tok-4');
    expect(await repo.invites.accept({ inviteId: tok4!.id, userId: sembian.id })).toBeUndefined();
    expect(await repo.invites.accept({ inviteId: tok4!.id, userId: meena.id })).toBe('view');
    expect(await repo.invites.accept({ inviteId: tok4!.id, userId: meena.id })).toBeUndefined();
    expect(await repo.documents.sharePermission(doc.id, meena.id)).toBe('view');
    // Withdrawing: only a pending invitation on this document.
    const tok5 = await inviteRow({
      documentId: doc.id,
      email: 'late@example.com',
      permission: 'view',
      token: 'tok-5',
      invitedBy: owner,
    });
    expect(
      await repo.invites.remove({ documentId: other.id, inviteId: tok5.invite.id, actorId: owner }),
    ).toBe(false);
    expect(
      await repo.invites.remove({ documentId: doc.id, inviteId: tok5.invite.id, actorId: owner }),
    ).toBe(true);
    const audit = await pool.query<{ action: string; target: string | null }>(
      "select action, target from audit_log where document_id = $1 and action like 'share.invite%' order by id",
      [doc.id],
    );
    expect(audit.rows).toEqual([
      { action: 'share.invite', target: 'Sembian@Example.com' },
      { action: 'share.invite_accept', target: 'SEMBIAN@example.com' },
      { action: 'share.invite', target: 'meena@example.com' },
      { action: 'share.invite_accept', target: 'meena@example.com' },
      { action: 'share.invite', target: 'late@example.com' },
      { action: 'share.invite_remove', target: 'late@example.com' },
    ]);
  });

  test('SHARE-02 SHARE-03 an invitation is only as good as its inviter: a removed or demoted editor’s invitations are withdrawn at conversion, not converted (review of #76)', async () => {
    const owner = await user('sub-stale-owner');
    const editor = await user('sub-stale-editor');
    const doc = await createDoc(owner, 'Stale trek');
    await repo.shares.add({
      documentId: doc.id,
      userId: editor,
      permission: 'edit',
      invitedBy: owner,
      actorId: owner,
    });
    // Four invitations by the editor: two to convert on sign-in, two through the mail link.
    for (const [email, token, permission] of [
      ['a@example.com', 'tok-a', 'edit'],
      ['b@example.com', 'tok-b', 'view'],
      ['c@example.com', 'tok-c', 'edit'],
      ['d@example.com', 'tok-d', 'view'],
    ] as const) {
      await inviteRow({ documentId: doc.id, email, permission, token, invitedBy: editor });
    }
    // And one by the owner, which always stands.
    await inviteRow({
      documentId: doc.id,
      email: 'a@example.com',
      permission: 'view',
      token: 'tok-a-owner',
      invitedBy: owner,
    }).then((r) => {
      expect(r.created).toBe(false); // a@ already has a pending invitation on this document
    });
    const otherDoc = await createDoc(owner, 'Owner trek');
    await inviteRow({
      documentId: otherDoc.id,
      email: 'a@example.com',
      permission: 'edit',
      token: 'tok-a-other',
      invitedBy: owner,
    });

    // The editor is demoted to view: their `edit` invitations are no longer
    // theirs to give; their `view` ones still are.
    await repo.shares.setPermission({
      documentId: doc.id,
      userId: editor,
      permission: 'view',
      actorId: owner,
    });
    const a = await repo.users.upsertFromToken({ sub: 'sub-a', email: 'a@example.com' });
    expect(await repo.documents.sharePermission(doc.id, a.id)).toBeUndefined();
    expect(await repo.documents.sharePermission(otherDoc.id, a.id)).toBe('edit');
    const b = await repo.users.upsertFromToken({ sub: 'sub-b', email: 'b@example.com' });
    expect(await repo.documents.sharePermission(doc.id, b.id)).toBe('view');
    const bShare = await pool.query<{ invited_by: string }>(
      'select invited_by from shares where document_id = $1 and user_id = $2',
      [doc.id, b.id],
    );
    expect(bShare.rows[0]).toEqual({ invited_by: editor });

    // The editor is removed: even a `view` invitation of theirs is withdrawn, on the link path too.
    await repo.shares.remove({ documentId: doc.id, userId: editor, actorId: owner });
    const c = await repo.users.upsertFromToken({ sub: 'sub-c', email: null });
    await repo.users.bindEmail(c.id, 'c@example.com');
    expect(await repo.documents.sharePermission(doc.id, c.id)).toBeUndefined();
    const d = await repo.users.upsertFromToken({ sub: 'sub-d', email: null });
    await pool.query('update users set email = $2 where id = $1', [d.id, 'd@example.com']);
    const tokD = await repo.invites.byToken('tok-d');
    expect(await repo.invites.accept({ inviteId: tokD!.id, userId: d.id })).toBeUndefined();
    expect(await repo.documents.sharePermission(doc.id, d.id)).toBeUndefined();
    expect(await repo.invites.byToken('tok-d')).toBeUndefined();
    expect((await repo.documents.participants(doc.id))?.invites).toEqual([]);

    const audit = await pool.query<{
      action: string;
      target: string | null;
      user_id: string | null;
    }>(
      "select action, target, user_id from audit_log where document_id = $1 and action in ('share.invite_withdraw', 'share.invite_accept') order by id",
      [doc.id],
    );
    expect(audit.rows).toEqual([
      { action: 'share.invite_withdraw', target: `a@example.com:${editor}`, user_id: null },
      { action: 'share.invite_accept', target: 'b@example.com', user_id: b.id },
      { action: 'share.invite_withdraw', target: `c@example.com:${editor}`, user_id: null },
      { action: 'share.invite_withdraw', target: `d@example.com:${editor}`, user_id: d.id },
    ]);
  });

  test('LIB-D2 LIB-D4 ever_shared follows the shares in SQL: set by add, redeem, accept and the conversion, or the link on; cleared when the last share goes and the link is off; never by an invitation sent', async () => {
    const owner = await user('sub-es-owner');
    const bob = await user('sub-es-bob');
    const doc = await createDoc(owner, 'Deletable until shared');
    const flag = async () =>
      (
        await pool.query<{ ever_shared: boolean }>(
          'select ever_shared from documents where id = $1',
          [doc.id],
        )
      ).rows[0]?.ever_shared;
    expect(await flag()).toBe(false);

    // An invitation sent sets nothing.
    const invite = await repo.invites.create({
      documentId: doc.id,
      email: 'dana@example.com',
      permission: 'edit',
      token: 'tok-es-dana',
      expiresAt: new Date(Date.now() + 60_000),
      invitedBy: owner,
    });
    expect(await flag()).toBe(false);
    // Accepted: set. Dana binds the address first (the accept checks it in SQL).
    const danaRow = await repo.users.upsertFromToken({ sub: 'sub-es-dana', email: null });
    await repo.users.bindEmail(danaRow.id, 'dana@example.com');
    // Binding converts the pending invitation on the spot (SHARE-02), so the flag is set here.
    expect(await flag()).toBe(true);
    expect(
      await repo.invites.accept({ inviteId: invite.invite.id, userId: danaRow.id }),
    ).toBeUndefined();

    // Removing the last participant, with the link off, clears it.
    expect(
      await repo.shares.remove({ documentId: doc.id, userId: danaRow.id, actorId: owner }),
    ).toBe(true);
    expect(await flag()).toBe(false);

    // A person with an account named in the sheet: set on the spot.
    await repo.shares.add({
      documentId: doc.id,
      userId: bob,
      permission: 'view',
      invitedBy: owner,
      actorId: owner,
    });
    expect(await flag()).toBe(true);
    // Link on while Bob holds a share, then Bob removed: the link keeps it shared.
    await repo.shares.setLinkAccess({
      documentId: doc.id,
      access: 'view',
      actorId: owner,
      mintToken: () => 'tok-es-link',
    });
    await repo.shares.remove({ documentId: doc.id, userId: bob, actorId: owner });
    expect(await flag()).toBe(true);
    // Link off with nobody left: deletable again.
    await repo.shares.setLinkAccess({
      documentId: doc.id,
      access: 'none',
      actorId: owner,
      mintToken: () => 'unused',
    });
    expect(await flag()).toBe(false);

    // Link switched on alone counts as shared (LIB-D1: "no active share link").
    const change = await repo.shares.setLinkAccess({
      documentId: doc.id,
      access: 'edit',
      actorId: owner,
      mintToken: () => 'tok-es-link-2',
    });
    expect(change?.document.everShared).toBe(true);
    // Redeemed by Bob, then the link goes: his link share goes with it and the flag clears.
    expect(
      await repo.shares.redeemLink({ documentId: doc.id, userId: bob, token: 'tok-es-link-2' }),
    ).toBe('edit');
    await repo.shares.setLinkAccess({
      documentId: doc.id,
      access: 'none',
      actorId: owner,
      mintToken: () => 'unused',
    });
    expect(await repo.documents.sharePermission(doc.id, bob)).toBeUndefined();
    expect(await flag()).toBe(false);

    // Stop sharing clears it outright.
    await repo.shares.add({
      documentId: doc.id,
      userId: bob,
      permission: 'edit',
      invitedBy: owner,
      actorId: owner,
    });
    await repo.shares.setLinkAccess({
      documentId: doc.id,
      access: 'view',
      actorId: owner,
      mintToken: () => 'tok-es-link-3',
    });
    expect(await flag()).toBe(true);
    await repo.shares.stop({ documentId: doc.id, actorId: owner });
    expect(await flag()).toBe(false);

    // The listing carries the flag and the new columns.
    const [row] = await repo.documents.listForUser(owner, 'browse');
    expect(row).toMatchObject({ id: doc.id, everShared: false, archivedAt: null, sample: false });
  });

  test('LIB-D2 LIB-D4 ever_shared and Delete are serialised on the document row: removing the last participant while another is being accepted keeps the flag, and Delete waits for the acceptance and is refused', async () => {
    const owner = await user('sub-lock-owner');
    const alice = await user('sub-lock-alice');
    const bob = await user('sub-lock-bob');
    const doc = await createDoc(owner, 'Contended');
    const flag = async () =>
      (
        await pool.query<{ ever_shared: boolean }>(
          'select ever_shared from documents where id = $1',
          [doc.id],
        )
      ).rows[0]?.ever_shared;
    const settles = (p: Promise<unknown>) =>
      Promise.race([
        p.then(() => 'settled'),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('waiting');
          }, 400);
        }),
      ]);
    await repo.shares.add({
      documentId: doc.id,
      userId: alice,
      permission: 'view',
      invitedBy: owner,
      actorId: owner,
    });
    expect(await flag()).toBe(true);

    // Another task is between inserting Bob's share and committing — what
    // `accept`, the sign-in conversion and `redeemLink` look like mid-flight.
    // All it holds on `documents` is the foreign key's KEY SHARE lock.
    const other = await pool.connect();
    try {
      await other.query('begin');
      await other.query(
        `insert into shares (document_id, user_id, permission, invited_by, source) values ($1, $2, 'view', $3, 'invite')`,
        [doc.id, bob, owner],
      );
      // The owner removes Alice, the last committed share. Unserialised, this
      // evaluated "no share remains" on a snapshot that cannot see Bob and
      // committed ever_shared = false beside his share.
      const removal = repo.shares.remove({ documentId: doc.id, userId: alice, actorId: owner });
      expect(await settles(removal)).toBe('waiting');
      await other.query('commit');
      expect(await removal).toBe(true);
      expect(await flag()).toBe(true);
      expect(await repo.documents.sharePermission(doc.id, bob)).toBe('view');

      // Back to deletable, then Delete lands while a second acceptance is in flight.
      await repo.shares.remove({ documentId: doc.id, userId: bob, actorId: owner });
      expect(await flag()).toBe(false);
      await other.query('begin');
      await other.query(
        `insert into shares (document_id, user_id, permission, invited_by, source) values ($1, $2, 'view', $3, 'invite')`,
        [doc.id, bob, owner],
      );
      await other.query(
        'update documents set ever_shared = true where id = $1 and ever_shared = false',
        [doc.id],
      );
      const deletion = repo.documents.tryDelete(doc.id);
      expect(await settles(deletion)).toBe('waiting');
      await other.query('commit');
      expect(await deletion).toEqual({ status: 'shared' });
      expect((await repo.documents.get(doc.id))?.deletedAt).toBeNull();
    } finally {
      other.release();
    }

    // The guard itself: shared and sample answer by name, a deletable row goes.
    await repo.shares.stop({ documentId: doc.id, actorId: owner });
    await pool.query('update documents set sample = true where id = $1', [doc.id]);
    expect(await repo.documents.tryDelete(doc.id)).toEqual({ status: 'sample' });
    await pool.query('update documents set sample = false where id = $1', [doc.id]);
    const deleted = await repo.documents.tryDelete(doc.id);
    expect(deleted).toMatchObject({ status: 'deleted', document: { id: doc.id } });
    expect(await repo.documents.tryDelete(doc.id)).toEqual({ status: 'missing' });
    expect(await repo.documents.tryDelete(crypto.randomUUID())).toEqual({ status: 'missing' });
  });

  test('LIB-D3 LIB-D5 LIB-D6 archive and unarchive: the owner’s views hide an archived row, a participant’s do not, delete clears the archive (CHECK: never both), purgeExpired never touches an archived row', async () => {
    const owner = await user('sub-arch-owner');
    const bob = await user('sub-arch-bob');
    const doc = await createDoc(owner, 'Archived trek');
    await repo.shares.add({
      documentId: doc.id,
      userId: bob,
      permission: 'view',
      invitedBy: owner,
      actorId: owner,
    });
    const idsFor = async (
      userId: string,
      view: 'recents' | 'browse' | 'shared' | 'deleted' | 'archived',
    ) => (await repo.documents.listForUser(userId, view)).map((d) => d.id);

    const archived = await repo.documents.archive(doc.id);
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect(archived?.updatedAt.getTime()).toBe(doc.updatedAt.getTime());
    expect(await repo.documents.archive(doc.id)).toBeUndefined();
    for (const view of ['recents', 'browse', 'shared'] as const) {
      expect(await idsFor(owner, view), `owner ${view}`).toEqual([]);
    }
    expect(await idsFor(owner, 'archived')).toEqual([doc.id]);
    expect(await idsFor(owner, 'deleted')).toEqual([]);
    expect(await idsFor(bob, 'recents')).toEqual([doc.id]);
    expect(await idsFor(bob, 'shared')).toEqual([doc.id]);
    expect(await idsFor(bob, 'archived')).toEqual([]);
    expect(await repo.documents.sharePermission(doc.id, bob)).toBe('view');

    // The CHECK: a row cannot be archived and deleted at once.
    await expect(
      pool.query('update documents set deleted_at = now() where id = $1', [doc.id]),
    ).rejects.toThrow(/documents_archived_or_deleted_check/);
    // softDelete clears the archive as it sets deleted_at.
    const deleted = await repo.documents.softDelete(doc.id);
    expect(deleted).toMatchObject({ archivedAt: null });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(await idsFor(owner, 'archived')).toEqual([]);
    expect(await idsFor(owner, 'deleted')).toEqual([doc.id]);
    expect(await repo.documents.unarchive(doc.id)).toBeUndefined();
    expect(await repo.documents.recover(doc.id)).toMatchObject({
      archivedAt: null,
      deletedAt: null,
    });

    // Unarchive restores the owner's views.
    await repo.documents.archive(doc.id);
    expect(await repo.documents.unarchive(doc.id)).toMatchObject({ archivedAt: null });
    expect(await repo.documents.unarchive(doc.id)).toBeUndefined();
    expect(await idsFor(owner, 'browse')).toEqual([doc.id]);

    // Archive has no expiry: an old archive is not a purge candidate.
    await repo.documents.archive(doc.id);
    await pool.query(
      "update documents set archived_at = now() - interval '400 days' where id = $1",
      [doc.id],
    );
    const purge = await repo.documents.purgeExpired({
      limit: 10,
      exclude: [],
      removeObjects: () => Promise.resolve(true),
    });
    expect(purge.purged.map((d) => d.id)).not.toContain(doc.id);
    expect(await idsFor(owner, 'archived')).toEqual([doc.id]);
  });

  test('LIB-D10 the sample flag is readable by the app role and survives the listing; LIB-D2 the migration’s backfill sets ever_shared from shares and the link, never clearing one', async () => {
    const owner = await user('sub-sample-owner');
    const bob = await user('sub-sample-bob');
    const sample = await createDoc(owner, 'Q3 Delivery — Guided sample');
    await pool.query('update documents set sample = true where id = $1', [sample.id]);
    expect((await repo.documents.get(sample.id))?.sample).toBe(true);
    expect(
      (await repo.documents.listForUser(owner, 'recents')).find((d) => d.id === sample.id)?.sample,
    ).toBe(true);

    // The backfill statement from migration 0008, re-run as the app role over rows
    // the runtime flagged the other way: a share, or a link on, sets the flag.
    const shared = await createDoc(owner, 'backfill: share');
    await repo.shares.add({
      documentId: shared.id,
      userId: bob,
      permission: 'view',
      invitedBy: owner,
      actorId: owner,
    });
    const linked = await createDoc(owner, 'backfill: link');
    await repo.shares.setLinkAccess({
      documentId: linked.id,
      access: 'view',
      actorId: owner,
      mintToken: () => 'tok-backfill',
    });
    const alone = await createDoc(owner, 'backfill: alone');
    await pool.query('update documents set ever_shared = false where id = any($1::uuid[])', [
      [shared.id, linked.id],
    ]);
    const migration = readFileSync(
      join(MIGRATIONS, '0008_documents_archive_ever_shared_sample.sql'),
      'utf8',
    );
    const backfill = /UPDATE documents d[\s\S]*?;/.exec(migration)?.[0];
    expect(backfill).toBeDefined();
    await pool.query(backfill ?? '');
    const flags = await pool.query<{ id: string; ever_shared: boolean }>(
      'select id, ever_shared from documents where id = any($1::uuid[]) order by title',
      [[shared.id, linked.id, alone.id]],
    );
    expect(flags.rows).toEqual([
      { id: alone.id, ever_shared: false },
      { id: linked.id, ever_shared: true },
      { id: shared.id, ever_shared: true },
    ]);
  });

  test('ONB-03 tour_done_at round-trips as the app role: null on first sight, stamped by tourDone true, cleared by false, read back by the upsert', async () => {
    const first = await repo.users.upsertFromToken({ sub: 'sub-tour', email: null });
    expect(first.tourDoneAt).toBeNull();
    const before = Date.now();
    const done = await repo.users.updateProfile(first.id, { tourDone: true });
    expect(done?.tourDoneAt).toBeInstanceOf(Date);
    expect(done!.tourDoneAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Per account: the next sight of the same sub (another device) reads the stamp.
    const again = await repo.users.upsertFromToken({ sub: 'sub-tour', email: null });
    expect(again.tourDoneAt?.getTime()).toBe(done!.tourDoneAt!.getTime());
    const replay = await repo.users.updateProfile(first.id, { tourDone: false });
    expect(replay?.tourDoneAt).toBeNull();
    expect(
      (await repo.users.upsertFromToken({ sub: 'sub-tour', email: null })).tourDoneAt,
    ).toBeNull();
    // A patch without the field leaves it alone.
    await repo.users.updateProfile(first.id, { tourDone: true });
    expect(
      (await repo.users.updateProfile(first.id, { locale: 'ta-IN' }))?.tourDoneAt,
    ).toBeInstanceOf(Date);
  });

  test('ONB-01 createSample is idempotent per owner through documents_owner_sample_key; the upsert reports the sample id', async () => {
    const owner = await repo.users.upsertFromToken({ sub: 'sub-sample-seed', email: null });
    expect(owner.sampleDocumentId).toBeNull();
    const bytes = encodeSampleWorkscape();
    const seed = (id: string) =>
      repo.documents.createSample({
        id,
        ownerId: owner.id,
        title: SAMPLE_TITLE,
        snapshot: { seq: 1, s3Key: `docs/${id}/1.yjs`, sizeBytes: bytes.byteLength },
      });
    const firstId = crypto.randomUUID();
    const first = await seed(firstId);
    expect(first).toMatchObject({ created: true, document: { id: firstId, sample: true } });
    // A racing second insert writes nothing and adopts the first row.
    const second = await seed(crypto.randomUUID());
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(firstId);
    const rows = await pool.query<{ n: number }>(
      'select count(*)::int as n from documents where owner_id = $1 and sample',
      [owner.id],
    );
    expect(rows.rows[0]?.n).toBe(1);
    const snapshots = await pool.query<{ n: number }>(
      'select count(*)::int as n from snapshots where document_id = $1',
      [firstId],
    );
    expect(snapshots.rows[0]?.n).toBe(1);
    const audit = await pool.query<{ target: string | null }>(
      "select target from audit_log where document_id = $1 and action = 'document.create'",
      [firstId],
    );
    expect(audit.rows).toEqual([{ target: 'sample' }]);
    // Every users read carries the id: the upsert, the profile update, the email lookup.
    expect(
      (await repo.users.upsertFromToken({ sub: 'sub-sample-seed', email: null })).sampleDocumentId,
    ).toBe(firstId);
    expect((await repo.users.updateProfile(owner.id, { locale: 'en-GB' }))?.sampleDocumentId).toBe(
      firstId,
    );
    // Pinned first in Recents and Browse, above a newer document.
    await createDoc(owner.id, 'newer');
    for (const view of ['recents', 'browse'] as const) {
      const listing = await repo.documents.listForUser(owner.id, view);
      expect(listing[0]).toMatchObject({ id: firstId, sample: true });
    }
    // The guard: the sample cannot be deleted (LIB-D10).
    expect(await repo.documents.tryDelete(firstId)).toEqual({ status: 'sample' });
    // Shared with a participant (the tour's last step), it is an ordinary row in
    // their library: their own sample stays first, the owner's sorts by date.
    const guest = await user('sub-sample-guest');
    const guestSample = crypto.randomUUID();
    await repo.documents.createSample({
      id: guestSample,
      ownerId: guest,
      title: SAMPLE_TITLE,
      snapshot: { seq: 1, s3Key: `docs/${guestSample}/1.yjs`, sizeBytes: bytes.byteLength },
    });
    await pool.query(
      "update documents set updated_at = now() + interval '1 minute' where id = $1",
      [firstId],
    );
    await repo.shares.add({
      documentId: firstId,
      userId: guest,
      permission: 'edit',
      invitedBy: owner.id,
      actorId: owner.id,
    });
    const guestRecents = await repo.documents.listForUser(guest, 'recents');
    expect(guestRecents.map((d) => d.id)).toEqual([guestSample, firstId]);
    expect(guestRecents[1]).toMatchObject({ sample: true, permission: 'edit', ownerId: owner.id });
  });
});
