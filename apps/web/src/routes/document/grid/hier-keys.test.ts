import { describe, expect, it } from 'vitest';

import { matchesChord, CHORDS } from '../../../doc/shortcuts.js';
import { HIER_ARIA_KEYS, HIER_CHORDS, HIER_LABELS, hierarchyKey } from './hier-keys.js';

const key = (
  code: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('hierarchy chords (KEYS-06, I18N-02)', () => {
  it('KEYS-06 I18N-02 ⌘] nests and ⌘[ promotes by physical key: ⌘ on Apple, Ctrl elsewhere, never the produced character', () => {
    expect(hierarchyKey(key('BracketRight', { metaKey: true }), true)).toBe('nest');
    expect(hierarchyKey(key('BracketLeft', { metaKey: true }), true)).toBe('promote');
    expect(hierarchyKey(key('BracketRight', { ctrlKey: true }), false)).toBe('nest');
    expect(hierarchyKey(key('BracketLeft', { ctrlKey: true }), false)).toBe('promote');
    // The wrong modifier for the platform, an extra modifier, or no modifier: nothing.
    expect(hierarchyKey(key('BracketRight', { ctrlKey: true }), true)).toBeNull();
    expect(hierarchyKey(key('BracketRight', { metaKey: true }), false)).toBeNull();
    expect(hierarchyKey(key('BracketRight', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(hierarchyKey(key('BracketRight'), true)).toBeNull();
  });

  it('HIER-06 ⌥← collapses and ⌥→ expands, and neither collides with the shell’s ⌥⌘↓ / ⌥⌘→', () => {
    expect(hierarchyKey(key('ArrowLeft', { altKey: true }), true)).toBe('collapse');
    expect(hierarchyKey(key('ArrowRight', { altKey: true }), true)).toBe('expand');
    const addColumn = key('ArrowRight', { altKey: true, metaKey: true });
    expect(hierarchyKey(addColumn, true)).toBeNull();
    expect(matchesChord(addColumn, CHORDS.addColumn, true)).toBe(true);
    expect(hierarchyKey(key('ArrowRight'), true)).toBeNull();
  });

  it('KEYS-08 (partial: the panel that shows them beside the commands mounts in the integration PR) every chord has an aria-keyshortcuts token and a glyph label', () => {
    for (const name of Object.keys(HIER_CHORDS) as (keyof typeof HIER_CHORDS)[]) {
      expect(HIER_ARIA_KEYS[name]).toMatch(/^(Meta|Alt)\+/);
      expect(HIER_LABELS[name]).toMatch(/^[⌘⌥]/);
    }
  });
});
