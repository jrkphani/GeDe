import { describe, expect, it } from 'vitest';

import { hasMarkThroughout, toggleMarkThroughout } from './marks.js';
import { docNode, EMPTY_DOC, paragraphNode, textNode } from './types.js';

const plain = docNode([paragraphNode([textNode('Base '), textNode('camp')])]);
const halfBold = docNode([
  paragraphNode([textNode('Base ', [{ type: 'bold' }]), textNode('camp')]),
]);

describe('whole-cell marks', () => {
  it('KEYS-05 INSP-06 (partial: inline marks only) toggles a mark on when any text lacks it, off when all text has it', () => {
    const bold = toggleMarkThroughout(plain, 'bold');
    expect(hasMarkThroughout(bold, 'bold')).toBe(true);
    expect(bold.content[0]?.content).toEqual([textNode('Base camp', [{ type: 'bold' }])]);
    // Partly bold → fully bold (the editor's rule), then off.
    expect(hasMarkThroughout(toggleMarkThroughout(halfBold, 'bold'), 'bold')).toBe(true);
    expect(toggleMarkThroughout(bold, 'bold')).toEqual(
      docNode([paragraphNode([textNode('Base camp')])]),
    );
  });

  it('KEYS-05 superscript and subscript exclude each other', () => {
    const sup = toggleMarkThroughout(plain, 'superscript');
    const sub = toggleMarkThroughout(sup, 'subscript');
    expect(hasMarkThroughout(sub, 'subscript')).toBe(true);
    expect(hasMarkThroughout(sub, 'superscript')).toBe(false);
  });

  it('KEYS-05 keeps other marks and leaves an empty document alone', () => {
    const italic = toggleMarkThroughout(
      docNode([paragraphNode([textNode('x', [{ type: 'italic' }])])]),
      'bold',
    );
    expect(italic.content[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }, { type: 'italic' }]);
    expect(hasMarkThroughout(EMPTY_DOC, 'bold')).toBe(false);
    expect(toggleMarkThroughout(EMPTY_DOC, 'bold')).toEqual(EMPTY_DOC);
  });
});
