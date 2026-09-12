import { describe, expect, test } from 'vitest';

import { docNode, paragraphNode, textNode, type RichDoc } from '../text/types.js';
import { references } from './ast.js';
import { evaluate, type CellValue, type Resolver } from './evaluate.js';
import { applyMethod, formatMethodCall, patternOf } from './methods.js';
import { parse } from './parser.js';

function ast(text: string) {
  const r = parse(text);
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`);
  return r.value;
}

const resolver = (text: string, rich?: RichDoc): Resolver => ({
  valueAt: () => ({ kind: 'text', text, rich }),
  entity: () => ({ kind: 'text', text, rich }),
  columnValues: () => [],
  bound: () => [{ address: 'B5', value: { kind: 'text', text, rich } }],
});

function run(formula: string, text: string, rich?: RichDoc, locale?: string): CellValue {
  const r = evaluate(ast(formula), resolver(text, rich), { locale });
  if (!r.ok) throw new Error(r.error.kind);
  return r.value;
}

describe('REF-04 method-call grammar (PRD §2–§4, §9, §20)', () => {
  test('REF-04 parses @Column.Method(args) as one reference carrying a method', () => {
    const a = ast('=@Notes.Extract("Country")');
    expect(a.kind).toBe('method');
    if (a.kind !== 'method') return;
    expect(a.name).toBe('Extract');
    expect(a.args.map((x) => x.value)).toEqual(['Country']);
    expect(a.target.kind).toBe('entity');
    if (a.target.kind === 'entity') expect(a.target.path).toEqual(['Notes']);
    expect(references(a)).toHaveLength(1);
  });

  test('REF-04 a method segment ends an @ path; earlier segments stay path', () => {
    const a = ast('=@"Table 1".Lukla.Notes.Format("upper")');
    if (a.kind !== 'method' || a.target.kind !== 'entity') throw new Error('shape');
    expect(a.target.path).toEqual(['Table 1', 'Lukla', 'Notes']);
    expect(a.name).toBe('Format');
  });

  test('REF-04 PRD §3 a named argument: @Column.Extract(Style="Highlight:Yellow")', () => {
    const a = ast('=@Column.Extract(Style="Highlight:Yellow")');
    if (a.kind !== 'method') throw new Error('shape');
    expect(a.args).toHaveLength(1);
    expect(a.args[0]).toMatchObject({ kind: 'string', name: 'Style', value: 'Highlight:Yellow' });
  });

  test('REF-04 PRD §9 a chip named property-style: @Row.Extract.Date()', () => {
    const a = ast('=@Row.Extract.Date()');
    if (a.kind !== 'method' || a.target.kind !== 'entity') throw new Error('shape');
    expect(a.target.path).toEqual(['Row']);
    expect(a.name).toBe('Extract');
    expect(a.args.map((x) => x.value)).toEqual(['date']);
    const r = parse('=@Row.Split.Date()');
    expect(r.ok).toBe(false);
    // A property that names no chip is an error, not a literal search for its own name.
    const unknown = parse('=@Row.Extract.Nope()');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.message).toContain('unknown chip');
    // Chip names bind case-insensitively, camel-cased ids included.
    const dash = ast('=@Row.Extract.AfterDash()');
    if (dash.kind !== 'method') throw new Error('shape');
    expect(dash.args.map((x) => x.value)).toEqual(['afterDash']);
    expect(run('=B5.Extract("afterdash")', 'Lukla — 2860 m')).toEqual({
      kind: 'text',
      text: '2860 m',
    });
  });

  test('REF-04 addresses and bound tokens carry methods, inside calls too', () => {
    const a = ast('=Concat(B5.Format("Trimmed"), " · ", @A.B.Format("upper"))');
    expect(a.kind).toBe('call');
    expect(references(a).map((r) => r.kind)).toEqual(['address', 'entity']);
    expect(ast('=B5.Split(", ")').kind).toBe('method');
  });

  test('REF-04 a method argument must be a literal; Length and Trim are not methods (PRD)', () => {
    const r = parse('=B5.Split(B6)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('quoted text');
    // `Trim()` is `Format("Trimmed")` (§22); a string length is a §9 metric, not a method.
    expect(ast('=@A.B.Trim()').kind).toBe('list');
    expect(ast('=@A.B.Length()').kind).toBe('list');
  });
});

const highlighted: RichDoc = docNode([
  paragraphNode([
    textNode('Meet at '),
    textNode('Lukla', [{ type: 'highlight', attrs: { token: 'amber' } }]),
    textNode(' then '),
    textNode('Namche', [{ type: 'highlight', attrs: { token: 'forest' } }]),
    textNode(' and '),
    textNode('Leh', [{ type: 'bold' }]),
  ]),
]);

describe('REF-04 methods evaluate through the text algebra', () => {
  test('REF-04 Extract by chip, regex and literal', () => {
    expect(run('=B5.Extract("email")', 'Write to ann@x.io or bo@y.org')).toEqual({
      kind: 'text',
      text: 'ann@x.io, bo@y.org',
    });
    expect(run('=B5.Extract("/\\\\(([^)]*)\\\\)/")', 'Lukla (2860 m) and Namche (3440 m)')).toEqual(
      {
        kind: 'text',
        text: '2860 m, 3440 m',
      },
    );
    expect(run('=B5.Extract("Ltd")', 'Acme Ltd and Zed Ltd')).toEqual({
      kind: 'text',
      text: 'Ltd, Ltd',
    });
    // PRD §9: the chip named property-style is the same extraction.
    expect(run('=B5.Extract.Date()', 'Due 2026-01-12 and 12 Jan 2026')).toMatchObject({
      kind: 'text',
    });
  });

  test('REF-04 PRD §3 Extract(Style=…) reads the marks: only highlighted terms, or one tint, or bold', () => {
    const text = 'Meet at Lukla then Namche and Leh';
    expect(run('=B5.Extract(Style="Highlight")', text, highlighted)).toEqual({
      kind: 'text',
      text: 'Lukla, Namche',
    });
    expect(run('=B5.Extract(Style="Highlight:Yellow")', text, highlighted)).toEqual({
      kind: 'text',
      text: 'Lukla',
    });
    expect(run('=B5.Extract(Style="Bold")', text, highlighted)).toEqual({
      kind: 'text',
      text: 'Leh',
    });
    // Without marks nothing is highlighted; an unknown style is an error value.
    expect(run('=B5.Extract(Style="Highlight")', text)).toEqual({ kind: 'text', text: '' });
    const bad = evaluate(ast('=B5.Extract(Style="Glow")'), resolver(text));
    expect(bad.ok).toBe(false);
  });

  test('HIER-07 Split yields a list of trimmed, non-empty pieces', () => {
    expect(run('=B5.Split(". ")', 'One. Two. Three.')).toEqual({
      kind: 'list',
      items: [
        { kind: 'text', text: 'One' },
        { kind: 'text', text: 'Two' },
        { kind: 'text', text: 'Three.' },
      ],
    });
  });

  test('REF-04 Replace, Format (in the active locale) and Concat', () => {
    expect(run('=B5.Replace("a", "o")', 'banana')).toEqual({ kind: 'text', text: 'bonono' });
    expect(run('=B5.Format("Title Case")', 'everest base camp')).toEqual({
      kind: 'text',
      text: 'Everest Base Camp',
    });
    expect(run('=B5.Format("UPPERCASE")', 'namche')).toEqual({ kind: 'text', text: 'NAMCHE' });
    expect(run('=B5.Format("Trimmed")', '  a   b ')).toEqual({ kind: 'text', text: 'a   b' });
    // I18N: a dotted i upper-cases per locale (Turkish keeps the dot).
    expect(run('=B5.Format("UPPERCASE")', 'i', undefined, 'tr')).toEqual({
      kind: 'text',
      text: 'İ',
    });
    expect(run('=B5.Format("UPPERCASE")', 'i', undefined, 'en-GB')).toEqual({
      kind: 'text',
      text: 'I',
    });
    expect(run('=B5.Concat(" (draft)")', 'Plan')).toEqual({ kind: 'text', text: 'Plan (draft)' });
  });

  test('REF-04 bad arguments are error values, never exceptions', () => {
    const r = evaluate(ast('=B5.Format("bold")'), resolver('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-argument');
    expect(applyMethod('Split', [{ value: '' }], highlighted).ok).toBe(false);
    expect(patternOf('/(?<=a)b/').ok).toBe(false);
  });

  test('REF-04 Sum over a Split list is text in range', () => {
    const r = evaluate(ast('=Sum(B5.Split(","))'), resolver('1,2'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('text-in-range');
  });

  test('REF-04 formatMethodCall quotes text arguments and writes names', () => {
    expect(formatMethodCall('Replace', [{ value: 'a "q"' }, { value: 'b' }])).toBe(
      'Replace("a \\"q\\"", "b")',
    );
    expect(formatMethodCall('Extract', [{ name: 'Style', value: 'Highlight' }])).toBe(
      'Extract(Style="Highlight")',
    );
    expect(formatMethodCall('Concat', [])).toBe('Concat()');
  });
});
