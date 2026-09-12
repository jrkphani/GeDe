import clsx from 'clsx';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { columnLetter, LATTICE } from '@gede/core';

import {
  pan,
  toCanvas,
  visibleRange,
  wheelZoomFactor,
  zoomBy,
  zoomTier,
  type Size,
  type Viewport,
} from '../../doc/viewport.js';

export interface CanvasProps {
  viewport: Viewport;
  onViewportChange: (next: Viewport) => void;
  /** Reports the plane's size so Fit can frame content (DOC-07). */
  onSizeChange: (size: Size) => void;
  gridlines: boolean;
  /** Clicking empty canvas clears selection (GRID-03). */
  onClearSelection: () => void;
  /** Double-clicking empty canvas offers a table there (PRD §11 empty-sheet affordance). */
  onPlaceTable?: ((at: { x: number; y: number }) => void) | undefined;
  children: ReactNode;
}

/** Until the container has been measured, assume the lg breakpoint so rulers render at once. */
const FALLBACK_SIZE: Size = { width: 1024, height: 768 };
/** Pointer travel below this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

interface Pinch {
  pointers: Map<number, { x: number; y: number }>;
  lastDistance: number | null;
}

/**
 * The infinite plane (DOC-04, DOC-06). DOM-first: tables are DOM children of
 * one CSS-transformed layer; the only `<canvas>` is the gridlines. Rulers are
 * laid out in canvas space from the same viewport so they track pan and zoom
 * exactly.
 */
export function Canvas({
  viewport,
  onViewportChange,
  onSizeChange,
  gridlines,
  onClearSelection,
  onPlaceTable,
  children,
}: CanvasProps) {
  const planeRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const measured = size.width > 0 && size.height > 0 ? size : FALLBACK_SIZE;
  const range = visibleRange(viewport, measured);
  const tier = zoomTier(viewport.zoom);
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<Pinch>({ pointers: new Map(), lastDistance: null });
  const latest = useRef(viewport);
  latest.current = viewport;

  // Measure the plane; the canvas queries its container, not the window.
  useLayoutEffect(() => {
    const el = planeRef.current;
    if (el === null) return undefined;
    const report = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    onSizeChange(measured);
  }, [measured.width, measured.height, onSizeChange, measured]);

  // Gridlines on a canvas layer, from the same viewport as the rulers.
  useEffect(() => {
    const canvas = gridRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(measured.width * dpr));
    canvas.height = Math.max(1, Math.round(measured.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, measured.width, measured.height);
    if (!gridlines) return;
    const stroke = getComputedStyle(canvas).getPropertyValue('--border').trim();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const colPx = LATTICE.col * viewport.zoom;
    const rowPx = LATTICE.row * viewport.zoom;
    for (let c = range.colStart; c <= range.colEnd; c += 1) {
      const x = Math.round(c * colPx - viewport.x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, measured.height);
    }
    for (let r = range.rowStart; r <= range.rowEnd; r += 1) {
      const y = Math.round(r * rowPx - viewport.y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(measured.width, y);
    }
    ctx.stroke();
  }, [gridlines, viewport, measured, range.colStart, range.colEnd, range.rowStart, range.rowEnd]);

  // ⌥scroll / pinch (ctrl+wheel) zoom about the cursor; plain wheel pans (DOC-04).
  useEffect(() => {
    const el = planeRef.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = latest.current;
      if (e.altKey || e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        onViewportChange(zoomBy(v, wheelZoomFactor(e.deltaY), at));
      } else {
        onViewportChange(pan(v, e.deltaX, e.deltaY));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [onViewportChange]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      pinch.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.current.pointers.size === 2) {
        pinch.current.lastDistance = null;
        drag.current = null;
        return;
      }
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: viewport.x,
      originY: viewport.y,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pinch.current;
    if (e.pointerType === 'touch' && p.pointers.has(e.pointerId)) {
      p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (p.pointers.size === 2) {
        const [a, b] = Array.from(p.pointers.values());
        if (a === undefined || b === undefined) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = e.currentTarget.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        if (p.lastDistance !== null && p.lastDistance > 0) {
          onViewportChange(zoomBy(latest.current, distance / p.lastDistance, mid));
        }
        p.lastDistance = distance;
        return;
      }
    }
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    onViewportChange(pan({ x: d.originX, y: d.originY, zoom: latest.current.zoom }, -dx, -dy));
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    pinch.current.pointers.delete(e.pointerId);
    if (pinch.current.pointers.size < 2) pinch.current.lastDistance = null;
    const d = drag.current;
    if (d?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) onClearSelection();
  };

  const layerStyle: CSSProperties = {
    transform: `translate(${String(-viewport.x)}px, ${String(-viewport.y)}px) scale(${String(viewport.zoom)})`,
  };
  const colPx = LATTICE.col * viewport.zoom;
  const rowPx = LATTICE.row * viewport.zoom;
  const cols: number[] = [];
  for (let c = range.colStart; c < range.colEnd; c += 1) cols.push(c);
  const rows: number[] = [];
  for (let r = range.rowStart; r < range.rowEnd; r += 1) rows.push(r);

  return (
    <div className={clsx('gd-canvas', `gd-canvas--${tier}`)} data-zoom-tier={tier}>
      <div className="gd-canvas__corner" aria-hidden="true" />
      <div className="gd-canvas__cols" aria-hidden="true" data-testid="ruler-columns">
        {cols.map((c) => (
          <span
            key={c}
            className="gd-canvas__ruler-cell"
            style={{ left: `${String(c * colPx - viewport.x)}px`, width: `${String(colPx)}px` }}
            data-col={c}
          >
            {columnLetter(c)}
          </span>
        ))}
      </div>
      <div className="gd-canvas__rows" aria-hidden="true" data-testid="ruler-rows">
        {rows.map((r) => (
          <span
            key={r}
            className="gd-canvas__ruler-cell"
            style={{ top: `${String(r * rowPx - viewport.y)}px`, height: `${String(rowPx)}px` }}
            data-row={r}
          >
            {r + 1}
          </span>
        ))}
      </div>
      <div
        ref={planeRef}
        className="gd-canvas__plane"
        aria-label="Canvas"
        data-testid="plane"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(e) => {
          if (onPlaceTable === undefined || e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onPlaceTable(toCanvas(viewport, { x: e.clientX - rect.left, y: e.clientY - rect.top }));
        }}
      >
        <canvas
          ref={gridRef}
          className="gd-canvas__grid"
          aria-hidden="true"
          data-testid="gridlines"
        />
        <div className="gd-canvas__layer" style={layerStyle} data-testid="layer">
          {children}
        </div>
      </div>
    </div>
  );
}
