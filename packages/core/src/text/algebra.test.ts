import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  concat,
  extract,
  format,
  marksAt,
  matches,
  replace,
  replaceSpan,
  slice,
  split,
} from './algebra.js';
import { checkDoc } from './schema.js';
import {
  docNode,
  EMPTY_DOC,
  HIGHLIGHT_TOKENS,
  markSetsEqual,
  normalise,
  paragraphNode,
  plainText,
  richFromText,
  TEXT_COLOUR_TOKENS,
  textNode,
  TOGGLE_MARKS,
  type Mark,
  type RichDoc,
} from './types.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbMark: fc.Arbitrary<Mark> = fc.oneof(
  fc.constantFrom(...TOGGLE_MARKS).map((type): Mark => ({ type })),
  fc.constantFrom('a', 'b').map((s): Mark => ({ type: 'link', attrs: { href: `https://${s}` } })),
  fc
    .constantFrom(...TEXT_COLOUR_TOKENS)
    .map((token): Mark => ({ type: 'textColour', attrs: { token } })),
  fc
    .constantFrom(...HIGHLIGHT_TOKENS)
    .map((token): Mark => ({ type: 'highlight', attrs: { token } })),
);

/** A mark set with no duplicate types and never both super and subscript. */
const arbMarks: fc.Arbitrary<Mark[]> = fc
  .uniqueArray(arbMark, {
    maxLength: 3,
    selector: (m) => m.type,
  })
  .map((marks) => {
    const hasSup = marks.some((m) => m.type === 'superscript');
    return hasSup ? marks.filter((m) => m.type !== 'subscript') : marks;
  });

const ALPHABET = 'ab .-,(x)ßé@தిह';
const arbText = fc.string({
  unit: fc.constantFrom(...ALPHABET.split('')),
  minLength: 1,
  maxLength: 6,
});

const arbParagraph = fc
  .array(fc.record({ text: arbText, marks: arbMarks }), { maxLength: 4 })
  .map((nodes) => paragraphNode(nodes.map((n) => textNode(n.text, n.marks))));

const arbDoc: fc.Arbitrary<RichDoc> = fc
  .array(arbParagraph, { minLength: 1, maxLength: 3 })
  .map((ps) => normalise(docNode(ps)));

const arbSeparator = fc.constantFrom(' ', '.', '-', ', ', '\n', 'ab');

// ---------------------------------------------------------------------------
// Helpers: the marks of every character in the plain-text offset space
// ---------------------------------------------------------------------------

/** One entry per plain-text character; `null` at a paragraph break. */
function charMarks(d: RichDoc): (readonly Mark[] | null)[] {
  const out: (readonly Mark[] | null)[] = [];
  d.content.forEach((p, i) => {
    if (i > 0) out.push(null);
    for (const node of p.content ?? []) {
      for (const _ch of node.text) out.push(node.marks ?? []);
    }
  });
  return out;
}

function sameMarks(a: readonly Mark[] | null, b: readonly Mark[] | null): boolean {
  if (a === null || b === null) return a === b;
  return markSetsEqual(a, b);
}

const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };
const amber: Mark = { type: 'highlight', attrs: { token: 'amber' } };

// ---------------------------------------------------------------------------

describe('text algebra — slice and concat', () => {
  test('TEXT-ALG slice projects to plainText.slice and keeps every character its marks', () => {
    fc.assert(
      fc.property(arbDoc, fc.nat(30), fc.nat(30), (d, a, b) => {
        const flat = plainText(d);
        const from = Math.min(a, flat.length);
        const to = Math.min(b, flat.length);
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        const piece = slice(d, from, to);
        checkDoc(piece);
        expect(plainText(piece)).toBe(flat.slice(lo, hi));
        const before = charMarks(d).slice(lo, hi);
        const after = charMarks(piece);
        expect(after.length).toBe(before.length);
        before.forEach((m, i) => {
          expect(sameMarks(m, after[i] ?? null)).toBe(true);
        });
      }),
    );
  });

  test('TEXT-ALG concat is the inverse of slicing at any offset', () => {
    fc.assert(
      fc.property(arbDoc, fc.nat(30), (d, a) => {
        const flat = plainText(d);
        const at = Math.min(a, flat.length);
        const joined = concat([slice(d, 0, at), slice(d, at, flat.length)]);
        expect(joined).toEqual(normalise(d));
      }),
    );
  });

  test('FX-01 concat joins plain text with the separator between each pair', () => {
    fc.assert(
      fc.property(fc.array(arbDoc, { minLength: 1, maxLength: 4 }), arbSeparator, (docs, sep) => {
        const joined = concat(docs, sep);
        checkDoc(joined);
        expect(plainText(joined)).toBe(docs.map(plainText).join(sep));
      }),
    );
  });

  test('FX-01 concat keeps the marks of each operand and leaves the separator unmarked', () => {
    const a = docNode([paragraphNode([textNode('Meena', [bold])])]);
    const b = docNode([paragraphNode([textNode('Kumar', [italic])])]);
    const joined = concat([a, b], ' ');
    expect(joined.content[0]?.content).toEqual([
      textNode('Meena', [bold]),
      textNode(' '),
      textNode('Kumar', [italic]),
    ]);
  });

  test('concat of nothing is the empty document', () => {
    expect(concat([])).toEqual(EMPTY_DOC);
    expect(concat([EMPTY_DOC, EMPTY_DOC], ', ')).toEqual(richFromText(', '));
  });
});

