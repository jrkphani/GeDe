/**
 * A set table's presentation (SET-02..07; ADR-056, SPEC §5; designs SimpleSet and
 * FamilyOfSets): the meta row and title row drawn in the title bar's two lattice rows, the
 * degree rail outside the table's left edge, the count strip in GRID-11's footer, and the
 * words a range cell carries (a repeat, a family row's kind). None of it is a Yjs row and
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
  /** Null renders “—”. */
  readonly value: string | null;
  /** What “—” means here, for assistive technology and the tooltip. */
  readonly empty: string;
  readonly id?: boolean;
}

function metaValues(record: TableRecord, facts: SetTableFacts, t: Translate): MetaValue[] {
  const { finite, variable, quantifier } = facts.definition;
  const undetermined = t('set.meta.undetermined');
  return [
    { field: t('set.meta.id'), value: record.id, empty: undetermined, id: true },
    {
      field: t('set.meta.finiteness'),
      value: finite === null ? null : t('set.meta.finite'),
      empty: undetermined,
    },
    {
      field: t('set.meta.variable'),
      value: variable === null ? null : t('set.meta.bound'),
      empty: undetermined,
    },
    {
      field: t('set.meta.quantifier'),
      value:
        quantifier === null
          ? null
          : t(quantifier === 'universal' ? 'set.meta.universal' : 'set.meta.existential'),
      empty: undetermined,
    },
    {
      field: t('set.meta.status'),
      value:
        facts.status === null
          ? null
          : t(facts.status === 'null' ? 'set.meta.null' : 'set.meta.singleton'),
      // SET-03: past one element the status is “—”: GeDe checked, and there is none.
      empty: t('set.meta.none'),
    },
  ];
}

/**
 * SET-03: the read-only row above the header — the kind, then the set id (the table's
 * ULID), finite or infinite, bound or free, the quantifier and the special status, each a
 * computed value or “—”. Each value names its field in words for assistive technology.
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
      <span className="gd-mono gd-set-meta__kind">{t(KIND_LABEL[record.kind])}</span>
      <ul className="gd-set-meta__values" aria-label={t('set.meta.label')}>
        {metaValues(record, facts, t).map((v) => {
          const said = v.value ?? v.empty;
          return (
            <li
              key={v.field}
              className={clsx('gd-mono gd-set-meta__value', { 'gd-set-meta__value--id': v.id })}
              title={`${v.field}: ${said}`}
            >
              <span className="gd-visually-hidden">{`${v.field}: `}</span>
              <span aria-hidden={v.value === null ? true : undefined}>{v.value ?? '—'}</span>
              {v.value === null && <span className="gd-visually-hidden">{said}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * SET-04: the title row — the set's name (the table title, renamed where ADR-051 renames
 * it) and its definition (the caption), rendered as typed. `children` is the title bar's
 * own content: the name or its rename field, the formula's error, the origin address.
 */
export function SetTitleRow({
  caption,
  children,
}: {
  readonly caption: string;
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

/**
 * The words a range cell carries beside its element, or null: “repeat of +2°” on a repeated
 * element (SET-02) and, in a family, the row's kind (SET-06) — in words, never by
 * indentation or tint alone.
 */
export function rangeCellNote(
  row: SetRowFacts | undefined,
  family: boolean,
  t: Translate,
): string | null {
  if (row === undefined) return null;
  const words = [
    family ? t(ROW_KIND[row.kind]) : null,
    row.repeatOf === null ? null : t('set.repeat', { degree: row.repeatOf }),
  ].filter((w): w is string => w !== null);
  return words.length === 0 ? null : words.join(' · ');
}
