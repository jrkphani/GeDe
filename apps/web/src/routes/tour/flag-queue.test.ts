import { describe, expect, test } from 'vitest';

import { createFlagQueue } from './flag-queue.js';

/** Let queued microtasks run (the queue starts a write on the next tick). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A writer whose answers the test releases by hand, in any order. */
function deferredWriter() {
  const calls: { value: boolean; resolve: () => void; reject: (e: Error) => void }[] = [];
  const write = (patch: { tourDone: boolean }) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ value: patch.tourDone, resolve, reject });
    });
  return { calls, write };
}

describe('tour flag queue', () => {
  test('ONB-08 ONB-03 Replay then Skip write in order: the second PATCH starts only after the first answered', async () => {
    const queue = createFlagQueue();
    const { calls, write } = deferredWriter();
    const replay = queue.persist(false, write);
    const skip = queue.persist(true, write);
    await tick();
    expect(calls.map((c) => c.value)).toEqual([false]);
    calls[0]!.resolve();
    await replay;
    await tick();
    expect(calls.map((c) => c.value)).toEqual([false, true]);
    calls[1]!.resolve();
    await skip;
  });

  test('ONB-03 a failed write does not block the next one, and the caller still resolves', async () => {
    const queue = createFlagQueue();
    const { calls, write } = deferredWriter();
    const first = queue.persist(true, write);
    const second = queue.persist(false, write);
    await tick();
    calls[0]!.reject(new Error('offline'));
    await first;
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve();
    await second;
  });

  test('ONB-07 a write of the value already queued at the tail is coalesced; a different value is not', async () => {
    const queue = createFlagQueue();
    const { calls, write } = deferredWriter();
    const a = queue.persist(true, write);
    const b = queue.persist(true, write);
    expect(b).toBe(a);
    await tick();
    expect(calls).toHaveLength(1);
    const c = queue.persist(false, write);
    expect(c).not.toBe(a);
    calls[0]!.resolve();
    await a;
    await tick();
    expect(calls.map((x) => x.value)).toEqual([true, false]);
    calls[1]!.resolve();
    await c;
    // Once drained, the same value writes again (a fresh Skip after a fresh Replay).
    const d = queue.persist(false, write);
    await tick();
    expect(calls).toHaveLength(3);
    calls[2]!.resolve();
    await d;
  });
});
