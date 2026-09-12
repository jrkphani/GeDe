import { useCallback, useRef } from 'react';
import {
  graphsOnSheet,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  unitBoundsToPx,
  type GedeDoc,
  type GraphEmphasis,
  type GraphRecord,
  type Id,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import type { CellSelection } from '../selection.js';
import { CoverageGraph } from './CoverageGraph.js';
import { GraphObject, UnboundBody } from './GraphObject.js';
import { RingGraph } from './RingGraph.js';
import { useGraphModel } from './use-graph-model.js';
import type { Graphs } from './use-graphs.js';

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
  useYVersion(gd.graphs);
  useYVersion(gd.tables, { depth: 'shallow' });
  const all = sheetId === null ? [] : graphsOnSheet(gd, sheetId);
  const byPair = new Map<Id, GraphRecord[]>();
  for (const g of all) {
    const list = byPair.get(g.pairId) ?? [];
    list.push(g);
    byPair.set(g.pairId, list);
  }
  const pairs = [...byPair.entries()];
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
  const hover = state.hover?.pairId === lead.pairId ? state.hover.emphasis : null;
  // GRAPH-09: the hover wins; otherwise the selected row dims softly (PRD §19 "selection dims softly").
  const emphasis: GraphEmphasis | null =
    hover ??
    (selectedRowId !== null && model.derivation.contexts.some((c) => c.id === selectedRowId)
      ? { role: 'context', id: selectedRowId }
      : null);
  return (
    <>
      {halves.map((graph) => (
        <GraphObject
          key={graph.id}
          graph={graph}
          derivation={model.derivation}
          sourceTitle={sourceTitle}
          selected={state.selectedGraphId === graph.id}
          editable={editable}
          actions={actions}
          scale={scale}
        >
          {sourceTitle === null ? (
            <UnboundBody pairId={graph.pairId} editable={editable} actions={actions} />
          ) : graph.kind === 'ring' ? (
            <RingGraph
              graph={graph}
              derivation={model.derivation}
              layout={model.ring}
              sourceTitle={sourceTitle}
              emphasis={emphasis}
              hovering={hover !== null}
              selectedRowId={selectedRowId}
              editable={editable}
              actions={actions}
            />
          ) : (
            <CoverageGraph
              graph={graph}
              derivation={model.derivation}
              sourceTitle={sourceTitle}
              emphasis={emphasis}
              hovering={hover !== null}
              selectedRowId={selectedRowId}
              editable={editable}
              actions={actions}
            />
          )}
        </GraphObject>
      ))}
    </>
  );
}

/**
 * GRAPH-03 pointing mode: every table on the sheet takes a dashed accent
 * outline that is itself the target — a button named after the table, so
 * the keyboard binds as well as the pointer. The banner lives in the shell.
 */
function PointingOverlay({ gd, sheetId, graphs }: { gd: GedeDoc; sheetId: Id; graphs: Graphs }) {
  const tables = tablesOnSheet(gd, sheetId);
  return (
    <div className="gd-pointing" data-testid="pointing-overlay">
      {tables.map((record) => {
        const map = tableMap(gd, record.id);
        if (map === null) return null;
        const px = unitBoundsToPx(tableUnitBounds(map, record));
        return (
          <button
            key={record.id}
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
