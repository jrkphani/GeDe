import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { LATTICE } from '@gede/core';

/**
 * Resize handles (GRID-08, GRID-09, ADR-049): a divider at each column
 * header, a divider under each row's handle, and a corner handle on the
 * table — the shape Numbers gives them. Pointer drags preview the snapped
 * size and commit once on release (one undo step); a double-click fits the
 * column or row to its content. The keyboard alternative on the focused
 * handle (`event.code`, I18N-02): the arrows one lattice unit a press, with
 * Shift four, with ⌥ the same (the divider owns the chord only while it has
 * focus, so ADR-030's ⌥← / ⌥→ on a cell are untouched); Enter fits. Every
 * handle is a separator with a value, so assistive tech reads the size in
 * units (A11Y-01), and the minimum — one unit, 160 × 22 px — is its
 * `aria-valuemin`; there is no maximum, so no `aria-valuemax`.
 */

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
}

export type DividerAxis = 'col' | 'row';

/** Snap a dragged size to whole units, never below one (GRID-01, R-D). */
export function dragToUnits(startUnits: number, dxCanvasPx: number, axis: DividerAxis): number {
  return Math.max(1, Math.round(startUnits + dxCanvasPx / LATTICE[axis]));
}

/** Units a key press moves a size: one, four with Shift (the field's coarse step, #167 criterion 9). */
export function keyStep(e: { readonly shiftKey: boolean }): number {
  return e.shiftKey ? 4 : 1;
}

export interface DividerProps {
  axis: DividerAxis;
  /** "column Column 1" / "row 5": the object the handle resizes, for its name and tooltip. */
  subject: string;
  /** Current size in lattice units. */
  units: number;
  /**
   * In the tab order only for the selected column or row, so a table does not
   * add N tab stops: Shift+Tab from the row's first cell (or the column's, in
   * the first row) reaches it (A11Y-01).
   */
  tabStop: boolean;
  /** Screen pixels per canvas pixel (the layer's zoom) at the moment a drag starts. */
  scale: () => number;
  onPreview: (units: number | null) => void;
  onCommit: (units: number) => void;
  /** Fit to content (double-click, Enter); absent where nothing can be measured. */
  onFit?: (() => void) | undefined;
  /** Why fit is unavailable, for the tooltip, when `onFit` is absent. */
  fitReason?: string | undefined;
  /** Extra class for the axis-specific placement. */
  className?: string | undefined;
}

export function Divider({
  axis,
  subject,
  units,
  tabStop,
  scale,
  onPreview,
  onCommit,
  onFit,
  fitReason,
  className,
}: DividerProps) {
  const drag = useRef<Drag | null>(null);
  const last = useRef(units);
  const moved = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    last.current = units;
    moved.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const delta = axis === 'col' ? e.clientX - d.startX : e.clientY - d.startY;
    const next = dragToUnits(units, delta / scale(), axis);
    if (next !== last.current) {
      moved.current = true;
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
    if (e.metaKey || e.ctrlKey) return;
    const grow = axis === 'col' ? 'ArrowRight' : 'ArrowDown';
    const shrink = axis === 'col' ? 'ArrowLeft' : 'ArrowUp';
    if (e.code === grow) {
      e.preventDefault();
      e.stopPropagation();
      onCommit(units + keyStep(e));
    } else if (e.code === shrink) {
      e.preventDefault();
      e.stopPropagation();
      if (units > 1) onCommit(Math.max(1, units - keyStep(e)));
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (onFit === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      onFit();
    }
  };
  const keys = axis === 'col' ? '← →' : '↑ ↓';
  const fitHint =
    onFit === undefined
      ? fitReason === undefined
        ? ''
        : `; fit to content: ${fitReason}`
      : '; double-click or Enter fits to content';

  return (
    <div
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
      aria-label={`Resize ${subject}`}
      aria-valuenow={units}
      aria-valuemin={1}
      aria-valuetext={`${String(units)} ${units === 1 ? 'unit' : 'units'}, ${String(units * LATTICE[axis])} px`}
      title={`Resize ${subject}: drag, or ${keys} when focused (Shift for four units)${fitHint}`}
      tabIndex={tabStop ? 0 : -1}
      className={className ?? (axis === 'col' ? 'gd-table__divider' : 'gd-table__row-divider')}
      data-axis={axis}
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
        if (moved.current) return;
        onFit?.();
      }}
    />
  );
}

export interface ColumnDividerProps extends Omit<DividerProps, 'axis' | 'subject'> {
  label: string;
}

/** GRID-08: the divider at a column header. */
export function ColumnDivider({ label, ...rest }: ColumnDividerProps) {
  return <Divider axis="col" subject={`column ${label}`} {...rest} />;
}

export interface RowDividerProps extends Omit<DividerProps, 'axis' | 'subject'> {
  /** "Row 5": the row as the ruler numbers it (DOC-06). */
  name: string;
}

/** GRID-09 / ADR-049: the divider under a row's handle. */
export function RowDivider({ name, ...rest }: RowDividerProps) {
  return <Divider axis="row" subject={name.toLowerCase()} {...rest} />;
}

export interface CornerHandleProps {
  title: string;
  /** Total visible width and total visible height, in units. */
  widthUnits: number;
  heightUnits: number;
  tabStop: boolean;
  scale: () => number;
  onPreview: (preview: { widthUnits: number; heightUnits: number } | null) => void;
  onCommit: (change: { widthUnits?: number; heightUnits?: number }) => void;
}

/**
 * The corner handle (GRID-08, Numbers N3): drags scale every column's width
 * and every row's height proportionally, in whole units each (ADR-049).
 */
export function CornerHandle({
  title,
  widthUnits,
  heightUnits,
  tabStop,
  scale,
  onPreview,
  onCommit,
}: CornerHandleProps) {
  const drag = useRef<Drag | null>(null);
  const last = useRef({ widthUnits, heightUnits });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    last.current = { widthUnits, heightUnits };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const s = scale();
    const next = {
      widthUnits: dragToUnits(widthUnits, (e.clientX - d.startX) / s, 'col'),
      heightUnits:
        heightUnits === 0 ? 0 : dragToUnits(heightUnits, (e.clientY - d.startY) / s, 'row'),
    };
    if (
      next.widthUnits !== last.current.widthUnits ||
      next.heightUnits !== last.current.heightUnits
    ) {
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
    const change: { widthUnits?: number; heightUnits?: number } = {};
    if (last.current.widthUnits !== widthUnits) change.widthUnits = last.current.widthUnits;
    if (last.current.heightUnits !== heightUnits) change.heightUnits = last.current.heightUnits;
    if (Object.keys(change).length > 0) onCommit(change);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) return;
    const change: { widthUnits?: number; heightUnits?: number } = {};
    const step = keyStep(e);
    switch (e.code) {
      case 'ArrowRight':
        change.widthUnits = widthUnits + step;
        break;
      case 'ArrowLeft':
        if (widthUnits > 1) change.widthUnits = Math.max(1, widthUnits - step);
        break;
      case 'ArrowDown':
        if (heightUnits > 0) change.heightUnits = heightUnits + step;
        break;
      case 'ArrowUp':
        if (heightUnits > 1) change.heightUnits = Math.max(1, heightUnits - step);
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
      aria-valuetext={`${String(widthUnits)} ${widthUnits === 1 ? 'unit' : 'units'} wide, rows ${String(heightUnits)} ${heightUnits === 1 ? 'unit' : 'units'} tall together`}
      title={`Resize ${title}: drag the corner, or arrows when focused (← → width, ↑ ↓ row heights; Shift for four units)`}
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
