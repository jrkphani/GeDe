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

  test('FX-07 a projected #REF or #hidden parses as a placeholder reference with its span', () => {
    const r = parse('=Sum(#REF, B2, #hidden)');
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'call') throw new Error('expected a call');
    expect(r.value.args.map((a) => a.kind)).toEqual(['placeholder', 'address', 'placeholder']);
    const [first, , third] = r.value.args;
    expect(first?.kind === 'placeholder' && first.label).toBe('REF');
    expect(first?.span).toEqual({ start: 5, end: 9 });
    expect(third?.kind === 'placeholder' && third.label).toBe('hidden');
    // In a list too.
    const list = parse('=#REF / B2');
    expect(list.ok && list.value.kind === 'list' && list.value.items.map((i) => i.kind)).toEqual([
      'placeholder',
      'separator',
      'address',
    ]);
    // `#Ref` or `#REFERENCE` is not a placeholder.
    expect(parse('=Sum(#REFERENCE)').ok).toBe(false);
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
  extentOf: (tableId) =>
    tableId === T ? { firstRow: 4, lastRow: 5, firstCol: 1, lastCol: 2 } : null,
};
/** Open corners resolve to the fake table's edges: rows R1 (first) / R2 (last), columns C1 / C2. */
function cornerOf(t: { rowId: string; colId: string }): { rowId: string; colId: string } {
  return {
    rowId: t.rowId === '^' ? R1 : t.rowId === '*' ? R2 : t.rowId,
    colId: t.colId === '^' ? C1 : t.colId === '*' ? C2 : t.colId,
  };
}
const projector: Projector = {
  positionOf: (target) => {
    const t = cornerOf(target);
    for (const [k, v] of Object.entries(cells)) {
      if (v.rowId === t.rowId && v.colId === t.colId) {
        const [col, row] = k.split(',').map(Number);
        return { col: col ?? 0, row: row ?? 0 };
      }
    }
    return null;
  },
  exists: (target) => {
    const t = cornerOf(target);
    return Object.values(cells).some((c) => c.rowId === t.rowId && c.colId === t.colId);
  },
  entityPathOf: (t) => (t.rowId === R2 && t.colId === C1 ? '@Trek.Namche' : null),
  columnOf: (_tableId, colId) => (colId === C1 ? 1 : null),
};

describe('bind at commit, project for display', () => {
  test('FX-06 every reference that names something binds to ids; the rest stays as typed', () => {
    expect(bindFormula('=Sum(B5:C6, B5, B:B, @Trek.Namche, H20, @Trek.Nowhere)', binder)).toBe(
      `=Sum(${encodeBound(range)}, ${encodeBound(cell)}, {k:${T}:${C1}}, ${encodeBound(entity)}, H20, @Trek.Nowhere)`,
    );
    // A range with a corner past the table binds that corner open-ended: it follows the table.
    expect(bindFormula('=Sum(B5:B20)', binder)).toBe(`=Sum({r:${T}:${R1}:${C1}:*:${C1}})`);
    expect(bindFormula('=Sum(B1:C6)', binder)).toBe(`=Sum({r:${T}:^:${C1}:${R2}:${C2}})`);
    expect(bindFormula('=Sum(B5:Z99)', binder)).toBe(`=Sum({r:${T}:${R1}:${C1}:*:*})`);
    // Neither corner on a table: nothing to anchor to, stays positional.
    expect(bindFormula('=Sum(H20:H30)', binder)).toBe('=Sum(H20:H30)');
    // Text that does not parse is stored as typed so the engine can report the error.
    expect(bindFormula('=Sum(', binder)).toBe('=Sum(');
    expect(bindFormula('plain', binder)).toBe('plain');
  });

  test('FX-06 an open-ended corner projects to the table edge and round-trips through its token', () => {
    const open = `{r:${T}:${R1}:${C1}:*:${C1}}`;
    expect(decodeBound(open)).toEqual({
      kind: 'range',
      tableId: T,
      from: { rowId: R1, colId: C1 },
      to: { rowId: '*', colId: C1 },
    });
    expect(projectFormula(`=Sum(${open})`, projector)).toBe('=Sum(B5:B6)');
    expect(projectFormula(`=Sum({r:${T}:^:^:*:*})`, projector)).toBe('=Sum(B5:C6)');
  });

  test('FX-07 a #REF / #hidden shown by the editor keeps the token the cell held when re-committed', () => {
    const gone = { ...cell, rowId: '01ARZ3NDEKTSV4RRFFQ69G5FA9' };
    const previous = `=Sum(${encodeBound(gone)}, ${encodeBound(cell)})`;
    expect(projectFormula(previous, projector)).toBe('=Sum(#REF, B5)');
    // The person adds an operand and commits the text as shown: the removed reference stays bound.
    expect(bindFormula('=Sum(#REF, B5, C6)', binder, { source: previous, projector })).toBe(
      `=Sum(${encodeBound(gone)}, ${encodeBound(cell)}, {c:${T}:${R2}:${C2}})`,
    );
    // Without a previous token behind it, a placeholder stays a placeholder (evaluates as removed).
    expect(bindFormula('=Sum(#REF, B5)', binder)).toBe(`=Sum(#REF, ${encodeBound(cell)})`);
    // Placeholders match previous placeholder tokens in order; a bound reference is never consumed.
    const two = `=Sum(${encodeBound(cell)}, ${encodeBound(gone)}, ${encodeBound({ ...gone, colId: C2 })})`;
    expect(bindFormula('=Sum(B5, #REF, #REF)', binder, { source: two, projector })).toBe(two);
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
