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
import { useMessages } from '../../../i18n/index.js';
import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import type { GridCommands } from '../grid/commands.js';
import { ReasonedButton, Section, Stepper } from './controls.js';

export interface ArrangeTabProps {
  gd: GedeDoc;
  table: TableMap;
  editable: boolean;
  commands: GridCommands;
  /** SET-18: why the table cannot be edited when its section or sheet is locked, else view-only. */
  readOnlyReason?: string | undefined;
}

/**
 * INSP-07: the Arrange tab. Stacking order among the sheet's tables, canvas
 * layout (the prototype's Side by side / Pipeline lanes / Stacked), size,
 * position in both grid address and pixels (live through `setTablePosition`,
 * RESP-01: the table moves on the lattice and every address follows its
 * origin), pin to viewport (PRD §10) and the sheet's DAG edges (PRD §7;
 * cross-sheet edges are counted here, not drawn, PRD §11). Pin and DAG edges
 * are *stated* here and *toggled* in the toolbar: DOC-02 names the toolbar as
 * their home and a command has one (ADR-041).
 */
export function ArrangeTab({ gd, table, editable, commands, readOnlyReason }: ArrangeTabProps) {
  const t = useMessages();
  // Stacking, edges and the sheet flag live outside this table's map.
  useYVersion(gd.tables);
  useYVersion(gd.sheets);
  const record = tableRecord(table);
  const locale = activeLocale();
  const viewOnly = editable ? undefined : (readOnlyReason ?? 'you have view-only access');
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
        label={t('inspector.stackingOrder')}
        hint={
          stack === null
            ? undefined
            : `${record.title} is ${String(stack.index + 1)} of ${String(stack.count)}, back to front.`
        }
      >
        <div className="gd-insp__row" role="group" aria-label={t('inspector.stackingOrder2')}>
          {STACKING_MOVES.map((m) => (
            <ReasonedButton
              key={m}
              label={STACKING_LABELS[m]}
              reason={stackReason(m)}
              onClick={() => {
                commands.restack(record.id, m);
              }}
            />
          ))}
        </div>
      </Section>
      <Section label={t('inspector.canvasLayout')} hint={t('inspector.placesEveryTableOn')}>
        <div className="gd-insp__row" role="group" aria-label={t('inspector.canvasLayout2')}>
          {CANVAS_LAYOUTS.map((layout) => (
            <ReasonedButton
              key={layout}
              label={CANVAS_LAYOUT_LABELS[layout]}
              reason={layoutReason}
              onClick={() => {
                commands.layoutSheet(record.sheetId, layout);
              }}
            />
          ))}
        </div>
      </Section>
      <Section label={t('inspector.size')} hint={t('inspector.wholeLatticeUnitsChange')}>
        <dl className="gd-insp__facts">
          <div>
            <dt>{t('inspector.width')}</dt>
            <dd className="gd-mono">
              {formatNumber(locale, width)} units · {formatNumber(locale, width * LATTICE.col)} px
            </dd>
          </div>
          <div>
            <dt>{t('inspector.rows')}</dt>
            <dd className="gd-mono">{formatNumber(locale, record.rows.length)}</dd>
          </div>
        </dl>
      </Section>
      <Section label={t('inspector.position')} hint={t('inspector.tablesSnapToThe')}>
        <div className="gd-insp__stack">
          <Stepper
            label={t('inspector.column')}
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
            label={t('inspector.row')}
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
              <dt>{t('inspector.address')}</dt>
              <dd className="gd-mono">
                {columnLetter(record.gridCol)}
                {record.gridRow + 1}
              </dd>
            </div>
            <div>
              <dt>{t('inspector.pixels')}</dt>
              <dd className="gd-mono">
                {formatNumber(locale, record.gridCol * LATTICE.col)} ×{' '}
                {formatNumber(locale, record.gridRow * LATTICE.row)}
              </dd>
            </div>
          </dl>
        </div>
      </Section>
      <Section label={t('inspector.viewport')} hint={t('inspector.aPinnedTableKeeps')}>
        <div className="gd-insp__stack">
          <dl className="gd-insp__facts" aria-label={t('inspector.viewport2')}>
            <div>
              <dt>{t('inspector.pinToViewport')}</dt>
              <dd className="gd-mono" data-testid="arrange-pinned">
                {record.pinned ? 'pinned' : 'not pinned'}
              </dd>
            </div>
            <div>
              <dt>{t('inspector.dagEdges')}</dt>
              <dd className="gd-mono" data-testid="arrange-edges">
                {edgesShown ? 'shown' : 'hidden'}
              </dd>
            </div>
          </dl>
          <dl className="gd-insp__facts" aria-label={t('inspector.lineage')}>
            <div>
              <dt>{t('inspector.readsFrom')}</dt>
              <dd className="gd-mono">
                {formatNumber(locale, mine.in)} {mine.in === 1 ? 'table' : 'tables'}
              </dd>
            </div>
            <div>
              <dt>{t('inspector.readBy')}</dt>
              <dd className="gd-mono">
                {formatNumber(locale, mine.out)} {mine.out === 1 ? 'table' : 'tables'}
              </dd>
            </div>
            {mine.crossSheet > 0 && (
              <div>
                <dt>{t('inspector.acrossSheets')}</dt>
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
