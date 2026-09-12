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

/** Does this event match the chord? Modifiers must match exactly so ⌘0 and ⇧⌘0 differ. */
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
  return (
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.shiftKey === (chord.shift === true) &&
    event.altKey === (chord.alt === true)
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
        event.preventDefault();
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

/** The chords this shell binds (subset of `docs/handover/reference/shortcuts.md`). */
export const CHORDS = {
  zoomIn: { code: ['Equal', 'NumpadAdd'], mod: true } satisfies Chord,
  zoomOut: { code: ['Minus', 'NumpadSubtract'], mod: true } satisfies Chord,
  actualSize: { code: ['Digit0', 'Numpad0'], mod: true } satisfies Chord,
  fit: { code: ['Digit0', 'Numpad0'], mod: true, shift: true } satisfies Chord,
  nextSheet: { code: 'Tab', ctrl: true } satisfies Chord,
  previousSheet: { code: 'Tab', ctrl: true, shift: true } satisfies Chord,
  inspector: { code: 'KeyI', mod: true, alt: true } satisfies Chord,
  addRow: { code: 'ArrowDown', mod: true, alt: true } satisfies Chord,
  addColumn: { code: 'ArrowRight', mod: true, alt: true } satisfies Chord,
  escape: { code: 'Escape' } satisfies Chord,
  undo: { code: 'KeyZ', mod: true } satisfies Chord,
  redo: { code: 'KeyZ', mod: true, shift: true } satisfies Chord,
} as const;

export const LABELS = {
  zoomIn: '⌘+',
  zoomOut: '⌘−',
  actualSize: '⌘0',
  fit: '⇧⌘0',
  nextSheet: '⌃⇥',
  previousSheet: '⌃⇧⇥',
  inspector: '⌥⌘I',
  addRow: '⌥⌘↓',
  addColumn: '⌥⌘→',
  escape: 'Esc',
  undo: '⌘Z',
  redo: '⇧⌘Z',
} as const satisfies Record<keyof typeof CHORDS, string>;
