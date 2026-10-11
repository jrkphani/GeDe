/**
 * SET-18: why a table cannot be edited because its section or sheet is locked, as the
 * read-only reason its cells show; null when it is not locked. The lock lives on the sheet's
 * map, not the table's, so this subscribes to the sheets.
 */
import {
  lockReasonOfTable,
  openDocument,
  readString,
  type ReadOnlyReason,
  type TableMap,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';

export function useTableLock(table: TableMap): ReadOnlyReason | null {
  const doc = table.doc;
  useYVersion(doc === null ? null : doc.getArray('sheets'));
  if (doc === null) return null;
  const reason = lockReasonOfTable(openDocument(doc), readString(table, 'id'));
  if (reason === null) return null;
  return reason === 'sheet' ? 'sheetLocked' : 'sectionLocked';
}
