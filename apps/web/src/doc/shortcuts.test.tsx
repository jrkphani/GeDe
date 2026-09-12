import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHORDS,
  isApplePlatform,
  matchesChord,
  useShortcuts,
  type ShortcutBinding,
} from './shortcuts.js';

function Harness({ bindings }: { bindings: readonly ShortcutBinding[] }) {
  useShortcuts(bindings);
  return <input aria-label="A field" />;
}

const key = (init: KeyboardEventInit) =>
  fireEvent.keyDown(window, { bubbles: true, cancelable: true, ...init });

describe('shortcuts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('I18N-02 chords resolve from event.code, never event.key', () => {
    const apple = true;
    // Tamil99 produces a Tamil letter for the physical Z key; the code is still KeyZ.
    expect(
      matchesChord(
        { code: 'KeyZ', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        CHORDS.undo,
        apple,
      ),
    ).toBe(true);
    expect(
      matchesChord(
        { code: 'KeyY', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        CHORDS.undo,
        apple,
      ),
    ).toBe(false);
    // ⌘0 and ⇧⌘0 are different commands.
    expect(
      matchesChord(
        { code: 'Digit0', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        CHORDS.fit,
        apple,
      ),
    ).toBe(false);
    expect(
      matchesChord(
        { code: 'Digit0', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        CHORDS.fit,
        apple,
      ),
    ).toBe(true);
    // On Windows/Linux `mod` is Ctrl, and ⌃⇥ stays Ctrl.
    expect(
      matchesChord(
        { code: 'Equal', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
        CHORDS.zoomIn,
        false,
      ),
    ).toBe(true);
    expect(
      matchesChord(
        { code: 'Tab', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
        CHORDS.nextSheet,
        false,
      ),
    ).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe(false);
  });

  it('KEYS-07 one keydown listener dispatches ⌘+ ⌘− ⌘0 ⇧⌘0 ⌃⇥ ⌥⌘I from the map and prevents default', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    const calls: string[] = [];
    const bind = (id: keyof typeof CHORDS): ShortcutBinding => ({
      id,
      chord: CHORDS[id],
      label: id,
      run: () => calls.push(id),
    });
    render(
      <Harness
        bindings={[
          bind('fit'),
          bind('actualSize'),
          bind('zoomIn'),
          bind('zoomOut'),
          bind('previousSheet'),
          bind('nextSheet'),
          bind('inspector'),
        ]}
      />,
    );
    key({ code: 'Equal', metaKey: true });
    key({ code: 'NumpadSubtract', metaKey: true });
    key({ code: 'Digit0', metaKey: true });
    key({ code: 'Digit0', metaKey: true, shiftKey: true });
    key({ code: 'Tab', ctrlKey: true });
    key({ code: 'Tab', ctrlKey: true, shiftKey: true });
    key({ code: 'KeyI', metaKey: true, altKey: true });
    key({ code: 'KeyI', metaKey: true }); // no binding: ignored
    expect(calls).toEqual([
      'zoomIn',
      'zoomOut',
      'actualSize',
      'fit',
      'nextSheet',
      'previousSheet',
      'inspector',
    ]);
    const event = new KeyboardEvent('keydown', {
      code: 'Equal',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('I18N-01 nothing fires while an IME is composing, and chords stay out of text fields unless they opt in', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    const calls: string[] = [];
    const { getByLabelText } = render(
      <Harness
        bindings={[
          { id: 'esc', chord: CHORDS.escape, label: 'Esc', run: () => calls.push('esc') },
          {
            id: 'zoom',
            chord: CHORDS.zoomIn,
            label: '⌘+',
            run: () => calls.push('zoom'),
            inEditors: true,
          },
        ]}
      />,
    );
    key({ code: 'Escape', isComposing: true });
    expect(calls).toEqual([]);
    const field = getByLabelText('A field');
    fireEvent.keyDown(field, { code: 'Escape', bubbles: true });
    fireEvent.keyDown(field, { code: 'Equal', metaKey: true, bubbles: true });
    expect(calls).toEqual(['zoom']);
    key({ code: 'Escape' });
    expect(calls).toEqual(['zoom', 'esc']);
  });
});
