import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ARIA_KEYS, CHORDS, LABELS, type ChordId } from '../../../doc/shortcuts.js';
import { MARK_CHORDS } from '../cell/index.js';
import { HIER_ARIA_KEYS, HIER_CHORDS, HIER_LABELS } from '../grid/hier-keys.js';
import {
  ariaKeysFor,
  markAriaKeys,
  markLabel,
  rowAriaKeys,
  reservedRows,
  rowKeys,
  SHORTCUT_SECTIONS,
  unlistedChords,
} from './shortcut-map.js';

const REFERENCE = resolve(__dirname, '../../../../../../docs/handover/reference/shortcuts.md');

/** The reference sheet's rows: `| Action | Keys |` under each `## Group`. */
function referenceRows(): { group: string; action: string; keys: string[] }[] {
  const out: { group: string; action: string; keys: string[] }[] = [];
  let group = '';
  for (const line of readFileSync(REFERENCE, 'utf8').split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      group = heading[1];
      continue;
    }
    const row = /^\| (.+?) \| (.+?) \|$/.exec(line);
    if (row?.[1] === undefined || row[2] === undefined) continue;
    if (row[1] === 'Action' || row[1].startsWith('---')) continue;
    out.push({
      group,
      action: row[1],
      keys: row[2].split(' · ').map((k) => k.replace(/ or /g, '·')),
    });
  }
  return out;
}

describe('the keyboard map (KEYS-01, KEYS-08)', () => {
  it('KEYS-08 every chord the shell binds is listed on the sheet, and every listed chord is bound', () => {
    expect(unlistedChords()).toEqual([]);
    for (const section of SHORTCUT_SECTIONS) {
      for (const row of section.rows) {
        for (const id of row.ids ?? []) expect(CHORDS[id]).toBeDefined();
        for (const mark of row.marks ?? []) {
          expect(MARK_CHORDS.some((m) => m.mark === mark)).toBe(true);
        }
      }
    }
  });

  it('KEYS-01 the sheet has exactly the reference groups and actions, in order, with the same keys; rows beyond the reference name their ADR', () => {
    const reference = referenceRows();
    const ours = SHORTCUT_SECTIONS.flatMap((section) =>
      section.rows
        .filter((row) => row.extra === undefined)
        .map((row) => ({ group: section.group, action: row.action, keys: rowKeys(row) })),
    );
    const extras = SHORTCUT_SECTIONS.flatMap((section) =>
      section.rows.filter((row) => row.extra !== undefined),
    );
    expect(extras.map((row) => [row.action, row.extra])).toEqual([
      ['Collapse / expand row', 'ADR-025, ADR-030'],
      ['Move between nodes, dots and cells', 'ADR-033'],
      ['Select the node’s row', 'ADR-033'],
      ['Open a child sheet for the node', 'ADR-033'],
      ['Cancel pointing', 'ADR-033'],
      ['Next / previous object on the sheet', 'ADR-042'],
    ]);
    // KEYS-02 / KEYS-07: the PRD's chords the browser keeps are listed, marked, and not bound (ADR-030).
    expect(reservedRows().map((row) => row.action)).toEqual([
      'New workscape',
      'Close document',
      'Next / previous sheet',
    ]);
    for (const row of reservedRows()) expect(row.reserved).toMatch(/browser/);
    expect(ours.map((r) => r.group)).toEqual(reference.map((r) => r.group));
    expect(ours.map((r) => r.action)).toEqual(reference.map((r) => r.action));
    // Keys: the reference writes "⏎ or double-click"; the sheet lists them as two chips.
    for (const [i, row] of ours.entries()) {
      const expected = reference[i]!.keys.flatMap((k) => k.split('·'));
      expect(row.keys, row.action).toEqual(expected);
    }
  });

  it('KEYS-08 labels and aria tokens exist for every chord id, and mark tokens derive from the editor table', () => {
    for (const id of Object.keys(CHORDS) as ChordId[]) {
      expect(LABELS[id]).toBeTruthy();
      expect(ARIA_KEYS[id]).toBeTruthy();
    }
    expect(markLabel('bold')).toBe('⌘B');
    expect(markAriaKeys('bold')).toBe('Meta+B');
    expect(markAriaKeys('strikethrough')).toBe('Shift+Meta+X');
    expect(markAriaKeys('superscript')).toBe('Control+Meta+Equal');
    expect(ariaKeysFor(CHORDS.nest)).toBe('Meta+BracketRight');
    // HIER-06 KEYS-06: the hierarchy chords the cell handles are the ones the sheet lists.
    for (const key of ['nest', 'promote', 'collapse', 'expand'] as const) {
      expect(CHORDS[key]).toEqual(HIER_CHORDS[key]);
      expect(LABELS[key]).toBe(HIER_LABELS[key]);
      expect(ARIA_KEYS[key]).toBe(HIER_ARIA_KEYS[key]);
    }
    expect(rowAriaKeys({ action: 'x', keys: ['Tab'] })).toBeUndefined();
    expect(rowAriaKeys({ action: 'x', ids: ['undo', 'redo'] })).toBe('Meta+Z Shift+Meta+Z');
  });
});
