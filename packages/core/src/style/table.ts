/**
 * Table look writes (INSP-04): style, title and caption visibility, outline,
 * gridline density, alternating row colour. Each is one key on the table map
 * and one transaction; none touches the lattice, so no address moves.
 */
import type { GedeDoc } from '../doc/schema.js';
import type { Id } from '../ids.js';
import type { TableLook } from './types.js';
import { requireTable, transact } from './write.js';

export type TableLookPatch = Partial<TableLook>;

const KEYS: readonly (keyof TableLook)[] = [
  'style',
  'titleShown',
  'caption',
  'captionShown',
  'outline',
  'gridlines',
  'alternating',
];

/** Write the given fields of the look; absent fields stay. Returns the keys written. */
export function setTableLook(gd: GedeDoc, tableId: Id, patch: TableLookPatch): (keyof TableLook)[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const written: (keyof TableLook)[] = [];
    for (const key of KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (table.get(key) !== value) table.set(key, value);
      written.push(key);
    }
    return written;
  });
}
