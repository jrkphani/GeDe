/**
 * The coverage graph's 2-D slice (GRAPH-08): two dimensions on the axes,
 * every other dimension pinned to one parameter. Pins default to the
 * selected context's bindings so the slice shown contains the selection.
 */
import type { GraphSlice } from '../doc/schema.js';
import type { Id } from '../ids.js';
import {
  tupleKeyOf,
  type GraphContext,
  type GraphDerivation,
  type GraphDimension,
} from './derive.js';

export interface ResolvedPin {
  readonly dimension: GraphDimension;
  readonly value: string;
  /** True when the value came from the stored slice rather than a default. */
  readonly explicit: boolean;
}

export interface CoverageCell {
  readonly rowValue: string;
  readonly colValue: string;
  /** The complete tuple this cell stands for (dimension order), pins included. */
  readonly bindings: readonly string[];
  readonly tupleKey: string;
  /** The context covering the tuple (the last complete row with it), or null when unexplored. */
  readonly context: GraphContext | null;
}

export interface CoverageMatrix {
  readonly rowAxis: GraphDimension | null;
  readonly colAxis: GraphDimension | null;
  readonly pins: readonly ResolvedPin[];
  /** `cells[r][c]` for row parameter r and column parameter c. */
  readonly cells: readonly (readonly CoverageCell[])[];
}

export interface ResolvedSlice {
  readonly rowAxis: GraphDimension | null;
  readonly colAxis: GraphDimension | null;
  readonly pins: readonly ResolvedPin[];
}

/**
 * Which dimensions sit on the axes and what every other one is pinned to.
 * The row axis is the stored one when it is still a dimension, else the
 * first; the column axis the stored one when distinct from the row axis, else
 * the first other dimension. A one-dimensional graph uses that dimension for
 * both axes. Pins: the stored value while it is still a parameter, else the
 * selected context's binding, else the first parameter.
 */
export function resolveSlice(
  derivation: GraphDerivation,
  slice: GraphSlice,
  selectedContextId: Id | null,
): ResolvedSlice {
  const dims = derivation.dimensions;
  const rowAxis = dims.find((d) => d.id === slice.rowAxis) ?? dims[0] ?? null;
  const colAxis =
    dims.find((d) => d.id === slice.colAxis && d.id !== rowAxis?.id) ??
    dims.find((d) => d.id !== rowAxis?.id) ??
    rowAxis;
  const selected =
    selectedContextId === null
      ? null
      : (derivation.contexts.find((c) => c.id === selectedContextId) ?? null);
  const pins: ResolvedPin[] = [];
  for (const d of dims) {
    if (d.id === rowAxis?.id || d.id === colAxis?.id) continue;
    const stored = slice.pins[d.id];
    const hasStored = stored !== undefined && d.parameters.some((p) => p.value === stored);
    const fromSelection = selected?.bindings[d.index] ?? null;
    const value = hasStored
      ? stored
      : fromSelection !== null && d.parameters.some((p) => p.value === fromSelection)
        ? fromSelection
        : (d.parameters[0]?.value ?? '');
    pins.push({ dimension: d, value, explicit: hasStored });
  }
  return { rowAxis, colAxis, pins };
}

/** The matrix for a resolved slice. Only complete contexts fill cells; the last one wins per tuple. */
export function coverageMatrix(
  derivation: GraphDerivation,
  resolved: ResolvedSlice,
): CoverageMatrix {
  const { rowAxis, colAxis, pins } = resolved;
  if (rowAxis === null || colAxis === null) return { rowAxis, colAxis, pins, cells: [] };
  const byTuple = new Map<string, GraphContext>();
  for (const c of derivation.contexts) if (c.complete) byTuple.set(c.tupleKey, c);
  const pinByDim = new Map(pins.map((p) => [p.dimension.id, p.value]));
  const cells = rowAxis.parameters.map((rp) =>
    colAxis.parameters.map((cp): CoverageCell => {
      const bindings = derivation.dimensions.map((d) =>
        d.id === rowAxis.id
          ? rp.value
          : d.id === colAxis.id
            ? cp.value
            : (pinByDim.get(d.id) ?? ''),
      );
      const tupleKey = tupleKeyOf(bindings);
      return {
        rowValue: rp.value,
        colValue: cp.value,
        bindings,
        tupleKey,
        context: byTuple.get(tupleKey) ?? null,
      };
    }),
  );
  return { rowAxis, colAxis, pins, cells };
}

/**
 * The next slice after picking an axis (GRAPH-05 chips): choosing for one
 * axis the dimension already on the other swaps them so the two stay distinct.
 */
export function withAxis(
  slice: GraphSlice,
  resolved: ResolvedSlice,
  axis: 'row' | 'col',
  dimensionId: Id,
): GraphSlice {
  const currentRow = resolved.rowAxis?.id ?? null;
  const currentCol = resolved.colAxis?.id ?? null;
  if (axis === 'row') {
    const colAxis = dimensionId === currentCol ? currentRow : currentCol;
    return { ...slice, rowAxis: dimensionId, colAxis };
  }
  const rowAxis = dimensionId === currentRow ? currentCol : currentRow;
  return { ...slice, rowAxis, colAxis: dimensionId };
}

/** The next slice after pinning a dimension to a value. */
export function withPin(slice: GraphSlice, dimensionId: Id, value: string): GraphSlice {
  return { ...slice, pins: { ...slice.pins, [dimensionId]: value } };
}

/** The values a click on an empty cell writes back (GRAPH-10), keyed by dimension column id. */
export function cellWriteBack(derivation: GraphDerivation, cell: CoverageCell): Record<Id, string> {
  const out: Record<Id, string> = {};
  derivation.dimensions.forEach((d, i) => {
    const value = cell.bindings[i];
    if (value !== undefined && value !== '') out[d.id] = value;
  });
  return out;
}
