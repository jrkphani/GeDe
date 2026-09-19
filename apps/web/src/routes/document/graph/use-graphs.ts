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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  bindGraphPair,
  bindShapedTable,
  createChildSheet,
  createGraphPair,
  createShapedTableWithGraph,
  defaultPairOrigin,
  graphById,
  graphsInPair,
  removeGraphObject,
  removeGraphPair,
  setGraphCollapsed,
  setGraphPosition,
  setGraphSize,
  setGraphSlice,
  sheetBounds,
  tableById,
  toggleGraphDimension,
  type GedeDoc,
  type GraphContext,
  type GraphKind,
  type GraphRecord,
  type GraphSlice,
  type Id,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { LABELS } from '../../../doc/shortcuts.js';
import { translate } from '../../../i18n/index.js';
import { activeLocale } from '../../../locale.js';
import {
  objectElement,
  objectEntry,
  sheetObjects,
  stepObject,
  type SheetObject,
} from '../keys/objects.js';
import { setTourPointing, subscribeTour, tourState } from '../../tour/store.js';
import { graphStoreFor, type GraphHover } from './store.js';
import type { LatticeUnits, Pixels } from '@gede/core';
import type { GridActions } from '../grid/use-grid.js';
import type { GridCommands } from '../grid/commands.js';

/**
 * ADR-047: the name the live region gives a half or a pair — "the ring of
 * Table 1", or "the ring" while unbound — in the active locale.
 */
export function graphObjectName(gd: GedeDoc, kind: GraphKind | 'pair', tableId: Id | null): string {
  const table = tableId === null ? null : tableById(gd, tableId);
  const locale = activeLocale();
  if (table === null) return translate(locale, `object.name.${kind}Unbound`);
  return translate(locale, `object.name.${kind}`, { table: table.title });
}

/** "Deleted the ring of Table 1 — press ⌘Z to undo" (A11Y-05). */
export function deletedAnnouncement(name: string): string {
  return translate(activeLocale(), 'object.deleted', { name, undo: LABELS.undo });
}

/** The controls Tab cycles while pointing, in reading order: banner buttons, targets, the tour's Skip. */
function pointingControls(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.gd-doc__pointing button, .gd-pointing__target, .gd-tour__skip',
    ),
  ).filter((el) => !el.hasAttribute('disabled'));
}

/**
 * Whether a Tab from `active` belongs to pointing mode: nothing focused, the
 * command that armed it (the toolbar), or the canvas — never a field, a menu or
 * a dialog the person is in, which keep their own Tab.
 */
function focusBelongsToPointing(active: Element | null): boolean {
  if (active === null || active === document.body) return true;
  return active.closest('.gd-doc__toolbar, .gd-canvas, .gd-doc__pointing') !== null;
}

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
  /** GRAPH-05 Remove: both halves. Focus then moves to the bound table (ADR-047). */
  remove: (pairId: Id) => void;
  /**
   * ADR-047: delete one half only; the other stays bound to the table and takes
   * focus and the selection. With no other half, focus moves to the bound table.
   */
  removeHalf: (pairId: Id, kind: GraphKind) => void;
  /** ADR-047: collapse a half to its header strip, or expand it; the box is kept. */
  setCollapsed: (graphId: Id, collapsed: boolean) => void;
  toggleCollapsed: (graphId: Id) => void;
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
  /**
   * ADR-047: where focus goes once a graph object is deleted and no half of its
   * pair remains — the bound table when there is one, else the object before
   * the deleted one in sheet order (`fallback`), revealed and entered as ⇧⌘→
   * does; the shell decides and falls back to the canvas when nothing is left.
   */
  afterDelete?:
    ((landing: { tableId: Id | null; fallback: SheetObject | null }) => void) | undefined;
}

