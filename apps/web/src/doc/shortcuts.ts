/**
 * Keyboard shortcuts (KEYS, I18N-02). Every chord resolves from `event.code`
 * — the physical key — never `event.key`, so ⌘+ is the same key on Tamil99,
 * InScript and Remington. One `keydown` listener serves the whole map; Wave 2
 * extends the map rather than adding listeners.
 *
 * `mod` is ⌘ on Apple platforms and Ctrl elsewhere. Chords never fire while an
 * IME is composing, and stay out of text fields unless the binding opts in —
 * the cell editor and the title field handle their own keys.
 */
import { useEffect, useRef } from 'react';

export interface Chord {
  /** One or more `KeyboardEvent.code` values, e.g. `['Equal', 'NumpadAdd']`. */
  readonly code: string | readonly string[];
  readonly mod?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
}

export interface ShortcutBinding {
  readonly id: string;
  readonly chord: Chord;
  /** Human label beside the command, e.g. "⌘+" (KEYS-08). */
  readonly label: string;
  readonly run: (event: KeyboardEvent) => void;
  /** Fire even when focus sits in a text field. Default false. */
  readonly inEditors?: boolean | undefined;
  /** Skip without preventing default. */
  readonly disabled?: boolean | undefined;
  /**
   * Run without preventing the browser's default: the chord's default action is
   * the route (⌥⇧⌘V lets the browser raise its `paste` event), the handler only
   * arms what that route should do.
   */
  readonly passive?: boolean | undefined;
}

