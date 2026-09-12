import { Button, Switch, Tooltip } from '@gede/ui';
import {
  CANVAS_LAYOUT_LABELS,
  CANVAS_LAYOUTS,
  columnLetter,
  dagEdges,
  edgesOf,
  LATTICE,
  setTablePosition,
  sheetEdgesShown,
  STACKING_LABELS,
  STACKING_MOVES,
  stackingPosition,
  tableRecord,
  type GedeDoc,
  type StackingMove,
  type TableMap,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import type { GridCommands } from '../grid/commands.js';
import { Section, Stepper } from './controls.js';

export interface ArrangeTabProps {
  gd: GedeDoc;
  table: TableMap;
  editable: boolean;
  commands: GridCommands;
}

/**
 * INSP-07: the Arrange tab. Stacking order among the sheet's tables, canvas
 * layout (the prototype's Side by side / Pipeline lanes / Stacked), size,
 * position in both grid address and pixels (live through `setTablePosition`,
 * RESP-01: the table moves on the lattice and every address follows its
 * origin), pin to viewport (PRD §10) and the sheet's DAG edges (PRD §7;
 * cross-sheet edges are counted here, not drawn, PRD §11).
 */
export function ArrangeTab({ gd, table, editable, commands }: ArrangeTabProps) {
  // Stacking, edges and the sheet flag live outside this table's map.
  useYVersion(gd.tables);
  useYVersion(gd.sheets);
  const record = tableRecord(table);
  const locale = activeLocale();
  const viewOnly = editable ? undefined : 'you have view-only access';
  const width = record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0);
  const move = (col: number, row: number) => {
    setTablePosition(gd, record.id, { col, row });
    announce(`${record.title} moved to ${columnLetter(col)}${String(row + 1)}`);
  };
  const stack = stackingPosition(gd, record.id);
  const edges = dagEdges(gd, record.sheetId);
  const mine = edgesOf(edges, record.id);
  const edgesShown = sheetEdgesShown(gd, record.sheetId);
  const stackReason = (m: StackingMove): string | undefined => {
    if (viewOnly !== undefined) return viewOnly;
    if (stack === null || stack.count < 2) return 'the only table on this sheet';
    if ((m === 'back' || m === 'backward') && stack.index === 0) return 'already at the back';
    if ((m === 'front' || m === 'forward') && stack.index === stack.count - 1)
      return 'already at the front';
    return undefined;
  };
  const layoutReason =
    viewOnly ?? (stack === null || stack.count < 2 ? 'the only table on this sheet' : undefined);

  return (
    <>
      <Section
        label="stacking order"
        hint={
          stack === null
            ? undefined
            : `${record.title} is ${String(stack.index + 1)} of ${String(stack.count)}, back to front.`
        }
      >
        <div className="gd-insp__row" role="group" aria-label="Stacking order">
          {STACKING_MOVES.map((m) => {
            const reason = stackReason(m);
            const label = STACKING_LABELS[m];
            return (
              <Tooltip key={m} content={reason === undefined ? label : `${label} — ${reason}`}>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={reason !== undefined || undefined}
                  title={reason === undefined ? label : `${label} — ${reason}`}
                  onClick={
                    reason === undefined
                      ? () => {
                          commands.restack(record.id, m);
                        }
                      : undefined
                  }
                >
                  {label}
                </Button>
              </Tooltip>
            );
          })}
        </div>
      </Section>
      <Section
        label="canvas layout"
        hint="Places every table on this sheet at once; positions stay on the lattice and every address follows its table."
      >
        <div className="gd-insp__row" role="group" aria-label="Canvas layout">
          {CANVAS_LAYOUTS.map((layout) => {
            const label = CANVAS_LAYOUT_LABELS[layout];
            return (
              <Tooltip
                key={layout}
                content={layoutReason === undefined ? label : `${label} — ${layoutReason}`}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={layoutReason !== undefined || undefined}
                  title={layoutReason === undefined ? label : `${label} — ${layoutReason}`}
                  onClick={
                    layoutReason === undefined
                      ? () => {
                          commands.layoutSheet(record.sheetId, layout);
                        }
                      : undefined
                  }
                >
                  {label}
                </Button>
              </Tooltip>
            );
          })}
        </div>
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
      <Section
        label="viewport"
        hint="A pinned table keeps its place on screen while the sheet pans; a ghost stays where it belongs."
      >
        <div className="gd-insp__stack">
          <Switch
            label="Pin to viewport"
            checked={record.pinned}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setTablePinned(record.id, on);
            }}
          />
          <Switch
            label="DAG edges"
            checked={edgesShown}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setSheetEdgesShown(record.sheetId, on);
            }}
          />
          <dl className="gd-insp__facts" aria-label="Lineage">
            <div>
              <dt>Reads from</dt>
              <dd className="gd-mono">
                {formatNumber(locale, mine.in)} {mine.in === 1 ? 'table' : 'tables'}
              </dd>
            </div>
            <div>
              <dt>Read by</dt>
              <dd className="gd-mono">
                {formatNumber(locale, mine.out)} {mine.out === 1 ? 'table' : 'tables'}
              </dd>
            </div>
            {mine.crossSheet > 0 && (
              <div>
                <dt>Across sheets</dt>
                <dd className="gd-mono">
                  {formatNumber(locale, mine.crossSheet)} — reported, not drawn
                </dd>
              </div>
            )}
          </dl>
        </div>
      </Section>
    </>
  );
}
