/**
 * Viewer state and commands for context graphs (GRAPH-01..11, INSP-08).
 *
 * Viewer state — never document state — is the selected graph, pointing
 * mode (the hover emphasis a pair shares lives in `store.ts`). Every command writes through
 * one `@gede/core` mutation (one transaction, one undo step), keeps the
 * selection sane, and announces what it did. Read-only documents (the phone,
 * a view-only participant) get the commands as no-ops so the objects still
 * render, without pointing, dragging or write-back.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bindGraphPair,
  bindShapedTable,
  createChildSheet,
  createGraphPair,
  createShapedTableWithGraph,
  defaultPairOrigin,
  graphById,
  graphsInPair,
  removeGraphPair,
  setGraphPosition,
  setGraphSize,
  setGraphSlice,
  sheetBounds,
  tableById,
  toggleGraphDimension,
  type GedeDoc,
  type GraphContext,
  type GraphSlice,
  type Id,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { graphStoreFor, type GraphHover } from './store.js';
import type { LatticeUnits, Pixels } from '@gede/core';
import type { GridActions } from '../grid/use-grid.js';
import type { GridCommands } from '../grid/commands.js';

export type Pointing =
  /** `+ Graph` with nothing to bind yet: the click creates the pair (GRAPH-03). */
  | { readonly mode: 'create' }
  /** Re-point (GRAPH-05): the click re-binds an existing pair. */
  | { readonly mode: 'rebind'; readonly pairId: Id };

export interface GraphsState {
  readonly selectedGraphId: Id | null;
  readonly pointing: Pointing | null;
}

export interface GraphsActions {
  /** Select a graph object (clears the grid selection); null clears. */
  select: (graphId: Id | null) => void;
  /** `+ Graph` / the empty-sheet menu: enter pointing mode (GRAPH-01, GRAPH-03). */
  startPointing: () => void;
  /** "Graph this table" (GRAPH-01): a pair bound to `tableId`, selected. */
  graphTable: (tableId: Id) => void;
  /** In pointing mode, the click on a table (GRAPH-03). */
  pointAt: (tableId: Id) => void;
  cancelPointing: () => void;
  /** GRAPH-05 Re-point. */
  repoint: (pairId: Id) => void;
  /**
   * GRAPH-04: a shaped table bound in one step — to `pairId`, else to the pair
   * being re-pointed, else as a new pair.
   */
  addShapedTable: (pairId?: Id) => void;
  remove: (pairId: Id) => void;
  toggleDimension: (pairId: Id, colId: Id, on: boolean) => void;
  setSlice: (pairId: Id, slice: GraphSlice) => void;
  /** GRAPH-05 "Add dimension column": a new entered column, marked as a dimension. */
  addDimensionColumn: (pairId: Id) => void;
  move: (graphId: Id, at: LatticeUnits | Pixels) => void;
  resize: (graphId: Id, size: { widthUnits: number; heightUnits: number }) => void;
  /** GRAPH-10 click: select the context's row in the source table. */
  selectRow: (tableId: Id, rowId: Id) => void;
  /** GRAPH-10 empty coverage cell: append a pre-filled row. */
  appendRow: (tableId: Id, values: Readonly<Record<Id, string>>) => void;
  /** GRAPH-10 double-click: a child sheet named after the symbol. */
  openChild: (context: GraphContext) => void;
  setHover: (hover: GraphHover | null) => void;
}

export interface Graphs {
  readonly state: GraphsState;
  readonly actions: GraphsActions;
}

export interface UseGraphsOptions {
  gd: GedeDoc;
  activeSheetId: Id | null;
  editable: boolean;
  grid: { actions: GridActions; commands: GridCommands };
  /** Switch the shell to a sheet (the child sheet a double-click made). */
  selectSheet: (sheetId: Id) => void;
  /** Pan so a lattice point is on screen. */
  reveal: (col: number, row: number) => void;
  /** KEYS-03: the undo manager's `stopCapturing`, so one command is one step. */
  settle?: (() => void) | undefined;
}

