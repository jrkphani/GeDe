import { describe, expect, test } from 'vitest';

import { BOUND_RE, decodeBound, encodeBound, type BoundReference } from './bound.js';
import { evaluate, type BoundOperand, type Resolver } from './evaluate.js';
import { parse } from './parser.js';
import { bindFormula, projectFormula, type Binder, type Projector } from './project.js';
import { tokenize } from './tokenizer.js';

const T = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const R1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const R2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
const C2 = '01ARZ3NDEKTSV4RRFFQ69G5FC2';

const cell: BoundReference = {
  kind: 'cell',
  tableId: T,
  rowId: R1,
  colId: C1,
  spelling: 'address',
};
const entity: BoundReference = {
  kind: 'cell',
  tableId: T,
  rowId: R2,
  colId: C1,
  spelling: 'entity',
};
const range: BoundReference = {
  kind: 'range',
  tableId: T,
  from: { rowId: R1, colId: C1 },
  to: { rowId: R2, colId: C2 },
};
const column: BoundReference = {
  kind: 'column',
  columns: [
    { tableId: T, colId: C1 },
    { tableId: T, colId: C2 },
  ],
};

describe('bound reference tokens (PRD §20: references store ids)', () => {
  test('every kind round-trips through its token', () => {
    for (const ref of [cell, entity, range, column]) {
      const token = encodeBound(ref);
      expect(BOUND_RE.test(token)).toBe(true);
      expect(decodeBound(token)).toEqual(ref);
    }
    expect(encodeBound(cell)).toBe(`{c:${T}:${R1}:${C1}}`);
    expect(encodeBound(entity)).toBe(`{e:${T}:${R2}:${C1}}`);
  });

  test('a brace that is not a token is ordinary text, so list separators may contain braces', () => {
    expect(decodeBound('{c:short}')).toBeNull();
    const tokens = tokenize('=A2 {x} D5');
    expect(tokens.ok && tokens.tokens.map((t) => t.kind)).toEqual([
      'equals',
      'ident',
      'space',
      'other',
      'ident',
      'other',
      'space',
      'ident',
      'eof',
    ]);
    const list = parse('=A2 {x} D5');
    expect(list.ok && list.value.kind === 'list' && list.value.items.map((i) => i.kind)).toEqual([
      'address',
      'separator',
      'address',
    ]);
  });

  test('the parser yields bound references inside calls and lists, with spans', () => {
    const source = `=Sum(${encodeBound(range)}, ${encodeBound(cell)})`;
    const parsed = parse(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'call') throw new Error('expected a call');
    expect(parsed.value.args.map((a) => a.kind)).toEqual(['bound', 'bound']);
    const first = parsed.value.args[0];
    expect(first?.kind === 'bound' && first.ref).toEqual(range);
    expect(source.slice(first!.span.start, first!.span.end)).toBe(encodeBound(range));
    const list = parse(`=${encodeBound(entity)} / ${encodeBound(cell)}`);
    expect(list.ok && list.value.kind === 'list' && list.value.items.map((i) => i.kind)).toEqual([
      'bound',
      'separator',
      'bound',
    ]);
  });

  test('FX-07 a projected #REF does not re-commit silently: the parser names it', () => {
    const r = parse('=Sum(#REF, B2)');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/#REF names a cell that was removed/);
    expect(r.error.span).toEqual({ start: 5, end: 9 });
  });

  test('FX-06 evaluation reads bound operands through the resolver and reports a removed target', () => {
    const values = new Map<string, BoundOperand[]>([
      [encodeBound(cell), [{ address: 'B5', value: { kind: 'number', value: 4 } }]],
      [
        encodeBound(range),
        [
          { address: 'B5', value: { kind: 'number', value: 1 } },
          { address: 'C6', value: { kind: 'number', value: 2 } },
        ],
      ],
    ]);
    const resolver: Resolver = {
      valueAt: () => undefined,
      entity: () => undefined,
      columnValues: () => [],
      bound: (ref) => values.get(encodeBound(ref)),
    };
    const ok = parse(`=Sum(${encodeBound(range)}, ${encodeBound(cell)})`);
    if (!ok.ok) throw new Error('parse');
    expect(evaluate(ok.value, resolver)).toEqual({ ok: true, value: { kind: 'number', value: 7 } });
    const gone = parse(`=Sum(${encodeBound(entity)})`);
    if (!gone.ok) throw new Error('parse');
    expect(evaluate(gone.value, resolver)).toEqual({
      ok: false,
      error: { kind: 'reference-removed', label: 'an @ path' },
    });
  });
});