export function useGraphs({
  gd,
  activeSheetId,
  editable,
  grid,
  selectSheet,
  reveal,
  settle,
  afterDelete,
}: UseGraphsOptions): Graphs {
  const [selectedGraphId, setSelectedGraphId] = useState<Id | null>(null);
  const [pointing, setPointing] = useState<Pointing | null>(null);
  const latest = useRef({
    gd,
    activeSheetId,
    editable,
    grid,
    selectSheet,
    reveal,
    settle,
    afterDelete,
  });
  latest.current = { gd, activeSheetId, editable, grid, selectSheet, reveal, settle, afterDelete };

  // A selection or pointing state must not outlive its sheet (DOC-03) or its object.
  useEffect(() => {
    setSelectedGraphId(null);
    setPointing(null);
    graphStoreFor(gd.doc).setHover(null);
  }, [activeSheetId, gd]);
  useEffect(() => {
    if (!editable) setPointing(null);
  }, [editable]);
  // ONB-05: the guided tour's step 4 shows its `point` card while pointing mode is on.
  useEffect(() => {
    setTourPointing(pointing !== null);
    return () => {
      setTourPointing(false);
    };
  }, [pointing]);
  // ONB-07 (#159 item 8): Skip ends the tour and leaves no mode behind it — the pointing
  // mode the tour asked for is cancelled with it.
  const tour = useSyncExternalStore(subscribeTour, tourState, tourState);
  useEffect(() => {
    if (tour.phase === 'ending' && tour.reason === 'skipped') setPointing(null);
  }, [tour]);

  // GRAPH-03: Escape cancels pointing, taken in the capture phase so the shell's Escape
  // (clear the selection) does not also fire (`event.code`, I18N-02). Tab cycles the mode's
  // own controls — the banner's buttons, every pointing target, the tour's Skip — so the
  // keyboard reaches a target from the toolbar without walking the grid (whose Tab appends
  // rows past the last one, GRID-05); Escape and Cancel are the way out (A11Y-01, #159).
  useEffect(() => {
    if (pointing === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        setPointing(null);
        announce('Pointing cancelled');
        return;
      }
      if (event.code !== 'Tab') return;
      const controls = pointingControls();
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? controls.indexOf(active) : -1;
      if (controls.length === 0 || (index === -1 && !focusBelongsToPointing(active))) return;
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const next = index === -1 ? 0 : (index + step + controls.length) % controls.length;
      controls[next]?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pointing]);

  const actions = useMemo<GraphsActions>(() => {
    const done = () => latest.current.settle?.();
    const can = () => latest.current.editable;
    // ADR-047: focus after a delete — the surviving half's header, else the bound table,
    // else the object before the deleted one (#163). The survivor is already in the DOM
    // (nothing about it changed), so its header can take focus at once; a table or another
    // object is the shell's to reveal and enter. `fallback` is read before the delete.
    const fallbackFor = (graphId: Id): SheetObject | null => {
      const { gd: doc, activeSheetId: sheetId } = latest.current;
      if (sheetId === null) return null;
      const objects = sheetObjects(doc, sheetId);
      const previous = stepObject(objects, { kind: 'graph', id: graphId }, -1);
      return previous !== null && previous.id === graphId ? null : previous;
    };
    const afterRemoval = (
      survivor: GraphRecord | null,
      tableId: Id | null,
      fallback: SheetObject | null,
    ) => {
      if (survivor !== null) {
        const section = objectElement({ kind: 'graph', id: survivor.id });
        const entry = section === null ? null : objectEntry(section);
        entry?.focus({ preventScroll: true });
        return;
      }
      const bound = tableId !== null && tableById(latest.current.gd, tableId) !== null;
      latest.current.afterDelete?.({ tableId: bound ? tableId : null, fallback });
    };
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
    const actions: GraphsActions = {
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
        const { gd: doc } = latest.current;
        const lead = graphsInPair(doc, pairId)[0];
        // Pointing mode owns the keyboard (Escape is its key, GRAPH-03): no delete under it.
        if (!can() || pointing !== null || lead === undefined) return;
        const name = graphObjectName(doc, 'pair', lead.tableId);
        const halves = graphsInPair(doc, pairId).map((g) => g.id);
        // The object before the pair's first half, skipping the pair's own halves.
        const fallback = (() => {
          const previous = fallbackFor(lead.id);
          return previous !== null && previous.kind === 'graph' && halves.includes(previous.id)
            ? fallbackFor(previous.id)
            : previous;
        })();
        done(); // one undo step of its own, never merged into the change before it (KEYS-03)
        const ids = removeGraphPair(doc, pairId);
        setSelectedGraphId((current) =>
          current !== null && ids.includes(current) ? null : current,
        );
        done();
        // Focus first, then the announcement: the entry cell's own "Selected …" must not be
        // what the live region ends on — the undo hint is (A11Y-05).
        afterRemoval(null, lead.tableId, fallback);
        announce(deletedAnnouncement(name));
      },
      removeHalf(pairId, kind) {
        const { gd: doc } = latest.current;
        const half = graphsInPair(doc, pairId).find((g) => g.kind === kind);
        if (!can() || pointing !== null || half === undefined) return;
        const name = graphObjectName(doc, kind, half.tableId);
        const fallback = fallbackFor(half.id);
        done();
        const removed = removeGraphObject(doc, pairId, kind);
        if (removed === null) return;
        const survivor = graphsInPair(doc, pairId)[0] ?? null;
        // The survivor takes the selection with the focus (the Graph tab then reads it), as
        // Enter on its header would; with none, a selection of the removed half ends.
        if (survivor !== null) actions.select(survivor.id);
        else setSelectedGraphId((current) => (current === removed ? null : current));
        done();
        afterRemoval(survivor, half.tableId, fallback);
        announce(deletedAnnouncement(name));
      },
      setCollapsed(graphId, collapsed) {
        const { gd: doc } = latest.current;
        const graph = graphById(doc, graphId);
        if (!can() || pointing !== null || graph === null) return;
        done();
        if (!setGraphCollapsed(doc, graphId, collapsed)) return;
        const name = graphObjectName(doc, graph.kind, graph.tableId);
        announce(
          translate(activeLocale(), collapsed ? 'object.collapsed' : 'object.expanded', { name }),
        );
        done();
      },
      toggleCollapsed(graphId) {
        const graph = graphById(latest.current.gd, graphId);
        if (graph !== null) actions.setCollapsed(graphId, !graph.collapsed);
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
    return actions;
  }, [pointing]);

  return { state: { selectedGraphId, pointing }, actions };
}
