/**
 * LIB-05: the sort choice persists per user — on the account (`users.library_sort`,
 * `PATCH /api/me { librarySort }`, #133). What is kept here is the device's copy
 * of the last answer, so the library sorts the right way before the profile
 * arrives and when the request fails; the profile wins the moment it answers.
 */
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
