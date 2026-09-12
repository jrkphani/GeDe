import pino from 'pino';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  createTable,
  encodeSeededDocument,
  listSheets,
  openDocument,
  setCellText,
  tableById,
} from '@gede/core';

import { ProjectionWorker } from '../projection/worker.js';
import { RECENTLY_DELETED_DAYS } from '../repo/types.js';
import { snapshotKey } from '../s3.js';
import { FakeRepo } from '../test/fake-repo.js';
import { FakeSnapshotStore } from '../test/fakes.js';
import { parseInvocation } from './invocation.js';
import { purgeExpired } from './purge.js';
import { reproject } from './reproject.js';

const DAY = 24 * 60 * 60 * 1000;
const silent = pino({ level: 'silent' });

function deletedAgo(repo: FakeRepo, ownerId: string, title: string, days: number): string {
  const doc = repo.seedDocument(ownerId, title);
  const stored = repo.docs.get(doc.id);
  if (!stored) throw new Error('doc');
  stored.deletedAt = new Date(Date.now() - days * DAY);
  return doc.id;
}

describe('parseInvocation', () => {
  test('LIB-08 no --job is the server; purge and reproject parse; anything else is refused', () => {
    expect(parseInvocation([])).toEqual({ kind: 'server' });
    expect(parseInvocation(['--job', 'purge'])).toEqual({ kind: 'job', job: 'purge' });
    expect(parseInvocation(['--job', 'reproject', 'all'])).toEqual({
      kind: 'job',
      job: 'reproject',
      target: 'all',
    });
    expect(parseInvocation(['--job', 'reproject', 'abc'])).toMatchObject({ target: 'abc' });
    expect(() => parseInvocation(['--job', 'reproject'])).toThrow(/document id or "all"/);
    expect(() => parseInvocation(['--job'])).toThrow(/unknown job/);
    expect(() => parseInvocation(['--job', 'vacuum'])).toThrow(/unknown job "vacuum"/);
  });
});