/** FAKE binder/projector for one 2×2 table at B5:C6 titled "Trek" with rows "Lukla" and "Namche". */
const cells: Record<string, { rowId: string; colId: string }> = {
  '1,4': { rowId: R1, colId: C1 },
  '2,4': { rowId: R1, colId: C2 },
  '1,5': { rowId: R2, colId: C1 },
  '2,5': { rowId: R2, colId: C2 },
};
const binder: Binder = {
  cellAt: (ref) => {
    const hit = cells[`${String(ref.col)},${String(ref.row)}`];
    return hit === undefined ? null : { tableId: T, ...hit };
  },
  columnsAt: (col) => (col === 1 ? [{ tableId: T, colId: C1 }] : []),
  entity: (path) =>
    path.join('.') === 'Trek.Namche' ? { tableId: T, rowId: R2, colId: C1 } : null,
};
const projector: Projector = {
  positionOf: (t) => {
    for (const [k, v] of Object.entries(cells)) {
      if (v.rowId === t.rowId && v.colId === t.colId) {
        const [col, row] = k.split(',').map(Number);
        return { col: col ?? 0, row: row ?? 0 };
      }
    }
    return null;
  },
  exists: (t) => Object.values(cells).some((c) => c.rowId === t.rowId && c.colId === t.colId),
  entityPathOf: (t) => (t.rowId === R2 && t.colId === C1 ? '@Trek.Namche' : null),
  columnOf: (_tableId, colId) => (colId === C1 ? 1 : null),
};

describe('bind at commit, project for display', () => {
  test('FX-06 every reference that names something binds to ids; the rest stays as typed', () => {
    expect(bindFormula('=Sum(B5:C6, B5, B:B, @Trek.Namche, H20, @Trek.Nowhere)', binder)).toBe(
      `=Sum(${encodeBound(range)}, ${encodeBound(cell)}, {k:${T}:${C1}}, ${encodeBound(entity)}, H20, @Trek.Nowhere)`,
    );
    // A range with corners in different tables (here: one corner off the table) is not bound.
    expect(bindFormula('=Sum(B5:D9)', binder)).toBe('=Sum(B5:D9)');
    // Text that does not parse is stored as typed so the engine can report the error.
    expect(bindFormula('=Sum(', binder)).toBe('=Sum(');
    expect(bindFormula('plain', binder)).toBe('plain');
  });

  test('FX-07 projection writes the addresses of today and paths, and #REF for a removed target', () => {
    const stored = `=Sum(${encodeBound(range)}, ${encodeBound(cell)}, {k:${T}:${C1}})`;
    expect(projectFormula(stored, projector)).toBe('=Sum(B5:C6, B5, B:B)');
    expect(projectFormula(`=${encodeBound(entity)} / ${encodeBound(cell)}`, projector)).toBe(
      '=@Trek.Namche / B5',
    );
    const removed: BoundReference = { ...cell, rowId: '01ARZ3NDEKTSV4RRFFQ69G5FA9' };
    expect(projectFormula(`=Sum(${encodeBound(removed)}, ${encodeBound(cell)})`, projector)).toBe(
      '=Sum(#REF, B5)',
    );
    // No braces: nothing to do, not even a parse.
    expect(projectFormula('=Sum(B5)', projector)).toBe('=Sum(B5)');
  });
});
