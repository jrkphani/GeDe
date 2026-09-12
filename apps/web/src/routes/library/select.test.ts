import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../../api/documents.js';
import { collator } from '../../intl.js';
import { filterByQuery, flattenGroups, groupDocuments, orderDocuments } from './select.js';

const NOW = new Date('2026-09-12T12:00:00').getTime();

function doc(over: Partial<DocumentSummary> & { id: string; title: string }): DocumentSummary {
  return {
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ownerId: 'sub-1',
    permission: 'owner',
    sharedWithOthers: false,
    deletedAt: null,
    ...over,
  };
}

const today = doc({ id: 'a', title: 'Everest trek', updatedAt: '2026-09-12T09:00:00' });
const yesterday = doc({ id: 'b', title: 'board minutes', updatedAt: '2026-09-11T09:00:00' });
const week = doc({ id: 'c', title: 'Plan 10', updatedAt: '2026-09-08T09:00:00' });
const month = doc({ id: 'd', title: 'Plan 2', updatedAt: '2026-09-01T09:00:00' });
const old = doc({ id: 'e', title: 'Archive', updatedAt: '2026-07-01T09:00:00' });

const en = collator('en-IN');

describe('library selection', () => {
  it('LIB-01 Recents is reverse-chronological and grouped by recency', () => {
    const ordered = orderDocuments([old, month, today, week, yesterday], 'recents', 'name', en);
    expect(ordered.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const groups = groupDocuments(ordered, 'recents', en, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'Earlier',
    ]);
    expect(flattenGroups(groups).map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('LIB-05 Browse sorts by Name with locale collation (case-insensitive, numeric-aware) or by Date', () => {
    const byName = orderDocuments([week, today, month, yesterday], 'browse', 'name', en);
    expect(byName.map((d) => d.title)).toEqual([
      'board minutes',
      'Everest trek',
      'Plan 2',
      'Plan 10',
    ]);
    const byDate = orderDocuments([week, today, month, yesterday], 'browse', 'date', en);
    expect(byDate.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(groupDocuments(byName, 'browse', en, NOW)).toHaveLength(1);
    expect(groupDocuments(byName, 'browse', en, NOW)[0]?.label).toBe('');
  });

  it('LIB-01 Shared groups by sharer, then "Shared by me"', () => {
    const fromSembian = doc({
      id: 's1',
      title: 'Minutes',
      sharedBy: { id: 'u2', name: 'Sembian V' },
      permission: 'edit',
    });
    const fromAkshaya = doc({
      id: 's2',
      title: 'Roster',
      sharedBy: { id: 'u3', name: 'Akshaya A' },
      permission: 'view',
    });
    const mine = doc({ id: 's3', title: 'Budget', sharedWithOthers: true });
    const groups = groupDocuments(
      orderDocuments([mine, fromSembian, fromAkshaya], 'shared', 'name', en),
      'shared',
      en,
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Akshaya A', 'Sembian V', 'Shared by me']);
    expect(groups[2]?.rows.map((d) => d.id)).toEqual(['s3']);
  });

  it('LIB-08 Recently Deleted orders by deletion time, newest first', () => {
    const a = doc({ id: 'x', title: 'X', deletedAt: '2026-09-01T00:00:00Z' });
    const b = doc({ id: 'y', title: 'Y', deletedAt: '2026-09-05T00:00:00Z' });
    expect(orderDocuments([a, b], 'deleted', 'name', en).map((d) => d.id)).toEqual(['y', 'x']);
  });

  it('LIB-D6 Archived orders by archive time, newest first, and is a flat list', () => {
    const a = doc({ id: 'x', title: 'X', archivedAt: '2026-09-01T00:00:00Z' });
    const b = doc({ id: 'y', title: 'Y', archivedAt: '2026-09-05T00:00:00Z' });
    const ordered = orderDocuments([a, b], 'archived', 'name', en);
    expect(ordered.map((d) => d.id)).toEqual(['y', 'x']);
    expect(groupDocuments(ordered, 'archived', en).map((g) => g.label)).toEqual(['']);
  });

  it('LIB-04 search filters by name, case-insensitively, as typed', () => {
    expect(filterByQuery([today, yesterday], 'EVEREST').map((d) => d.id)).toEqual(['a']);
    expect(filterByQuery([today, yesterday], '  ').map((d) => d.id)).toEqual(['a', 'b']);
    expect(filterByQuery([today, yesterday], 'zzz')).toEqual([]);
  });

  it('ONB-01 the guided sample is pinned above every other row in Recents, Browse and Shared, whatever the sort, in its own group', () => {
    const sample = doc({
      id: 's',
      title: 'Q3 Delivery — Guided sample',
      updatedAt: '2026-06-01T09:00:00',
      sample: true,
    });
    const rows = [old, today, sample, week];
    for (const sort of ['name', 'date'] as const) {
      expect(orderDocuments(rows, 'browse', sort, en)[0]?.id).toBe('s');
      expect(orderDocuments(rows, 'recents', sort, en)[0]?.id).toBe('s');
    }
    const recents = groupDocuments(orderDocuments(rows, 'recents', 'date', en), 'recents', en, NOW);
    expect(recents.map((g) => [g.label, g.rows.map((d) => d.id)])).toEqual([
      ['Sample', ['s']],
      ['Today', ['a']],
      ['This week', ['c']],
      ['Earlier', ['e']],
    ]);
    const shared = groupDocuments(
      orderDocuments(
        [sample, doc({ id: 'x', title: 'X', sharedBy: { id: 'o', name: 'Om' } })],
        'shared',
        'name',
        en,
      ),
      'shared',
      en,
      NOW,
    );
    expect(shared.map((g) => g.label)).toEqual(['Sample', 'Om']);
    // Flat views keep it first without a heading.
    const browse = groupDocuments(orderDocuments(rows, 'browse', 'name', en), 'browse', en, NOW);
    expect(browse.map((g) => [g.id, g.label])).toEqual([['all', '']]);
    expect(flattenGroups(browse)[0]?.id).toBe('s');
  });
});
