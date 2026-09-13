import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addDerivedColumn,
  addMappingColumn,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  graphById,
  graphsInPair,
  graphsOnSheet,
  listSheets,
  openDocument,
  setCellText,
  graphUnitBounds,
  sheetBounds,
  tableById,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  type GedeDoc,
  type Id,
} from '../index.js';
import {
  cellWriteBack,
  coverageMatrix,
  resolveSlice,
  withAxis,
  withoutPin,
  withPin,
} from './coverage.js';
import {
  coverageLabel,
  deriveGraph,
  distinctValueCount,
  GREEK_SYMBOLS,
  symbolFor,
  tupleKeyOf,
  type GraphInput,
} from './derive.js';
import { graphInputOf } from './input.js';
import {
  appendRowWithValues,
  bindGraphPair,
  createChildSheet,
  createGraphPair,
  createShapedTableWithGraph,
  defaultDimensions,
  deleteTableWithGraphs,
  graphsBoundTo,
  removeGraph,
  removeGraphObject,
  removeGraphPair,
  setGraphCollapsed,
  setGraphDimensions,
  setGraphPosition,
  setGraphSize,
  setGraphSlice,
  SHAPED_TABLE_COLUMNS,
  toggleGraphDimension,
} from './mutations.js';
import { adjacencyOf, orbitsFor, RING_CENTRE, RING_RADIUS, ringLayout, spokesFor } from './ring.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function input(
  dims: readonly string[],
  rows: readonly (readonly string[])[],
  extra: { ineligible?: string[] } = {},
): GraphInput {
  const ids = dims.map((_, i) => `d${String(i)}`);
  return {
    columns: [
      ...dims.map((label, i) => ({ id: `d${String(i)}`, label, eligible: true })),
      ...(extra.ineligible ?? []).map((label, i) => ({
        id: `x${String(i)}`,
        label,
        eligible: false,
      })),
    ],
    rows: rows.map((values, r) => ({
      id: `r${String(r)}`,
      values: Object.fromEntries(values.map((v, i) => [ids[i] ?? '', v])),
    })),
    dimensions: ids,
  };
}

/** A document with one sheet and a 3-column table; returns the ids. */
function fixture(): {
  gd: GedeDoc;
  sheetId: Id;
  tableId: Id;
  rows: readonly Id[];
  cols: readonly Id[];
} {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 4 });
  const record = tableById(gd, tableId);
  if (record === null) throw new Error('table');
  return { gd, sheetId, tableId, rows: record.rows, cols: record.columns.map((c) => c.id) };
}

