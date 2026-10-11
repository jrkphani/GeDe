/**
 * The words the structure tables are written in (SET-13..16): the catalogue's, for a locale.
 * The tables' cells are text a formula can read, so they are spelled here, once, and not by
 * the component that draws them. Numbers are plain digits whatever the locale.
 */
import { SUMMARY_COLUMNS, type StructureLabels } from '@gede/core';

import { translate } from '../i18n/index.js';
import type { Locale } from '../locale.js';

export function structureLabels(locale: Locale): StructureLabels {
  return {
    universe: 'U',
    superSet: translate(locale, 'summary.super.kind'),
    sheetSummary: translate(locale, 'summary.sheet.kind'),
    sectionTitle: (ordinal, name) => `${String(ordinal)}° ${name}`,
    summaryColumns: Object.fromEntries(
      SUMMARY_COLUMNS.map((c) => [c, translate(locale, `summary.col.${c}`)]),
    ) as StructureLabels['summaryColumns'],
    sheetColumns: {
      section: translate(locale, 'summary.sheet.section'),
      sets: translate(locale, 'summary.sheet.sets'),
      elements: translate(locale, 'summary.sheet.elements'),
    },
    superColumns: {
      member: translate(locale, 'summary.super.member'),
      kind: translate(locale, 'summary.super.kindColumn'),
    },
    element: translate(locale, 'summary.super.element'),
    set: translate(locale, 'summary.super.set'),
    specialNull: translate(locale, 'set.meta.null'),
    specialSingleton: translate(locale, 'set.meta.singleton'),
    none: '—',
    bag: (count) => translate(locale, 'summary.bag', { count }),
  };
}
