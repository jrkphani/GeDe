import { describe, expect, it } from 'vitest';
import type { DeleteSheetResult, SheetRecord } from '@gede/core';

import { translate } from '../../i18n/index.js';
import {
  deletedSheetAnnouncement,
  deletedSheetTitle,
  emptyNameReason,
  lastSheetAnnouncement,
  neighbourSheet,
  remoteSheetRemovedAnnouncement,
  renamedSheetAnnouncement,
  restoredSheetAnnouncement,
} from './sheets.js';

const sheet = (id: string, label: string, ordinal: number): SheetRecord => ({
  id,
  label,
  ordinal,
  seeded: false,
  parentContext: null,
});

const result = (over: Partial<DeleteSheetResult>): DeleteSheetResult => ({
  label: 'Sheet 2',
  tables: 0,
  graphs: 0,
  referencesRemoved: 0,
  neighbourId: 's1',
  ...over,
});

describe('sheet announcements (ADR-048, #165)', () => {
  it('A11Y-05 the delete sentence names what went, singular and plural, the undo chord, dependents elsewhere, and where the person now is', () => {
    expect(deletedSheetAnnouncement(result({}))).toBe('Deleted Sheet 2 — press ⌘Z to undo');
    expect(deletedSheetAnnouncement(result({ tables: 1 }))).toBe(
      'Deleted Sheet 2 with 1 table — press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ tables: 2, graphs: 1 }))).toBe(
      'Deleted Sheet 2 with 2 tables and 1 graph — press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ tables: 1, graphs: 2 }))).toBe(
      'Deleted Sheet 2 with 1 table and 2 graphs — press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ graphs: 1 }))).toBe(
      'Deleted Sheet 2 with 1 graph — press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ tables: 2, referencesRemoved: 3 }))).toBe(
      'Deleted Sheet 2 with 2 tables — 3 cells elsewhere now read “reference removed”; press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ tables: 1, referencesRemoved: 1 }))).toBe(
      'Deleted Sheet 2 with 1 table — 1 cell elsewhere now reads “reference removed”; press ⌘Z to undo',
    );
    expect(deletedSheetAnnouncement(result({ tables: 2 }), sheet('s1', 'Sheet 1', 1))).toBe(
      'Deleted Sheet 2 with 2 tables — press ⌘Z to undo. Now on Sheet 1',
    );
    expect(deletedSheetAnnouncement(result({}), sheet('s1', 'Budget', 1))).toBe(
      'Deleted Sheet 2 — press ⌘Z to undo. Now on Sheet 1, Budget',
    );
    expect(deletedSheetTitle(result({ tables: 2, graphs: 1 }))).toBe(
      'Deleted Sheet 2 with 2 tables and 1 graph',
    );
  });

  it('A11Y-05 SHARE-04 the other sentences: a collaborator’s removal, a rename, a restore, the last sheet, an empty name', () => {
    expect(
      remoteSheetRemovedAnnouncement(sheet('s2', 'Sheet 2', 2), sheet('s1', 'Sheet 1', 1)),
    ).toBe('Sheet 2 was deleted — now on Sheet 1');
    expect(renamedSheetAnnouncement('Sheet 2', 'Budget')).toBe('Renamed Sheet 2 to Budget');
    expect(restoredSheetAnnouncement(sheet('s2', 'Budget', 2))).toBe('Restored Budget');
    expect(lastSheetAnnouncement()).toBe('A workscape keeps at least one sheet');
    expect(emptyNameReason()).toBe('A sheet needs a name');
    // I18N-05: every sentence is a catalogue string, so the Indic locales carry their own.
    expect(translate('ta-IN', 'sheet.renamed', { from: 'a', to: 'b' })).toMatch(
      /\p{Script=Tamil}/u,
    );
  });

  it('DOC-03 the neighbour of a sheet that went is the next one, else the previous, among those that remain', () => {
    const before = [sheet('a', 'A', 1), sheet('b', 'B', 2), sheet('c', 'C', 3)];
    expect(neighbourSheet(before, [before[0]!, before[2]!], 'b')?.id).toBe('c');
    expect(neighbourSheet(before, [before[0]!, before[1]!], 'c')?.id).toBe('b');
    expect(neighbourSheet(before, [before[1]!, before[2]!], 'a')?.id).toBe('b');
    // Both neighbours went too: the first sheet that remains.
    expect(neighbourSheet(before, [before[0]!], 'b')?.id).toBe('a');
    expect(neighbourSheet(before, [], 'b')).toBeNull();
    expect(neighbourSheet([], [before[0]!], 'zzz')?.id).toBe('a');
  });
});
