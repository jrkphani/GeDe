import clsx from 'clsx';
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  coverageLabel,
  GRAPH_COLLAPSED_HEIGHT_UNITS,
  GRAPH_MIN_HEIGHT_UNITS,
  GRAPH_MIN_WIDTH_UNITS,
  LATTICE,
  TABLE_TITLE_ROWS,
  type GraphDerivation,
  type GraphRecord,
  type Id,
  type LatticeUnits,
} from '@gede/core';
import { Button, Icon } from '@gede/ui';

import { useMessages } from '../../../i18n/index.js';
import type { GraphsActions } from './use-graphs.js';

/** The header is two lattice rows, like a table's title bar. */
export const GRAPH_HEADER_PX = TABLE_TITLE_ROWS * LATTICE.row;
/** Collapsed, the object is its header strip alone: one lattice row (ADR-047). */
export const GRAPH_COLLAPSED_PX = GRAPH_COLLAPSED_HEIGHT_UNITS * LATTICE.row;
/** The chevron's box: 14 px, so its 2 px ring at 2 px offset fits the 22 px strip (A11Y-02). */
const CHEVRON_PX = 14;
/** Pointer travel below this is a click on the header, not a drag. */
const DRAG_THRESHOLD_PX = 3;

export interface GraphObjectProps {
  graph: GraphRecord;
  derivation: GraphDerivation;
  /** The source table's title, or null while unbound. */
  sourceTitle: string | null;
  selected: boolean;
  /** RESP-02 / SHARE-03: no drag, no corner, no pointing, no write-back when false. */
  editable: boolean;
  actions: GraphsActions;
  /** Screen pixels per canvas pixel right now (the layer's zoom). */
  scale: () => number;
  /**
   * ADR-047: what the header's second line says — the dimensions, or for a
   * coverage its axes line (GRAPH-08), so the strip keeps it while collapsed.
   */
  subLine?: ReactNode | undefined;
  children: ReactNode;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
}

/**
 * The frame every graph half shares (GRAPH-11): a header that drags the
 * object, a body, and a corner handle that resizes it; both snap to the
 * lattice on release and preview the snapped geometry while dragging. The
 * header states the source, the dimensions and the covered / total tuple
 * count (GRAPH-07); the chip names the half. The header's chevron collapses
 * the half to that strip — one lattice row, position and stored size kept —
 * and expands it again (ADR-047); collapsed, no body and no corner render.
 */
