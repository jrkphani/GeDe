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
  inlineTransport,
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
    const host = createEngineHost(f.gd, transport);
    f.set(0, 0, '1');
    await host.settled();
    expect(transport.requests.map((r) => r.type)).toEqual(['apply', 'apply']);
    const first = transport.requests[0]?.changes[0];
    expect(first?.type).toBe('reset');
    const last = transport.requests[1];
    expect(last?.changes).toEqual([
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
});
