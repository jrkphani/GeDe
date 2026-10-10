/**
 * A sheet's structure (SET-13..18; ADR-056, SPEC §3–4; designs Main and SectionSummary):
 * its sections as named lanes on lattice columns between two guide lines, and the read-only
 * tables beneath its tables — a summary per section, the sheet summary, the universal set
 * and the super set array. None of it is a Yjs row: the lanes are the sheet's section
 * records, the tables are pure functions of the set tables (`summarySets`), redrawn when a
 * set changes. Sections only choose where a table sits, so no A1 address moves (SET-17).
 */
import clsx from 'clsx';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import {
  LATTICE,
  cellKey,
  listSections,
  sectionSummary,
  sheetBounds,
  sheetSummary,
  structureLayout,
  summarySets,
  superSetArray,
  universalSet,
  workbookCellId,
  type BandBlock,
  type GedeDoc,
  type Id,
  type SectionRecord,
  type SummaryRow,
  type SummarySet,
  SUMMARY_ALGEBRA_LIMIT,
} from '@gede/core';
import { Button, Icon, Menu, type MenuEntry } from '@gede/ui';

import { engineFor, peekEngine } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useMessages, type Translate } from '../../../i18n/index.js';
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

/** Re-render on every batch of engine results while `wanted`: a formula range counts its value. */
function useEngineTick(gd: GedeDoc, wanted: boolean): void {
  useSyncExternalStore(
    (onChange) => (wanted ? engineFor(gd.doc).subscribeAll(onChange) : () => undefined),
    () => (wanted ? (peekEngine(gd.doc)?.version ?? 0) : 0),
    () => 0,
  );
}

const px = (units: number, unit: number): string => `${String(units * unit)}px`;

function blockStyle(block: BandBlock) {
  return {
    left: px(block.col, LATTICE.col),
    top: px(block.row, LATTICE.row),
    width: px(block.cols, LATTICE.col),
    height: px(block.rows, LATTICE.row),
  };
}

/** “—” means GeDe checked and found none (SET-15): drawn as the dash, spoken as the words. */
function None({ t, reason }: { t: Translate; reason?: string | undefined }) {
  return (
    <>
      <span aria-hidden="true" title={reason}>
        —
      </span>
      <span className="gd-visually-hidden">{reason ?? t('summary.none')}</span>
    </>
  );
}

function Names({
  names,
  t,
  reason,
}: {
  names: readonly string[] | null;
  t: Translate;
  reason: string;
}) {
  if (names === null) return <None t={t} reason={reason} />;
  if (names.length === 0) return <None t={t} />;
  return <span title={names.join(', ')}>{names.join(', ')}</span>;
}