export function GraphObject({
  graph,
  derivation,
  sourceTitle,
  selected,
  editable,
  actions,
  scale,
  subLine: subLineOverride,
  children,
}: GraphObjectProps) {
  const t = useMessages();
  const bodyId = useId();
  const drag = useRef<Drag | null>(null);
  // Previews live in state for the render and in refs for the release handler: pointer
  // moves are continuous events React may not have flushed when the pointer lifts.
  const [movePreview, setMovePreview] = useState<LatticeUnits | null>(null);
  const lastMove = useRef<LatticeUnits | null>(null);
  const lastSize = useRef<{ widthUnits: number; heightUnits: number } | null>(null);
  const [sizePreview, setSizePreview] = useState<{
    widthUnits: number;
    heightUnits: number;
  } | null>(null);
  const at = movePreview ?? { col: graph.gridCol, row: graph.gridRow };
  const size = sizePreview ?? { widthUnits: graph.widthUnits, heightUnits: graph.heightUnits };
  const { collapsed } = graph;
  const heightPx = collapsed ? GRAPH_COLLAPSED_PX : size.heightUnits * LATTICE.row;
  const headerPx = collapsed ? GRAPH_COLLAPSED_PX : GRAPH_HEADER_PX;
  const bound = graph.tableId !== null && sourceTitle !== null;
  const dimensionLine = derivation.dimensions.map((d) => d.label).join(' · ');
  const subLine =
    subLineOverride ??
    (!bound ? 'unbound' : dimensionLine === '' ? 'no dimensions' : dimensionLine);
  const stat = bound ? coverageLabel(derivation) : '';
  const kindLabel = graph.kind === 'ring' ? 'Ring' : 'Coverage';
  const name = `${kindLabel} graph${bound ? ` of ${sourceTitle}` : ''}`;

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    actions.select(graph.id);
    if (!editable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const s = scale();
    const dx = (e.clientX - d.startX) / s;
    const dy = (e.clientY - d.startY) / s;
    if (!d.moved && Math.hypot(dx * s, dy * s) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const next = {
      col: Math.max(0, Math.round(graph.gridCol + dx / LATTICE.col)),
      row: Math.max(0, Math.round(graph.gridRow + dy / LATTICE.row)),
    };
    lastMove.current = next;
    setMovePreview(next);
  };
  const endHeaderPointer = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    const next = lastMove.current;
    lastMove.current = null;
    setMovePreview(null);
    if (d.moved && next !== null && (next.col !== graph.gridCol || next.row !== graph.gridRow)) {
      actions.move(graph.id, next);
    }
  };

  const corner = useRef<Drag | null>(null);
  const onCornerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    corner.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const onCornerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = corner.current;
    if (d?.pointerId !== e.pointerId) return;
    const s = scale();
    const next = {
      widthUnits: Math.max(
        GRAPH_MIN_WIDTH_UNITS,
        Math.round(graph.widthUnits + (e.clientX - d.startX) / s / LATTICE.col),
      ),
      heightUnits: Math.max(
        GRAPH_MIN_HEIGHT_UNITS,
        Math.round(graph.heightUnits + (e.clientY - d.startY) / s / LATTICE.row),
      ),
    };
    lastSize.current = next;
    setSizePreview(next);
  };
  const endCornerPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = corner.current;
    if (d?.pointerId !== e.pointerId) return;
    corner.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    const next = lastSize.current;
    lastSize.current = null;
    setSizePreview(null);
    if (
      next !== null &&
      (next.widthUnits !== graph.widthUnits || next.heightUnits !== graph.heightUnits)
    ) {
      actions.resize(graph.id, next);
    }
  };
  const onCornerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    // A modified arrow is someone else's chord (⇧⌘→ steps to the next object, ADR-042).
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    let next = { widthUnits: graph.widthUnits, heightUnits: graph.heightUnits };
    switch (e.code) {
      case 'ArrowRight':
        next = { ...next, widthUnits: next.widthUnits + 1 };
        break;
      case 'ArrowLeft':
        next = { ...next, widthUnits: next.widthUnits - 1 };
        break;
      case 'ArrowDown':
        next = { ...next, heightUnits: next.heightUnits + 1 };
        break;
      case 'ArrowUp':
        next = { ...next, heightUnits: next.heightUnits - 1 };
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    actions.resize(graph.id, next);
  };
  const onHeaderKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || !editable) return;
    // The chevron inside the header keeps its own keys: Enter and Space press it.
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    // ADR-047 (#163): the header is the ⇧⌘→ landing spot, focused but not always selected,
    // so the object chords work from it by `event.code` — ⌫ / Delete removes this half,
    // ⌥← / ⌥→ collapse or expand it (the row chevron's chords, ADR-030). The shell binds the
    // same chords for the selected half wherever focus is; this handler stops them here.
    if ((e.code === 'Delete' || e.code === 'Backspace') && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      actions.removeHalf(graph.pairId, graph.kind);
      return;
    }
    if (e.altKey && !mod && !e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      actions.setCollapsed(graph.id, e.code === 'ArrowLeft');
      return;
    }
    // A modified arrow is someone else's chord (⇧⌘→ steps to the next object, ADR-042).
    if (mod || e.altKey || e.shiftKey) return;
    // The header is a button: Enter or Space selects the graph, as a pointer press does
    // (A11Y-01 — the Graph tab must be reachable without a pointer).
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      actions.select(graph.id);
      return;
    }
    let next: LatticeUnits = { col: graph.gridCol, row: graph.gridRow };
    switch (e.code) {
      case 'ArrowRight':
        next = { ...next, col: next.col + 1 };
        break;
      case 'ArrowLeft':
        next = { ...next, col: Math.max(0, next.col - 1) };
        break;
      case 'ArrowDown':
        next = { ...next, row: next.row + 1 };
        break;
      case 'ArrowUp':
        next = { ...next, row: Math.max(0, next.row - 1) };
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    actions.move(graph.id, next);
  };

  return (
    <section
      className={clsx('gd-graph', `gd-graph--${graph.kind}`, {
        'gd-graph--selected': selected,
        'gd-graph--dragging': movePreview !== null || sizePreview !== null,
        'gd-graph--unbound': !bound,
        'gd-graph--collapsed': collapsed,
      })}
      style={{
        left: `${String(at.col * LATTICE.col)}px`,
        top: `${String(at.row * LATTICE.row)}px`,
        width: `${String(size.widthUnits * LATTICE.col)}px`,
        height: `${String(heightPx)}px`,
      }}
      aria-label={name}
      data-graph-id={graph.id}
      data-graph-kind={graph.kind}
      data-pair-id={graph.pairId}
      data-selected={selected || undefined}
      data-collapsed={collapsed || undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        actions.select(graph.id);
      }}
    >
      {editable && (
        // ADR-047: the collapse chevron, at the header's leading edge — a sibling of the
        // header, not a child: the header is itself a button (move), and a control inside a
        // control is a defect (axe nested-interactive). A native button, so Enter and Space
        // press it; it neither starts a drag nor hands its keys to the header. Absent on the
        // phone and for a view-only participant (RESP-02, SHARE-03): collapse is a document
        // edit. Below 1024 px its hit area is the 44 px target (RESP-05, CSS).
        <button
          type="button"
          className="gd-graph__chevron"
          style={{ top: `${String((headerPx - CHEVRON_PX) / 2)}px` }}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={t(collapsed ? 'object.expand' : 'object.collapse', { name })}
          title={t(collapsed ? 'object.expand' : 'object.collapse', { name })}
          data-testid="graph-chevron"
          onPointerDown={(e) => {
            e.stopPropagation();
            actions.select(graph.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            // A press selects the half (as any press on it does), from the keyboard too.
            actions.select(graph.id);
            actions.toggleCollapsed(graph.id);
          }}
        >
          <Icon
            name="chevron-right"
            size={13}
            className={clsx('gd-graph__chevron-glyph', {
              'gd-graph__chevron-glyph--expanded': !collapsed,
            })}
          />
        </button>
      )}
      <header
        className={clsx('gd-graph__header', { 'gd-graph__header--with-chevron': editable })}
        style={{ height: `${String(headerPx)}px` }}
        role={editable ? 'button' : undefined}
        tabIndex={editable ? 0 : undefined}
        aria-label={
          editable
            ? `Move ${name}: drag, or arrows when focused (one lattice unit a press); Enter selects it`
            : undefined
        }
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderPointer}
        onPointerCancel={endHeaderPointer}
        onKeyDown={onHeaderKeyDown}
      >
        <Icon name="graph" size={15} className="gd-graph__glyph" />
        <span className="gd-graph__titles">
          <span className="gd-graph__title">{bound ? sourceTitle : 'Graph'}</span>
          <span className="gd-mono gd-graph__sub" data-testid="graph-dimensions">
            {subLine}
          </span>
        </span>
        {stat !== '' && (
          <span
            className="gd-mono gd-graph__stat"
            title="Distinct covered tuples over the total tuple space"
            data-testid="graph-stat"
          >
            {stat}
          </span>
        )}
        <span className="gd-mono gd-graph__kind" aria-hidden="true">
          {graph.kind}
        </span>
      </header>
      {!collapsed && (
        <div
          id={bodyId}
          className="gd-graph__body"
          style={{ height: `${String(size.heightUnits * LATTICE.row - GRAPH_HEADER_PX)}px` }}
        >
          {children}
        </div>
      )}
      {editable && !collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${name}`}
          aria-valuenow={size.widthUnits}
          aria-valuemin={GRAPH_MIN_WIDTH_UNITS}
          aria-valuetext={`${String(size.widthUnits)} by ${String(size.heightUnits)} units`}
          title={`Resize ${name}: drag the corner, or arrows when focused`}
          tabIndex={selected ? 0 : -1}
          className="gd-graph__corner"
          onPointerDown={onCornerPointerDown}
          onPointerMove={onCornerPointerMove}
          onPointerUp={endCornerPointer}
          onPointerCancel={endCornerPointer}
          onKeyDown={onCornerKeyDown}
          onClick={(e) => {
            e.stopPropagation();
          }}
        />
      )}
    </section>
  );
}

/** The unbound body (GRAPH-03): point at a table, or add a shaped one (GRAPH-04). */
export function UnboundBody({
  pairId,
  editable,
  actions,
}: {
  pairId: Id;
  editable: boolean;
  actions: GraphsActions;
}) {
  return (
    <div className="gd-graph__empty" data-testid="graph-unbound">
      <p className="gd-graph__empty-text">
        {editable
          ? 'This graph is not pointed at a table yet.'
          : 'This graph is not pointed at a table.'}
      </p>
      {editable && (
        <div className="gd-graph__empty-actions">
          <Button
            size="sm"
            variant="primary"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={() => {
              actions.repoint(pairId);
            }}
          >
            Point at a table
          </Button>
          <Button
            size="sm"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={() => {
              actions.addShapedTable(pairId);
            }}
          >
            Add shaped table
          </Button>
        </div>
      )}
    </div>
  );
}
