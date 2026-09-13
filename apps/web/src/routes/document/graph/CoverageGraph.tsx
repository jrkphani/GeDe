import clsx from 'clsx';
import { memo, useMemo } from 'react';
import {
  adjacencyOf,
  cellWriteBack,
  coverageMatrix,
  describeTuple,
  resolveSlice,
  truncateLabel,
  type GraphDerivation,
  type GraphEmphasis,
  type GraphRecord,
  type GraphSlice,
  type Id,
} from '@gede/core';

import { activation, useRoving } from './roving.js';
import { hoverFor } from './store.js';
import type { GraphsActions } from './use-graphs.js';

export interface CoverageGraphProps {
  graph: GraphRecord;
  derivation: GraphDerivation;
  sourceTitle: string;
  emphasis: GraphEmphasis | null;
  hovering: boolean;
  selectedRowId: Id | null;
  editable: boolean;
  actions: GraphsActions;
}

/** Cell pitch in SVG units — one lattice row, so a cell reads as a row. */
export const COVERAGE_CELL = 22;
/** Width of the row-label column and height of the column-label band. */
const LABEL_COLUMN = 110;
const LABEL_BAND = 78;
const ROW_LABEL_MAX = 18;

function shortLabel(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * The coverage matrix (GRAPH-08) on SVG: one 2-D slice with the row and
 * column dimensions on the axes and every other dimension pinned. A filled
 * cell carries its context's symbol; an empty cell is unexplored and, when
 * editable, appends a pre-filled row on click (GRAPH-10). Hover mutes what
 * is not adjacent across the pair (GRAPH-09).
 */
/** GRAPH-08: "rows Region · columns Season", or "rows Region" when one dimension serves both axes. */
function axesLine(
  rowAxis: { readonly id: string; readonly label: string },
  colAxis: { readonly id: string; readonly label: string },
): string {
  return rowAxis.id === colAxis.id
    ? `rows ${rowAxis.label}`
    : `rows ${rowAxis.label} · columns ${colAxis.label}`;
}

/**
 * ADR-047: the axes line a collapsed coverage keeps in its header strip — the
 * same text its body shows, resolved the same way. Empty without dimensions.
 */
export function coverageAxesNote(
  derivation: GraphDerivation,
  slice: GraphSlice,
  selectedRowId: Id | null,
): string {
  if (derivation.dimensions.length === 0) return '';
  const matrix = coverageMatrix(derivation, resolveSlice(derivation, slice, selectedRowId));
  if (matrix.rowAxis === null || matrix.colAxis === null) return '';
  return axesLine(matrix.rowAxis, matrix.colAxis);
}

export const CoverageGraph = memo(function CoverageGraph({
  graph,
  derivation,
  sourceTitle,
  emphasis,
  hovering,
  selectedRowId,
  editable,
  actions,
}: CoverageGraphProps) {
  const resolved = useMemo(
    () => resolveSlice(derivation, graph.slice, selectedRowId),
    [derivation, graph.slice, selectedRowId],
  );
  const matrix = useMemo(() => coverageMatrix(derivation, resolved), [derivation, resolved]);
  const adjacency = useMemo(() => adjacencyOf(derivation, emphasis), [derivation, emphasis]);
  const rows = matrix.cells.length;
  const cols = matrix.cells[0]?.length ?? 0;
  const roving = useRoving(rows * cols);
  const tableId = graph.tableId;
  const muted = emphasis !== null;
  const hover = (e: GraphEmphasis | null) => {
    actions.setHover(e === null ? null : hoverFor(graph.pairId, tableId, derivation, e));
  };

  if (derivation.dimensions.length === 0) {
    return (
      <p className="gd-graph__note" data-testid="graph-no-dimensions">
        Mark at least one column as a dimension in the Graph inspector.
      </p>
    );
  }
  if (matrix.rowAxis === null || matrix.colAxis === null) return null;

  // One dimension: the axes coincide and the matrix is a single unlabelled column.
  const oneDimensional = matrix.rowAxis.id === matrix.colAxis.id;
  const colParams = oneDimensional ? [] : matrix.colAxis.parameters;
  const width = LABEL_COLUMN + cols * COVERAGE_CELL;
  const height = LABEL_BAND + rows * COVERAGE_CELL;
  const pinNote = matrix.pins.map((p) => `${p.dimension.label}: ${p.value}`).join(' · ');
  const axesNote = axesLine(matrix.rowAxis, matrix.colAxis);
  const svgName = oneDimensional
    ? `Coverage of ${sourceTitle}: ${matrix.rowAxis.label}`
    : `Coverage of ${sourceTitle}: ${matrix.rowAxis.label} by ${matrix.colAxis.label}`;

  return (
    <div className="gd-coverage">
      <p className="gd-mono gd-coverage__axes" data-testid="coverage-axes">
        {axesNote}
        {pinNote !== '' && (
          <span
            className="gd-coverage__pins"
            data-testid="coverage-pins"
          >{` · pinned ${pinNote}`}</span>
        )}
      </p>
      {rows === 0 || cols === 0 ? (
        <p className="gd-graph__note">Type into a row of the table to place the first context</p>
      ) : (
        <svg
          className={clsx('gd-coverage__grid', {
            'gd-coverage--hover': muted && hovering,
            'gd-coverage--soft': muted && !hovering,
          })}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          preserveAspectRatio="xMinYMin meet"
          role="group"
          aria-label={svgName}
          data-testid="coverage-graph"
          onKeyDown={(e) => {
            roving.onKeyDown(e);
          }}
          onPointerLeave={() => {
            hover(null);
          }}
        >
          {colParams.map((p, c) => (
            <text
              key={p.key}
              className="gd-mono gd-coverage__col-label"
              transform={`translate(${String(LABEL_COLUMN + c * COVERAGE_CELL + COVERAGE_CELL / 2 + 3)} ${String(LABEL_BAND - 6)}) rotate(-90)`}
            >
              {truncateLabel(p.value)}
            </text>
          ))}
          {matrix.rowAxis.parameters.map((p, r) => (
            <text
              key={p.key}
              className="gd-mono gd-coverage__row-label"
              x={LABEL_COLUMN - 8}
              y={LABEL_BAND + r * COVERAGE_CELL + COVERAGE_CELL / 2}
              textAnchor="end"
              dominantBaseline="central"
            >
              {shortLabel(p.value, ROW_LABEL_MAX)}
            </text>
          ))}
          <line
            className="gd-coverage__axis"
            x1={LABEL_COLUMN - 1}
            y1={LABEL_BAND}
            x2={LABEL_COLUMN - 1}
            y2={height}
          />
          {matrix.cells.map((row, r) =>
            row.map((cell, c) => {
              const index = r * cols + c;
              const hit = cell.context;
              const lit = hit !== null && adjacency.contextIds.has(hit.id);
              const selected = hit !== null && selectedRowId === hit.id;
              const x = LABEL_COLUMN + c * COVERAGE_CELL;
              const y = LABEL_BAND + r * COVERAGE_CELL;
              // The name says what each value is: "α: Region India, Quarter Q3".
              const tuple = describeTuple(derivation.dimensions, cell.bindings);
              const name =
                hit === null
                  ? `Unexplored: ${tuple}${editable ? '. Add a row' : ''}`
                  : `${hit.symbol}: ${tuple}`;
              return (
                <g
                  key={cell.lookupKey}
                  className={clsx('gd-coverage__cell', {
                    'gd-coverage__cell--filled': hit !== null,
                    'gd-coverage__cell--empty': hit === null,
                    'gd-coverage__cell--lit': lit,
                    'gd-coverage__cell--selected': selected,
                    'gd-coverage__cell--muted': muted && hit !== null && !lit,
                    'gd-coverage__cell--static': hit === null && !editable,
                  })}
                  role="button"
                  tabIndex={roving.tabIndex(index)}
                  aria-label={name}
                  aria-pressed={hit === null ? undefined : selected}
                  aria-disabled={hit === null && !editable ? true : undefined}
                  data-graph-item={index}
                  data-tuple={cell.tupleKey}
                  data-filled={hit !== null}
                  onFocus={() => {
                    roving.onFocus(index);
                    if (hit !== null) hover({ role: 'context', id: hit.id });
                  }}
                  onBlur={() => {
                    hover(null);
                  }}
                  onPointerEnter={() => {
                    if (hit !== null) hover({ role: 'context', id: hit.id });
                    else hover(null);
                  }}
                  onPointerDown={(e) => {
                    // Focus without scroll-into-view: the plane is a transformed layer, never a scroller.
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.focus({ preventScroll: true });
                    actions.select(graph.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tableId === null) return;
                    if (hit !== null) actions.selectRow(tableId, hit.id);
                    else if (editable) actions.appendRow(tableId, cellWriteBack(derivation, cell));
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (editable && hit !== null) actions.openChild(hit);
                  }}
                  onKeyDown={(e) => {
                    const what = activation(e);
                    if (what === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (tableId === null) return;
                    if (what === 'open') {
                      if (editable && hit !== null) actions.openChild(hit);
                      return;
                    }
                    // As a click: the graph is selected (the Graph tab opens) and then the cell acts (A11Y-01).
                    actions.select(graph.id);
                    if (hit !== null) actions.selectRow(tableId, hit.id);
                    else if (editable) actions.appendRow(tableId, cellWriteBack(derivation, cell));
                  }}
                >
                  <rect
                    className="gd-graph-focus"
                    x={x - 2}
                    y={y - 2}
                    width={COVERAGE_CELL + 4}
                    height={COVERAGE_CELL + 4}
                  />
                  <rect
                    className="gd-coverage__cell-box"
                    x={x}
                    y={y}
                    width={COVERAGE_CELL}
                    height={COVERAGE_CELL}
                  />
                  {hit !== null && (
                    <text
                      className="gd-mono gd-coverage__symbol"
                      x={x + COVERAGE_CELL / 2}
                      y={y + COVERAGE_CELL / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {hit.symbol}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </svg>
      )}
    </div>
  );
});