function fill(
  gd: GedeDoc,
  tableId: Id,
  rows: readonly Id[],
  cols: readonly Id[],
  grid: string[][],
) {
  grid.forEach((line, r) => {
    line.forEach((text, c) => {
      const rowId = rows[r];
      const colId = cols[c];
      if (rowId !== undefined && colId !== undefined) setCellText(gd, tableId, rowId, colId, text);
    });
  });
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe('GRAPH-06 derivation', () => {
  test('GRAPH-06 dimensions → parameters (distinct, row order) → contexts (rows as tuples)', () => {
    const d = deriveGraph(
      input(
        ['Region', 'Season'],
        [
          ['Nepal', 'Spring'],
          ['India', 'Spring'],
          ['Nepal', 'Autumn'],
          ['Nepal', 'Spring'],
        ],
      ),
    );
    expect(d.dimensions.map((x) => x.label)).toEqual(['Region', 'Season']);
    expect(d.dimensions[0]?.parameters.map((p) => p.value)).toEqual(['Nepal', 'India']);
    expect(d.dimensions[1]?.parameters.map((p) => p.value)).toEqual(['Spring', 'Autumn']);
    expect(d.contexts.map((c) => c.bindings)).toEqual([
      ['Nepal', 'Spring'],
      ['India', 'Spring'],
      ['Nepal', 'Autumn'],
      ['Nepal', 'Spring'],
    ]);
    expect(d.dimensions[0]?.parameters[0]?.contextIds).toEqual(['r0', 'r2', 'r3']);
    expect(d.contexts.every((c) => c.complete)).toBe(true);
  });

  test('GRAPH-06 symbols are generated in row order: α β γ … ω, then α2 …', () => {
    expect(symbolFor(0)).toBe('α');
    expect(symbolFor(1)).toBe('β');
    expect(symbolFor(23)).toBe('ω');
    expect(symbolFor(24)).toBe('α2');
    expect(symbolFor(49)).toBe('β3');
    const d = deriveGraph(
      input(
        ['A'],
        Array.from({ length: 30 }, (_, i) => [`v${String(i)}`]),
      ),
    );
    expect(d.contexts.map((c) => c.symbol).slice(0, 3)).toEqual(['α', 'β', 'γ']);
    expect(d.contexts[24]?.symbol).toBe('α2');
    expect(new Set(d.contexts.map((c) => c.symbol)).size).toBe(30);
  });

  test('GRAPH-06 a fully bound row is complete; a partially bound row is a draft; an empty row is no context', () => {
    const d = deriveGraph(
      input(
        ['A', 'B'],
        [
          ['x', 'y'],
          ['x', ''],
          ['', '  '],
          [' z ', 'y'],
        ],
      ),
    );
    expect(d.contexts.map((c) => [c.symbol, c.complete])).toEqual([
      ['α', true],
      ['β', false],
      ['γ', true],
    ]);
    expect(d.contexts[1]?.tupleKey).toBe('x · ∅');
    expect(d.contexts[2]?.bindings).toEqual(['z', 'y']);
    expect(d.draftCount).toBe(1);
  });

  test('GRAPH-07 the header states distinct covered tuples over the total tuple space', () => {
    const d = deriveGraph(
      input(
        ['A', 'B'],
        [
          ['x', 'y'],
          ['x', 'y'],
          ['w', 'y'],
          ['w', ''],
        ],
      ),
    );
    expect(d.tupleSpace).toBe(2); // {x,w} × {y}
    expect(d.coveredTuples).toBe(2);
    expect(coverageLabel(d)).toBe('2 / 2');
    expect(coverageLabel(deriveGraph(input([], [['x']])))).toBe('—');
  });

  test('REF-05 an ineligible column is never a dimension even when listed', () => {
    const base = input(['A'], [['x']], { ineligible: ['Derived'] });
    const d = deriveGraph({ ...base, dimensions: ['d0', 'x0', 'missing', 'd0'] });
    expect(d.dimensions.map((x) => x.id)).toEqual(['d0']);
  });

  test('GRAPH-05 distinct-value counts per column', () => {
    const i = input(
      ['A', 'B'],
      [
        ['x', 'y'],
        ['x', ''],
        ['z', 'y'],
      ],
    );
    expect(distinctValueCount(i.rows, 'd0')).toBe(2);
    expect(distinctValueCount(i.rows, 'd1')).toBe(1);
  });

  test('GRAPH-06 property: every complete context is counted, the space is the product, symbols are unique', () => {
    const value = fc.constantFrom('', 'a', 'b', 'c', 'd');
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.array(value, { minLength: 4, maxLength: 4 }), { maxLength: 40 }),
        (dimCount, rows) => {
          const dims = Array.from({ length: dimCount }, (_, i) => `D${String(i)}`);
          const d = deriveGraph(
            input(
              dims,
              rows.map((r) => r.slice(0, dimCount)),
            ),
          );
          const expectedSpace = d.dimensions.reduce(
            (acc, x) => acc * Math.max(1, x.parameters.length),
            1,
          );
          expect(d.tupleSpace).toBe(expectedSpace);
          const complete = new Set(d.contexts.filter((c) => c.complete).map((c) => c.tupleKey));
          expect(d.coveredTuples).toBe(complete.size);
          expect(d.coveredTuples).toBeLessThanOrEqual(d.tupleSpace);
          expect(new Set(d.contexts.map((c) => c.symbol)).size).toBe(d.contexts.length);
          // Every context is a row with at least one binding, in row order.
          const nonEmpty = rows
            .map((r, i) => ({ r: r.slice(0, dimCount), i }))
            .filter(({ r }) => r.some((v) => v.trim() !== ''));
          expect(d.contexts.map((c) => c.id)).toEqual(nonEmpty.map(({ i }) => `r${String(i)}`));
          // Parameters are the distinct trimmed non-empty values, first appearance first.
          d.dimensions.forEach((dim, di) => {
            const seen: string[] = [];
            for (const r of rows) {
              const v = (r[di] ?? '').trim();
              if (v !== '' && !seen.includes(v)) seen.push(v);
            }
            expect(dim.parameters.map((p) => p.value)).toEqual(seen);
          });
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('GRAPH-08 coverage slice', () => {
  const three = input(
    ['Region', 'Season', 'Grade'],
    [
      ['Nepal', 'Spring', 'Easy'],
      ['Nepal', 'Autumn', 'Hard'],
      ['India', 'Spring', 'Hard'],
    ],
  );

  test('GRAPH-08 two dimensions on the axes, every other dimension pinned; pins default to the selected context', () => {
    const d = deriveGraph(three);
    const unpinned = resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, null);
    expect(unpinned.rowAxis?.label).toBe('Region');
    expect(unpinned.colAxis?.label).toBe('Season');
    expect(unpinned.pins.map((p) => [p.dimension.label, p.value, p.explicit])).toEqual([
      ['Grade', 'Easy', false],
    ]);
    // The selected context (row 1: Hard) drives the pin so the slice contains the selection.
    const selected = resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, 'r1');
    expect(selected.pins[0]?.value).toBe('Hard');
    const m = coverageMatrix(d, selected);
    expect(m.cells.map((row) => row.map((c) => c.context?.symbol ?? ''))).toEqual([
      ['', 'β'],
      ['γ', ''],
    ]);
    // An explicit pin wins over the selection.
    const pinned = resolveSlice(
      d,
      withPin({ rowAxis: null, colAxis: null, pins: {} }, 'd2', 'Easy'),
      'r1',
    );
    expect(pinned.pins[0]).toMatchObject({ value: 'Easy', explicit: true });
    // "From the selection" (#141): the pin is forgotten and the selection drives it again.
    const released = withoutPin(
      withPin({ rowAxis: null, colAxis: null, pins: {} }, 'd2', 'Easy'),
      'd2',
    );
    expect(released.pins).toEqual({});
    expect(resolveSlice(d, released, 'r1').pins[0]).toMatchObject({
      value: 'Hard',
      explicit: false,
    });
    const untouched = { rowAxis: null, colAxis: null, pins: { d1: 'Spring' } };
    expect(withoutPin(untouched, 'd2')).toBe(untouched);
  });

  test('GRAPH-08 choosing for one axis the dimension on the other swaps them', () => {
    const d = deriveGraph(three);
    const slice = { rowAxis: 'd0', colAxis: 'd1', pins: {} };
    const resolved = resolveSlice(d, slice, null);
    expect(withAxis(slice, resolved, 'row', 'd1')).toEqual({
      rowAxis: 'd1',
      colAxis: 'd0',
      pins: {},
    });
    expect(withAxis(slice, resolved, 'col', 'd2')).toEqual({
      rowAxis: 'd0',
      colAxis: 'd2',
      pins: {},
    });
  });

  test('GRAPH-08 a one-dimensional graph uses that dimension for both axes and is one column, one cell per parameter; a stale axis falls back', () => {
    const d = deriveGraph(input(['Only'], [['a'], ['b'], ['']]));
    const r = resolveSlice(d, { rowAxis: 'gone', colAxis: 'gone', pins: { gone: 'x' } }, null);
    expect(r.rowAxis?.id).toBe('d0');
    expect(r.colAxis?.id).toBe('d0');
    expect(r.pins).toEqual([]);
    const m = coverageMatrix(d, r);
    // Not a 2 × 2 square of repeated tuples: every cell is a distinct tuple.
    expect(m.cells.map((row) => row.map((c) => [c.tupleKey, c.context?.symbol ?? '']))).toEqual([
      [['a', 'α']],
      [['b', 'β']],
    ]);
    const keys = m.cells.flat().map((c) => c.lookupKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('GRAPH-07 GRAPH-08 tuples are matched by identity, not by their label: a value may contain the separator or the gap mark', () => {
    const d = deriveGraph(
      input(
        ['A', 'B'],
        [
          ['x · y', 'z'],
          ['x', 'y · z'], // same label as the row above, a different tuple
          ['∅', 'q'],
          ['', 'q'], // a draft whose label reads like the row above
        ],
      ),
    );
    expect(d.contexts.map((c) => c.tupleKey)).toEqual(['x · y · z', 'x · y · z', '∅ · q', '∅ · q']);
    expect(d.coveredTuples).toBe(3);
    expect(coverageLabel(d)).toBe('3 / 9');
    const m = coverageMatrix(d, resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, null));
    const filled = m.cells.flat().filter((c) => c.context !== null);
    expect(filled.map((c) => c.context?.symbol)).toEqual(['α', 'β', 'γ']);
    for (const cell of filled) expect(cell.context?.bindings).toEqual(cell.bindings);
  });

  test('GRAPH-10 an empty cell writes back the full tuple, pins included', () => {
    const d = deriveGraph(three);
    const m = coverageMatrix(d, resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, null));
    const empty = m.cells[1]?.[1];
    expect(empty?.context).toBeNull();
    expect(
      cellWriteBack(
        d,
        empty ?? {
          rowValue: '',
          colValue: '',
          bindings: [],
          tupleKey: '',
          lookupKey: '',
          context: null,
        },
      ),
    ).toEqual({
      d0: 'India',
      d1: 'Autumn',
      d2: 'Easy',
    });
  });

  test('GRAPH-08 property: the matrix is |row params| × |col params| and every filled cell is a complete context with that tuple', () => {
    const value = fc.constantFrom('', 'a', 'b', 'c');
    fc.assert(
      fc.property(
        fc.array(fc.array(value, { minLength: 3, maxLength: 3 }), { maxLength: 30 }),
        (rows) => {
          const d = deriveGraph(input(['A', 'B', 'C'], rows));
          const r = resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, null);
          const m = coverageMatrix(d, r);
          expect(m.cells.length).toBe(r.rowAxis?.parameters.length ?? 0);
          for (const row of m.cells) {
            expect(row.length).toBe(r.colAxis?.parameters.length ?? 0);
            for (const cell of row) {
              if (cell.context === null) continue;
              expect(cell.context.complete).toBe(true);
              expect(cell.context.tupleKey).toBe(tupleKeyOf(cell.bindings));
            }
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------

describe('GRAPH-07 ring layout', () => {
  test('GRAPH-07 one arc per dimension with a dot per parameter, on the ring radius', () => {
    const d = deriveGraph(
      input(
        ['A', 'B', 'C'],
        [
          ['x', 'y', 'z'],
          ['w', 'y', 'q'],
        ],
      ),
    );
    const l = ringLayout(d);
    expect(l.arcs.length).toBe(3);
    expect(l.dots.map((x) => x.value)).toEqual(['x', 'w', 'y', 'z', 'q']);
    for (const dot of l.dots) {
      const r = Math.hypot(dot.at.x - RING_CENTRE, dot.at.y - RING_CENTRE);
      expect(r).toBeCloseTo(RING_RADIUS, 6);
      const arc = l.arcs[dot.dimensionIndex];
      expect(arc).toBeDefined();
      if (arc !== undefined) {
        expect(dot.angle).toBeGreaterThan(arc.startAngle);
        expect(dot.angle).toBeLessThan(arc.endAngle);
      }
    }
    expect(l.viewBox).toBe('-40 -40 600 600');
  });

  test('GRAPH-07 contexts sit on concentric orbits of 1, 6, 12, 18 …', () => {
    expect(orbitsFor(0)).toEqual([]);
    expect(orbitsFor(1).map((o) => o.orbit)).toEqual([0]);
    const twenty = orbitsFor(20).map((o) => o.orbit);
    expect(twenty.filter((k) => k === 0).length).toBe(1);
    expect(twenty.filter((k) => k === 1).length).toBe(6);
    expect(twenty.filter((k) => k === 2).length).toBe(12);
    expect(twenty.filter((k) => k === 3).length).toBe(1);
    const d = deriveGraph(
      input(
        ['A'],
        Array.from({ length: 20 }, (_, i) => [`v${String(i)}`]),
      ),
    );
    const l = ringLayout(d);
    expect(l.nodes[0]?.at).toEqual({ x: RING_CENTRE, y: RING_CENTRE });
    const radii = l.nodes.map((n) => Math.hypot(n.at.x - RING_CENTRE, n.at.y - RING_CENTRE));
    // Each orbit is inside the arcs, and the outer orbit is further out than the inner.
    expect(Math.max(...radii)).toBeLessThan(RING_RADIUS - 40);
    expect(radii[1]).toBeLessThan(radii[7] ?? 0);
    expect(l.nodeRadius).toBe(12);
  });

  test('GRAPH-07 property: the layout is deterministic and every node stays inside the ring', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(
          fc.array(fc.constantFrom('', 'a', 'b', 'c', 'd', 'e'), { minLength: 5, maxLength: 5 }),
          {
            maxLength: 60,
          },
        ),
        (dimCount, rows) => {
          const d = deriveGraph(
            input(
              Array.from({ length: dimCount }, (_, i) => `D${String(i)}`),
              rows.map((r) => r.slice(0, dimCount)),
            ),
          );
          const a = ringLayout(d);
          const b = ringLayout(d);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          expect(a.nodes.length).toBe(d.contexts.length);
          for (const n of a.nodes) {
            expect(Math.hypot(n.at.x - RING_CENTRE, n.at.y - RING_CENTRE)).toBeLessThan(
              RING_RADIUS,
            );
          }
          expect(a.dots.length).toBe(d.dimensions.reduce((acc, x) => acc + x.parameters.length, 0));
        },
      ),
    );
  });

  test('GRAPH-09 adjacency: a context lights its parameters; a parameter lights its contexts; spokes join them', () => {
    const d = deriveGraph(
      input(
        ['A', 'B'],
        [
          ['x', 'y'],
          ['x', ''],
          ['w', 'y'],
        ],
      ),
    );
    const byContext = adjacencyOf(d, { role: 'context', id: 'r0' });
    expect([...byContext.contextIds]).toEqual(['r0']);
    expect([...byContext.dotKeys].sort()).toEqual(['d0|x', 'd1|y']);
    const byParam = adjacencyOf(d, { role: 'parameter', key: 'd0|x' });
    expect([...byParam.contextIds]).toEqual(['r0', 'r1']);
    expect([...byParam.dotKeys]).toEqual(['d0|x']);
    expect(adjacencyOf(d, null).contextIds.size).toBe(0);
    expect(adjacencyOf(d, { role: 'context', id: 'nope' }).dotKeys.size).toBe(0);
    const l = ringLayout(d);
    expect(spokesFor(l, d, 'r0').map((s) => s.dotKey)).toEqual(['d0|x', 'd1|y']);
    expect(spokesFor(l, d, 'r1').map((s) => s.dotKey)).toEqual(['d0|x']);
    expect(spokesFor(l, d, 'nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Document mutations
// ---------------------------------------------------------------------------

describe('GRAPH-01 GRAPH-02 graph objects in the document', () => {
  test('GRAPH-01 a pair is a linked ring and coverage placed side by side below the sheet’s tables', () => {
    const { gd, sheetId, tableId } = fixture();
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('table');
    const tableBounds = tableUnitBounds(table);
    const pair = createGraphPair(gd, { sheetId, tableId });
    const graphs = graphsOnSheet(gd, sheetId);
    expect(graphs.map((g) => g.kind)).toEqual(['ring', 'coverage']);
    const [ring, coverage] = graphs;
    expect(ring?.gridRow).toBe(tableBounds.row + tableBounds.rows + 1);
    expect(ring?.gridCol).toBe(tableBounds.col);
    expect(coverage?.gridRow).toBe(ring?.gridRow);
    expect(coverage?.gridCol).toBe((ring?.gridCol ?? 0) + (ring?.widthUnits ?? 0) + 1);
    expect(ring?.widthUnits).toBe(6);
    expect(ring?.heightUnits).toBe(28);
    expect(graphsInPair(gd, pair.pairId).map((g) => g.id)).toEqual([pair.ringId, pair.coverageId]);
    // DOC-07: Fit frames graphs with the tables.
    const bounds = sheetBounds(gd, sheetId);
    expect(bounds?.rows).toBe(tableBounds.rows + 1 + 28);
  });

  test('GRAPH-02 a pair shares table, dimensions and slice; position and size are per object', () => {
    const { gd, sheetId, tableId, cols } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId });
    const dims = setGraphDimensions(gd, pair.pairId, [cols[2] ?? '', cols[0] ?? '']);
    expect(dims).toEqual([cols[2], cols[0]]);
    setGraphSlice(gd, pair.pairId, {
      rowAxis: cols[2] ?? null,
      colAxis: null,
      pins: { [cols[0] ?? '']: 'x' },
    });
    setGraphPosition(gd, pair.coverageId, { col: 20, row: 3 });
    setGraphSize(gd, pair.coverageId, { widthUnits: 9, heightUnits: 30 });
    const ring = graphById(gd, pair.ringId);
    const coverage = graphById(gd, pair.coverageId);
    expect(ring?.dimensions).toEqual([cols[2], cols[0]]);
    expect(coverage?.dimensions).toEqual([cols[2], cols[0]]);
    expect(coverage?.slice).toEqual(ring?.slice);
    expect(ring?.slice.pins[cols[0] ?? '']).toBe('x');
    expect(coverage?.gridCol).toBe(20);
    expect(ring?.gridCol).not.toBe(20);
    expect(coverage?.widthUnits).toBe(9);
    expect(ring?.widthUnits).toBe(6);
  });

  test('GRAPH-11 positions and sizes snap to the lattice and never go below the minimum box', () => {
    const { gd, sheetId, tableId } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId });
    setGraphPosition(gd, pair.ringId, { x: 165, y: 34 });
    expect(graphById(gd, pair.ringId)).toMatchObject({ gridCol: 1, gridRow: 2 });
    setGraphPosition(gd, pair.ringId, { col: -3, row: 2.4 });
    expect(graphById(gd, pair.ringId)).toMatchObject({ gridCol: 0, gridRow: 2 });
    expect(setGraphSize(gd, pair.ringId, { widthUnits: 0.4, heightUnits: 100.6 })).toEqual({
      widthUnits: 2,
      heightUnits: 101,
    });
  });

  test('GRAPH-03 GRAPH-05 an unbound pair binds to a table; Re-point resets dimensions and slice', () => {
    const { gd, sheetId, tableId, cols } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId: null });
    expect(graphById(gd, pair.ringId)?.tableId).toBeNull();
    expect(graphById(gd, pair.ringId)?.dimensions).toEqual([]);
    expect(bindGraphPair(gd, pair.pairId, 'nope')).toBe(false);
    expect(bindGraphPair(gd, pair.pairId, tableId)).toBe(true);
    expect(graphById(gd, pair.coverageId)?.tableId).toBe(tableId);
    expect(graphById(gd, pair.coverageId)?.dimensions).toEqual(cols);
    setGraphSlice(gd, pair.pairId, { rowAxis: cols[1] ?? null, colAxis: null, pins: {} });
    const other = createTable(gd, { sheetId, at: { col: 10, row: 1 }, columns: 5 });
    expect(bindGraphPair(gd, pair.pairId, other)).toBe(true);
    const rebound = graphById(gd, pair.ringId);
    expect(rebound?.dimensions.length).toBe(3);
    expect(rebound?.slice).toEqual({ rowAxis: null, colAxis: null, pins: {} });
  });

  test('REF-05 derived, linked and pulled columns are never dimensions: defaults skip them, the checklist refuses them', () => {
    const { gd, sheetId, tableId, cols } = fixture();
    addDerivedColumn(gd, tableId, { sourceColId: cols[0] ?? '', method: 'Extract', args: ['/x/'] });
    addMappingColumn(gd, tableId, { tableId, colId: cols[1] ?? '' });
    const record = tableById(gd, tableId);
    const derived = record?.columns.find((c) => c.source === 'derived')?.id ?? '';
    const linked = record?.columns.find((c) => c.source === 'linked')?.id ?? '';
    expect(defaultDimensions(record ?? ({ columns: [] } as never))).toEqual(cols);
    const pair = createGraphPair(gd, { sheetId, tableId });
    expect(setGraphDimensions(gd, pair.pairId, [derived, linked, cols[0] ?? ''])).toEqual([
      cols[0],
    ]);
    expect(toggleGraphDimension(gd, pair.pairId, derived, true)).toEqual([cols[0]]);
    expect(toggleGraphDimension(gd, pair.pairId, cols[2] ?? '', true)).toEqual([cols[0], cols[2]]);
    expect(toggleGraphDimension(gd, pair.pairId, cols[0] ?? '', false)).toEqual([cols[2]]);
  });

  test('GRAPH-05 Remove takes both halves in one step', () => {
    const { gd, sheetId, tableId } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId });
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    expect(removeGraphPair(gd, pair.pairId).sort()).toEqual([pair.coverageId, pair.ringId].sort());
    expect(transactions).toBe(1);
    expect(graphsOnSheet(gd, sheetId)).toEqual([]);
  });

  test('GRAPH-02 ADR-047 removing one half leaves the other bound to the table, in one transaction, and the lone half still takes every pair mutation', () => {
    const { gd, sheetId, tableId, cols } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId });
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    expect(removeGraphObject(gd, pair.pairId, 'ring')).toBe(pair.ringId);
    expect(transactions).toBe(1);
    expect(removeGraphObject(gd, pair.pairId, 'ring')).toBeNull();
    expect(removeGraph(gd, pair.ringId)).toBe(false);
    const survivors = graphsInPair(gd, pair.pairId);
    expect(survivors.map((g) => g.id)).toEqual([pair.coverageId]);
    expect(survivors[0]?.tableId).toBe(tableId);
    // The lone coverage carries the shared state, so the pair mutations keep working on it.
    expect(setGraphDimensions(gd, pair.pairId, [cols[1] ?? ''])).toEqual([cols[1]]);
    expect(toggleGraphDimension(gd, pair.pairId, cols[2] ?? '', true)).toEqual([cols[1], cols[2]]);
    setGraphSlice(gd, pair.pairId, { rowAxis: cols[2] ?? null, colAxis: null, pins: {} });
    expect(graphById(gd, pair.coverageId)?.slice.rowAxis).toBe(cols[2]);
    const other = createTable(gd, { sheetId, at: { col: 10, row: 1 }, columns: 2 });
    expect(bindGraphPair(gd, pair.pairId, other)).toBe(true);
    expect(graphById(gd, pair.coverageId)?.tableId).toBe(other);
    // The other half goes the same way (by id this time); then the pair is gone.
    expect(removeGraph(gd, pair.coverageId)).toBe(true);
    expect(graphsInPair(gd, pair.pairId)).toEqual([]);
    expect(removeGraphObject(gd, pair.pairId, 'coverage')).toBeNull();
  });

  test('GRAPH-06 ADR-047 a lone half derives from its table like a whole pair', () => {
    const { gd, sheetId, tableId, rows, cols } = fixture();
    fill(gd, tableId, rows, cols, [
      ['a', 'x', '1'],
      ['b', 'x', '2'],
      ['a', 'y', '1'],
    ]);
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('table');
    const pair = createGraphPair(gd, { sheetId, tableId });
    const whole = deriveGraph(
      graphInputOf(table, graphById(gd, pair.ringId)?.dimensions ?? [], (r, c) =>
        cellText(table, r, c),
      ),
    );
    removeGraphObject(gd, pair.pairId, 'ring');
    const lone = graphsInPair(gd, pair.pairId)[0];
    if (lone === undefined) throw new Error('lone half');
    const derived = deriveGraph(
      graphInputOf(table, lone.dimensions, (r, c) => cellText(table, r, c)),
    );
    expect(derived).toEqual(whole);
    expect(derived.contexts.length).toBe(3);
    expect(coverageLabel(derived)).toBe(coverageLabel(whole));
  });

  test('GRAPH-02 GRAPH-11 ADR-047 collapse is per object, keeps position and size, is one undo step, and the footprint is one row', () => {
    const { gd, sheetId, tableId } = fixture();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const pair = createGraphPair(gd, { sheetId, tableId });
    setGraphSize(gd, pair.coverageId, { widthUnits: 9, heightUnits: 40 });
    setGraphPosition(gd, pair.coverageId, { col: 20, row: 3 });
    undo.stopCapturing();
    const before = sheetBounds(gd, sheetId);
    expect(before?.rows).toBe(3 + 40 - (before?.row ?? 0));
    expect(graphById(gd, pair.coverageId)?.collapsed).toBe(false);
    expect(setGraphCollapsed(gd, pair.coverageId, true)).toBe(true);
    expect(setGraphCollapsed(gd, pair.coverageId, true)).toBe(false);
    const collapsed = graphById(gd, pair.coverageId);
    expect(collapsed).toMatchObject({
      collapsed: true,
      gridCol: 20,
      gridRow: 3,
      widthUnits: 9,
      heightUnits: 40,
    });
    expect(graphById(gd, pair.ringId)?.collapsed).toBe(false);
    if (collapsed === null) throw new Error('coverage');
    expect(graphUnitBounds(collapsed)).toEqual({ col: 20, row: 3, cols: 9, rows: 1 });
    // DOC-07: Fit frames the strip, not the stored box.
    expect(sheetBounds(gd, sheetId)?.rows).toBeLessThan(before?.rows ?? 0);
    // Expand restores the stored size exactly.
    expect(setGraphCollapsed(gd, pair.coverageId, false)).toBe(true);
    expect(graphById(gd, pair.coverageId)).toMatchObject({
      collapsed: false,
      widthUnits: 9,
      heightUnits: 40,
    });
    expect(sheetBounds(gd, sheetId)).toEqual(before);
    // One undo step per toggle.
    undo.stopCapturing();
    undo.undo();
    expect(graphById(gd, pair.coverageId)?.collapsed).toBe(true);
    undo.undo();
    expect(graphById(gd, pair.coverageId)?.collapsed).toBe(false);
    undo.redo();
    expect(graphById(gd, pair.coverageId)?.collapsed).toBe(true);
  });

  test('GRAPH-02 ADR-047 two replicas converge on a half deleted and the other collapsed apart', () => {
    const a = openDocument(new Y.Doc());
    const sheetId = createSheet(a);
    const tableId = createTable(a, { sheetId, at: { col: 1, row: 1 }, columns: 3 });
    const pair = createGraphPair(a, { sheetId, tableId });
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    // Apart: A deletes the ring, B collapses the coverage and re-dimensions the pair.
    expect(removeGraphObject(a, pair.pairId, 'ring')).toBe(pair.ringId);
    expect(setGraphCollapsed(b, pair.coverageId, true)).toBe(true);
    const cols = tableById(b, tableId)?.columns.map((c) => c.id) ?? [];
    setGraphDimensions(b, pair.pairId, [cols[0] ?? '']);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    for (const gd of [a, b]) {
      expect(graphsInPair(gd, pair.pairId).map((g) => g.id)).toEqual([pair.coverageId]);
      expect(graphById(gd, pair.coverageId)).toMatchObject({
        collapsed: true,
        dimensions: [cols[0]],
        tableId,
      });
    }
    expect(JSON.stringify(a.graphs.toJSON())).toBe(JSON.stringify(b.graphs.toJSON()));
    // Concurrent collapse and expand of the same half land the same way on both.
    setGraphCollapsed(a, pair.coverageId, false);
    setGraphCollapsed(b, pair.coverageId, false);
    setGraphCollapsed(b, pair.coverageId, true);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    expect(graphById(a, pair.coverageId)?.collapsed).toBe(graphById(b, pair.coverageId)?.collapsed);
  });

  test('ADR-047 deleting a table takes every graph bound to it, in one transaction that one undo restores', () => {
    const { gd, sheetId, tableId, rows, cols } = fixture();
    fill(gd, tableId, rows, cols, [['kept', 'x', '1']]);
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const pair = createGraphPair(gd, { sheetId, tableId });
    const other = createTable(gd, { sheetId, at: { col: 10, row: 1 }, columns: 2 });
    const otherPair = createGraphPair(gd, { sheetId, tableId: other });
    const unbound = createGraphPair(gd, { sheetId, tableId: null });
    undo.stopCapturing();
    expect(graphsBoundTo(gd, tableId).map((g) => g.id)).toEqual([pair.ringId, pair.coverageId]);
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    expect(deleteTableWithGraphs(gd, tableId)?.sort()).toEqual(
      [pair.ringId, pair.coverageId].sort(),
    );
    expect(transactions).toBe(1);
    expect(tableById(gd, tableId)).toBeNull();
    expect(graphsInPair(gd, pair.pairId)).toEqual([]);
    // Pairs bound elsewhere, and unbound pairs, stay.
    expect(graphsInPair(gd, otherPair.pairId).length).toBe(2);
    expect(graphsInPair(gd, unbound.pairId).length).toBe(2);
    expect(deleteTableWithGraphs(gd, tableId)).toBeNull();
    undo.stopCapturing();
    undo.undo();
    const restored = tableMap(gd, tableId);
    expect(restored).not.toBeNull();
    if (restored === null) throw new Error('table');
    expect(cellText(restored, rows[0] ?? '', cols[0] ?? '')).toBe('kept');
    expect(graphsInPair(gd, pair.pairId).map((g) => g.id)).toEqual([pair.ringId, pair.coverageId]);
    expect(graphById(gd, pair.ringId)?.tableId).toBe(tableId);
  });

  test('GRAPH-04 "Add shaped table" creates Dimension A · B · C · Notes and binds a pair in one step', () => {
    const { gd, sheetId } = fixture();
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    const made = createShapedTableWithGraph(gd, { sheetId, at: { col: 8, row: 1 } });
    expect(transactions).toBe(1);
    const record = tableById(gd, made.tableId);
    expect(record?.columns.map((c) => c.label)).toEqual([...SHAPED_TABLE_COLUMNS]);
    expect(record?.rows.length).toBe(6);
    const ring = graphById(gd, made.ringId);
    expect(ring?.tableId).toBe(made.tableId);
    expect(ring?.dimensions).toEqual(record?.columns.slice(0, 3).map((c) => c.id));
    const table = tableMap(gd, made.tableId);
    const b = table === null ? null : tableUnitBounds(table);
    expect(ring?.gridRow).toBe((b?.row ?? 0) + (b?.rows ?? 0) + 1);
  });

  test('GRAPH-10 an appended row carries its pre-filled tuple in one undo step; a child sheet is named after the symbol', () => {
    const { gd, tableId, cols } = fixture();
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    const rowId = appendRowWithValues(gd, tableId, {
      [cols[0] ?? '']: 'Nepal',
      [cols[1] ?? '']: 'Spring',
    });
    expect(transactions).toBe(1);
    expect(appendRowWithValues(gd, 'nope', {})).toBeNull();
    transactions = 1; // an empty transaction still fires afterTransaction
    const table = tableMap(gd, tableId);
    if (table === null || rowId === null) throw new Error('row');
    const i = graphInputOf(table, cols);
    expect(i.rows.at(-1)?.values).toMatchObject({
      [cols[0] ?? '']: 'Nepal',
      [cols[1] ?? '']: 'Spring',
    });

    const child = createChildSheet(gd, { symbol: 'β', tupleKey: 'Nepal · Spring' });
    expect(transactions).toBe(2);
    const sheet = listSheets(gd).find((s) => s.id === child.sheetId);
    expect(sheet?.label).toBe('β');
    expect(sheet?.parentContext).toBe('β — Nepal · Spring');
    const tables = tablesOnSheet(gd, child.sheetId);
    expect(tables.map((t) => t.title)).toEqual(['Children of β']);
    expect(tables[0]?.columns.map((c) => c.label)).toEqual([...SHAPED_TABLE_COLUMNS]);
  });

  test('GRAPH-06 the input reads the table live: values, eligibility and the excluded row kinds', () => {
    const { gd, tableId, rows, cols } = fixture();
    fill(gd, tableId, rows, cols, [
      ['Nepal', 'Spring', 'x'],
      ['India', 'Spring', 'y'],
    ]);
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('table');
    const d = deriveGraph(graphInputOf(table, [cols[0] ?? '', cols[1] ?? '']));
    expect(d.contexts.length).toBe(2);
    expect(d.tupleSpace).toBe(2);
    expect(coverageLabel(d)).toBe('2 / 2');
    // A formula cell contributes what the injected reader says (the engine's value in the browser).
    setCellText(gd, tableId, rows[2] ?? '', cols[0] ?? '', '=Concat("Ne", "pal")');
    const evaluated = deriveGraph(
      graphInputOf(table, [cols[0] ?? ''], (rowId, colId) =>
        rowId === rows[2] && colId === cols[0] ? 'Nepal' : cellText(table, rowId, colId),
      ),
    );
    expect(evaluated.dimensions[0]?.parameters.map((p) => p.value)).toEqual(['Nepal', 'India']);
    expect(evaluated.dimensions[0]?.parameters[0]?.contextIds).toEqual([rows[0], rows[2]]);
  });

  test('GRAPH-02 two replicas converge on a pair edited apart, half by half', () => {
    const a = openDocument(new Y.Doc());
    const sheetId = createSheet(a);
    const tableId = createTable(a, { sheetId, at: { col: 1, row: 1 }, columns: 3 });
    const pair = createGraphPair(a, { sheetId, tableId });
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const cols = tableById(a, tableId)?.columns.map((c) => c.id) ?? [];
    // Apart: A narrows the dimensions, B moves the coverage and pins a value.
    setGraphDimensions(a, pair.pairId, [cols[1] ?? '']);
    setGraphPosition(b, pair.coverageId, { col: 30, row: 40 });
    setGraphSlice(b, pair.pairId, { rowAxis: null, colAxis: null, pins: { [cols[2] ?? '']: 'z' } });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    for (const gd of [a, b]) {
      const ring = graphById(gd, pair.ringId);
      const coverage = graphById(gd, pair.coverageId);
      expect(ring?.dimensions).toEqual([cols[1]]);
      expect(coverage?.dimensions).toEqual([cols[1]]);
      expect(coverage?.gridCol).toBe(30);
      expect(ring?.slice.pins).toEqual({ [cols[2] ?? '']: 'z' });
      expect(coverage?.slice).toEqual(ring?.slice);
    }
    expect(JSON.stringify(a.graphs.toJSON())).toBe(JSON.stringify(b.graphs.toJSON()));
    // Concurrent writes to the same shared key land the same way on both halves.
    setGraphDimensions(a, pair.pairId, [cols[0] ?? '']);
    setGraphDimensions(b, pair.pairId, [cols[2] ?? '']);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    const ringA = graphById(a, pair.ringId)?.dimensions;
    expect(graphById(b, pair.ringId)?.dimensions).toEqual(ringA);
    expect(graphById(a, pair.coverageId)?.dimensions).toEqual(ringA);
    expect(graphById(b, pair.coverageId)?.dimensions).toEqual(ringA);
  });

  test('GRAPH-03 a graph whose table was deleted elsewhere reads as unbound (nothing crashes)', () => {
    const { gd, sheetId, tableId } = fixture();
    const pair = createGraphPair(gd, { sheetId, tableId });
    gd.tables.delete(tableId);
    const ring = graphById(gd, pair.ringId);
    expect(ring?.tableId).toBe(tableId);
    expect(tableById(gd, ring?.tableId ?? '')).toBeNull();
    expect(setGraphDimensions(gd, pair.pairId, ['anything'])).toEqual([]);
  });
});

describe('GREEK_SYMBOLS', () => {
  test('GRAPH-06 the alphabet has 24 letters α…ω', () => {
    expect(GREEK_SYMBOLS.length).toBe(24);
    expect(GREEK_SYMBOLS[0]).toBe('α');
    expect(GREEK_SYMBOLS[23]).toBe('ω');
  });
});
