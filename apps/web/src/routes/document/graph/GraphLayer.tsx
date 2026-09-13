import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  graphsOnSheet,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  unitBoundsToPx,
  type GedeDoc,
  type GraphDerivation,
  type GraphEmphasis,
  type GraphRecord,
  type Id,
  type RingLayout,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import type { CellSelection } from '../selection.js';
import { CoverageGraph } from './CoverageGraph.js';
import { GraphObject, UnboundBody } from './GraphObject.js';
import { RingGraph } from './RingGraph.js';
import { useGraphHover } from './store.js';
import { useGraphModel } from './use-graph-model.js';
import type { Graphs, GraphsActions } from './use-graphs.js';

export interface GraphLayerProps {
  gd: GedeDoc;
  sheetId: Id | null;
  graphs: Graphs;
  /** The selected cell, for the soft emphasis of its row and the coverage pins (GRAPH-08). */
  selectedCell: CellSelection | null;
  editable: boolean;
  /** The layer's zoom, for drag maths. */
  zoom: number;
}

/**
 * Every graph pair on the sheet, inside the canvas layer so they pan and
 * zoom with the tables (GRAPH-01), plus the pointing overlay (GRAPH-03).
 * One model per pair: both halves read the same derivation.
 */
export function GraphLayer({ gd, sheetId, graphs, selectedCell, editable, zoom }: GraphLayerProps) {
  const graphsVersion = useYVersion(gd.graphs);
  useYVersion(gd.tables, { depth: 'shallow' });
  // Records are rebuilt only when the graphs map changes, so the memoised halves see
  // the same objects across the shell's other renders.
  const pairs = useMemo(() => {
    const all = sheetId === null ? [] : graphsOnSheet(gd, sheetId);
    const byPair = new Map<Id, GraphRecord[]>();
    for (const g of all) {
      const list = byPair.get(g.pairId) ?? [];
      list.push(g);
      byPair.set(g.pairId, list);
    }
    return [...byPair.entries()];
    // graphsVersion is the change signal for the map read above.
  }, [gd, sheetId, graphsVersion]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const scale = useCallback(() => zoomRef.current, []);
  const pointing = graphs.state.pointing;
  return (
    <>
      {pairs.map(([pairId, halves]) => (
        <GraphPairView
          key={pairId}
          gd={gd}
          halves={halves}
          graphs={graphs}
          selectedCell={selectedCell}
          editable={editable}
          scale={scale}
        />
      ))}
      {pointing !== null && editable && sheetId !== null && (
        <PointingOverlay gd={gd} sheetId={sheetId} graphs={graphs} />
      )}
    </>
  );
}

function GraphPairView({
  gd,
  halves,
  graphs,
  selectedCell,
  editable,
  scale,
}: {
  gd: GedeDoc;
  halves: readonly GraphRecord[];
  graphs: Graphs;
  selectedCell: CellSelection | null;
  editable: boolean;
  scale: () => number;
}) {
  const lead = halves.find((h) => h.kind === 'ring') ?? halves[0];
  if (lead === undefined) throw new RangeError('a pair with no halves');
  const model = useGraphModel(gd, lead);
  const { state, actions } = graphs;
  const sourceTitle = model.record?.title ?? null;
  const selectedRowId =
    selectedCell !== null && selectedCell.tableId === lead.tableId ? selectedCell.rowId : null;
  const hover = useGraphHover(gd.doc, lead.pairId);
  // GRAPH-09: the hover wins; otherwise the selected row dims softly (PRD §19 "selection dims
  // softly"). Memoised so the halves see one object per state.
  const { derivation } = model;
  const selection = useMemo<GraphEmphasis | null>(
    () =>
      selectedRowId !== null && derivation.contexts.some((c) => c.id === selectedRowId)
        ? { role: 'context', id: selectedRowId }
        : null,
    [selectedRowId, derivation],
  );
  const emphasis = hover ?? selection;
  return (
    <>
      {halves.map((graph) => (
        <GraphHalf
          key={graph.id}
          graph={graph}
          derivation={derivation}
          layout={model.ring}
          sourceTitle={sourceTitle}
          selected={state.selectedGraphId === graph.id}
          editable={editable}
          actions={actions}
          scale={scale}
          emphasis={emphasis}
          hovering={hover !== null}
          selectedRowId={selectedRowId}
        />
      ))}
    </>
  );
}

interface GraphHalfProps {
  graph: GraphRecord;
  derivation: GraphDerivation;
  layout: RingLayout;
  sourceTitle: string | null;
  selected: boolean;
  editable: boolean;
  actions: GraphsActions;
  scale: () => number;
  emphasis: GraphEmphasis | null;
  hovering: boolean;
  selectedRowId: Id | null;
}

/**
 * One half, memoised on the derived model: a change elsewhere in the
 * document that leaves the derivation structurally equal renders nothing
 * here (review of #90, finding 6; PRD §20 keystroke budget).
 */
const GraphHalf = memo(function GraphHalf({
  graph,
  derivation,
  layout,
  sourceTitle,
  selected,
  editable,
  actions,
  scale,
  emphasis,
  hovering,
  selectedRowId,
}: GraphHalfProps) {
  return (
    <GraphObject
      graph={graph}
      derivation={derivation}
      sourceTitle={sourceTitle}
      selected={selected}
      editable={editable}
      actions={actions}
      scale={scale}
    >
      {sourceTitle === null ? (
        <UnboundBody pairId={graph.pairId} editable={editable} actions={actions} />
      ) : graph.kind === 'ring' ? (
        <RingGraph
          graph={graph}
          derivation={derivation}
          layout={layout}
          sourceTitle={sourceTitle}
          emphasis={emphasis}
          hovering={hovering}
          selectedRowId={selectedRowId}
          editable={editable}
          actions={actions}
        />
      ) : (
        <CoverageGraph
          graph={graph}
          derivation={derivation}
          sourceTitle={sourceTitle}
          emphasis={emphasis}
          hovering={hovering}
          selectedRowId={selectedRowId}
          editable={editable}
          actions={actions}
        />
      )}
    </GraphObject>
  );
});

/**
 * GRAPH-03 pointing mode: every table on the sheet takes a dashed accent
 * outline that is itself the target — a button named after the table, so
 * the keyboard binds as well as the pointer. The banner lives in the shell.
 * The targets carry the tour's `pointing` anchor (ONB-04): step 3's `point`
 * card spotlights all of them at once.
 */
function PointingOverlay({ gd, sheetId, graphs }: { gd: GedeDoc; sheetId: Id; graphs: Graphs }) {
  const tables = tablesOnSheet(gd, sheetId);
  // A11Y-01: entering pointing mode hands focus to the first target, so the keyboard binds
  // with Enter (Tab walks the others, Escape cancels) without crossing the grid's own Tab
  // traversal (GRID-05). The plane is not a scroller, so focus must not try to scroll it.
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="gd-pointing" data-testid="pointing-overlay">
      {tables.map((record, i) => {
        const map = tableMap(gd, record.id);
        if (map === null) return null;
        const px = unitBoundsToPx(tableUnitBounds(map, record));
        return (
          <button
            key={record.id}
            ref={i === 0 ? first : undefined}
            type="button"
            className="gd-pointing__target"
            style={{
              left: `${String(px.x)}px`,
              top: `${String(px.y)}px`,
              width: `${String(px.width)}px`,
              height: `${String(px.height)}px`,
            }}
            aria-label={`Bind the graph to ${record.title}`}
            data-testid="pointing-target"
            data-tour="pointing"
            data-table-id={record.id}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              graphs.actions.pointAt(record.id);
            }}
          >
            <span className="gd-mono gd-pointing__label">{record.title}</span>
          </button>
        );
      })}
    </div>
  );
}