export function isApplePlatform(userAgent: string = navigator.userAgent): boolean {
  return /Macintosh|Mac OS X|iPhone|iPad|iPod/.test(userAgent);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Does this event match the chord? Modifiers must match exactly so ⌘0 and ⇧⌘0
 * differ. Off Apple platforms `mod` is Ctrl, so a chord that wants both ⌘ and
 * ⌃ (`⌃⌘+` superscript) would collide with the one that wants ⌘ alone (`⌘+`
 * zoom): there, ⌃⌘ is spelled Ctrl+Alt (ADR-042, #136).
 */
export function matchesChord(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  chord: Chord,
  apple: boolean,
): boolean {
  const codes = typeof chord.code === 'string' ? [chord.code] : chord.code;
  if (!codes.includes(event.code)) return false;
  const wantsMod = chord.mod === true;
  const wantsCtrl = chord.ctrl === true;
  const meta = apple ? wantsMod : false;
  const ctrl = apple ? wantsCtrl : wantsMod || wantsCtrl;
  const alt = chord.alt === true || (!apple && wantsMod && wantsCtrl);
  return (
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.shiftKey === (chord.shift === true) &&
    event.altKey === alt
  );
}

export function useShortcuts(bindings: readonly ShortcutBinding[]): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    const apple = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
      if (event.isComposing || event.keyCode === 229) return;
      if (event.defaultPrevented) return;
      const editable = isEditableTarget(event.target);
      for (const binding of ref.current) {
        if (binding.disabled === true) continue;
        if (editable && binding.inEditors !== true) continue;
        if (!matchesChord(event, binding.chord, apple)) continue;
        if (binding.passive !== true) event.preventDefault();
        binding.run(event);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/**
 * The chords this shell binds — every modifier chord in
 * `docs/handover/reference/shortcuts.md` (KEYS-02..07). The shortcut sheet
 * (KEYS-01) and the handler both read `routes/document/keys/shortcut-map.ts`,
 * which maps each of these ids to its group and action, so the two cannot drift.
 */
export const CHORDS = {
  // Document (KEYS-02)
  newWorkscape: { code: 'KeyN', mod: true } satisfies Chord,
  open: { code: 'KeyO', mod: true } satisfies Chord,
  print: { code: 'KeyP', mod: true } satisfies Chord,
  close: { code: 'KeyW', mod: true } satisfies Chord,
  // `?` is Shift+/ on the reference layout; the physical key is what counts (I18N-02).
  shortcutSheet: { code: 'Slash', shift: true } satisfies Chord,
  // Edit (KEYS-03). Cut, copy and paste ride the browser's own clipboard events
  // (`keys/useClipboard.ts`); the chords here name them for the sheet and menus.
  undo: { code: 'KeyZ', mod: true } satisfies Chord,
  redo: { code: 'KeyZ', mod: true, shift: true } satisfies Chord,
  cut: { code: 'KeyX', mod: true } satisfies Chord,
  copy: { code: 'KeyC', mod: true } satisfies Chord,
  paste: { code: 'KeyV', mod: true } satisfies Chord,
  pasteMatchStyle: { code: 'KeyV', mod: true, alt: true, shift: true } satisfies Chord,
  selectAll: { code: 'KeyA', mod: true } satisfies Chord,
  clear: { code: ['Backspace', 'Delete'] } satisfies Chord,
  // Find (KEYS-04): ⌘F · ⌥⌘F · ⌘G · ⇧⌘G; Esc closes the bar through `escape`.
  find: { code: 'KeyF', mod: true } satisfies Chord,
  findReplace: { code: 'KeyF', mod: true, alt: true } satisfies Chord,
  findNext: { code: 'KeyG', mod: true } satisfies Chord,
  findPrevious: { code: 'KeyG', mod: true, shift: true } satisfies Chord,
  // Format (KEYS-05). The inline marks live in `cell/marks.ts` (MARK_CHORDS).
  formatInspector: { code: ['Digit1', 'Numpad1'], mod: true, alt: true } satisfies Chord,
  organizeInspector: { code: ['Digit2', 'Numpad2'], mod: true, alt: true } satisfies Chord,
  // Table and cells (KEYS-06)
  addRow: { code: 'ArrowDown', mod: true, alt: true } satisfies Chord,
  addColumn: { code: 'ArrowRight', mod: true, alt: true } satisfies Chord,
  // The hierarchy chords mirror `routes/document/grid/hier-keys.ts` (HIER_CHORDS); the
  // shortcut-map test pins the two tables equal. ⌥← / ⌥→ are not in the handover map —
  // ADR-025 / ADR-030 record why they exist and why the plain ⌥ is kept.
  nest: { code: 'BracketRight', mod: true } satisfies Chord,
  promote: { code: 'BracketLeft', mod: true } satisfies Chord,
  collapse: { code: 'ArrowLeft', alt: true } satisfies Chord,
  expand: { code: 'ArrowRight', alt: true } satisfies Chord,
  escape: { code: 'Escape' } satisfies Chord,
  // View (KEYS-07)
  zoomIn: { code: ['Equal', 'NumpadAdd'], mod: true } satisfies Chord,
  zoomOut: { code: ['Minus', 'NumpadSubtract'], mod: true } satisfies Chord,
  actualSize: { code: ['Digit0', 'Numpad0'], mod: true } satisfies Chord,
  fit: { code: ['Digit0', 'Numpad0'], mod: true, shift: true } satisfies Chord,
  inspector: { code: 'KeyI', mod: true, alt: true } satisfies Chord,
  nextSheet: { code: 'Tab', ctrl: true } satisfies Chord,
  previousSheet: { code: 'Tab', ctrl: true, shift: true } satisfies Chord,
  // Not in the handover map (ADR-042): Tab never leaves a table forward (past the last
  // cell it appends a row, GRID-05), so these move focus to the sheet's next or previous
  // object — a table, a graph — without a pointer (A11Y-01, #131). ⇧⌘, not ⌃⌥: off Apple
  // platforms ⌃⌥→ is the same keys as ⌥⌘→ (add column), since `mod` is Ctrl there.
  nextObject: { code: 'ArrowRight', mod: true, shift: true } satisfies Chord,
  previousObject: { code: 'ArrowLeft', mod: true, shift: true } satisfies Chord,
} as const;

export type ChordId = keyof typeof CHORDS;

/**
 * `aria-keyshortcuts` values (WAI-ARIA 1.2 key tokens, physical keys, `Meta`
 * for ⌘); the glyph labels below are for eyes, these are for assistive tech.
 */
export const ARIA_KEYS = {
  newWorkscape: 'Meta+N',
  open: 'Meta+O',
  print: 'Meta+P',
  close: 'Meta+W',
  shortcutSheet: 'Shift+/',
  undo: 'Meta+Z',
  redo: 'Shift+Meta+Z',
  cut: 'Meta+X',
  copy: 'Meta+C',
  paste: 'Meta+V',
  pasteMatchStyle: 'Alt+Shift+Meta+V',
  selectAll: 'Meta+A',
  clear: 'Backspace',
  find: 'Meta+F',
  findReplace: 'Alt+Meta+F',
  findNext: 'Meta+G',
  findPrevious: 'Shift+Meta+G',
  formatInspector: 'Alt+Meta+1',
  organizeInspector: 'Alt+Meta+2',
  addRow: 'Alt+Meta+ArrowDown',
  addColumn: 'Alt+Meta+ArrowRight',
  nest: 'Meta+BracketRight',
  promote: 'Meta+BracketLeft',
  collapse: 'Alt+ArrowLeft',
  expand: 'Alt+ArrowRight',
  escape: 'Escape',
  zoomIn: 'Meta+Equal',
  zoomOut: 'Meta+Minus',
  actualSize: 'Meta+0',
  fit: 'Shift+Meta+0',
  inspector: 'Alt+Meta+I',
  nextSheet: 'Control+Tab',
  previousSheet: 'Control+Shift+Tab',
  nextObject: 'Shift+Meta+ArrowRight',
  previousObject: 'Shift+Meta+ArrowLeft',
} as const satisfies Record<ChordId, string>;

export const LABELS = {
  newWorkscape: '⌘N',
  open: '⌘O',
  print: '⌘P',
  close: '⌘W',
  shortcutSheet: '?',
  undo: '⌘Z',
  redo: '⇧⌘Z',
  cut: '⌘X',
  copy: '⌘C',
  paste: '⌘V',
  pasteMatchStyle: '⌥⇧⌘V',
  selectAll: '⌘A',
  clear: '⌫',
  find: '⌘F',
  findReplace: '⌥⌘F',
  findNext: '⌘G',
  findPrevious: '⇧⌘G',
  formatInspector: '⌥⌘1',
  organizeInspector: '⌥⌘2',
  addRow: '⌥⌘↓',
  addColumn: '⌥⌘→',
  nest: '⌘]',
  promote: '⌘[',
  collapse: '⌥←',
  expand: '⌥→',
  escape: 'Esc',
  zoomIn: '⌘+',
  zoomOut: '⌘−',
  actualSize: '⌘0',
  fit: '⇧⌘0',
  inspector: '⌥⌘I',
  nextSheet: '⌃⇥',
  previousSheet: '⌃⇧⇥',
  nextObject: '⇧⌘→',
  previousObject: '⇧⌘←',
} as const satisfies Record<ChordId, string>;
