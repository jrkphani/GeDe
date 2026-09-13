/**
 * Sheet commands beyond the strip's + (ADR-048, #165): the words the shell
 * says, in the active locale, and the neighbour it shows when a sheet goes.
 * Pure over the catalogue, so the announcements are pinned by tests and the
 * shell only wires them.
 */
import type { DeleteSheetResult, Id, SheetRecord } from '@gede/core';

import { LABELS } from '../../doc/shortcuts.js';
import { translate } from '../../i18n/index.js';
import { formatNumber } from '../../intl.js';
import { activeLocale } from '../../locale.js';

/** Why the last sheet's Delete item is disabled (MENU-02); inline English like every menu reason. */
export const LAST_SHEET_REASON = 'a workscape keeps at least one sheet';

/** What ⌫ on the last sheet's tab says (A11Y-05). */
export function lastSheetAnnouncement(): string {
  return translate(activeLocale(), 'sheet.lastKept');
}

/** Why an empty name is refused inline, beside the field and in the live region (A11Y-04). */
export function emptyNameReason(): string {
  return translate(activeLocale(), 'sheet.needsName');
}

/** "Sheet 2 with 2 tables and 1 graph"; "Sheet 2" when it was empty. */
export function deletedSheetName(result: DeleteSheetResult): string {
  const locale = activeLocale();
  const count = (n: number, one: 'sheet.count.table' | 'sheet.count.graph') =>
    n === 1
      ? translate(locale, one)
      : translate(
          locale,
          one === 'sheet.count.table' ? 'sheet.count.tables' : 'sheet.count.graphs',
          {
            count: formatNumber(locale, n),
          },
        );
  const sheet = result.label;
  if (result.tables > 0 && result.graphs > 0) {
    return translate(locale, 'sheet.name.both', {
      sheet,
      tables: count(result.tables, 'sheet.count.table'),
      graphs: count(result.graphs, 'sheet.count.graph'),
    });
  }
  if (result.tables > 0) {
    return translate(locale, 'sheet.name.tables', {
      sheet,
      tables: count(result.tables, 'sheet.count.table'),
    });
  }
  if (result.graphs > 0) {
    return translate(locale, 'sheet.name.graphs', {
      sheet,
      graphs: count(result.graphs, 'sheet.count.graph'),
    });
  }
  return sheet;
}

/**
 * "Deleted Sheet 2 with 2 tables and 1 graph — press ⌘Z to undo"; with
 * dependents elsewhere, "… — 3 cells elsewhere now read “reference removed”;
 * press ⌘Z to undo" (ADR-047's sentence, the same for a table); and, when
 * the active sheet moved, ". Now on Sheet 1" (#165 §3). The chord is spelled
 * as the shortcut sheet spells it (ADR-042).
 */
export function deletedSheetAnnouncement(
  result: DeleteSheetResult,
  nowOn: SheetRecord | null = null,
): string {
  const locale = activeLocale();
  const name = deletedSheetName(result);
  const undo = LABELS.undo;
  const broken = result.referencesRemoved;
  const deleted =
    broken === 0
      ? translate(locale, 'object.deleted', { name, undo })
      : broken === 1
        ? translate(locale, 'object.deleted.ref', { name, undo })
        : translate(locale, 'object.deleted.refs', {
            name,
            undo,
            count: formatNumber(locale, broken),
          });
  return nowOn === null
    ? deleted
    : translate(locale, 'sheet.nowOn', { deleted, sheet: sheetName(nowOn) });
}

/** The toast's one line — "Deleted Sheet 2 with 1 table"; its Undo button is the route back. */
export function deletedSheetTitle(result: DeleteSheetResult): string {
  return translate(activeLocale(), 'sheet.deleted', { name: deletedSheetName(result) });
}

/** "Sheet 2 was deleted — now on Sheet 1": a collaborator removed the sheet this replica showed. */
export function remoteSheetRemovedAnnouncement(gone: SheetRecord, nowOn: SheetRecord): string {
  return translate(activeLocale(), 'sheet.removedRemotely', {
    sheet: gone.label,
    nowOn: sheetName(nowOn),
  });
}

/** "Renamed Sheet 2 to Budget". */
export function renamedSheetAnnouncement(from: string, to: string): string {
  return translate(activeLocale(), 'sheet.renamed', { from, to });
}

/** "Restored Sheet 2": an undo brought the sheet back and the shell is showing it. */
export function restoredSheetAnnouncement(sheet: SheetRecord): string {
  return translate(activeLocale(), 'sheet.restored', { sheet: sheet.label });
}

/**
 * How the strip announces a sheet (DOC-03, #142): its ordinal, and its label
 * when that is not merely the ordinal — "Sheet 2" or "Sheet 2, Budget".
 */
export function sheetName(sheet: SheetRecord): string {
  const ordinal = `Sheet ${String(sheet.ordinal)}`;
  return sheet.label === ordinal ? ordinal : `${ordinal}, ${sheet.label}`;
}

/**
 * The sheet to show when `sheetId` has left `before` (a collaborator deleted
 * it, or a redo did): the one that followed it, else the one before it, as
 * long as it is still in `now`; else the first sheet that remains.
 */
export function neighbourSheet(
  before: readonly SheetRecord[],
  now: readonly SheetRecord[],
  sheetId: Id,
): SheetRecord | null {
  const index = before.findIndex((s) => s.id === sheetId);
  const candidates = index < 0 ? [] : [before[index + 1], before[index - 1]];
  for (const candidate of candidates) {
    const present = candidate === undefined ? undefined : now.find((s) => s.id === candidate.id);
    if (present !== undefined) return present;
  }
  return now[0] ?? null;
}
