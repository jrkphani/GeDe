/**
 * The hierarchy chords (KEYS-06, HIER-01, HIER-06, I18N-02): `⌘]` nests,
 * `⌘[` promotes, `⌥←` collapses and `⌥→` expands the selected row. They
 * resolve from `event.code` — `BracketRight` / `BracketLeft` are the same
 * physical keys on Tamil99, InScript and Remington — and they are handled on
 * the focused cell (the grid keydown path), not the window, because they act
 * on the selected row and must stay out of the cell editor.
 *
 * `⌘]` / `⌘[` are the handover's (`docs/handover/reference/shortcuts.md`).
 * `⌥←` / `⌥→` are not in that map: the chevron is a button a pointer can
 * press, and A11Y-01 needs a route to it with the mouse unplugged that does
 * not add a tab stop per parent row to the roving-tabindex grid.
 *
 * Shaped like `CHORDS` / `ARIA_KEYS` / `LABELS` in `doc/shortcuts.ts` so the
 * shortcut sheet can fold them in without translation.
 */
import { isApplePlatform, matchesChord, type Chord } from '../../../doc/shortcuts.js';

export type HierarchyKey = 'nest' | 'promote' | 'collapse' | 'expand';

export const HIER_CHORDS = {
  nest: { code: 'BracketRight', mod: true } satisfies Chord,
  promote: { code: 'BracketLeft', mod: true } satisfies Chord,
  collapse: { code: 'ArrowLeft', alt: true } satisfies Chord,
  expand: { code: 'ArrowRight', alt: true } satisfies Chord,
} as const;

export const HIER_ARIA_KEYS = {
  nest: 'Meta+BracketRight',
  promote: 'Meta+BracketLeft',
  collapse: 'Alt+ArrowLeft',
  expand: 'Alt+ArrowRight',
} as const satisfies Record<HierarchyKey, string>;

export const HIER_LABELS = {
  nest: '⌘]',
  promote: '⌘[',
  collapse: '⌥←',
  expand: '⌥→',
} as const satisfies Record<HierarchyKey, string>;

const ORDER: readonly HierarchyKey[] = ['nest', 'promote', 'collapse', 'expand'];

/** Which hierarchy chord this keydown is, or null. Modifiers must match exactly. */
export function hierarchyKey(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  apple: boolean = isApplePlatform(),
): HierarchyKey | null {
  return ORDER.find((key) => matchesChord(event, HIER_CHORDS[key], apple)) ?? null;
}
