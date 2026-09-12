import pino from 'pino';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { FakeRepo } from '../test/fake-repo.js';
import { FakeSnapshotStore, testConfig } from '../test/fakes.js';
import { PersistenceWriter } from './persistence.js';

const silent = pino({ level: 'silent' });

/** Two writers for one document, as two tasks co-hosting a room during a rolling deploy would be. */
async function twoTasks() {
  const repo = new FakeRepo();
  const s3 = new FakeSnapshotStore();
  const config = testConfig({ SNAPSHOT_EVERY_UPDATES: 1000, SNAPSHOT_IDLE_MS: 60_000 });
  const owner = repo.seedUser('sub-owner').id;
  const doc = repo.seedDocument(owner, 'shared');
  const updates = Array.from({ length: 5 }, (_, i) => ({
    update: new Uint8Array([i + 1]),
    authorId: owner,
  }));
  await repo.updates.append(doc.id, updates); // seq 1..5 in the log
  const yA = new Y.Doc();
  const yB = new Y.Doc();
  yA.getMap('m').set('seen', 'everything up to 5');
  yB.getMap('m').set('seen', 'only up to 3');
  const a = new PersistenceWriter(doc.id, yA, repo.updates, s3, config, silent, {
    snapshotSeq: 0,
    lastSeq: 5,
  });
  const b = new PersistenceWriter(doc.id, yB, repo.updates, s3, config, silent, {
    snapshotSeq: 0,
    lastSeq: 3,
  });
  return { repo, s3, doc, a, b };
}

describe('commitSnapshot is monotonic across tasks (#39)', () => {
  test('LOAD-06 a task that compacts behind another task cannot move the pointer back or prune the newer log', async () => {
    const { repo, s3, doc, a, b } = await twoTasks();
    await a.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(5);
    expect(repo.updatesByDoc.get(doc.id)).toEqual([]);

    // B is behind: its commit at 3 is refused, the pointer stays at 5, and
    // nothing is pruned or recorded. B knows it was superseded.
    await b.compact();
    expect(repo.docs.get(doc.id)).toMatchObject({
      snapshotSeq: 5,
      snapshotKey: `docs/${doc.id}/5.yjs`,
    });
    expect(repo.snapshotsByDoc.get(doc.id)?.map((s) => s.seq)).toEqual([5]);
    expect(b.stats).toMatchObject({ snapshots: 0, staleSnapshots: 1 });
    expect(b.currentSnapshotSeq).toBe(0);
    expect(a.stats).toMatchObject({ snapshots: 1, staleSnapshots: 0 });
    // The cold-open pointer still resolves to the newer object.
    const state = await repo.updates.loadState(doc.id);
    expect(state.snapshotSeq).toBe(5);
    expect(await s3.get(state.snapshotKey ?? '')).toBeDefined();
  });

  test('LOAD-06 in the other order both commits land and the log is pruned only up to the latest', async () => {
    const { repo, doc, a, b } = await twoTasks();
    await b.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(3);
    expect(repo.updatesByDoc.get(doc.id)?.map((u) => u.seq)).toEqual([4, 5]);
    await a.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(5);
    expect(repo.updatesByDoc.get(doc.id)).toEqual([]);
    expect(repo.snapshotsByDoc.get(doc.id)?.map((s) => s.seq)).toEqual([3, 5]);
    expect(a.stats.staleSnapshots + b.stats.staleSnapshots).toBe(0);
  });
});
