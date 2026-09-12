import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellAddress,
  cellKey,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  tableMap,
  workbookCellId,
  type EngineRequest,
  type EngineResponse,
  type GedeDoc,
} from '@gede/core';

import {
  createEngineHost,
  engineFor,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  inlineTransport,
  MAX_WORKER_RESTARTS,
  setEngineTransportForTests,
  type EngineTransport,
} from './engine.js';

function fixture() {
  const doc = new Y.Doc();
  const gd = openDocument(doc);
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 3 });
  const t = tableById(gd, tableId);
  if (t === null) throw new Error('no table');
  const rows = t.rows;
  const cols = t.columns.map((c) => c.id);
  const map = tableMap(gd, tableId);
  if (map === null) throw new Error('no map');
  const addr = (r: number, c: number) => cellAddress(map, rows[r] ?? '', cols[c] ?? '') ?? '';
  const id = (r: number, c: number) =>
    workbookCellId(tableId, cellKey(rows[r] ?? '', cols[c] ?? ''));
  const set = (r: number, c: number, text: string) => {
    setCellText(gd, tableId, rows[r] ?? '', cols[c] ?? '', text);
  };
  return { doc, gd, tableId, addr, id, set };
}

/** FAKE transport: records every request and answers through a real inline engine. */
function recordingTransport(): EngineTransport & { requests: EngineRequest[] } {
  const inner = inlineTransport();
  const requests: EngineRequest[] = [];
  return {
    requests,
    mode: 'inline',
    post: (request) => {
      requests.push(request);
      inner.post(request);
    },
    onResponse: (h) => {
      inner.onResponse(h);
    },
    terminate: () => {
      inner.terminate();
    },
  };
}