export function useGraphs({
  gd,
  activeSheetId,
  editable,
  grid,
  selectSheet,
  reveal,
  settle,
}: UseGraphsOptions): Graphs {
  const [selectedGraphId, setSelectedGraphId] = useState<Id | null>(null);
  const [pointing, setPointing] = useState<Pointing | null>(null);
  const latest = useRef({ gd, activeSheetId, editable, grid, selectSheet, reveal, settle });
  latest.current = { gd, activeSheetId, editable, grid, selectSheet, reveal, settle };

  // A selection or pointing state must not outlive its sheet (DOC-03) or its object.
  useEffect(() => {
    setSelectedGraphId(null);
    setPointing(null);
    graphStoreFor(gd.doc).setHover(null);
  }, [activeSheetId, gd]);
  useEffect(() => {
    if (!editable) setPointing(null);
  }, [editable]);

  // GRAPH-03: Escape cancels pointing, taken in the capture phase so the shell's Escape
  // (clear the selection) does not also fire (`event.code`, I18N-02).
  useEffect(() => {
    if (pointing === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setPointing(null);
      announce('Pointing cancelled');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pointing]);

  const actions = useMemo<GraphsActions>(() => {
    const done = () => latest.current.settle?.();
    const can = () => latest.current.editable;
    const selectPair = (ringId: Id) => {
      latest.current.grid.actions.clear();
      setSelectedGraphId(ringId);
      const ring = graphById(latest.current.gd, ringId);
      if (ring !== null) latest.current.reveal(ring.gridCol, ring.gridRow);
    };
    const bindTo = (tableId: Id) => {
      const { gd: doc, activeSheetId: sheetId } = latest.current;
      const table = tableById(doc, tableId);
      if (!can() || sheetId === null || table === null) return;
      const current = pointing;
      if (current?.mode === 'rebind') {
        // The pair may have been removed by another replica while pointing.
        announce(
          bindGraphPair(doc, current.pairId, tableId)
            ? `Graph re-pointed at ${table.title}`
            : 'The graph is gone; nothing was re-pointed',
        );
      } else {
        const pair = createGraphPair(doc, { sheetId, tableId });
        selectPair(pair.ringId);
        announce(`Added a graph of ${table.title}`);
      }
      setPointing(null);
      done();
    };
    return {
      select(graphId) {
        if (graphId !== null) latest.current.grid.actions.clear();
        setSelectedGraphId(graphId);
      },
      startPointing() {
        if (!can() || latest.current.activeSheetId === null) return;
        setPointing({ mode: 'create' });
        announce('Pointing: click a table to bind the graph, or press Escape');
      },
      graphTable(tableId) {
        const { gd: doc, activeSheetId: sheetId } = latest.current;
        const table = tableById(doc, tableId);
        if (!can() || sheetId === null || table === null) return;
        const pair = createGraphPair(doc, { sheetId, tableId });
        selectPair(pair.ringId);
        setPointing(null);
        announce(`Added a graph of ${table.title}`);
        done();
      },
      pointAt: bindTo,
      cancelPointing() {
        setPointing(null);
        announce('Pointing cancelled');
      },
      repoint(pairId) {
        if (!can()) return;
        setPointing({ mode: 'rebind', pairId });
        announce('Pointing: click a table to re-point the graph, or press Escape');
      },
      addShapedTable(pairId) {
        const { gd: doc, activeSheetId: sheetId } = latest.current;
        if (!can() || sheetId === null) return;
        const rebind = pairId ?? (pointing?.mode === 'rebind' ? pointing.pairId : null);
        const bounds = sheetBounds(doc, sheetId);
        const at = bounds === null ? { col: 1, row: 1 } : defaultPairOrigin(doc, sheetId);
        if (rebind !== null) {
          const tableId = bindShapedTable(doc, rebind, { sheetId, at });
          if (tableId !== null) announce('Added a shaped table and re-pointed the graph at it');
        } else {
          const made = createShapedTableWithGraph(doc, { sheetId, at });
          selectPair(made.ringId);
          announce('Added a shaped table with its graph');
        }
        setPointing(null);
        done();
      },
      remove(pairId) {
        if (!can()) return;
        const ids = removeGraphPair(latest.current.gd, pairId);
        setSelectedGraphId((current) =>
          current !== null && ids.includes(current) ? null : current,
        );
        announce('Removed the graph');
        done();
      },
      toggleDimension(pairId, colId, on) {
        if (!can()) return;
        const next = toggleGraphDimension(latest.current.gd, pairId, colId, on);
        announce(`${String(next.length)} ${next.length === 1 ? 'dimension' : 'dimensions'}`);
        done();
      },
      setSlice(pairId, slice) {
        if (!can()) return;
        setGraphSlice(latest.current.gd, pairId, slice);
        done();
      },
      addDimensionColumn(pairId) {
        const { gd: doc, grid: g } = latest.current;
        const ring = graphsInPair(doc, pairId)[0];
        if (!can() || ring?.tableId === null || ring === undefined) return;
        const colId = g.commands.insertColumnAfter(ring.tableId);
        if (colId === null) return;
        toggleGraphDimension(doc, pairId, colId, true);
        announce('Added a dimension column');
        done();
      },
      move(graphId, at) {
        if (!can()) return;
        setGraphPosition(latest.current.gd, graphId, at);
        done();
      },
      resize(graphId, size) {
        if (!can()) return;
        setGraphSize(latest.current.gd, graphId, size);
        done();
      },
      selectRow(tableId, rowId) {
        const record = tableById(latest.current.gd, tableId);
        if (record === null) return;
        const colId = record.columns.find((c) => !c.hidden)?.id;
        if (colId === undefined || !record.rows.includes(rowId)) return;
        latest.current.grid.actions.selectCell({ tableId, rowId, colId });
      },
      appendRow(tableId, values) {
        if (!can()) return;
        latest.current.grid.commands.appendRowWith(tableId, values);
      },
      openChild(context) {
        const { gd: doc, selectSheet: go } = latest.current;
        if (!can()) return;
        const made = createChildSheet(doc, { symbol: context.symbol, tupleKey: context.tupleKey });
        done();
        go(made.sheetId);
        announce(`Opened sheet ${context.symbol} with a shaped child table`);
      },
      // GRAPH-09: hover lives in the graph store, so a hover re-renders the pair, not the shell.
      setHover(hover) {
        graphStoreFor(latest.current.gd.doc).setHover(hover);
      },
    };
  }, [pointing]);

  return { state: { selectedGraphId, pointing }, actions };
}