describe('text algebra — split', () => {
  test('TEXT-ALG split projects to String.split for a literal separator', () => {
    fc.assert(
      fc.property(arbDoc, arbSeparator, (d, sep) => {
        const pieces = split(d, sep);
        expect(pieces.map(plainText)).toEqual(plainText(d).split(sep));
        for (const piece of pieces) checkDoc(piece);
      }),
    );
  });

  test('TEXT-ALG split pieces re-join with the separator to the original text; every kept character keeps its marks', () => {
    fc.assert(
      fc.property(arbDoc, arbSeparator, (d, sep) => {
        const joined = concat(split(d, sep), sep);
        expect(plainText(joined)).toBe(plainText(d));
        // The separator itself is not part of any piece, so only its characters may lose marks.
        const cut = new Set<number>();
        for (const m of matches(d, sep)) for (let i = m.start; i < m.end; i += 1) cut.add(i);
        const before = charMarks(d);
        const after = charMarks(joined);
        before.forEach((marks, i) => {
          if (!cut.has(i)) expect(sameMarks(marks, after[i] ?? null)).toBe(true);
        });
      }),
    );
  });

  test('split on a regex drops the matched text and keeps marks either side', () => {
    const d = docNode([
      paragraphNode([textNode('one', [bold]), textNode(', '), textNode('two', [italic])]),
    ]);
    expect(split(d, /,\s*/)).toEqual([
      docNode([paragraphNode([textNode('one', [bold])])]),
      docNode([paragraphNode([textNode('two', [italic])])]),
    ]);
  });

  test('a zero-length match never splits', () => {
    const d = richFromText('abc');
    expect(split(d, /x*/)).toEqual([normalise(d)]);
    expect(split(d, '')).toEqual([normalise(d)]);
  });

  test('a paragraph break is a character the separator can cut', () => {
    const d = richFromText('a\nb\nc');
    expect(split(d, '\n').map(plainText)).toEqual(['a', 'b', 'c']);
  });
});

describe('text algebra — extract', () => {
  test('TEXT-ALG extract projects to matchAll and keeps marks', () => {
    fc.assert(
      fc.property(arbDoc, fc.constantFrom(/[ab]+/, /\(([^()]*)\)/, /\S+/), (d, re) => {
        const flat = plainText(d);
        const found = extract(d, re);
        const expected = [...flat.matchAll(new RegExp(re.source, 'g'))]
          .filter((m) => m[0] !== '')
          .map((m) => m[1] ?? m[0]);
        expect(found.map(plainText)).toEqual(expected);
        const before = charMarks(d);
        matches(d, re).forEach((m, i) => {
          const range = m.group ?? m;
          const after = charMarks(found[i] ?? EMPTY_DOC);
          before.slice(range.start, range.end).forEach((marks, k) => {
            expect(sameMarks(marks, after[k] ?? null)).toBe(true);
          });
        });
      }),
    );
  });

  test('a capture group narrows what is extracted (Parenthetical)', () => {
    const d = docNode([
      paragraphNode([textNode('Acme ('), textNode('Singapore', [bold]), textNode(') Pte Ltd')]),
    ]);
    expect(extract(d, /\(([^()]*)\)/)).toEqual([
      docNode([paragraphNode([textNode('Singapore', [bold])])]),
    ]);
  });
});

describe('text algebra — replace', () => {
  test('TEXT-ALG replace projects to String.replaceAll', () => {
    fc.assert(
      fc.property(arbDoc, arbSeparator, arbText, (d, target, repl) => {
        const out = replace(d, target, repl);
        checkDoc(out);
        expect(plainText(out)).toBe(plainText(d).replaceAll(target, repl));
      }),
    );
  });

  test('TEXT-ALG replace leaves the marks outside every match untouched', () => {
    fc.assert(
      fc.property(arbDoc, arbSeparator, arbText, (d, target, repl) => {
        const before = charMarks(d);
        const after = charMarks(replace(d, target, repl));
        let i = 0;
        let j = 0;
        for (const m of matches(d, target)) {
          while (i < m.start) {
            expect(sameMarks(before[i] ?? null, after[j] ?? null)).toBe(true);
            i += 1;
            j += 1;
          }
          i = m.end;
          j += repl.length;
        }
        while (i < before.length) {
          expect(sameMarks(before[i] ?? null, after[j] ?? null)).toBe(true);
          i += 1;
          j += 1;
        }
      }),
    );
  });

  test('a plain replacement inherits the marks where the match began', () => {
    const d = docNode([paragraphNode([textNode('total: '), textNode('draft', [bold, amber])])]);
    expect(replace(d, 'draft', 'final')).toEqual(
      docNode([paragraphNode([textNode('total: '), textNode('final', [bold, amber])])]),
    );
  });

  test('a rich replacement keeps its own marks', () => {
    const d = richFromText('a b');
    const r = docNode([paragraphNode([textNode('c', [italic])])]);
    expect(replace(d, 'b', r)).toEqual(
      docNode([paragraphNode([textNode('a '), textNode('c', [italic])])]),
    );
  });

  test('a replacement containing a newline introduces a paragraph break', () => {
    expect(plainText(replace(richFromText('a, b'), ', ', '\n'))).toBe('a\nb');
  });
});

