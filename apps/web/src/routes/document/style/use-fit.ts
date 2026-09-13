/**
 * How the grid and the inspector measure text (INSP-04, ADR-049): one canvas
 * measurer per document view, the active locale's formatting, and the
 * engine's evaluated values for formula cells. Where no 2D context exists
 * (jsdom, a browser without canvas) `fit()` is null and every Fit control
 * says why rather than guessing (no invented data).
 */
import { useCallback, useMemo } from 'react';
import type * as Y from 'yjs';

import { peekEngine } from '../../../doc/engine.js';
import { useLocale } from '../../../locale.js';
import { toFormatLocale } from '../cell/index.js';
import { canvasMeasure, type FitOptions } from './fit.js';

export const NO_MEASURE_REASON = 'text cannot be measured in this browser';

export interface Fitter {
  /** The options to measure with now, or null when this browser cannot measure. */
  fit: () => FitOptions | null;
  /** Why fit is unavailable, or undefined when it is. */
  reason: string | undefined;
}

export function useFitter(doc: Y.Doc | null): Fitter {
  const [activeLocale] = useLocale();
  const measure = useMemo(() => (typeof document === 'undefined' ? null : canvasMeasure()), []);
  const fit = useCallback((): FitOptions | null => {
    if (measure === null) return null;
    const engine = doc === null ? undefined : peekEngine(doc);
    return {
      locale: toFormatLocale(activeLocale),
      measure,
      cellValue: (cellId) => engine?.result(cellId)?.value ?? undefined,
    };
  }, [measure, doc, activeLocale]);
  return { fit, reason: measure === null ? NO_MEASURE_REASON : undefined };
}