describe('purgeExpired job', () => {
  test('LIB-08 LIB-D6 removes only documents deleted more than 30 days ago, any owner, with a system-actor audit row and their S3 objects; an archived document never expires', async () => {
    const repo = new FakeRepo();
    const s3 = new FakeSnapshotStore();
    const alice = repo.seedUser('sub-alice').id;
    const bob = repo.seedUser('sub-bob').id;
    const old = deletedAgo(repo, alice, 'old', RECENTLY_DELETED_DAYS + 1);
    const older = deletedAgo(repo, bob, 'older', 400);
    const recent = deletedAgo(repo, alice, 'recent', RECENTLY_DELETED_DAYS - 1);
    const live = repo.seedDocument(bob, 'live').id;
    // LIB-D6: archive has no expiry; the purge keys off `deleted_at` alone.
    const archived = repo.seedDocument(alice, 'archived long ago').id;
    repo.docs.get(archived)!.archivedAt = new Date(Date.now() - 400 * DAY);
    for (const id of [old, older, recent, live, archived]) {
      await s3.put(snapshotKey('docs/', id, 1), new Uint8Array([1]));
      await s3.put(snapshotKey('docs/', id, 7), new Uint8Array([2]));
    }
    repo.share(old, bob, 'view');

    const result = await purgeExpired({
      repo,
      s3,
      docsPrefix: 'docs/',
      logger: silent,
      batchSize: 1,
    });
    expect(result).toEqual({ purged: 2, objectsDeleted: 4, failed: [] });
    expect([...repo.docs.keys()].sort()).toEqual([live, recent, archived].sort());
    expect(repo.sharesByDoc.has(old)).toBe(false);
    expect(repo.auditLog).toEqual([
      { documentId: older, userId: null, action: 'document.purge', target: 'older' },
      { documentId: old, userId: null, action: 'document.purge', target: 'old' },
    ]);
    expect([...s3.objects.keys()].sort()).toEqual(
      [1, 7]
        .flatMap((seq) => [
          snapshotKey('docs/', recent, seq),
          snapshotKey('docs/', live, seq),
          snapshotKey('docs/', archived, seq),
        ])
        .sort(),
    );

    // Idempotent: a second run finds nothing.
    expect(await purgeExpired({ repo, s3, docsPrefix: 'docs/', logger: silent })).toEqual({
      purged: 0,
      objectsDeleted: 0,
      failed: [],
    });
  });

  test('LIB-08 objects go before rows: an S3 failure keeps that document (rows and objects) for the next run, the rest still goes, nothing is orphaned', async () => {
    const repo = new FakeRepo();
    const s3 = new FakeSnapshotStore();
    const alice = repo.seedUser('sub-alice').id;
    const first = deletedAgo(repo, alice, 'first', 100);
    const second = deletedAgo(repo, alice, 'second', 90);
    await s3.put(snapshotKey('docs/', first, 1), new Uint8Array([1]));
    await s3.put(snapshotKey('docs/', second, 1), new Uint8Array([1]));
    s3.failNextDelete = true; // `first` is oldest, so its delete is the one that fails
    const result = await purgeExpired({
      repo,
      s3,
      docsPrefix: 'docs/',
      logger: silent,
      batchSize: 1,
    });
    expect(result).toEqual({ purged: 1, objectsDeleted: 1, failed: [first] });
    // The failed document is intact on both sides; no audit row claims it was purged.
    expect([...repo.docs.keys()]).toEqual([first]);
    expect([...s3.objects.keys()]).toEqual([snapshotKey('docs/', first, 1)]);
    expect(repo.auditLog.map((a) => a.documentId)).toEqual([second]);
    // Retry-safe: the next run finishes the job.
    expect(await purgeExpired({ repo, s3, docsPrefix: 'docs/', logger: silent })).toEqual({
      purged: 1,
      objectsDeleted: 1,
      failed: [],
    });
    expect(repo.docs.size).toBe(0);
    expect(s3.objects.size).toBe(0);
  });

  test('LIB-08 a failed read changes nothing and surfaces; a batch whose row delete fails after its objects went is reported, skipped, and finished by the next run (#109)', async () => {
    const repo = new FakeRepo();
    const alice = repo.seedUser('sub-alice').id;
    const doomed = deletedAgo(repo, alice, 'doomed', 100);
    repo.failNextPurge = true; // the first call is the read
    await expect(
      purgeExpired({ repo, s3: new FakeSnapshotStore(), docsPrefix: 'docs/', logger: silent }),
    ).rejects.toThrow('simulated purge failure');
    expect(repo.docs.size).toBe(1);
    expect(repo.auditLog).toEqual([]);

    // The read succeeds, S3 goes, the row delete fails: the run goes on and reports it.
    const s3 = new FakeSnapshotStore();
    await s3.put(snapshotKey('docs/', doomed, 1), new Uint8Array([1]));
    const other = deletedAgo(repo, alice, 'other', 90);
    await s3.put(snapshotKey('docs/', other, 1), new Uint8Array([1]));
    const original = repo.documents.purge.bind(repo.documents);
    let calls = 0;
    (repo.documents as { purge: typeof original }).purge = (ids) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('25P03 simulated')) : original(ids);
    };
    const result = await purgeExpired({
      repo,
      s3,
      docsPrefix: 'docs/',
      logger: silent,
      batchSize: 1,
    });
    expect(result).toEqual({ purged: 1, objectsDeleted: 2, failed: [doomed] });
    expect([...repo.docs.keys()]).toEqual([doomed]);
    expect(s3.objects.size).toBe(0);
    // Next night: nothing left to remove in S3, the rows go.
    expect(await purgeExpired({ repo, s3, docsPrefix: 'docs/', logger: silent })).toEqual({
      purged: 1,
      objectsDeleted: 0,
      failed: [],
    });
    expect(repo.docs.size).toBe(0);
  });

  test('LIB-08 S3 runs outside any transaction (#109): a slow object store neither holds a claim nor fails the run', async () => {
    const repo = new FakeRepo();
    const alice = repo.seedUser('sub-alice').id;
    const doomed = deletedAgo(repo, alice, 'doomed', 100);
    const s3 = new FakeSnapshotStore();
    await s3.put(snapshotKey('docs/', doomed, 1), new Uint8Array([1]));
    let inFlight = 0;
    const slow = {
      put: s3.put.bind(s3),
      get: s3.get.bind(s3),
      deletePrefix: async (prefix: string) => {
        inFlight += 1;
        // The repository must not be mid-transaction while this waits: the
        // fake records every open purge transaction as a call in progress.
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return s3.deletePrefix(prefix);
      },
    };
    const purge = repo.documents.purge.bind(repo.documents);
    (repo.documents as { purge: typeof purge }).purge = (ids) => {
      expect(inFlight).toBe(0); // rows are deleted only after S3 has answered
      return purge(ids);
    };
    const result = await purgeExpired({ repo, s3: slow, docsPrefix: 'docs/', logger: silent });
    expect(result).toEqual({ purged: 1, objectsDeleted: 1, failed: [] });
    expect(repo.docs.size).toBe(0);
  });

  test('LIB-D10 the purge never removes a guided sample, even one a hand-run UPDATE put in the trash (#114); Delete All skips it too; softDelete refuses it', async () => {
    const repo = new FakeRepo();
    const s3 = new FakeSnapshotStore();
    const alice = repo.seedUser('sub-alice').id;
    const sample = repo.seedDocument(alice, 'Q3 Delivery — Guided sample', new Date(), undefined, {
      sample: true,
    }).id;
    // What the CHECK in migration 0010 forbids; the fake has no CHECK, so plant it by hand.
    repo.docs.get(sample)!.deletedAt = new Date(Date.now() - 400 * DAY);
    const old = deletedAgo(repo, alice, 'old', 100);
    await s3.put(snapshotKey('docs/', sample, 1), new Uint8Array([1]));
    await s3.put(snapshotKey('docs/', old, 1), new Uint8Array([1]));
    const result = await purgeExpired({ repo, s3, docsPrefix: 'docs/', logger: silent });
    expect(result).toEqual({ purged: 1, objectsDeleted: 1, failed: [] });
    expect([...repo.docs.keys()]).toEqual([sample]);
    expect(s3.objects.has(snapshotKey('docs/', sample, 1))).toBe(true);
    expect(await repo.documents.purge([sample])).toEqual([]);
    expect(await repo.documents.purgeDeleted(alice, alice, 50)).toEqual([]);
    expect(repo.docs.has(sample)).toBe(true);
    repo.docs.get(sample)!.deletedAt = null;
    expect(await repo.documents.softDelete(sample)).toBeUndefined();
    expect(repo.docs.get(sample)?.deletedAt).toBeNull();
  });
});