describe('text algebra — replaceSpan (FIND-08)', () => {
  test('FIND-08 replaceSpan keeps marks outside the span and gives the new text the marks where the span began', () => {
    const d = docNode([
      paragraphNode([textNode('Trip to '), textNode('Singapore', [bold]), textNode(' soon')]),
    ]);
    expect(replaceSpan(d, 8, 17, 'Mumbai')).toEqual(
      docNode([
        paragraphNode([textNode('Trip to '), textNode('Mumbai', [bold]), textNode(' soon')]),
      ]),
    );
    expect(replaceSpan(d, 0, 4, 'Flew')).toEqual(
      docNode([
        paragraphNode([textNode('Flew to '), textNode('Singapore', [bold]), textNode(' soon')]),
      ]),
    );
  });

  test('FIND-08 replaceSpan projects to String.slice splicing and leaves a bad span alone', () => {
    fc.assert(
      fc.property(arbDoc, fc.nat(30), fc.nat(30), arbText, (d, a, b, repl) => {
        const flat = plainText(d);
        const from = Math.min(a, flat.length);
        const to = Math.min(b, flat.length);
        const out = replaceSpan(d, from, to, repl);
        checkDoc(out);
        if (from >= to) expect(out).toEqual(normalise(d));
        else expect(plainText(out)).toBe(flat.slice(0, from) + repl + flat.slice(to));
      }),
    );
    const d = richFromText('abc');
    expect(replaceSpan(d, 2, 9, 'x')).toEqual(normalise(d));
    expect(replaceSpan(d, -1, 2, 'x')).toEqual(normalise(d));
  });
});

describe('text algebra — format presets (PRD §22 Text)', () => {
  test('TEXT-ALG upper and lower project to toLocaleUpperCase / toLocaleLowerCase', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        expect(plainText(format(d, 'upper'))).toBe(plainText(d).toLocaleUpperCase());
        expect(plainText(format(d, 'lower'))).toBe(plainText(d).toLocaleLowerCase());
      }),
    );
  });

  test('TEXT-ALG every preset keeps each run its marks (ß → SS lengthens a run, never moves a mark)', () => {
    fc.assert(
      fc.property(
        arbDoc,
        fc.constantFrom('upper', 'lower', 'titleCase', 'trimmed' as const),
        (d, kind) => {
          const out = format(d, kind);
          checkDoc(out);
          // The multiset of mark sets in use cannot grow: no run gains a mark it did not have.
          const before = new Set(charMarks(d).map((m) => (m === null ? '\n' : JSON.stringify(m))));
          for (const m of charMarks(out)) {
            expect(before.has(m === null ? '\n' : JSON.stringify(m))).toBe(true);
          }
        },
      ),
    );
  });

  test('titleCase capitalises across a mark boundary and lowercases the rest', () => {
    const d = docNode([
      paragraphNode([textNode('hELLO w', [bold]), textNode('ORLD again', [italic])]),
    ]);
    expect(format(d, 'titleCase')).toEqual(
      docNode([paragraphNode([textNode('Hello W', [bold]), textNode('orld Again', [italic])])]),
    );
  });

  test('titleCase is locale-aware', () => {
    expect(plainText(format(richFromText('istanbul'), 'titleCase', 'tr'))).toBe('İstanbul');
  });

  test('trimmed strips the ends of every paragraph, dropping whitespace-only runs', () => {
    const d = docNode([
      paragraphNode([textNode('  ', [bold]), textNode(' a b ', [italic]), textNode('  ')]),
      paragraphNode([textNode('\t c ')]),
    ]);
    expect(format(d, 'trimmed')).toEqual(
      docNode([paragraphNode([textNode('a b', [italic])]), paragraphNode([textNode('c')])]),
    );
  });
});

describe('marksAt', () => {
  test('returns the marks of the character at the offset, else the one before', () => {
    const d = docNode([paragraphNode([textNode('ab', [bold]), textNode('cd')])]);
    expect(marksAt(d, 0)).toEqual([bold]);
    expect(marksAt(d, 1)).toEqual([bold]);
    expect(marksAt(d, 2)).toEqual([]);
    expect(marksAt(d, 4)).toEqual([]);
  });
});
