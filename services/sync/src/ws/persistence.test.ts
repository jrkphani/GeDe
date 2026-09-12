import pino from 'pino';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { FakeRepo } from '../test/fake-repo.js';
import { FakeSnapshotStore, testConfig } from '../test/fakes.js';
import { waitFor } from '../test/y-client.js';
import { PersistenceWriter } from './persistence.js';
import { RoomManager } from './room-manager.js';

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
  test('LOAD-06 a snapshot that would prune rows another task appended after this writer loaded is refused (#39 residual)', async () => {
    const { repo, doc, a, b } = await twoTasks(); // both loaded everything up to seq 5
    // A appends 6 and 7; B appends 8 without ever seeing 6 and 7 (no cross-task fan-out).
    a.enqueue(new Uint8Array([6]), null);
    a.enqueue(new Uint8Array([7]), null);
    await a.flush();
    b.enqueue(new Uint8Array([8]), null);
    await b.flush();
    expect(repo.updatesByDoc.get(doc.id)?.map((u) => u.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // B's snapshot at 8 lacks rows 6 and 7: refused, nothing pruned, pointer unmoved.
    await b.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(0);
    expect(repo.updatesByDoc.get(doc.id)).toHaveLength(8);
    expect(b.stats.staleSnapshots).toBe(1);

    // A's snapshot at 7 contains everything ≤ 7: committed; row 8 stays for replay.
    await a.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(7);
    expect(repo.updatesByDoc.get(doc.id)?.map((u) => u.seq)).toEqual([8]);
    expect(a.stats.staleSnapshots).toBe(0);

    // B is now behind a commit it never saw: even a snapshot that would prune
    // nothing new is refused until B reloads.
    b.enqueue(new Uint8Array([9]), null);
    await b.flush();
    await b.compact();
    expect(repo.docs.get(doc.id)?.snapshotSeq).toBe(7);
    expect(b.stats.staleSnapshots).toBe(2);
  });

  test('LOAD-06 a room whose commit was superseded is dropped by its manager so the next join reloads from storage', async () => {
    const repo = new FakeRepo();
    const s3 = new FakeSnapshotStore();
    const config = testConfig({ SNAPSHOT_EVERY_UPDATES: 1000 });
    const owner = repo.seedUser('sub-owner').id;
    const doc = repo.seedDocument(owner, 'shared');
    // Two managers = two tasks hosting the same document.
    const taskA = new RoomManager(repo, s3, config, silent);
    const taskB = new RoomManager(repo, s3, config, silent);
    const closes: number[] = [];
    const socket = (): never =>
      ({
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        on: () => undefined,
        once: () => undefined,
        send: () => undefined,
        close: (code: number) => closes.push(code),
      }) as never;
    taskA.join(doc.id, socket(), { userId: owner, permission: 'owner' });
    taskB.join(doc.id, socket(), { userId: owner, permission: 'owner' });
    const roomA = taskA.get(doc.id);
    const roomB = taskB.get(doc.id);
    if (!roomA || !roomB) throw new Error('rooms');
    await Promise.all([roomA.ready, roomB.ready]);
    // A writes and compacts; B, which never saw the write, then tries to compact its own edit.
    roomA.persistence.enqueue(new Uint8Array([1]), owner);
    await roomA.persistence.flush();
    await roomA.persistence.compact();
    roomB.persistence.enqueue(new Uint8Array([2]), owner);
    await roomB.persistence.flush();
    await roomB.persistence.compact();
    expect(roomB.persistence.stats.staleSnapshots).toBe(1);
    expect(taskB.get(doc.id)).toBeUndefined(); // dropped: the next join loads afresh
    await waitFor(() => closes.length === 1);
    expect(closes).toEqual([1001]);
    expect(taskA.get(doc.id)).toBe(roomA);
    await taskA.shutdown();
    await taskB.shutdown();
  });

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
