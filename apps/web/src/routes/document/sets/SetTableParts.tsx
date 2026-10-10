/**
 * A set table's presentation (SET-02..07; ADR-056, SPEC §5; designs SimpleSet and
 * FamilyOfSets): the meta row and title row drawn in the title bar's two lattice rows, the
 * degree rail along the table's left edge and a family's kind column along its right edge
 * (both inside the footprint, so they never draw over a neighbouring table), the count strip
 * in GRID-11's footer, and a repeat's flag in its range cell. None of it is a Yjs row and
 * none of it takes a lattice unit, so no A1 address moves (SET-07). Every value is read
 * from `setTableFacts` in core; nothing here is typed or stored.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import {
  SET_DEGREE,
  type SetRowFacts,
  type SetTableFacts,
  type TableKind,
  type TableRecord,
} from '@gede/core';

import { useMessages, type MessageKey, type Translate } from '../../../i18n/index.js';
import { formatNumber } from '../../../intl.js';
import type { Locale } from '../../../locale.js';

/**
 * SET-07: one label of the degree rail, in mono with U+00B0. Presentation only: hidden from
 * assistive technology, which reads the cell's A1 address (the index is a label, not data).
 */
export function SetDegree({ label }: { readonly label: string }) {
  return (
    <span className="gd-mono gd-set-degree" aria-hidden="true" data-testid="set-degree">
      {label}
    </span>
  );
}

const KIND_LABEL: Readonly<Record<TableKind, MessageKey>> = {
  plain: 'addTable.kind.plain',
  simple: 'addTable.kind.simple',
  family: 'addTable.kind.family',
  computed: 'addTable.kind.computed',
  product: 'addTable.kind.product',
};

interface MetaValue {
  readonly field: string;
  /** What the chip shows; null renders “—”. */
  readonly shown: string | null;
  /** What assistive technology and the tooltip say for it. */
  readonly said: string;
  readonly id?: boolean;
}

function metaValues(record: TableRecord, facts: SetTableFacts, t: Translate): MetaValue[] {
  const { finite, variable, quantifier } = facts.definition;
  const undetermined = t('set.meta.undetermined');
  const value = (shown: string | null, empty = undetermined) => ({
    shown,
    said: shown ?? empty,
  });
  return [
    { field: t('set.meta.id'), ...value(record.id), id: true },
    {
      field: t('set.meta.finiteness'),
      ...value(finite === null ? null : t('set.meta.finite')),
    },
    {
      field: t('set.meta.variable'),
      ...value(variable === null ? null : t('set.meta.bound')),
    },
    // The chip shows the quantifier's symbol, which fits a two-column set (320 px); the words
    // are its tooltip and what assistive technology hears.
    {
      field: t('set.meta.quantifier'),
      shown:
        quantifier === null
          ? null
          : t(quantifier === 'universal' ? 'set.meta.universalShort' : 'set.meta.existentialShort'),
      said:
        quantifier === null
          ? undetermined
          : t(quantifier === 'universal' ? 'set.meta.universal' : 'set.meta.existential'),
    },
    {
      field: t('set.meta.status'),
      // SET-03: past one element the status is “—”: GeDe checked, and there is none.
      ...value(
        facts.status === null
          ? null
          : t(facts.status === 'null' ? 'set.meta.null' : 'set.meta.singleton'),
        t('set.meta.none'),
      ),
    },
  ];
}

/**
 * SET-03: the read-only row above the header — the set id (the table's ULID), finite or
 * infinite, bound or free, the quantifier and the special status, each a computed value or
 * “—”. Each value names its field in words for assistive technology. The id chip gives way
 * first when the row is narrow; its whole value is in the tooltip and in the Table tab.
 */
