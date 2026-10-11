/**
 * A sheet's structure (SET-13..18; ADR-056, SPEC §3–4; designs Main and SectionSummary):
 * its sections as named lanes on lattice columns between two guide lines, and the read-only
 * tables beneath its tables — a summary per section, the sheet summary, the universal set
 * and the super set array. The lanes are the sheet's section records; the tables are the
 * engine's own (`EngineHost.structure`), projections of the set tables that formulas read by
 * A1 address and by `@`, drawn here at the lattice positions they hold, so what is drawn is
 * what a formula reads. Sections only choose where a table sits, so no A1 address moves
 * (SET-17).
 */
import clsx from 'clsx';
import { useRef, useSyncExternalStore, type CSSProperties } from 'react';
import {
  LATTICE,
  TABLE_HEADER_ROWS,
  TABLE_TITLE_ROWS,
  formatAddress,
  listSections,
  sheetBounds,
  SUMMARY_ALGEBRA_LIMIT,
  type GedeDoc,
  type Id,
  type SectionRecord,
  type StructureKind,
  type StructureTable,
} from '@gede/core';
import { Button, Icon, Menu, type MenuEntry } from '@gede/ui';

import { engineFor, peekEngine } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useMessages, type MessageKey, type Translate } from '../../../i18n/index.js';
import { formatNumber } from '../../../intl.js';
import { useLocale, type Locale } from '../../../locale.js';
import { InlineNameField } from '../InlineNameField.js';
import type { RenameResult } from '../grid/rename.js';

export interface SheetStructureProps {
  gd: GedeDoc;
  sheetId: Id;
  /** Where the lane headings offer their menu and Rename section…; false on phone and for viewers. */
  editable: boolean;
  /** The section whose heading is an inline name field right now, or null. */
  renaming: Id | null;
  commitRename: (sectionId: Id, name: string) => RenameResult;
  cancelRename: () => void;
  /** The section menu's entries (Rename section…, Lock section / Unlock section). */
  menuEntries: (sectionId: Id) => MenuEntry[];
}

/** Re-render when the engine's results or its structure tables move. */
function useEngineTick(gd: GedeDoc): void {
  useSyncExternalStore(
    (onChange) => engineFor(gd.doc).subscribeAll(onChange),
    () => peekEngine(gd.doc)?.version ?? 0,
    () => 0,
  );
}

const px = (units: number, unit: number): string => `${String(units * unit)}px`;

const KIND_TAG: Readonly<Record<StructureKind, MessageKey>> = {
  section: 'summary.section.kind',
  sheet: 'summary.sheet.kind',
  universe: 'summary.universe.kind',
  super: 'summary.super.kind',
};

const TEST_ID: Readonly<Record<StructureKind, string>> = {
  section: 'section-summary',
  sheet: 'sheet-summary',
  universe: 'universal-set',
  super: 'super-set-array',
};

/** The three pair columns of a section summary (SET-15): “—” with the reason above the limit. */
const PAIR_COLUMNS = 9;
const DASH = '—';

/** “—” means GeDe checked and found none (SET-15): drawn as the dash, spoken as the words. */
function None({ t, reason }: { t: Translate; reason?: string | undefined }) {
  return (
    <>
      <span aria-hidden="true" title={reason}>
        {DASH}
      </span>
      <span className="gd-visually-hidden">{reason ?? t('summary.none')}</span>
    </>
  );
}

/** The title bar's second row: what the table counts, in words (SET-05's voice). */
function countsLine(entry: StructureTable, locale: Locale, t: Translate): string {
  const n = (count: number) => formatNumber(locale, count);
  switch (entry.kind) {
    case 'section':
      return [
        `${t('summary.setCount', { count: n(entry.sets) })} · ${t('summary.elementCount', { count: n(entry.elements) })}`,
        entry.algebra ? null : t('summary.tooMany', { limit: SUMMARY_ALGEBRA_LIMIT }),
      ]
        .filter((part) => part !== null)
        .join(' · ');
    case 'sheet':
      return t('summary.indexes');
    case 'universe':
      return `${t('summary.universe.count', { count: n(entry.elements) })} · @U`;
    case 'super':
      return t('summary.super.count', { elements: n(entry.elements), sets: n(entry.sets) });
  }
}

