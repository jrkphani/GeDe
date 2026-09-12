import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { LATTICE } from '@gede/core';

/**
 * Resize handles (GRID-08): a divider at each column header and a corner
 * handle on the table. Pointer drags preview the snapped size and commit once
 * on release; the keyboard alternative is the arrows on the focused handle
 * (`event.code`, I18N-02), one lattice unit a press. Both are separators with
 * a value, so assistive tech reads the size in units (A11Y-01).
 */

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
}

export interface ColumnDividerProps {
  label: string;
  /** Current width in lattice units. */
  units: number;
  /** In the tab order only for the selected column, so a table does not add N tab stops. */
  tabStop: boolean;
  /** Screen pixels per canvas pixel (the layer's zoom) at the moment a drag starts. */
  scale: () => number;
  onPreview: (units: number | null) => void;
  onCommit: (units: number) => void;
}

/** Snap a dragged width to whole units, never below one (GRID-01). */
export function dragToUnits(startUnits: number, dxCanvasPx: number, axis: 'col' | 'row'): number {
  return Math.max(1, Math.round(startUnits + dxCanvasPx / LATTICE[axis]));
}

export function ColumnDivider({
  label,
  units,
  tabStop,
  scale,
  onPreview,
  onCommit,
}: ColumnDividerProps) {
  const drag = useRef<Drag | null>(null);
  const last = useRef(units);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    last.current = units;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const next = dragToUnits(units, (e.clientX - d.startX) / scale(), 'col');
    if (next !== last.current) {
      last.current = next;
      onPreview(next);
    }
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onPreview(null);
    if (last.current !== units) onCommit(last.current);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      onCommit(units + 1);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      if (units > 1) onCommit(units - 1);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize column ${label}`}
      aria-valuenow={units}
      aria-valuemin={1}
      aria-valuetext={`${String(units)} ${units === 1 ? 'unit' : 'units'}`}
      title={`Resize column ${label}: drag, or ← → when focused`}
      tabIndex={tabStop ? 0 : -1}
      className="gd-table__divider"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
    />
  );
}

export interface CornerHandleProps {
  title: string;
  /** Total visible width in units and whether every row is wrapped. */
  widthUnits: number;
  rows: number;
  wrapped: boolean;
  tabStop: boolean;
  scale: () => number;
  onPreview: (preview: { widthUnits: number; wrapped: boolean } | null) => void;
  onCommit: (change: { widthUnits?: number; wrapped?: boolean }) => void;
}

/**
 * Vertical travel snaps to the only two heights the lattice allows for a
 * table body: every row compact (one unit) or every row wrapped (two).
 */
export function dragToWrapped(rows: number, startWrapped: boolean, dyCanvasPx: number): boolean {
  const compact = rows * LATTICE.row;
  const start = startWrapped ? compact * 2 : compact;
  const target = start + dyCanvasPx;
  return target >= compact * 1.5;
}

export function CornerHandle({
  title,
  widthUnits,
  rows,
  wrapped,
  tabStop,
  scale,
  onPreview,
  onCommit,
}: CornerHandleProps) {
  const drag = useRef<Drag | null>(null);
  const last = useRef({ widthUnits, wrapped });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    last.current = { widthUnits, wrapped };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const s = scale();
    const next = {
      widthUnits: dragToUnits(widthUnits, (e.clientX - d.startX) / s, 'col'),
      wrapped: rows === 0 ? wrapped : dragToWrapped(rows, wrapped, (e.clientY - d.startY) / s),
    };
    if (next.widthUnits !== last.current.widthUnits || next.wrapped !== last.current.wrapped) {
      last.current = next;
      onPreview(next);
    }
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onPreview(null);
    const change: { widthUnits?: number; wrapped?: boolean } = {};
    if (last.current.widthUnits !== widthUnits) change.widthUnits = last.current.widthUnits;
    if (last.current.wrapped !== wrapped) change.wrapped = last.current.wrapped;
    if (Object.keys(change).length > 0) onCommit(change);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const change: { widthUnits?: number; wrapped?: boolean } = {};
    switch (e.code) {
      case 'ArrowRight':
        change.widthUnits = widthUnits + 1;
        break;
      case 'ArrowLeft':
        if (widthUnits > 1) change.widthUnits = widthUnits - 1;
        break;
      case 'ArrowDown':
        if (!wrapped) change.wrapped = true;
        break;
      case 'ArrowUp':
        if (wrapped) change.wrapped = false;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (Object.keys(change).length > 0) onCommit(change);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${title}`}
      aria-valuenow={widthUnits}
      aria-valuemin={1}
      aria-valuetext={`${String(widthUnits)} ${widthUnits === 1 ? 'unit' : 'units'} wide, rows ${wrapped ? 'wrapped' : 'compact'}`}
      title={`Resize ${title}: drag the corner, or arrows when focused (← → width, ↑ ↓ row height)`}
      tabIndex={tabStop ? 0 : -1}
      className="gd-table__corner"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
      }}
    />
  );
}
