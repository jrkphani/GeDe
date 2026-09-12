import { isReferenceSource, type ColumnRecord, type RowMeta } from '@gede/core';

/**
 * Which body a grid cell renders (REF-01..04), decided once per cell from
 * facts the grid already holds. `null` is an ordinary text or formula cell.
 *
 *   derived    the column is derived and the row is not a `Split()` child
 *              (a child holds its piece as text and renders as text)
 *   mapping    the column is a mapping column
 *   pulled     the row was pulled and this is the receiving column
 *   reference  the cell holds one `{e:…}` token (an `@` pick)
 */
export type RefCellKind = 'derived' | 'mapping' | 'pulled' | 'reference';

export function refCellKind(
  column: ColumnRecord,
  row: Pick<RowMeta, 'pulledFrom' | 'splitChild'>,
  source: string,
): RefCellKind | null {
  if (column.derive !== null) return row.splitChild ? null : 'derived';
  if (column.link !== null) return 'mapping';
  if (column.pull !== null && row.pulledFrom !== null) return 'pulled';
  if (source.startsWith('=') && isReferenceSource(source)) return 'reference';
  return null;
}
