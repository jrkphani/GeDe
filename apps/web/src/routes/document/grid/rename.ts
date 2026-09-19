/**
 * ADR-051: what a table's title bar and column headers can do beyond
 * selecting — rename inline. The shell holds which field is open (one at a
 * time across the document, as the sheet strip does under ADR-048) and hands
 * `TableView` this object; it is absent on phone (RESP-02) and for view-only
 * participants, so no field, no F2 and no double-click exist there. The
 * Table tab is the command's home (INSP-04); the inline field, F2, Enter, a
 * double-click and the context menus are routes (ADR-041).
 */
import type { Id } from '@gede/core';

import type { RenameResult } from './commands.js';

export type { RenameResult } from './commands.js';

export type RenameTarget =
  | { readonly kind: 'table'; readonly tableId: Id }
  | { readonly kind: 'column'; readonly tableId: Id; readonly colId: Id };

export interface TableRenaming {
  /** The field open right now, in whichever table, or null. */
  readonly target: RenameTarget | null;
  /** F2, Enter on the header or title, a double-click, or the context menu's Rename. */
  readonly start: (target: RenameTarget) => void;
  /**
   * The typed name, trimmed by the command. A refusal carries the reason —
   * empty, a duplicate, a lineage label, view-only — for the field to show.
   */
  readonly commit: (target: RenameTarget, name: string) => RenameResult;
  readonly cancel: () => void;
}

export function sameRenameTarget(a: RenameTarget | null, b: RenameTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.tableId !== b.tableId) return false;
  return a.kind === 'column' && b.kind === 'column' ? a.colId === b.colId : true;
}
