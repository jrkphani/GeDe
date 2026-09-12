import {
  columnLetter,
  LATTICE,
  setTablePosition,
  tableRecord,
  type GedeDoc,
  type TableMap,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import { Section, Slot, Stepper, UnavailableRow } from './controls.js';

export interface ArrangeTabProps {
  gd: GedeDoc;
  table: TableMap;
  editable: boolean;
}

/**
 * INSP-07: the Arrange tab. Position in both grid address and pixels, live
 * through `setTablePosition` (RESP-01: the table moves on the lattice, its
 * cells keep their offsets, so every address follows the origin). Stacking
 * order, canvas layout, pin to viewport and DAG edges are not implemented
 * yet and say so (INSP-11).
 */
export function ArrangeTab({ gd, table, editable }: ArrangeTabProps) {
  const record = tableRecord(table);
  const locale = activeLocale();
  const viewOnly = editable ? undefined : 'you have view-only access';
  const width = record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0);
  const move = (col: number, row: number) => {
    setTablePosition(gd, record.id, { col, row });
    announce(`${record.title} moved to ${columnLetter(col)}${String(row + 1)}`);
  };
  return (
    <>
      <Section label="order">
        <UnavailableRow labels={['Back', 'Backward', 'Forward', 'Front']} />
      </Section>
      <Section label="align on canvas">
        <UnavailableRow labels={['Side by side', 'Pipeline lanes', 'Stacked']} />
      </Section>
      <Section label="size" hint="Whole lattice units; change the width from the Table tab.">
        <dl className="gd-insp__facts">
          <div>
            <dt>Width</dt>
            <dd className="gd-mono">
              {formatNumber(locale, width)} units · {formatNumber(locale, width * LATTICE.col)} px
            </dd>
          </div>
          <div>
            <dt>Rows</dt>
            <dd className="gd-mono">{formatNumber(locale, record.rows.length)}</dd>
          </div>
        </dl>
      </Section>
      <Section
        label="position"
        hint="Tables snap to the 160 × 22 grid, so A1 addressing stays exact."
      >
        <div className="gd-insp__stack">
          <Stepper
            label="Column"
            unit="column"
            value={record.gridCol}
            min={0}
            disabledReason={viewOnly}
            decrementReason="already at column A"
            onChange={(next) => {
              move(next, record.gridRow);
            }}
          />
          <Stepper
            label="Row"
            unit="row"
            value={record.gridRow + 1}
            min={1}
            disabledReason={viewOnly}
            decrementReason="already at row 1"
            onChange={(next) => {
              move(record.gridCol, next - 1);
            }}
          />
          <dl className="gd-insp__facts">
            <div>
              <dt>Address</dt>
              <dd className="gd-mono">
                {columnLetter(record.gridCol)}
                {record.gridRow + 1}
              </dd>
            </div>
            <div>
              <dt>Pixels</dt>
              <dd className="gd-mono">
                {formatNumber(locale, record.gridCol * LATTICE.col)} ×{' '}
                {formatNumber(locale, record.gridRow * LATTICE.row)}
              </dd>
            </div>
          </dl>
        </div>
      </Section>
      <Section label="viewport">
        <UnavailableRow labels={['Pin to viewport', 'DAG edges']} />
        <Slot name="graph" reason="Edges arrive with the context graph release." />
      </Section>
    </>
  );
}