export function SetMetaRow({
  record,
  facts,
}: {
  readonly record: TableRecord;
  readonly facts: SetTableFacts;
}) {
  const t = useMessages();
  return (
    <div className="gd-set-meta" data-testid="set-meta">
      <SetDegree label={SET_DEGREE.meta} />
      <ul className="gd-set-meta__values" aria-label={t('set.meta.label')}>
        {metaValues(record, facts, t).map((v) => (
          <li
            key={v.field}
            className={clsx('gd-mono gd-set-meta__value', { 'gd-set-meta__value--id': v.id })}
            title={`${v.field}: ${v.said}`}
          >
            <span className="gd-visually-hidden">{`${v.field}: ${v.said}`}</span>
            <span className="gd-set-meta__shown" aria-hidden="true">
              {v.shown ?? '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * SET-04: the title row — the set's name (the table title, renamed where ADR-051 renames
 * it) and its definition (the caption, edited in the Table tab), rendered as typed, then the
 * table's kind. `children` is the title bar's own content: the name or its rename field, the
 * formula's error, the origin address.
 */
export function SetTitleRow({
  caption,
  kind,
  children,
}: {
  readonly caption: string;
  readonly kind: TableKind;
  readonly children: ReactNode;
}) {
  const t = useMessages();
  return (
    <div className="gd-set-title">
      <SetDegree label={SET_DEGREE.title} />
      {children}
      {caption !== '' && (
        <span className="gd-set-title__definition" title={caption} data-testid="set-definition">
          <span className="gd-visually-hidden">{`${t('set.title.definition')}: `}</span>
          {caption}
        </span>
      )}
      <span className="gd-mono gd-set-title__kind" data-testid="set-kind-badge">
        {t(KIND_LABEL[kind])}
      </span>
    </div>
  );
}

/**
 * SET-05: the footer count strip's counts — `|E| = 3` and `bag 4`, numbers through
 * `Intl.NumberFormat` for the active locale. Assistive technology hears a sentence rather
 * than the bars.
 */
export function SetCounts({
  title,
  facts,
  locale,
}: {
  readonly title: string;
  readonly facts: SetTableFacts;
  readonly locale: Locale;
}) {
  const t = useMessages();
  const cardinality = formatNumber(locale, facts.cardinality);
  const bag = formatNumber(locale, facts.bag);
  return (
    <span className="gd-set-counts" data-testid="set-counts">
      <span className="gd-visually-hidden">
        {t('set.count.label', { set: title, cardinality, bag })}
      </span>
      <span className="gd-set-counts__cardinality" aria-hidden="true">
        {t('set.count.cardinality', { set: title, count: cardinality })}
      </span>
      <span aria-hidden="true">{t('set.count.bag', { count: bag })}</span>
    </span>
  );
}

const ROW_KIND: Readonly<Record<SetRowFacts['kind'], MessageKey>> = {
  element: 'set.rowKind.element',
  set: 'set.rowKind.set',
  family: 'set.rowKind.family',
};

/** SET-02: the words a range cell carries beside a repeated element — “repeat of +2°” — or null. */
export function rangeCellNote(row: SetRowFacts | undefined, t: Translate): string | null {
  return row?.repeatOf == null ? null : t('set.repeat', { degree: row.repeatOf });
}

/**
 * SET-06: a family row's kind in words, for the range cell's description (assistive
 * technology hears it after the cell's value, which it never changes).
 */
export function rowKindDescription(row: SetRowFacts | undefined, t: Translate): string | null {
  return row === undefined ? null : t('set.kind.label', { kind: t(ROW_KIND[row.kind]) });
}

/**
 * SET-06: one cell of a family's kind column — “element”, “set” or “family” in words, along
 * the table's right edge inside its footprint (the last column yields the room, as the first
 * yields the rail's). Presentation: the range cell's description says the same to assistive
 * technology, so the grid's columns and their count are untouched.
 */
export function SetKindCell({ kind }: { readonly kind: SetRowFacts['kind'] | null }) {
  const t = useMessages();
  return (
    <span
      className={clsx('gd-set-kind', { 'gd-set-kind--header': kind === null })}
      aria-hidden="true"
      data-testid={kind === null ? 'set-kind-header' : 'set-kind'}
    >
      {kind === null ? (
        t('set.kind.header')
      ) : (
        <span className="gd-mono gd-set-kind__tag">{t(ROW_KIND[kind])}</span>
      )}
    </span>
  );
}

/** SET-07: the rail's width in characters — its longest label, so a deep family widens it. */
export function railCharacters(facts: SetTableFacts): number {
  let longest = Math.max(...Object.values(SET_DEGREE).map((label) => label.length));
  for (const row of facts.rows.values()) longest = Math.max(longest, row.degree.length);
  return longest;
}