/**
 * One structure table, drawn on the lattice where the engine holds it: a title bar of two
 * rows, a header row, one row per entry, a lattice unit per column unit. Read-only and
 * unscrolled; a cell carries its A1 address so what is drawn can be checked against what a
 * formula reads.
 */
function StructureTableView({
  entry,
  section,
  locale,
  t,
}: {
  entry: StructureTable;
  section: SectionRecord | undefined;
  locale: Locale;
  t: Translate;
}) {
  const { table, bounds } = entry;
  const tag = t(KIND_TAG[entry.kind]);
  const showTitle = entry.kind === 'section' || entry.kind === 'universe';
  const label =
    entry.kind === 'section' && section !== undefined
      ? t('summary.section.label', { section: section.name })
      : tag;
  const style: CSSProperties = {
    left: px(bounds.col, LATTICE.col),
    top: px(bounds.row, LATTICE.row),
    width: px(bounds.cols, LATTICE.col),
    height: px(bounds.rows, LATTICE.row),
  };
  let offset = 0;
  const offsets = table.columns.map((c) => {
    const at = offset;
    offset += c.width;
    return at;
  });
  const addressOf = (rowIndex: number, colIndex: number): string =>
    formatAddress({
      col: table.gridCol + (offsets[colIndex] ?? 0),
      row: table.gridRow + TABLE_TITLE_ROWS + TABLE_HEADER_ROWS + rowIndex,
    });
  const limit = t('summary.tooMany', { limit: SUMMARY_ALGEBRA_LIMIT });
  return (
    <section
      className={clsx('gd-sband', `gd-sband--${entry.kind}`)}
      style={style}
      aria-label={label}
      data-testid={TEST_ID[entry.kind]}
      data-table-title={table.title}
      {...(entry.sectionId === null ? {} : { 'data-section-id-summary': entry.sectionId })}
    >
      <table className="gd-sband__table" aria-describedby={undefined}>
        <colgroup>
          {table.columns.map((c) => (
            <col key={c.id} style={{ width: px(c.width, LATTICE.col) }} />
          ))}
        </colgroup>
        <caption className="gd-sband__caption">
          <div className="gd-sband__caption-row">
            <span className="gd-mono gd-sband__degree" aria-hidden="true">
              −2°
            </span>
            <span className="gd-sband__kind">{tag}</span>
            {showTitle && (
              <span className="gd-sband__title" title={table.title}>
                {table.title}
              </span>
            )}
          </div>
          <div className="gd-sband__caption-row">
            <span className="gd-mono gd-sband__degree" aria-hidden="true">
              −1°
            </span>
            <span className="gd-mono gd-sband__counts">{countsLine(entry, locale, t)}</span>
          </div>
        </caption>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={c.id} scope="col" className="gd-sband__th" data-address={addressOf(-1, i)}>
                {i === 0 && (
                  <span className="gd-mono gd-sband__degree" aria-hidden="true">
                    ±0°
                  </span>
                )}
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((rowId, r) => (
            <tr key={rowId}>
              {table.columns.map((c, i) => {
                const cell = table.cells[`${rowId}:${c.id}`];
                const text = cell?.kind === 'text' ? cell.text : '';
                const body =
                  text === DASH ? (
                    <None
                      t={t}
                      reason={
                        entry.kind === 'section' && !entry.algebra && i >= PAIR_COLUMNS
                          ? limit
                          : undefined
                      }
                    />
                  ) : (
                    text
                  );
                const props = {
                  'data-address': addressOf(r, i),
                  title: text === DASH ? undefined : text,
                };
                return i === 0 ? (
                  <th
                    key={c.id}
                    scope="row"
                    className="gd-sband__cell gd-sband__cell--first"
                    {...props}
                  >
                    <span
                      className="gd-mono gd-sband__degree"
                      aria-hidden="true"
                    >{`+${String(r + 1)}°`}</span>
                    {body}
                  </th>
                ) : (
                  <td key={c.id} className="gd-sband__cell" {...props}>
                    {body}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function SheetStructure({
  gd,
  sheetId,
  editable,
  renaming,
  commitRename,
  cancelRename,
  menuEntries,
}: SheetStructureProps) {
  useYVersion(gd.sheets);
  useYVersion(gd.tables);
  useEngineTick(gd);
  const afterClose = useRef<(() => void) | null>(null);
  const t = useMessages();
  const [locale] = useLocale();
  const sections = listSections(gd, sheetId);
  const tables = peekEngine(gd.doc)?.structure(sheetId) ?? [];
  if (sections.length === 0 && tables.length === 0) return null;
  // The lanes run down past the sheet's tables and the structure tables beneath them.
  const own = sheetBounds(gd, sheetId);
  const last = tables.at(-1);
  const laneRows = Math.max(
    own === null ? 1 : own.row + own.rows + 1,
    last === undefined ? 0 : last.bounds.row + last.bounds.rows + 1,
  );
  return (
    <div className="gd-structure" data-testid="sheet-structure">
      {sections.map((section, i) => (
        <div
          key={section.id}
          className={clsx('gd-lane', { 'gd-lane--locked': section.locked })}
          style={{
            left: px(section.firstColumn, LATTICE.col),
            width: px(section.lastColumn - section.firstColumn + 1, LATTICE.col),
            height: px(laneRows, LATTICE.row),
          }}
          data-testid="section-lane"
        >
          <span className="gd-lane__guide gd-lane__guide--start" aria-hidden="true" />
          <span className="gd-lane__guide gd-lane__guide--end" aria-hidden="true" />
          <div
            className="gd-lane__heading"
            data-section-id={section.id}
            data-sheet-id={sheetId}
            role="group"
            aria-label={t('section.label', { n: i + 1, name: section.name })}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
          >
            <span className="gd-mono gd-lane__ordinal">{`${String(i + 1)}°`}</span>
            {renaming === section.id ? (
              <InlineNameField
                value={section.name}
                label={t('section.rename.field')}
                emptyReason={t('section.rename.empty')}
                commit={(name) => commitRename(section.id, name)}
                cancel={cancelRename}
                className="gd-table__rename gd-lane__rename"
                reasonClassName="gd-table__rename-reason"
                data={{ 'data-section-rename': section.id }}
              />
            ) : (
              <h2 className="gd-lane__name" title={section.name}>
                {section.name}
              </h2>
            )}
            <span className="gd-mono gd-lane__state">
              {section.locked ? (
                <span role="status" className="gd-lane__locked">
                  <Icon name="locked" size={13} />
                  {t('lock.status', { name: section.name })}
                </span>
              ) : (
                t('lock.state.unlocked')
              )}
            </span>
            {editable && (
              <Menu
                label={t('section.menu', { name: section.name })}
                align="end"
                // Rename section… waits for the menu to close: its focus trap would pull the
                // name field's focus back, and a field that loses focus at once commits.
                entries={menuEntries(section.id).map((entry) =>
                  entry.kind === 'item' && entry.id === 'section-rename'
                    ? {
                        ...entry,
                        onSelect: () => {
                          afterClose.current = entry.onSelect;
                        },
                      }
                    : entry,
                )}
                onCloseAutoFocus={(event) => {
                  const run = afterClose.current;
                  afterClose.current = null;
                  if (run === null) return;
                  event.preventDefault();
                  run();
                }}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gd-lane__menu"
                    aria-label={t('section.menu', { name: section.name })}
                  >
                    <Icon name="more" size={13} />
                  </Button>
                }
              />
            )}
          </div>
        </div>
      ))}
      {tables.map((entry) => (
        <StructureTableView
          key={entry.table.id}
          entry={entry}
          section={sections.find((x) => x.id === entry.sectionId)}
          locale={locale}
          t={t}
        />
      ))}
    </div>
  );
}
