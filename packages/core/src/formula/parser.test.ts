import { describe, expect, test } from 'vitest';

import { formatAddress, formatRange } from '../address.js';
import { references, type Ast, type Reference } from './ast.js';
import { parse } from './parser.js';
import { tokenize } from './tokenizer.js';

function mustParse(text: string): Ast {
  const result = parse(text);
  if (!result.ok) throw new Error(`${text}: ${result.error.message}`);
  return result.value;
}

function describeRef(ref: Reference): string {
  switch (ref.kind) {
    case 'address':
      return formatAddress(ref.ref);
    case 'range':
      return formatRange(ref.range);
    case 'column':
      return `col ${String(ref.col)}`;
    case 'entity':
      return `@${ref.path.join('.')}`;
    case 'bound':
      return `bound ${ref.ref.kind}`;
  }
}

describe('tokenizer', () => {
  test('FX-01 strings decode escapes and keep their raw span', () => {
    const result = tokenize('="a \\"b\\"", \'c\'');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const strings = result.tokens.filter((t) => t.kind === 'string');
    expect(strings.map((t) => t.value)).toEqual(['a "b"', 'c']);
    expect(strings[0]?.span).toEqual({ start: 1, end: 10 });
  });

  test('FX-01 an unterminated string is an error with a span', () => {
    const result = tokenize('=Concat("open');
    expect(result).toEqual({
      ok: false,
      error: { message: 'unterminated string literal', span: { start: 8, end: 13 } },
    });
  });

  test('FX-04 identifiers accept Tamil, Hindi and Telugu letters', () => {
    const result = tokenize('=@விற்பனை.मूल्य.మొత్తం');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.filter((t) => t.kind === 'ident').map((t) => t.text)).toEqual([
      'விற்பனை',
      'मूल्य',
      'మొత్తం',
    ]);
  });
});

describe('parse — calls', () => {
  test('FX-01 Concat takes addresses, @ paths and quoted literals', () => {
    const ast = mustParse('=Concat(A1, "—", @Team.Lead, B2:B3, 42)');
    expect(ast.kind).toBe('call');
    if (ast.kind !== 'call') return;
    expect(ast.name).toBe('Concat');
    expect(ast.args.map((a) => a.kind)).toEqual(['address', 'string', 'entity', 'range', 'number']);
    expect(ast.span).toEqual({ start: 1, end: 39 });
  });

  test('FX-02 Sum accepts a range, an address list, @ paths and a whole column', () => {
    expect(references(mustParse('=Sum(B2:B14)')).map(describeRef)).toEqual(['B2:B14']);
    expect(references(mustParse('=Sum(B2, B3, B4)')).map(describeRef)).toEqual(['B2', 'B3', 'B4']);
    expect(references(mustParse('=Sum(@Q1.Total, @Q2.Total)')).map(describeRef)).toEqual([
      '@Q1.Total',
      '@Q2.Total',
    ]);
    expect(references(mustParse('=Sum(B:B)')).map(describeRef)).toEqual(['col 1']);
  });

  test('FX-01 function names are case-insensitive and normalised; empty arguments and nesting are allowed', () => {
    const ast = mustParse('=concat( SUM(A1, -2.5), "x" )');
    if (ast.kind !== 'call') throw new Error('expected call');
    expect(ast.name).toBe('Concat');
    const nested = ast.args[0];
    expect(nested?.kind).toBe('call');
    if (nested?.kind !== 'call') return;
    expect(nested.name).toBe('Sum');
    expect(nested.args[1]).toMatchObject({ kind: 'number', value: -2.5 });
    expect(mustParse('=Sum()')).toMatchObject({ kind: 'call', args: [] });
  });

  test('FX-01 ranges inside calls are normalised', () => {
    const ast = mustParse('=Sum(C3:B2)');
    if (ast.kind !== 'call') throw new Error('expected call');
    expect(ast.args[0]).toMatchObject({
      kind: 'range',
      range: { start: { col: 1, row: 1 }, end: { col: 2, row: 2 } },
    });
  });
});

describe('parse — lists', () => {
  test('FX-03 =A2, D5 lists addresses with the typed separator kept verbatim', () => {
    const ast = mustParse('=A2, D5');
    expect(ast.kind).toBe('list');
    if (ast.kind !== 'list') return;
    expect(ast.items).toEqual([
      { kind: 'address', ref: { col: 0, row: 1 }, span: { start: 1, end: 3 } },
      { kind: 'separator', text: ', ', span: { start: 3, end: 5 } },
      { kind: 'address', ref: { col: 3, row: 4 }, span: { start: 5, end: 7 } },
    ]);
  });

  test('FX-03 =@Group.Entity, @Group.Entity resolves entity paths with any separator', () => {
    const ast = mustParse('=@Sales.North — @Sales.South / @Sales."Far East"');
    if (ast.kind !== 'list') throw new Error('expected list');
    expect(ast.items.map((i) => (i.kind === 'separator' ? `[${i.text}]` : describeRef(i)))).toEqual(
      ['@Sales.North', '[ — ]', '@Sales.South', '[ / ]', '@Sales.Far East'],
    );
  });

  test('FX-03 a single reference is a one-item list; trailing text becomes a separator', () => {
    expect(mustParse('=B14').kind).toBe('list');
    const ast = mustParse('=B14 units');
    if (ast.kind !== 'list') throw new Error('expected list');
    expect(ast.items.map((i) => i.kind)).toEqual(['address', 'separator']);
  });

  test('FX-03 ranges and columns are references in list mode too', () => {
    expect(references(mustParse('=B2:B4 and C:C')).map(describeRef)).toEqual(['B2:B4', 'col 2']);
  });
});

describe('parse — errors never throw', () => {
  test.each([
    ['', 'a formula starts with ='],
    ['A1', 'a formula starts with ='],
    ['=', 'type a cell address'],
    ['=hello', 'expected a cell address'],
    ['=Foo(A1)', 'unknown function Foo'],
    ['=Sum(A1', 'missing closing )'],
    ['=Sum(A1 A2)', 'expected , or )'],
    ['=Sum(A1,)', 'expected a cell address'],
    ['=Sum(hello)', 'hello is not a cell address'],
    ['=Sum(A1:x)', 'a range is two addresses'],
    ['=Concat(@)', 'expected a name after @'],
    ['=@A.', 'expected a name after .'],
    ['=Sum(A1) trailing', 'unexpected text after the closing )'],
    ['=Concat("open', 'unterminated string'],
  ])('FX-01 %j → %s', (text, message) => {
    const result = parse(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(message);
    expect(result.error.span.start).toBeGreaterThanOrEqual(0);
    expect(result.error.span.end).toBeGreaterThanOrEqual(result.error.span.start);
  });

  test('FX-01 error spans point at the offending token', () => {
    const result = parse('=Sum(A1, nope)');
    if (result.ok) throw new Error('expected failure');
    expect('=Sum(A1, nope)'.slice(result.error.span.start, result.error.span.end)).toBe('nope');
  });
});

describe('references', () => {
  test('FX-08 references are returned in operand order with spans for highlighting', () => {
    const text = '=Concat(B2, Sum(C1:C9, @Total), "lit", D:D)';
    const refs = references(mustParse(text));
    expect(refs.map(describeRef)).toEqual(['B2', 'C1:C9', '@Total', 'col 3']);
    expect(refs.map((r) => text.slice(r.span.start, r.span.end))).toEqual([
      'B2',
      'C1:C9',
      '@Total',
      'D:D',
    ]);
  });
});
