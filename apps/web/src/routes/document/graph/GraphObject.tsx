import clsx from 'clsx';
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  coverageLabel,
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

import type { GraphsActions } from './use-graphs.js';

/** The header is two lattice rows, like a table's title bar. */
export const GRAPH_HEADER_PX = TABLE_TITLE_ROWS * LATTICE.row;
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
 * count (GRAPH-07); the chip names the half.
 */
export function GraphObject({
  graph,
  derivation,
  sourceTitle,
  selected,
  editable,
  actions,
  scale,
  children,
}: GraphObjectProps) {
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
  const bound = graph.tableId !== null && sourceTitle !== null;
  const dimensionLine = derivation.dimensions.map((d) => d.label).join(' · ');
  const subLine = !bound ? 'unbound' : dimensionLine === '' ? 'no dimensions' : dimensionLine;
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
      })}
      style={{
        left: `${String(at.col * LATTICE.col)}px`,
        top: `${String(at.row * LATTICE.row)}px`,
        width: `${String(size.widthUnits * LATTICE.col)}px`,
        height: `${String(size.heightUnits * LATTICE.row)}px`,
      }}
      aria-label={name}
      data-graph-id={graph.id}
      data-graph-kind={graph.kind}
      data-pair-id={graph.pairId}
      data-selected={selected || undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        actions.select(graph.id);
      }}
    >
      <header
        className="gd-graph__header"
        style={{ height: `${String(GRAPH_HEADER_PX)}px` }}
        role={editable ? 'button' : undefined}
        tabIndex={editable ? 0 : undefined}
        aria-label={
          editable
            ? `Move ${name}: drag, or arrows when focused (one lattice unit a press)`
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
      <div
        className="gd-graph__body"
        style={{ height: `${String(size.heightUnits * LATTICE.row - GRAPH_HEADER_PX)}px` }}
      >
        {children}
      </div>
      {editable && (
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
