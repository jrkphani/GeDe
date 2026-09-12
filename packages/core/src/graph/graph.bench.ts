/**
 * Graph derivation budget (PRD §20, GRAPH-06 "recompute live"): one change
 * on a 160-row × 22-column table with four dimensions must re-derive, lay
 * out the ring and build the coverage matrix in under 16 ms.
 *
 * Run with `npx vitest bench src/graph` from packages/core. Not part of verify.
 */
import { bench, describe } from 'vitest';

import { coverageMatrix, resolveSlice } from './coverage.js';
import { deriveGraph, type GraphInput } from './derive.js';
import { ringLayout } from './ring.js';

const ROWS = 160;
const COLS = 22;
const DIMS = 4;

function table(tick: number): GraphInput {
  const columns = Array.from({ length: COLS }, (_, c) => ({
    id: `c${String(c)}`,
    label: `Column ${String(c + 1)}`,
    eligible: true,
  }));
  const rows = Array.from({ length: ROWS }, (_, r) => ({
    id: `r${String(r)}`,
    values: Object.fromEntries(
      columns.map((c, ci) => [c.id, `v${String((r * 7 + ci * 3 + tick) % 9)}`]),
    ),
  }));
  return { columns, rows, dimensions: columns.slice(0, DIMS).map((c) => c.id) };
}

describe('graph derivation budget (160 × 22, 4 dimensions)', () => {
  let tick = 0;
  bench('derive + ring layout + coverage matrix after one change (< 16 ms)', () => {
    tick += 1;
    const d = deriveGraph(table(tick));
    ringLayout(d);
    coverageMatrix(d, resolveSlice(d, { rowAxis: null, colAxis: null, pins: {} }, 'r3'));
  });
});
