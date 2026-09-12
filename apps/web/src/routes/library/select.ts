/**
 * Pure ordering, grouping and filtering for the library (LIB-01, LIB-04,
 * LIB-05). The server scopes each view; the client orders it with the active
 * locale's collation and groups it for display.
 */
import type { DocumentsView, DocumentSummary } from '../../api/documents.js';
import { RECENCY_LABELS, recencyBucket, type RecencyBucket } from '../../intl.js';

export type SortKey = 'name' | 'date';

export interface DocumentGroup {
  /** Stable key for React and for tests. */
  id: string;
  /** Heading shown above the rows; empty for a flat list. */
  label: string;
  rows: DocumentSummary[];
}

const BUCKET_ORDER: readonly RecencyBucket[] = [
  'today',
  'yesterday',
  'this-week',
  'this-month',
  'earlier',
];

export const SHARED_BY_ME = 'Shared by me';
/** Group label when the sharer has no display name: a true statement, not an invented name. */
export const SHARED_WITH_ME = 'Shared with me';

/** LIB-04: filter by name, case-insensitive, as typed. */
export function filterByQuery(rows: readonly DocumentSummary[], query: string): DocumentSummary[] {
  const q = query.trim().toLocaleLowerCase();
  return q === '' ? [...rows] : rows.filter((d) => d.title.toLocaleLowerCase().includes(q));
}

const byDateDesc =
  (key: (d: DocumentSummary) => string) => (a: DocumentSummary, b: DocumentSummary) =>
    key(b).localeCompare(key(a));

/** LIB-05: Browse and Shared sort by name or date; Recents is always reverse-chronological. */
export function orderDocuments(
  rows: readonly DocumentSummary[],
  view: DocumentsView,
  sort: SortKey,
  collate: Intl.Collator,
): DocumentSummary[] {
  const out = [...rows];
  switch (view) {
    case 'recents':
      return out.sort(byDateDesc((d) => d.updatedAt));
    case 'deleted':
      return out.sort(byDateDesc((d) => d.deletedAt ?? d.updatedAt));
    case 'browse':
    case 'shared':
      return sort === 'name'
        ? out.sort((a, b) => collate.compare(a.title, b.title))
        : out.sort(byDateDesc((d) => d.updatedAt));
  }
}

/**
 * LIB-01: Recents grouped by recency; Shared grouped by who shared it, then
 * "Shared by me"; Browse and Recently Deleted are flat.
 */
export function groupDocuments(
  ordered: readonly DocumentSummary[],
  view: DocumentsView,
  collate: Intl.Collator,
  now: number = Date.now(),
): DocumentGroup[] {
  if (view === 'recents') {
    const buckets = new Map<RecencyBucket, DocumentSummary[]>();
    for (const d of ordered) {
      const b = recencyBucket(d.updatedAt, now);
      const list = buckets.get(b) ?? [];
      list.push(d);
      buckets.set(b, list);
    }
    return BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => ({
      id: b,
      label: RECENCY_LABELS[b],
      rows: buckets.get(b) ?? [],
    }));
  }
  if (view === 'shared') {
    const byOwner = new Map<string, DocumentGroup>();
    const mine: DocumentSummary[] = [];
    for (const d of ordered) {
      if (d.sharedBy === undefined) {
        mine.push(d);
        continue;
      }
      const g = byOwner.get(d.sharedBy.id) ?? {
        id: `by-${d.sharedBy.id}`,
        label: d.sharedBy.name ?? SHARED_WITH_ME,
        rows: [],
      };
      g.rows.push(d);
      byOwner.set(d.sharedBy.id, g);
    }
    const groups = [...byOwner.values()].sort((a, b) => collate.compare(a.label, b.label));
    if (mine.length > 0) groups.push({ id: 'mine', label: SHARED_BY_ME, rows: mine });
    return groups;
  }
  return ordered.length === 0 ? [] : [{ id: 'all', label: '', rows: [...ordered] }];
}

/** Rows in display order, across groups; what the keyboard walks. */
export function flattenGroups(groups: readonly DocumentGroup[]): DocumentSummary[] {
  return groups.flatMap((g) => g.rows);
}
