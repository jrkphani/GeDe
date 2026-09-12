import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { fragmentText, textFragment } from '../doc/schema.js';
import { checkDoc } from './schema.js';
import {
  docNode,
  EMPTY_DOC,
  HIGHLIGHT_TOKENS,
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
import { fragmentToRich, richToFragment, writeRich } from './yjs.js';

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
  unit: fc.constantFrom('a', 'b', ' ', 'த', 'é'),
  minLength: 1,
  maxLength: 5,
});
const arbDoc: fc.Arbitrary<RichDoc> = fc
  .array(
    fc
      .array(fc.record({ text: arbText, marks: arbMarks }), { maxLength: 3 })
      .map((nodes) => paragraphNode(nodes.map((n) => textNode(n.text, n.marks)))),
    { minLength: 1, maxLength: 3 },
  )
  .map((ps) => normalise(docNode(ps)));

/** Integrate a prelim fragment so it can be read back. */
function integrate(fragment: Y.XmlFragment): Y.XmlFragment {
  const doc = new Y.Doc();
  doc.getMap('cells').set('k', fragment);
  return fragment;
}

describe('rich text ↔ Y.XmlFragment (ARCHITECTURE §1.5.3)', () => {
  test('DOC-05 a document round-trips through a fragment with every mark intact', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const back = fragmentToRich(integrate(richToFragment(d)));
        checkDoc(back);
        expect(back).toEqual(d);
      }),
    );
  });

  test('the fragment layout is one paragraph element holding one text per paragraph', () => {
    const fragment = integrate(
      richToFragment(
        docNode([
          paragraphNode([textNode('a', [{ type: 'bold' }]), textNode('b')]),
          paragraphNode(),
        ]),
      ),
    );
    const [p1, p2] = fragment.toArray();
    expect(p1).toBeInstanceOf(Y.XmlElement);
    expect((p1 as Y.XmlElement).nodeName).toBe('paragraph');
    expect((p1 as Y.XmlElement).length).toBe(1);
    const xmlText = (p1 as Y.XmlElement).get(0);
    expect(xmlText).toBeInstanceOf(Y.XmlText);
    expect((xmlText as Y.XmlText).toDelta()).toEqual([
      { insert: 'a', attributes: { bold: {} } },
      { insert: 'b' },
    ]);
    expect((p2 as Y.XmlElement).length).toBe(0);
  });

  test('marks are stored as text attributes keyed by mark name with the attrs as value', () => {
    const fragment = integrate(
      richToFragment(
        docNode([
          paragraphNode([
            textNode('x', [
              { type: 'link', attrs: { href: 'https://a' } },
              { type: 'highlight', attrs: { token: 'forest' } },
            ]),
          ]),
        ]),
      ),
    );
    const xmlText = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(xmlText.toDelta()).toEqual([
      { insert: 'x', attributes: { link: { href: 'https://a' }, highlight: { token: 'forest' } } },
    ]);
  });

  test('Wave 1 plain-text fragments read as unmarked documents and vice versa', () => {
    const wave1 = integrate(textFragment('one\ntwo'));
    expect(fragmentToRich(wave1)).toEqual(richFromText('one\ntwo'));
    const rich = integrate(richToFragment(richFromText('one\ntwo')));
    expect(fragmentText(rich)).toBe('one\ntwo');
  });

  test('an unknown mark attribute written by a newer client is dropped, not crashed on', () => {
    const doc = new Y.Doc();
    const fragment = new Y.XmlFragment();
    doc.getMap('cells').set('k', fragment);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    fragment.insert(0, [p]);
    p.insert(0, [t]);
    t.applyDelta([{ insert: 'hi', attributes: { bold: {}, glow: { level: 3 } } }]);
    expect(fragmentToRich(fragment)).toEqual(
      docNode([paragraphNode([textNode('hi', [{ type: 'bold' }])])]),
    );
  });

  test('a y-prosemirror overlapping-mark key (`name--hash`) reads as the mark', () => {
    const doc = new Y.Doc();
    const fragment = new Y.XmlFragment();
    doc.getMap('cells').set('k', fragment);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    fragment.insert(0, [p]);
    p.insert(0, [t]);
    t.applyDelta([{ insert: 'hi', attributes: { 'italic--abc123': {} } }]);
    expect(fragmentToRich(fragment)).toEqual(
      docNode([paragraphNode([textNode('hi', [{ type: 'italic' }])])]),
    );
  });

  test('writeRich replaces an integrated fragment in place inside one transaction', () => {
    const doc = new Y.Doc();
    const fragment = integrate(richToFragment(richFromText('old')));
    let transactions = 0;
    fragment.doc?.on('afterTransaction', () => {
      transactions += 1;
    });
    fragment.doc?.transact(() => {
      writeRich(fragment, docNode([paragraphNode([textNode('new', [{ type: 'italic' }])])]));
    });
    expect(transactions).toBe(1);
    expect(plainText(fragmentToRich(fragment))).toBe('new');
    expect(fragmentToRich(fragment).content[0]?.content?.[0]?.marks).toEqual([{ type: 'italic' }]);
    expect(doc).toBeDefined();
  });

  test('an empty fragment is the empty document', () => {
    const fragment = new Y.XmlFragment();
    new Y.Doc().getMap('cells').set('k', fragment);
    expect(fragmentToRich(fragment)).toEqual(EMPTY_DOC);
  });
});
