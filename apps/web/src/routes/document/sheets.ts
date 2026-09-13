/**
 * Sheet commands beyond the strip's + (ADR-048, #165): the words the shell
 * says and the neighbour it shows when a sheet goes. Pure, so the
 * announcements are pinned by tests and the shell only wires them.
 */
import type { DeleteSheetResult, Id, SheetRecord } from '@gede/core';

import { LABELS } from '../../doc/shortcuts.js';

/** Why the last sheet's Delete item is disabled (MENU-02). */
export const LAST_SHEET_REASON = 'a workscape keeps at least one sheet';
/** What ⌫ on the last sheet's tab says (A11Y-05). */
export const LAST_SHEET_ANNOUNCEMENT = 'A workscape keeps at least one sheet';
/** Why an empty name is refused inline (A11Y-04: text, not a red border alone). */
export const EMPTY_SHEET_NAME_REASON = 'A sheet needs a name';

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** "Sheet 2 with 2 tables and 1 graph"; "Sheet 2" when it was empty. */
function whatWent(result: DeleteSheetResult): string {
  const contents: string[] = [];
  if (result.tables > 0) contents.push(plural(result.tables, 'table'));
  if (result.graphs > 0) contents.push(plural(result.graphs, 'graph'));
  return `${result.label}${contents.length === 0 ? '' : ` with ${contents.join(' and ')}`}`;
}

/**
 * "Deleted Sheet 2 with 2 tables and 1 graph — press ⌘Z to undo"; with
 * dependents elsewhere, "Deleted Sheet 2 with 2 tables — 3 cells elsewhere
 * now read "reference removed"; press ⌘Z to undo"; and, when the active
 * sheet moved, ". Now on Sheet 1" (#165 §3). The chord is spelled as the
 * shortcut sheet spells it (ADR-042).
 */
export function deletedSheetAnnouncement(
  result: DeleteSheetResult,
  nowOn: SheetRecord | null = null,
): string {
  const refs =
    result.referencesRemoved === 0
      ? ''
      : `${plural(result.referencesRemoved, 'cell')} elsewhere now read "reference removed"; `;
  const moved = nowOn === null ? '' : `. Now on ${sheetName(nowOn)}`;
  return `Deleted ${whatWent(result)} — ${refs}press ${LABELS.undo} to undo${moved}`;
}

/** The toast's one line: what went; its Undo button is the route back. */
export function deletedSheetTitle(result: DeleteSheetResult): string {
  return `Deleted ${whatWent(result)}`;
}

/** "Sheet 2 was deleted — now on Sheet 1": a collaborator removed the sheet this replica showed. */
export function remoteSheetRemovedAnnouncement(gone: SheetRecord, nowOn: SheetRecord): string {
  return `${gone.label} was deleted — now on ${sheetName(nowOn)}`;
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
