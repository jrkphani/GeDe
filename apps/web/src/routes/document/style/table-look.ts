/**
 * The table-level look (INSP-04, INSP-07) as the attributes `document.css`
 * paints from: style ramp, outline weight, gridline density, banding, the
 * stacking order and the pinned state. Names only; the stylesheet maps each
 * to `packages/tokens` custom properties.
 */
import type { CSSProperties } from 'react';
import type { TableRecord } from '@gede/core';

export interface TablePaint {
  readonly data: Readonly<Record<string, string | undefined>>;
  readonly style: CSSProperties;
}

export function paintTable(record: TableRecord): TablePaint {
  const { look } = record;
  return {
    data: {
      'data-style': look.style === 'plain' ? undefined : look.style,
      'data-outline': look.outline,
      'data-gridlines': look.gridlines === 'light' ? undefined : look.gridlines,
      'data-alternating': look.alternating ? 'true' : undefined,
      'data-pinned': record.pinned ? 'true' : undefined,
    },
    // INSP-07: paint order on the sheet. Pinned and match overlays sit above every table's z.
    style: record.z === 0 ? {} : ({ '--gd-z': record.z } as CSSProperties),
  };
}
