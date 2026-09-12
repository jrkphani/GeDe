/**
 * Typed client for the Smart Chip Worker (PRD §5, §20). `runChip` and
 * `runRegex` resolve with the matches or a typed failure; a pattern that
 * runs past the timeout terminates the Worker (RE2-safe patterns never
 * should, but the Worker exists so a runaway never freezes the sheet) and
 * a fresh one is spawned for the next call.
 *
 * `createChipRunner({ worker: false })` runs the same handler on the calling
 * thread — for tests and for environments without `Worker`. Nothing about
 * the result differs; only where it was computed.
 */
import {
  handleChipRequest,
  type ChipId,
  type ChipRequest,
  type ChipResponse,
  type Match,
} from '@gede/core';

export type ChipResult =
  | { readonly ok: true; readonly matches: readonly Match[] }
  | { readonly ok: false; readonly error: string; readonly timedOut?: boolean };

export interface ChipRunner {
  runChip(chip: ChipId, text: string): Promise<ChipResult>;
  runRegex(source: string, text: string, flags?: string): Promise<ChipResult>;
  /** Terminate the Worker (if any) and reject anything in flight. */
  dispose(): void;
}

export interface ChipRunnerOptions {
  /** Use a Web Worker when one is available. Default: `typeof Worker !== 'undefined'`. */
  worker?: boolean | undefined;
  /** Milliseconds before a request is abandoned and the Worker recycled. Default 2000. */
  timeoutMs?: number | undefined;
  /** Test seam: a Worker factory; defaults to the Vite module Worker. */
  spawn?: (() => Worker) | undefined;
}

export const DEFAULT_CHIP_TIMEOUT_MS = 2000;

function spawnDefault(): Worker {
  return new Worker(new URL('./chips.worker.ts', import.meta.url), { type: 'module' });
}

function isChipResponse(value: unknown): value is ChipResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function toResult(response: ChipResponse): ChipResult {
  return response.ok
    ? { ok: true, matches: response.matches }
    : { ok: false, error: response.error };
}

export function createChipRunner(options: ChipRunnerOptions = {}): ChipRunner {
  const useWorker = options.worker ?? typeof Worker !== 'undefined';
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHIP_TIMEOUT_MS;
  const spawn = options.spawn ?? spawnDefault;

  if (!useWorker) {
    return {
      runChip: (chip, text) =>
        Promise.resolve(toResult(handleChipRequest({ id: 0, kind: 'chip', chip, text }))),
      runRegex: (source, text, flags) =>
        Promise.resolve(
          toResult(
            handleChipRequest(
              flags === undefined
                ? { id: 0, kind: 'regex', source, text }
                : { id: 0, kind: 'regex', source, flags, text },
            ),
          ),
        ),
      dispose: () => undefined,
    };
  }

  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: ChipResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const settle = (id: number, result: ChipResult): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(result);
  };

  const recycle = (reason: string): void => {
    worker?.terminate();
    worker = null;
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: reason });
  };

  const ensure = (): Worker => {
    if (worker !== null) return worker;
    const w = spawn();
    w.onmessage = (event: MessageEvent<unknown>) => {
      if (isChipResponse(event.data)) settle(event.data.id, toResult(event.data));
    };
    w.onerror = (event) => {
      recycle(event.message === '' ? 'worker error' : event.message);
    };
    worker = w;
    return w;
  };

  const send = (make: (id: number) => ChipRequest): Promise<ChipResult> =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        // Only this request is abandoned by the timeout; the Worker is recycled so a
        // pattern still running cannot starve the next one.
        pending.delete(id);
        resolve({
          ok: false,
          error: `pattern timed out after ${String(timeoutMs)} ms`,
          timedOut: true,
        });
        recycle('worker recycled after a timeout');
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      ensure().postMessage(make(id));
    });

  return {
    runChip: (chip, text) => send((id) => ({ id, kind: 'chip', chip, text })),
    runRegex: (source, text, flags) =>
      send((id) =>
        flags === undefined
          ? { id, kind: 'regex', source, text }
          : { id, kind: 'regex', source, flags, text },
      ),
    dispose: () => {
      recycle('runner disposed');
    },
  };
}
