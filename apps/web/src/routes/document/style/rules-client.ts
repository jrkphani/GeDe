/**
 * Typed client for the rules Worker (`workers/rules.worker.ts`, INSP-05).
 * `evaluate` resolves with the cells a rule matched; a Worker that errors,
 * or that has not answered within `timeoutMs`, is terminated and respawned
 * for the next call, so one pathological pattern never freezes the sheet.
 *
 * `createRuleEvaluator({ worker: false })` runs the same engine on the
 * calling thread — for jsdom in unit tests, and for environments without
 * `Worker`. Nothing about the result differs; only where it was computed.
 *
 * One evaluator serves every column of every table: requests carry the
 * table and column ids, and a response older than the latest request for
 * that column is dropped, so a column never paints a stale answer.
 */
import {
  handleRulesRequest,
  type RuleMatch,
  type RulesRequest,
  type RulesResponse,
} from '@gede/core';

export type EvaluateResult =
  | { readonly ok: true; readonly matches: readonly RuleMatch[] }
  | { readonly ok: false; readonly error: string; readonly stale?: true };

export interface RuleEvaluator {
  readonly mode: 'worker' | 'main';
  evaluate(input: Omit<RulesRequest, 'id'>): Promise<EvaluateResult>;
  /** Terminate the Worker (if any) and settle anything in flight as stale. */
  dispose(): void;
}

export interface RuleEvaluatorOptions {
  /** Use a Web Worker when one is available. Default: `typeof Worker === 'function'`. */
  worker?: boolean | undefined;
  /** Test seam: a Worker factory; defaults to the Vite module Worker. */
  spawn?: (() => Worker) | undefined;
  /** Watchdog for a runaway pattern. Default `DEFAULT_RULES_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

export const DEFAULT_RULES_TIMEOUT_MS = 3000;

function spawnDefault(): Worker {
  return new Worker(new URL('../../../workers/rules.worker.ts', import.meta.url), {
    type: 'module',
    name: 'gede-rules',
  });
}

function isRulesResponse(value: unknown): value is RulesResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function toResult(response: RulesResponse): EvaluateResult {
  return response.ok
    ? { ok: true, matches: response.matches }
    : { ok: false, error: response.error };
}

const STALE: EvaluateResult = { ok: false, stale: true, error: 'superseded' };
const columnKey = (tableId: string, colId: string): string => `${tableId}/${colId}`;

export function createRuleEvaluator(options: RuleEvaluatorOptions = {}): RuleEvaluator {
  const useWorker = options.worker ?? typeof Worker === 'function';
  const spawn = options.spawn ?? spawnDefault;
  let nextId = 1;
  /** Latest request id per column; an older response is stale. */
  const latest = new Map<string, number>();

  if (!useWorker) {
    return {
      mode: 'main',
      evaluate: (input) => {
        const id = nextId;
        nextId += 1;
        const key = columnKey(input.tableId, input.colId);
        latest.set(key, id);
        const response = handleRulesRequest({ id, ...input });
        return Promise.resolve(latest.get(key) === id ? toResult(response) : STALE);
      },
      dispose: () => undefined,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RULES_TIMEOUT_MS;
  let worker: Worker | null = null;
  const pending = new Map<
    number,
    { key: string; resolve: (r: EvaluateResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const settle = (id: number, result: EvaluateResult): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(latest.get(entry.key) === id ? result : STALE);
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
      if (isRulesResponse(event.data)) settle(event.data.id, toResult(event.data));
    };
    w.onerror = (event) => {
      recycle(event.message === '' ? 'worker error' : event.message);
    };
    worker = w;
    return w;
  };

  return {
    mode: 'worker',
    evaluate: (input) =>
      new Promise((resolve) => {
        const id = nextId;
        nextId += 1;
        const key = columnKey(input.tableId, input.colId);
        latest.set(key, id);
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: `rules timed out after ${String(timeoutMs)} ms` });
          recycle('worker recycled after a timeout');
        }, timeoutMs);
        pending.set(id, { key, resolve, timer });
        ensure().postMessage({ id, ...input } satisfies RulesRequest);
      }),
    dispose: () => {
      recycle('evaluator disposed');
    },
  };
}