function SectionSummaryTable({
  section,
  ordinal,
  sets,
  block,
  locale,
  t,
}: {
  section: SectionRecord;
  ordinal: number;
  sets: readonly SummarySet[];
  block: BandBlock;
  locale: Locale;
  t: Translate;
}) {
  const summary = sectionSummary(sets);
  const limit = t('summary.tooMany', { limit: SUMMARY_ALGEBRA_LIMIT });
  const label = t('summary.section.label', { section: section.name });
  const columns = [
    'id',
    'name',
    'definition',
    'cardinality',
    'status',
    'equal',
    'improper',
    'proper',
    'elementOf',
    'intersection',
    'union',
    'difference',
  ] as const;
  const status = (row: SummaryRow): string | null =>
    row.status === null ? null : t(row.status === 'null' ? 'set.meta.null' : 'set.meta.singleton');
  const count = (n: number) => formatNumber(locale, n);
  return (
    <section
      className="gd-sband gd-sband--summary"
      style={blockStyle(block)}
      aria-label={label}
      data-testid="section-summary"
      data-section-id-summary={section.id}
      // The table is wider than a lane: it scrolls inside the lane, by keyboard too.
      tabIndex={0}
    >
      <table className="gd-sband__table">
        <caption className="gd-sband__caption">
          <div className="gd-sband__caption-row">
            <span className="gd-mono gd-sband__degree" aria-hidden="true">
              −2°
            </span>
            <span className="gd-sband__kind">{t('summary.section.kind')}</span>
            <span className="gd-sband__title">{`${String(ordinal)}° ${section.name}`}</span>
          </div>
          <div className="gd-sband__caption-row">
            <span className="gd-mono gd-sband__degree" aria-hidden="true">
              −1°
            </span>
            <span className="gd-mono gd-sband__counts">
              {`${t('summary.setCount', { count: count(summary.setCount) })} · ${t('summary.elementCount', { count: count(summary.elementCount) })}`}
            </span>
          </div>
        </caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} scope="col" className={clsx('gd-sband__th', `gd-sband__col--${c}`)}>
                {i === 0 && (
                  <span className="gd-mono gd-sband__degree" aria-hidden="true">
                    ±0°
                  </span>
                )}
                {t(`summary.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row, i) => (
            <tr key={row.id}>
              <th scope="row" className="gd-mono gd-sband__id" title={row.id}>
                <span
                  className="gd-mono gd-sband__degree"
                  aria-hidden="true"
                >{`+${String(i + 1)}°`}</span>
                {row.id.slice(0, 10)}
              </th>
              <td className="gd-sband__name" title={row.name}>
                {row.name}
              </td>
              <td title={row.definition}>
                {row.definition === '' ? <None t={t} /> : row.definition}
              </td>
              <td className="gd-mono">
                {row.bag === row.cardinality
                  ? count(row.cardinality)
                  : `${count(row.cardinality)} · ${t('summary.bag', { count: count(row.bag) })}`}
              </td>
              <td>{status(row) ?? <None t={t} />}</td>
              <td>
                <Names names={row.equal} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.improperSubsetOf} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.properSubsetOf} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.elementOf} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.intersection} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.union} t={t} reason={limit} />
              </td>
              <td>
                <Names names={row.difference} t={t} reason={limit} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gd-sband__note">
        {t('summary.note')}
        {!summary.algebra && ` ${limit}.`}
      </p>
    </section>
  );
}

function ListBlock({
  block,
  kind,
  title,
  counts,
  note,
  testId,
  children,
}: {
  block: BandBlock;
  kind: string;
  title: string;
  counts: string;
  note?: string | undefined;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="gd-sband gd-sband--list"
      style={blockStyle(block)}
      aria-label={title}
      data-testid={testId}
    >
      <header className="gd-sband__head">
        <span className="gd-mono gd-sband__degree" aria-hidden="true">
          −2°
        </span>
        <span className="gd-sband__kind">{kind}</span>
        <span className="gd-mono gd-sband__counts">{counts}</span>
      </header>
      <ul className="gd-sband__chips">{children}</ul>
      {note !== undefined && <p className="gd-sband__note">{note}</p>}
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
  const afterClose = useRef<(() => void) | null>(null);
  const t = useMessages();
  const [locale] = useLocale();
  const sections = listSections(gd, sheetId);
  // Read the engine only while a range holds a formula it must count (as `useSetFacts` does).
  const plain = summarySets(gd, sheetId);
  useEngineTick(gd, plain.length > 0);
  const engine = peekEngine(gd.doc);
  const sets =
    engine === undefined
      ? plain
      : summarySets(
          gd,
          sheetId,
          (tableId) => (rowId, colId) =>
            engine.result(workbookCellId(tableId, cellKey(rowId, colId)))?.value,
        );
  const bounds = sheetBounds(gd, sheetId);
  const top = bounds === null ? 1 : bounds.row + bounds.rows + 1;
  const layout = structureLayout(top, sections, sets);
  if (layout === null) return null;
  const laneRows = layout.end + 1;
  const universe = universalSet(sets);
  const superSet = superSetArray(sets);
  const rows = sheetSummary(sections, sets);
  const count = (n: number) => formatNumber(locale, n);
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
      {layout.sections.map(({ sectionId, block }) => {
        const index = sections.findIndex((s) => s.id === sectionId);
        const section = sections[index];
        return section === undefined ? null : (
          <SectionSummaryTable
            key={sectionId}
            section={section}
            ordinal={index + 1}
            sets={sets.filter((s) => s.sectionId === sectionId)}
            block={block}
            locale={locale}
            t={t}
          />
        );
      })}
      <section
        className="gd-sband"
        style={blockStyle(layout.sheetSummary)}
        aria-label={t('summary.sheet.kind')}
        data-testid="sheet-summary"
        tabIndex={0}
      >
        <table className="gd-sband__table gd-sband__table--sheet">
          <caption className="gd-sband__caption">
            <div className="gd-sband__caption-row">
              <span className="gd-mono gd-sband__degree" aria-hidden="true">
                −2°
              </span>
              <span className="gd-sband__kind">{t('summary.sheet.kind')}</span>
            </div>
            <div className="gd-sband__caption-row">
              <span className="gd-mono gd-sband__degree" aria-hidden="true">
                −1°
              </span>
              <span className="gd-mono gd-sband__counts">{t('summary.indexes')}</span>
            </div>
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('summary.sheet.section')}</th>
              <th scope="col">{t('summary.sheet.sets')}</th>
              <th scope="col">{t('summary.sheet.elements')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.sectionId}>
                <th scope="row">{`${String(i + 1)}° ${row.name}`}</th>
                <td className="gd-mono">{count(row.setCount)}</td>
                <td className="gd-mono">{count(row.elementCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <ListBlock
        block={layout.universe}
        kind={t('summary.universe.kind')}
        title={t('summary.universe.kind')}
        counts={t('summary.universe.count', { count: count(universe.length) })}
        note={t('summary.universe.hint')}
        testId="universal-set"
      >
        {universe.map((element) => (
          <li key={element} className="gd-mono gd-sband__chip" title={element}>
            {element}
          </li>
        ))}
      </ListBlock>
      <ListBlock
        block={layout.superSet}
        kind={t('summary.super.kind')}
        title={t('summary.super.kind')}
        counts={t('summary.super.count', {
          elements: count(superSet.elements.length),
          sets: count(superSet.sets.length),
        })}
        testId="super-set-array"
      >
        {superSet.elements.map((element) => (
          <li key={`e${element}`} className="gd-mono gd-sband__chip" title={element}>
            <span className="gd-sband__chip-kind">{t('summary.super.element')}</span>
            {element}
          </li>
        ))}
        {superSet.sets.map((name) => (
          <li key={`s${name}`} className="gd-sband__chip gd-sband__chip--set" title={name}>
            <span className="gd-sband__chip-kind">{t('summary.super.set')}</span>
            {name}
          </li>
        ))}
      </ListBlock>
    </div>
  );
}
