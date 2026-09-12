import { describe, expect, test } from 'vitest';

import { checkDoc, isValidDoc, richSchema } from './schema.js';
import { docNode, normalise, paragraphNode, textNode, toMark, type RichDoc } from './types.js';

describe('rich text schema (PRD §3, §20)', () => {
  test('INSP-06 the schema carries the six inline marks, link, text colour and highlight', () => {
    expect(Object.keys(richSchema.marks).sort()).toEqual(
      [
        'bold',
        'italic',
        'underline',
        'strikethrough',
        'superscript',
        'subscript',
        'link',
        'textColour',
        'highlight',
      ].sort(),
    );
    expect(Object.keys(richSchema.nodes).sort()).toEqual(['doc', 'paragraph', 'text']);
  });

  test('superscript and subscript exclude each other', () => {
    const sup = richSchema.marks.superscript;
    const sub = richSchema.marks.subscript;
    expect(sup.excludes(sub)).toBe(true);
    expect(sub.excludes(sup)).toBe(true);
    expect(sup.excludes(sup)).toBe(true); // a mark never overlaps itself: y-prosemirror keys it by name
  });

  test('colour marks accept token names only, never a colour value', () => {
    const named: RichDoc = docNode([
      paragraphNode([
        textNode('a', [{ type: 'textColour', attrs: { token: 'danger' } }]),
        textNode('b', [{ type: 'highlight', attrs: { token: 'amber' } }]),
      ]),
    ]);
    expect(() => {
      checkDoc(named);
    }).not.toThrow();
    const hex = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [{ type: 'textColour', attrs: { token: '#b42318' } }],
            },
          ],
        },
      ],
    } as unknown as RichDoc;
    expect(() => {
      checkDoc(hex);
    }).toThrow(RangeError);
    // `toMark` drops it, so `normalise` never lets it reach the fragment.
    expect(toMark({ type: 'highlight', attrs: { token: 'yellow' } })).toBeNull();
    expect(normalise(hex).content[0]?.content?.[0]?.marks).toBeUndefined();
  });

  test('toDOM specs are the array form and never touch the DOM', () => {
    const link = richSchema.marks.link.create({ href: 'https://gede.work' });
    expect(richSchema.marks.link.spec.toDOM?.(link, true)).toEqual([
      'a',
      { href: 'https://gede.work', rel: 'noopener noreferrer', tabindex: '-1' },
      0,
    ]);
    expect(richSchema.marks.bold.spec.toDOM?.(richSchema.marks.bold.create(), true)).toEqual([
      'strong',
      0,
    ]);
  });

  test('isValidDoc tolerates empty text nodes by normalising first', () => {
    expect(isValidDoc(docNode([paragraphNode([textNode('')])]))).toBe(true);
    expect(isValidDoc({ type: 'doc', content: [] })).toBe(true);
  });
});
