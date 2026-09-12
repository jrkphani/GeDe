import clsx from 'clsx';
import { useMemo, type CSSProperties } from 'react';
import type * as Y from 'yjs';
import { LATTICE, type Id, type OperandOutline } from '@gede/core';

import { useWorkbookIndexVersion } from '../../../doc/workbook-index.js';
import { operandsOf } from './workbook.js';

/** Six outline colours cycle (`--reference-1..6`); the index badge disambiguates beyond that. */
export const REFERENCE_COLOURS = 6;

/** Tooltip for an operand that is not bound to a cell (PRD §20). */
export const POSITIONAL_TITLE = (label: string): string =>
  `${label} is not anchored to a cell: it follows the address, so rows inserted above it change what it reads. Re-enter the formula once a table covers it.`;

export function referenceColourVar(operandIndex: number): string {
  return `var(--reference-${String((operandIndex % REFERENCE_COLOURS) + 1)})`;
}

export interface ReferenceOutlinesProps {
  /** Operands in formula order; `rect` null means nothing on this sheet to outline. */
  operands: readonly OperandOutline[];
  /** Current zoom, so the stroke and badge keep their screen size while the block scales. */
  zoom: number;
}

/**
 * FX-08 / A11Y-04: one outlined block per operand, in the colour of its
 * operand index, with that index as a badge. Mounted inside the canvas layer
 * (`.gd-canvas__layer`) so pan and zoom carry it for free; unmount to clear.
 */
export function ReferenceOutlines({ operands, zoom }: ReferenceOutlinesProps) {
  const style = { '--gd-zoom': String(zoom) } as CSSProperties;
  return (
    <div className="gd-outlines" style={style} data-testid="reference-outlines" aria-hidden="true">
      {operands.map((o) => {
        if (o.rect === null) return null;
        const outline = {
          left: `${String(o.rect.col * LATTICE.col)}px`,
          top: `${String(o.rect.row * LATTICE.row)}px`,
          width: `${String(o.rect.cols * LATTICE.col)}px`,
          height: `${String(o.rect.rows * LATTICE.row)}px`,
          '--gd-outline': referenceColourVar(o.index),
        } as CSSProperties;
        // PRD §20: an operand that follows the address rather than a cell is drawn in the muted
        // ramp with a dashed stroke and says so (never hue alone, A11Y-04).
        const positional = !o.anchored;
        return (
          <div
            key={`${String(o.index)}:${o.label}`}
            className={clsx(`gd-outline gd-outline--${o.kind}`, {
              'gd-outline--positional': positional,
            })}
            style={outline}
            data-operand={o.index + 1}
            data-label={o.label}
            data-anchored={o.anchored}
            title={positional ? POSITIONAL_TITLE(o.label) : undefined}
          >
            <span className="gd-mono gd-outline__index">
              {o.index + 1}
              {positional && <span className="gd-outline__positional">not anchored</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Operands of a formula text on a sheet — a typed draft or a stored source —
 * resolved against the cached workbook index; recomputed only when the text
 * or the workbook's shape changes, never per keystroke elsewhere.
 */
export function useOperandsOf(
  doc: Y.Doc,
  sheetId: Id | null,
  formula: string | null,
  /** True for the cell's stored source: operands that are not bound tokens are flagged positional. */
  stored = false,
): readonly OperandOutline[] {
  const version = useWorkbookIndexVersion(doc);
  return useMemo(
    () => (sheetId === null || formula === null ? [] : operandsOf(doc, sheetId, formula, stored)),
    // version is the change signal for the index reads inside operandsOf.
    [doc, sheetId, formula, stored, version],
  );
}
