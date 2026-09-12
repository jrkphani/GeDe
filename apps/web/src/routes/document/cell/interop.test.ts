/**
 * `@gede/core`'s fragment codec must agree with y-prosemirror's own, since
 * the live editor writes through y-prosemirror and everything else (the
 * renderer, the algebra, the sync service) reads through core.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import {
  docNode,
  fragmentToRich,
  HIGHLIGHT_TOKENS,
  normalise,
  paragraphNode,
  richToFragment,
  TEXT_COLOUR_TOKENS,
  textNode,
  TOGGLE_MARKS,
  type Mark,
  type RichDoc,
} from '@gede/core';

import { editorSchema } from './schema.js';

const arbMark: fc.Arbitrary<Mark> = fc.oneof(
  fc.constantFrom(...TOGGLE_MARKS).map((type): Mark => ({ type })),
  fc.constant<Mark>({ type: 'link', attrs: { href: 'https://gede.work' } }),
  fc
    .constantFrom(...TEXT_COLOUR_TOKENS)
    .map((token): Mark => ({ type: 'textColour', attrs: { token } })),
  fc
    .constantFrom(...HIGHLIGHT_TOKENS)
    .map((token): Mark => ({ type: 'highlight', attrs: { token } })),
);
const arbMarks = fc
  .uniqueArray(arbMark, { maxLength: 3, selector: (m) => m.type })
  .map((marks) =>
    marks.some((m) => m.type === 'superscript')
      ? marks.filter((m) => m.type !== 'subscript')
      : marks,
  );
const arbText = fc.string({
  unit: fc.constantFrom('a', 'b', ' ', 'த'),
  minLength: 1,
  maxLength: 4,
});
const arbDoc: fc.Arbitrary<RichDoc> = fc
  .array(
    fc
      .array(fc.record({ text: arbText, marks: arbMarks }), { maxLength: 3 })
      .map((nodes) => paragraphNode(nodes.map((n) => textNode(n.text, n.marks)))),
    { minLength: 1, maxLength: 3 },
  )
  .map((ps) => normalise(docNode(ps)));

/** y-prosemirror emits `attrs: {}` for attribute-less marks; core omits it. Normalise both sides. */
function canon(json: unknown): RichDoc {
  return normalise(json as RichDoc);
}

describe('fragment codec ↔ y-prosemirror', () => {
  test('a fragment written by core reads identically through y-prosemirror', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const fragment = richToFragment(d);
        new Y.Doc().getMap('cells').set('k', fragment);
        expect(canon(yXmlFragmentToProseMirrorRootNode(fragment, editorSchema).toJSON())).toEqual(
          d,
        );
      }),
    );
  });

  test('a fragment written by y-prosemirror reads identically through core', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const fragment = new Y.XmlFragment();
        new Y.Doc().getMap('cells').set('k', fragment);
        prosemirrorJSONToYXmlFragment(editorSchema, d, fragment);
        expect(fragmentToRich(fragment)).toEqual(d);
      }),
    );
  });

  test('the editor schema accepts every document core produces', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        expect(() => {
          editorSchema.nodeFromJSON(d).check();
        }).not.toThrow();
      }),
    );
  });
});
