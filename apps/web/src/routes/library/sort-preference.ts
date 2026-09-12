/** LIB-05: the sort choice persists per user, on this device. */
import type { SortKey } from './select.js';

const key = (sub: string): string => `gede.librarySort.${sub}`;

export const DEFAULT_SORT: SortKey = 'name';

export function readSortPreference(sub: string): SortKey {
  try {
    const v = localStorage.getItem(key(sub));
    return v === 'name' || v === 'date' ? v : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function writeSortPreference(sub: string, sort: SortKey): void {
  try {
    localStorage.setItem(key(sub), sort);
  } catch {
    /* private mode: the choice lives for this page only */
  }
}
