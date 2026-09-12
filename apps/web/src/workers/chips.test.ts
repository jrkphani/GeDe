import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleChipRequest, isChipRequest, type ChipResponse } from '@gede/core';

import { createChipRunner } from './chips.js';

/**
 * FAKE: a Worker that runs the real handler on a macrotask, the way the
 * browser's would on its own thread. `respond: false` never answers, for
 * the timeout path.
 */
class FakeWorker implements Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'> {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  static spawned = 0;
  constructor(private readonly respond: boolean) {
    FakeWorker.spawned += 1;
  }
  postMessage(message: unknown): void {
    if (!this.respond) return;
    const response: ChipResponse = isChipRequest(message)
      ? handleChipRequest(message)
      : { id: -1, ok: false, error: 'malformed request' };
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<unknown>);
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWorker.spawned = 0;
});

describe('Smart Chip runner (PRD §5, §20)', () => {
  test('SORT-04 (partial) the main-thread fallback answers with the same matches as the handler', async () => {
    const runner = createChipRunner({ worker: false });
    await expect(runner.runChip('email', 'mail meena@1cloudhub.com now')).resolves.toEqual({
      ok: true,
      matches: [{ start: 5, end: 24, text: 'meena@1cloudhub.com' }],
    });
    await expect(runner.runRegex('\\d+', 'a1b22')).resolves.toEqual({
      ok: true,
      matches: [
        { start: 1, end: 2, text: '1' },
        { start: 3, end: 5, text: '22' },
      ],
    });
    await expect(runner.runRegex('(?=x)', 'x')).resolves.toMatchObject({ ok: false });
    runner.dispose();
  });

  test('SORT-04 (partial) through a Worker: requests are matched by id and resolve in any order', async () => {
    const runner = createChipRunner({
      worker: true,
      spawn: () => new FakeWorker(true) as unknown as Worker,
    });
    const [a, b] = await Promise.all([
      runner.runChip('country', 'Singapore and India'),
      runner.runChip('parenthetical', 'x (y)'),
    ]);
    expect(a).toEqual({
      ok: true,
      matches: [
        { start: 0, end: 9, text: 'Singapore' },
        { start: 14, end: 19, text: 'India' },
      ],
    });
    expect(b).toEqual({
      ok: true,
      matches: [{ start: 2, end: 5, text: '(y)', group: { start: 3, end: 4, text: 'y' } }],
    });
    expect(FakeWorker.spawned).toBe(1);
    runner.dispose();
  });

  test('a pattern that runs past the timeout is abandoned and the Worker recycled', async () => {
    vi.useFakeTimers();
    const runner = createChipRunner({
      worker: true,
      timeoutMs: 50,
      spawn: () => new FakeWorker(false) as unknown as Worker,
    });
    const pending = runner.runRegex('a+', 'aaaa');
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'pattern timed out after 50 ms',
      timedOut: true,
    });
    // The next request gets a fresh Worker.
    void runner.runRegex('a', 'a');
    expect(FakeWorker.spawned).toBe(2);
    runner.dispose();
  });

  test('dispose rejects what is in flight', async () => {
    const runner = createChipRunner({
      worker: true,
      spawn: () => new FakeWorker(false) as unknown as Worker,
    });
    const pending = runner.runChip('email', 'x');
    runner.dispose();
    await expect(pending).resolves.toEqual({ ok: false, error: 'runner disposed' });
  });

  test('a Worker error fails in-flight requests with its message', async () => {
    const worker = new FakeWorker(false);
    const runner = createChipRunner({ worker: true, spawn: () => worker as unknown as Worker });
    const pending = runner.runChip('email', 'x');
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(pending).resolves.toEqual({ ok: false, error: 'boom' });
  });
});
