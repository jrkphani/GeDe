/**
 * Appearance over the lattice (INSP-04..07, MENU-04): every write is one
 * transaction on the document, every reader guards its vocabulary, and no
 * write moves an address.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  cellAddress,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableAddresses,
  tableById,
  tableMap,
  tableUnitBounds,
  type GedeDoc,
  type Id,
} from '../doc/index.js';
import { cellKey } from '../ids.js';
import { commitCellText } from '../engine/commit.js';
import { UNSAFE_TEXT_ON_FILL, readableTextColour } from './contrast.js';
import {
  cellAppearanceFor,
  cellAppearanceOverride,
  countAppearanceOverrides,
  resolveLook,
  setCellAppearance,
  setColumnAppearance,
} from './appearance.js';
import {
  dagEdges,
  edgesOf,
  layoutSheet,
  restack,
  setSheetEdgesShown,
  setTablePinned,
  sheetEdgesShown,
  stackingOrder,
  stackingPosition,
} from './arrange.js';
import { handleRulesRequest, isRulesRequest } from './rule-engine.js';
import { addColumnRule, removeColumnRule, updateColumnRule } from './rule-writes.js';
import { describeRule, evaluateRules, readRules, ruleMatches } from './rules.js';
import { mergeCells, mergeRoom, spanAt, spanCovering, spanIndex, unmergeCells } from './spans.js';
import { setTableLook } from './table.js';
import {
  characterStyleOf,
  CHARACTER_STYLE_BUNDLES,
  DEFAULT_TABLE_LOOK,
  mergeAppearance,
  readAppearance,
  TYPE_SIZE_PX,
} from './types.js';

function fixture(rows = 4, columns = 3): { gd: GedeDoc; sheetId: Id; tableId: Id } {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns, rows });
  return { gd, sheetId, tableId };
}

describe('INSP-04 table look', () => {
  it('INSP-04 reads defaults for a table written before the look existed, and each control writes one key at once', () => {
    const { gd, tableId } = fixture();
    expect(tableById(gd, tableId)?.look).toEqual(DEFAULT_TABLE_LOOK);
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    setTableLook(gd, tableId, { style: 'forest', alternating: true });
    expect(transactions).toBe(1);
    const look = tableById(gd, tableId)?.look;
    expect(look?.style).toBe('forest');
    expect(look?.alternating).toBe(true);
    expect(look?.outline).toBe('hairline');
    setTableLook(gd, tableId, { outline: 'accent', gridlines: 'contrast', captionShown: true });
    setTableLook(gd, tableId, { caption: 'Field notes', titleShown: false });
    expect(tableById(gd, tableId)?.look).toEqual({
      style: 'forest',
      titleShown: false,
      caption: 'Field notes',
      captionShown: true,
      outline: 'accent',
      gridlines: 'contrast',
      alternating: true,
    });
  });

  it('INSP-04 an off-vocabulary style, outline or density stored by a newer client reads as the default', () => {
    const { gd, tableId } = fixture();
    const map = tableMap(gd, tableId)!;
    map.set('style', 'neon');
    map.set('outline', 'dotted');
    map.set('gridlines', 42);
    expect(tableById(gd, tableId)?.look.style).toBe('plain');
    expect(tableById(gd, tableId)?.look.outline).toBe('hairline');
    expect(tableById(gd, tableId)?.look.gridlines).toBe('light');
  });

  it('INSP-04 RESP-01 the title and caption visibility never move an address: the title bar keeps its rows and the caption is one row at the foot', () => {
    const { gd, tableId } = fixture();
    const table = tableMap(gd, tableId)!;
    const before = tableAddresses(table);
    const bounds = tableUnitBounds(table);
    setTableLook(gd, tableId, { titleShown: false, captionShown: true, caption: 'c' });
    expect(tableAddresses(table)).toEqual(before);
    expect(tableUnitBounds(table)).toEqual({ ...bounds, rows: bounds.rows + 1 });
    setTableLook(gd, tableId, { captionShown: false });
    expect(tableUnitBounds(table)).toEqual(bounds);
  });
});

describe('INSP-05 INSP-06 INSP-10 appearance', () => {
  it('INSP-10 a column appearance is inherited by every cell and by rows added later; a cell override wins field by field', () => {
    const { gd, tableId } = fixture();
    const record = tableById(gd, tableId)!;
    const col = record.columns[0]!;
    setColumnAppearance(gd, tableId, col.id, { fill: 'amber', weight: 600, hAlign: 'center' });
    const table = tableMap(gd, tableId)!;
    const column = tableById(gd, tableId)!.columns[0]!;
    expect(column.appearance).toEqual({ fill: 'amber', weight: 600, hAlign: 'center' });
    expect(cellAppearanceFor(table, column, record.rows[2]!)).toEqual(column.appearance);
    setCellAppearance(gd, tableId, record.rows[1]!, col.id, { fill: 'forest' });
    expect(cellAppearanceOverride(table, record.rows[1]!, col.id)).toEqual({ fill: 'forest' });
    expect(cellAppearanceFor(table, column, record.rows[1]!)).toEqual({
      fill: 'forest',
      weight: 600,
      hAlign: 'center',
    });
    expect(countAppearanceOverrides(table, col.id)).toBe(1);
    // A null field clears back to inherit; an empty override is removed.
    setCellAppearance(gd, tableId, record.rows[1]!, col.id, { fill: null });
    expect(cellAppearanceOverride(table, record.rows[1]!, col.id)).toBeNull();
    setColumnAppearance(gd, tableId, col.id, { fill: null, weight: null, hAlign: null });
    expect(tableById(gd, tableId)!.columns[0]!.appearance).toEqual({});
  });

  it('INSP-05 the border matrix stores edges and weight; an unknown edge is dropped', () => {
    const { gd, tableId } = fixture();
    const record = tableById(gd, tableId)!;
    setCellAppearance(gd, tableId, record.rows[0]!, record.columns[0]!.id, {
      border: { edges: 'top-bottom', weight: 'strong' },
    });
    const table = tableMap(gd, tableId)!;
    expect(cellAppearanceOverride(table, record.rows[0]!, record.columns[0]!.id)).toEqual({
      border: { edges: 'top-bottom', weight: 'strong' },
    });
    expect(readAppearance({ border: { edges: 'diagonal', weight: 'strong' } })).toEqual({});
    expect(readAppearance({ size: 'label', weight: 300, font: 'serif', fill: 'pink' })).toEqual({});
  });

  it('INSP-06 character styles are bundles on the type scale; size never goes under the 11 px floor nor above a 22 px row', () => {
    expect(characterStyleOf(CHARACTER_STYLE_BUNDLES.title)).toBe('title');
    expect(characterStyleOf(mergeAppearance({ fill: 'amber' }, CHARACTER_STYLE_BUNDLES.body))).toBe(
      'body',
    );
    expect(characterStyleOf({ size: 'h3', weight: 400 })).toBeNull();
    for (const px of Object.values(TYPE_SIZE_PX)) {
      expect(px).toBeGreaterThanOrEqual(11);
      expect(px).toBeLessThanOrEqual(22);
    }
    // A size stored by a newer client that this scale does not carry reads as absent.
    expect(readAppearance({ size: 'display' })).toEqual({});
  });

  it('A11Y-03 a text colour under 4.5:1 on its fill resolves to ink and says so; numbers keep their right alignment under Automatic (FMT-02)', () => {
    expect(readableTextColour('amber', 'live')).toBe('ink');
    expect(readableTextColour('amber', 'danger')).toBe('danger');
    expect(readableTextColour(undefined, 'live')).toBe('live');
    for (const unsafe of Object.values(UNSAFE_TEXT_ON_FILL)) expect(unsafe).not.toContain('ink');
    const look = resolveLook({ fill: 'forest', textColour: 'warning' }, null, {
      kind: 'number',
      opts: {},
    });
    expect(look.textColour).toBe('ink');
    expect(look.inkAdjusted).toBe(true);
    expect(look.hAlign).toBe('right');
    expect(resolveLook({ hAlign: 'left' }, null, { kind: 'number', opts: {} }).hAlign).toBe('left');
    expect(resolveLook({}, null, { kind: 'text', opts: {} }).hAlign).toBe('left');
  });
});

describe('INSP-05 conditional highlighting rules', () => {
  const rule = (when: Parameters<typeof ruleMatches>[0]['when']) => ({
    id: 'r',
    when,
    style: {},
  });

  it('INSP-05 the PRD triggers: lexical, metrics and pattern (chip) — pure, against the cell text', () => {
    expect(ruleMatches(rule({ trigger: 'contains', text: 'camp' }), 'Base Camp')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'notContains', text: 'camp' }), 'Lukla')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'contains', text: '' }), 'anything')).toBe(false);
    expect(ruleMatches(rule({ trigger: 'charsOver', count: 3 }), 'நான்கு')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'charsUnder', count: 3 }), 'ab')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'wordsOver', count: 2 }), 'one two three')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'wordsUnder', count: 1 }), '   ')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'matchesChip', chip: 'email' }), 'a@b.co')).toBe(true);
    expect(ruleMatches(rule({ trigger: 'failsChip', chip: 'email' }), 'no address')).toBe(true);
    expect(describeRule(rule({ trigger: 'failsChip', chip: 'email' }))).toBe('fails Email');
  });

  it('INSP-05 A11Y-03 first match wins and its text colour is contrast-adjusted on its fill', () => {
    const rules = [
      {
        id: 'a',
        when: { trigger: 'contains' as const, text: 'x' },
        style: { fill: 'amber' as const, textColour: 'live' as const },
      },
      {
        id: 'b',
        when: { trigger: 'charsOver' as const, count: 0 },
        style: { mark: 'strikethrough' as const },
      },
    ];
    const hit = evaluateRules(rules, 'xylophone');
    expect(hit?.rule.id).toBe('a');
    expect(hit?.fill).toBe('amber');
    expect(hit?.textColour).toBe('ink');
    expect(evaluateRules(rules, 'other')?.mark).toBe('strikethrough');
    expect(evaluateRules(rules, '')).toBeNull();
  });

  it('INSP-05 rules live on the column, one transaction per change, malformed entries dropped on read', () => {
    const { gd, tableId } = fixture();
    const colId = tableById(gd, tableId)!.columns[1]!.id;
    const created = addColumnRule(gd, tableId, colId, {
      when: { trigger: 'contains', text: 'due' },
      style: { fill: 'amber', mark: 'bold' },
    });
    expect(tableById(gd, tableId)!.columns[1]!.rules).toEqual([created]);
    expect(updateColumnRule(gd, tableId, colId, created.id, { style: { fill: 'slate' } })).toBe(
      true,
    );
    expect(tableById(gd, tableId)!.columns[1]!.rules[0]?.style).toEqual({ fill: 'slate' });
    expect(removeColumnRule(gd, tableId, colId, 'nope')).toBe(false);
    expect(removeColumnRule(gd, tableId, colId, created.id)).toBe(true);
    expect(tableById(gd, tableId)!.columns[1]!.rules).toEqual([]);
    expect(
      readRules([
        { id: 'ok', when: { trigger: 'wordsOver', count: 2 }, style: { textColour: 'danger' } },
        { id: 'bad', when: { trigger: 'regex', pattern: '.*' }, style: {} },
        'junk',
      ]),
    ).toEqual([
      { id: 'ok', when: { trigger: 'wordsOver', count: 2 }, style: { textColour: 'danger' } },
    ]);
  });
});

describe('INSP-05 rules as a Worker service', () => {
  it('INSP-05 a request carries a column\'s rules and cell texts and answers with the first match per cell; malformed input is refused, never thrown', () => {
    const rules = readRules([
      { id: 'r1', when: { trigger: 'contains', text: 'due' }, style: { fill: 'amber' } },
      { id: 'r2', when: { trigger: 'charsOver', count: 3 }, style: { textColour: 'danger' } },
    ]);
    const request = {
      id: 7,
      tableId: 't',
      colId: 'c',
      rules,
      cells: [
        { key: 'r:c', text: 'overdue' },
        { key: 's:c', text: 'a' },
        { key: 'u:c', text: 'long enough' },
      ],
    };
    expect(isRulesRequest(request)).toBe(true);
    expect(isRulesRequest({ id: 1 })).toBe(false);
    const response = handleRulesRequest(request);
    expect(response.ok && response.matches).toEqual([
      { key: 'r:c', ruleId: 'r1' },
      { key: 'u:c', ruleId: 'r2' },
    ]);
    const empty = handleRulesRequest({ ...request, rules: [{ bogus: true }] as never });
    expect(empty.ok && empty.matches).toEqual([]);
  });
});

describe('MENU-04 merged cells as spans', () => {
  it('MENU-04 a merge spans rows and columns from its anchor, covers the cells inside, and unmerging shows them again', () => {
    const { gd, tableId } = fixture(4, 3);
    const record = tableById(gd, tableId)!;
    const [r0, r1] = record.rows as [Id, Id];
    const [c0, c1, c2] = record.columns.map((c) => c.id) as [Id, Id, Id];
    setCellText(gd, tableId, r1, c1, 'hidden by the span');
    expect(mergeRoom(record, r1, c1)).toEqual({ rows: 3, cols: 2 });
    expect(mergeCells(gd, tableId, r0, c0, { rows: 2, cols: 2 })).toBeNull();
    const table = tableMap(gd, tableId)!;
    const span = spanAt(table, r0, c0);
    expect(span?.rowIds).toEqual([r0, r1]);
    expect(span?.colIds).toEqual([c0, c1]);
    expect(spanCovering(table, r1, c1)?.anchor).toBe(cellKey(r0, c0));
    expect(spanCovering(table, r0, c2)).toBeNull();
    // The covered cell keeps its data.
    expect(table.get('cells')).toBeDefined();
    expect(unmergeCells(gd, tableId, r1, c1)).toBe(true);
    expect(spanIndex(table).byAnchor.size).toBe(0);
    expect(unmergeCells(gd, tableId, r1, c1)).toBe(false);
  });

  it('MENU-04 a merge past the table edge or over another span is refused and writes nothing', () => {
    const { gd, tableId } = fixture(3, 3);
    const record = tableById(gd, tableId)!;
    const [r0, r1, r2] = record.rows as [Id, Id, Id];
    const [c0, c1] = record.columns.map((c) => c.id) as [Id, Id];
    expect(mergeCells(gd, tableId, r2, c0, { rows: 2, cols: 1 })).toBe('past-edge');
    expect(mergeCells(gd, tableId, r0, c0, { rows: 2, cols: 2 })).toBeNull();
    expect(mergeCells(gd, tableId, r1, c1, { rows: 2, cols: 1 })).toBe('overlaps');
    expect(mergeCells(gd, tableId, r1, c0, { rows: 1, cols: 2 })).toBe('overlaps');
    expect(mergeCells(gd, tableId, 'nope', c0, { rows: 1, cols: 2 })).toBe('unknown-cell');
    expect(spanIndex(tableMap(gd, tableId)!).byAnchor.size).toBe(1);
    // 1 × 1 at the anchor unmerges.
    expect(mergeCells(gd, tableId, r0, c0, { rows: 1, cols: 1 })).toBeNull();
    expect(spanIndex(tableMap(gd, tableId)!).byAnchor.size).toBe(0);
  });

  it('MENU-04 GRID-01 property: a merge never changes any address, and a deleted covered row shrinks the span', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 2, max: 5 }),
        fc.nat(5),
        fc.nat(4),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 5 }),
        (rows, columns, ar, ac, sr, sc) => {
          const { gd, tableId } = fixture(rows, columns);
          const table = tableMap(gd, tableId)!;
          const record = tableById(gd, tableId)!;
          const rowId = record.rows[ar % rows]!;
          const colId = record.columns[ac % columns]!.id;
          const before = tableAddresses(table);
          const result = mergeCells(gd, tableId, rowId, colId, { rows: sr, cols: sc });
          expect(tableAddresses(table)).toEqual(before);
          for (const r of record.rows)
            for (const c of record.columns)
              expect(cellAddress(table, r, c.id)).toBe(
                before[record.rows.indexOf(r)]![record.columns.indexOf(c)],
              );
          if (result === null && (sr > 1 || sc > 1)) {
            const span = spanAt(table, rowId, colId)!;
            expect(span.rows).toBe(Math.min(sr, rows - (ar % rows)));
            expect(span.cols).toBe(Math.min(sc, columns - (ac % columns)));
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('INSP-07 arrange', () => {
  it('INSP-07 stacking: tables paint in z order with ties by id; back, backward, forward and front rewrite a dense order', () => {
    const { gd, sheetId, tableId: a } = fixture();
    const b = createTable(gd, { sheetId, at: { col: 5, row: 1 }, columns: 2, rows: 2 });
    const c = createTable(gd, { sheetId, at: { col: 9, row: 1 }, columns: 2, rows: 2 });
    const order = () =>
      stackingOrder([tableById(gd, a)!, tableById(gd, b)!, tableById(gd, c)!]).map((t) => t.id);
    expect(order()).toEqual([a, b, c]);
    expect(stackingPosition(gd, a)).toEqual({ index: 0, count: 3 });
    expect(restack(gd, a, 'front')).toBe(2);
    expect(order()).toEqual([b, c, a]);
    expect(restack(gd, a, 'forward')).toBeNull();
    expect(restack(gd, a, 'backward')).toBe(1);
    expect(order()).toEqual([b, a, c]);
    expect(restack(gd, c, 'back')).toBe(0);
    expect(order()).toEqual([c, b, a]);
    expect(tableById(gd, c)?.z).toBe(0);
    expect(tableById(gd, a)?.z).toBe(2);
  });

  it('INSP-07 pin to viewport is a table flag; the table keeps its lattice origin', () => {
    const { gd, tableId } = fixture();
    setTablePinned(gd, tableId, true);
    expect(tableById(gd, tableId)?.pinned).toBe(true);
    expect(tableById(gd, tableId)?.gridCol).toBe(1);
    setTablePinned(gd, tableId, false);
    expect(tableById(gd, tableId)?.pinned).toBe(false);
    expect(tableMap(gd, tableId)?.has('pinned')).toBe(false);
  });

  it('INSP-07 RESP-01 a canvas layout places the sheet in stacking order on whole units; every address follows its table', () => {
    const { gd, sheetId, tableId: a } = fixture(4, 3);
    const b = createTable(gd, { sheetId, at: { col: 2, row: 30 }, columns: 2, rows: 2 });
    const record = tableById(gd, a)!;
    const target = { rowId: record.rows[1]!, colId: record.columns[1]!.id };
    expect(cellAddress(tableMap(gd, a)!, target.rowId, target.colId)).toBe('C6');
    let moved = layoutSheet(gd, sheetId, 'lanes');
    expect(moved).toEqual([
      { id: a, col: 1, row: 1 },
      { id: b, col: 1 + 3 + 1, row: 1 },
    ]);
    moved = layoutSheet(gd, sheetId, 'stacked');
    // a is title 2 + header 1 + 4 rows = 7 units tall, then a 4-unit gap.
    expect(moved).toEqual([
      { id: a, col: 1, row: 1 },
      { id: b, col: 1, row: 1 + 7 + 4 },
    ]);
    moved = layoutSheet(gd, sheetId, 'side-by-side');
    expect(moved).toEqual([
      { id: a, col: 1, row: 1 },
      { id: b, col: 5, row: 1 + 6 },
    ]);
    expect(cellAddress(tableMap(gd, a)!, target.rowId, target.colId)).toBe('C6');
    expect(tableById(gd, b)?.gridRow).toBe(7);
  });

  it('INSP-07 DAG edges come from the id-bound formula tokens, counted per table pair, cross-sheet ones flagged; visibility is a sheet flag', () => {
    const { gd, sheetId, tableId: a } = fixture(3, 2);
    const b = createTable(gd, { sheetId, at: { col: 6, row: 1 }, columns: 2, rows: 2 });
    const other = createSheet(gd);
    const c = createTable(gd, { sheetId: other, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const bRec = tableById(gd, b)!;
    const cRec = tableById(gd, c)!;
    // Two cells of b read a (one edge, count 2); c on the other sheet reads b (cross-sheet).
    commitCellText(gd, b, bRec.rows[0]!, bRec.columns[0]!.id, '=Sum(B5:B6)');
    commitCellText(gd, b, bRec.rows[1]!, bRec.columns[0]!.id, '=B5');
    // An address binds within its own sheet, so the cross-sheet read is a bound token
    // typed by hand — the grammar accepts one like any other (formula/bound.ts).
    commitCellText(
      gd,
      c,
      cRec.rows[0]!,
      cRec.columns[0]!.id,
      `=Concat({c:${b}:${bRec.rows[0]!}:${bRec.columns[0]!.id}})`,
    );
    const edges = dagEdges(gd, sheetId);
    expect(edges).toEqual([{ from: a, to: b, count: 2, crossSheet: false }]);
    expect(edgesOf(edges, a)).toEqual({ in: 0, out: 1, crossSheet: 0 });
    expect(edgesOf(edges, b)).toEqual({ in: 1, out: 0, crossSheet: 0 });
    // From the other sheet, c's edge from b is reported as cross-sheet (PRD §11: counted, not drawn).
    const otherEdges = dagEdges(gd, other);
    expect(otherEdges).toEqual([{ from: b, to: c, count: 1, crossSheet: true }]);
    expect(edgesOf(otherEdges, c)).toEqual({ in: 1, out: 0, crossSheet: 1 });
    expect(sheetEdgesShown(gd, sheetId)).toBe(false);
    expect(setSheetEdgesShown(gd, sheetId, true)).toBe(true);
    expect(sheetEdgesShown(gd, sheetId)).toBe(true);
  });
});