describe('reproject job', () => {
  test('FIND-03 rebuilds one document or every live document from snapshot + log; a missing object fails that document only', async () => {
    const repo = new FakeRepo();
    const s3 = new FakeSnapshotStore();
    const alice = repo.seedUser('sub-alice').id;
    const worker = new ProjectionWorker(repo.projection, { PROJECTION_DEBOUNCE_MS: 1 }, silent);

    // A document with a seed snapshot and one logged update on top of it.
    const a = repo.seedDocument(alice, 'A').id;
    const seed = encodeSeededDocument({ title: 'A' });
    await s3.put(snapshotKey('docs/', a, 1), seed);
    await repo.updates.commitSnapshot({
      coversFrom: 0,
      appended: 0,
      documentId: a,
      seq: 1,
      s3Key: snapshotKey('docs/', a, 1),
      sizeBytes: seed.byteLength,
    });
    const replica = new Y.Doc();
    Y.applyUpdate(replica, seed);
    const gd = openDocument(replica);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    const table = tableById(gd, tableId);
    setCellText(gd, tableId, table?.rows[0] ?? '', table?.columns[0]?.id ?? '', 'from the log');
    await repo.updates.append(a, [
      {
        update: Y.encodeStateAsUpdate(replica, Y.encodeStateVectorFromUpdate(seed)),
        authorId: alice,
      },
    ]);

    // A document whose snapshot object is missing, and a deleted one that must be skipped by `all`.
    const b = repo.seedDocument(alice, 'B').id;
    await repo.updates.commitSnapshot({
      coversFrom: 0,
      appended: 0,
      documentId: b,
      seq: 1,
      s3Key: 'docs/missing.yjs',
      sizeBytes: 1,
    });
    const gone = repo.seedDocument(alice, 'gone').id;
    await repo.documents.softDelete(gone);

    const one = await reproject({ repo, s3, worker, logger: silent }, a);
    expect(one).toEqual({ projected: 1, failed: [] });
    expect(repo.projections.get(a)?.cells.map((c) => c.textPlain)).toEqual(['from the log']);

    const all = await reproject({ repo, s3, worker, logger: silent }, 'all');
    expect(all).toEqual({ projected: 1, failed: [b] });
    expect(repo.projections.has(gone)).toBe(false);
    expect(worker.stats).toMatchObject({ runs: 2, failures: 0 });
  });
});