describe('engine host', () => {
  it('FX-06 evaluates through the inline fallback where no Worker exists, asynchronously, and notifies per cell', async () => {
    const f = fixture();
    const host = createEngineHost(f.gd);
    expect(host.mode).toBe('inline');
    expect(typeof Worker).toBe('undefined');
    f.set(0, 0, '4');
    f.set(1, 0, '5');
    const onChange = vi.fn();
    host.subscribe(f.id(2, 0), onChange);
    f.set(2, 0, `=Sum(${f.addr(0, 0)}:${f.addr(1, 0)})`);
    // Typing is never blocked: the result is not there synchronously.
    expect(host.result(f.id(2, 0))).toBeUndefined();
    await host.settled();
    expect(host.result(f.id(2, 0))?.value).toEqual({ kind: 'number', value: 9 });
    expect(onChange).toHaveBeenCalledTimes(1);
    f.set(0, 1, 'unrelated');
    await host.settled();
    expect(onChange).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('every request crosses the boundary as structured-clone data (no Yjs types), one batch per transaction', async () => {
    const f = fixture();
    const transport = recordingTransport();
    const host = createEngineHost(f.gd, () => transport);
    f.set(0, 0, '1');
    await host.settled();
    expect(transport.requests.map((r) => r.type)).toEqual(['apply', 'apply']);
    const first = transport.requests[0];
    expect(first?.type === 'apply' && first.changes[0]?.type).toBe('reset');
    const last = transport.requests[1];
    expect(last?.type === 'apply' && last.changes).toEqual([
      {
        type: 'cells',
        tableId: f.tableId,
        cells: expect.objectContaining({}) as Record<string, unknown>,
      },
    ]);
    for (const r of transport.requests) expect(() => structuredClone(r)).not.toThrow();
    host.dispose();
  });

  it('FX-06 a remote update (applied from another replica) re-evaluates locally', async () => {
    const f = fixture();
    const host = createEngineHost(f.gd);
    f.set(0, 0, '1');
    f.set(2, 0, `=Sum(${f.addr(0, 0)}:${f.addr(1, 0)})`);
    await host.settled();
    expect(host.result(f.id(2, 0))?.value).toEqual({ kind: 'number', value: 1 });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.doc));
    const rgd: GedeDoc = openDocument(remote);
    const t = tableById(rgd, f.tableId);
    setCellText(rgd, f.tableId, t?.rows[1] ?? '', t?.columns[0]?.id ?? '', '41');
    Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(f.doc)), 'remote');
    await host.settled();
    expect(host.result(f.id(2, 0))?.value).toEqual({ kind: 'number', value: 42 });
    host.dispose();
  });

  it('engineFor hands out one host per document and disposes it when the document is destroyed', async () => {
    const f = fixture();
    const transport = recordingTransport();
    const terminate = vi.spyOn(transport, 'terminate');
    setEngineTransportForTests(() => transport);
    try {
      const a = engineFor(f.doc);
      const b = engineFor(f.doc);
      expect(a).toBe(b);
      f.set(0, 0, `=Concat("a", "b")`);
      await a.settled();
      expect(a.result(f.id(0, 0))?.value).toEqual({ kind: 'text', text: 'ab' });
      f.doc.destroy();
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      setEngineTransportForTests(null);
    }
  });

  it('withdraws a result when the formula becomes text, and reports the engine time', async () => {
    const f = fixture();
    const host = createEngineHost(f.gd);
    f.set(0, 0, '=Sum(');
    await host.settled();
    expect(host.result(f.id(0, 0))?.error?.kind).toBe('parse');
    expect(host.lastElapsedMs).toBeGreaterThanOrEqual(0);
    f.set(0, 0, 'plain');
    await host.settled();
    expect(host.result(f.id(0, 0))).toBeUndefined();
    host.dispose();
  });

  it('the response protocol carries results, removals and elapsed time', async () => {
    const transport = inlineTransport();
    const responses: EngineResponse[] = [];
    transport.onResponse((r) => responses.push(r));
    transport.post({
      type: 'apply',
      seq: 1,
      changes: [{ type: 'reset', snapshot: { tables: [] } }],
    });
    await Promise.resolve();
    expect(responses).toEqual([
      {
        type: 'results',
        seq: 1,
        results: [],
        removed: [],
        elapsedMs: expect.any(Number) as number,
      },
    ]);
  });

  it('FX-06 a Worker that dies is restarted from a fresh snapshot — evaluation never moves to the main thread — and after too many deaths the host reports failure until Retry', async () => {
    const f = fixture();
    let fail: ((error: unknown) => void) | null = null;
    const made: string[] = [];
    // FAKE transports standing in for Workers: the first swallows requests and then dies;
    // the replacements are real inline engines labelled as workers.
    const makeTransport = (): EngineTransport => {
      const n = made.length;
      made.push(`w${String(n)}`);
      if (n === 0) {
        return {
          mode: 'worker',
          post: () => undefined,
          onResponse: () => undefined,
          onError: (h) => {
            fail = h;
          },
          terminate: () => undefined,
        };
      }
      const inner = inlineTransport();
      return {
        mode: 'worker',
        post: (r) => {
          inner.post(r);
        },
        onResponse: (h) => {
          inner.onResponse(h);
        },
        onError: (h) => {
          fail = h;
        },
        terminate: () => {
          inner.terminate();
        },
      };
    };
    const host = createEngineHost(f.gd, makeTransport);
    f.set(0, 0, '=Concat("x", "y")');
    expect(host.status).toMatchObject({ mode: 'worker', restarts: 0, failed: false });
    const statusChanges = vi.fn();
    host.subscribeStatus(statusChanges);

    fail!(new Error('script blocked'));
    expect(host.status).toMatchObject({
      mode: 'worker',
      restarts: 1,
      failed: false,
      lastError: 'script blocked',
    });
    expect(made).toEqual(['w0', 'w1']);
    await host.settled();
    // The replacement was seeded from the document: the formula is there and evaluated.
    expect(host.result(f.id(0, 0))?.value).toEqual({ kind: 'text', text: 'xy' });
    expect(host.mode).toBe('worker');

    for (let i = 0; i < MAX_WORKER_RESTARTS; i += 1) fail!(new Error(`death ${String(i)}`));
    expect(host.status.failed).toBe(true);
    expect(host.status.restarts).toBe(MAX_WORKER_RESTARTS);
    expect(statusChanges).toHaveBeenCalled();
    // Nothing is posted while failed; Retry starts over from a snapshot.
    const before = made.length;
    f.set(0, 1, '=Concat("a")');
    expect(made.length).toBe(before);
    host.retry();
    expect(host.status).toMatchObject({ failed: false, restarts: 0 });
    await host.settled();
    expect(host.result(f.id(0, 1))?.value).toEqual({ kind: 'text', text: 'a' });
    host.dispose();
  });

  it('FX-06 a Worker that stops answering (killed without an error event) is detected by the heartbeat and restarted', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const made: EngineTransport[] = [];
      // FAKE transports: the first answers apply requests but never a ping (a Worker the browser
      // reclaimed after its last answer); the replacement is a real inline engine labelled as a worker.
      const makeTransport = (): EngineTransport => {
        const inner = inlineTransport();
        const mute = made.length === 0;
        const t: EngineTransport = {
          mode: 'worker',
          post: (r) => {
            if (mute && r.type === 'ping') return;
            inner.post(r);
          },
          onResponse: (h) => {
            inner.onResponse(h);
          },
          terminate: () => {
            inner.terminate();
          },
        };
        made.push(t);
        return t;
      };
      const host = createEngineHost(f.gd, makeTransport);
      f.set(0, 0, '=Concat("a")');
      await vi.advanceTimersByTimeAsync(0);
      expect(host.result(f.id(0, 0))?.value).toEqual({ kind: 'text', text: 'a' });
      expect(host.status.restarts).toBe(0);
      // One interval later the ping goes out; one timeout later, unanswered, the Worker is replaced.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS + 1);
      expect(made).toHaveLength(2);
      expect(host.status).toMatchObject({ restarts: 1, failed: false, mode: 'worker' });
      expect(host.status.lastError).toMatch(/stopped answering/);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.result(f.id(0, 0))?.value).toEqual({ kind: 'text', text: 'a' });
      // The replacement answers pings: no further restarts.
      await vi.advanceTimersByTimeAsync(3 * (HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS));
      expect(host.status.restarts).toBe(1);
      host.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
