/**
 * Typed client for the sort Worker (`workers/sort.worker.ts`). `project`
 * resolves with the table's projection; a Worker that errors, or that has not
 * answered within `timeoutMs`, is terminated and respawned for the next call,
 * so a bad frame never freezes the sheet and fuzzy matching never moves to
 * the main thread in a browser.
 *
 * `createViewProjector({ worker: false })` runs the same engine on the
 * calling thread — for jsdom in unit tests, and for environments without
 * `Worker`. Nothing about the result differs; only where it was computed.
 *
 * One projector serves every table: requests carry the table id, and a
 * response older than the latest request for that table is dropped, so a
 * table never renders a stale projection after a newer one was asked for.
 */
import {
  handleViewRequest,
  type ProjectionInput,
  type ViewProjection,
  type ViewRequest,
  type ViewResponse,
} from '@gede/core';

export type ProjectResult =
  | { readonly ok: true; readonly projection: ViewProjection }
  | { readonly ok: false; readonly error: string }
  /** Superseded by a newer request for the same table; nothing to render. */
  | { readonly ok: false; readonly stale: true; readonly error: string };

export interface ViewProjector {
  readonly mode: 'worker' | 'main';
  project(tableId: string, input: ProjectionInput): Promise<ProjectResult>;
  /** Terminate the Worker (if any) and settle anything in flight as stale. */
  dispose(): void;
}

export interface ViewProjectorOptions {
  /** Use a Web Worker when one is available. Default: `typeof Worker === 'function'`. */
  worker?: boolean | undefined;
  /** Test seam: a Worker factory; defaults to the Vite module Worker. */
  spawn?: (() => Worker) | undefined;
  /**
   * Watchdog: a projection still unanswered after this long is abandoned and the
   * Worker recycled, so one pathological table (a facet over very long cells) can
   * never starve every other table's projection. Default `DEFAULT_VIEW_TIMEOUT_MS`.
   */
  timeoutMs?: number | undefined;
}

/** A 3,000-row projection takes tens of milliseconds; this is the runaway guard, not a budget. */
export const DEFAULT_VIEW_TIMEOUT_MS = 5000;

function spawnDefault(): Worker {
  return new Worker(new URL('../../../workers/sort.worker.ts', import.meta.url), {
    type: 'module',
    name: 'gede-sort',
  });
}

function isViewResponse(value: unknown): value is ViewResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function toResult(response: ViewResponse): ProjectResult {
  return response.ok
    ? { ok: true, projection: response.projection }
    : { ok: false, error: response.error };
}

const STALE: ProjectResult = { ok: false, stale: true, error: 'superseded' };

export function createViewProjector(options: ViewProjectorOptions = {}): ViewProjector {
  const useWorker = options.worker ?? typeof Worker === 'function';
  const spawn = options.spawn ?? spawnDefault;
  let nextId = 1;
  /** Latest request id per table; an older response is stale. */
  const latest = new Map<string, number>();

  if (!useWorker) {
    return {
      mode: 'main',
      project: (tableId, input) => {
        const id = nextId;
        nextId += 1;
        latest.set(tableId, id);
        const response = handleViewRequest({ id, tableId, input });
        return Promise.resolve(latest.get(tableId) === id ? toResult(response) : STALE);
      },
      dispose: () => undefined,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_VIEW_TIMEOUT_MS;
  let worker: Worker | null = null;
  const pending = new Map<
    number,
    { tableId: string; resolve: (r: ProjectResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const settle = (id: number, result: ProjectResult): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(latest.get(entry.tableId) === id ? result : STALE);
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
      if (isViewResponse(event.data)) settle(event.data.id, toResult(event.data));
    };
    w.onerror = (event) => {
      recycle(event.message === '' ? 'worker error' : event.message);
    };
    worker = w;
    return w;
  };

  return {
    mode: 'worker',
    project: (tableId, input) =>
      new Promise((resolve) => {
        const id = nextId;
        nextId += 1;
        latest.set(tableId, id);
        // A request the next one for the same table supersedes resolves as stale as soon
        // as its answer arrives; the Worker still finishes it (projections are quick).
        const timer = setTimeout(() => {
          // The Worker is recycled, so a projection still running cannot starve the next;
          // every other request in flight settles as an error and is re-asked on the next
          // table change.
          pending.delete(id);
          resolve({ ok: false, error: `projection timed out after ${String(timeoutMs)} ms` });
          recycle('worker recycled after a timeout');
        }, timeoutMs);
        pending.set(id, { tableId, resolve, timer });
        const request: ViewRequest = { id, tableId, input };
        ensure().postMessage(request);
      }),
    dispose: () => {
      recycle('projector disposed');
    },
  };
}
