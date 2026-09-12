import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { Direction, EditSeed } from '../../doc/selection.js';

export interface CellEditorProps {
  /** The cell's current text; the seed decides whether the editor starts from it. */
  initial: string;
  /** GRID-04: `existing` edits the text in place; `overwrite` starts from the typed character. */
  seed: EditSeed;
  address: string | undefined;
  onCommit: (value: string, then: Direction | null) => void;
  onCancel: () => void;
}

/**
 * The cell editor (GRID-04, GRID-06, I18N-01): a textarea drawn as the cell so
 * newlines survive a round trip (⇧⏎ adds one). Enter commits and moves down,
 * Tab right, ⇧Tab left; Escape cancels; blur commits in place. When the edit
 * began by typing, the arrows commit too and move that way, as in Numbers.
 * None of it fires while an IME is composing. Shortcuts resolve from
 * `event.code` (I18N-02).
 */
export function CellEditor({ initial, seed, address, onCommit, onCancel }: CellEditorProps) {
  const [value, setValue] = useState(seed.kind === 'overwrite' ? seed.text : initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const el = ref.current;
    if (el !== null) {
      el.focus();
      // Caret at the end: an overwrite continues the word, an edit appends to it.
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // GRID-06: blur commits. Selecting another cell (or switching sheet) unmounts the
    // editor before the browser blurs it, so the draft commits here unless already
    // finished. Deferred one microtask so StrictMode's mount → unmount → mount rehearsal
    // (which remounts synchronously) does not commit.
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (mounted.current || done.current) return;
        done.current = true;
        latest.current.onCommit(latest.current.value, null);
      });
    };
  }, []);

  const finish = (then: Direction | null | 'cancel') => {
    if (done.current) return;
    done.current = true;
    if (then === 'cancel') onCancel();
    else onCommit(value, then);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // The editor owns its keys; the cell beneath must not see them (⇧⏎ is a newline here).
    e.stopPropagation();
    // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        if (e.shiftKey) return; // newline
        e.preventDefault();
        finish('down');
        return;
      case 'Tab':
        e.preventDefault();
        finish(e.shiftKey ? 'left' : 'right');
        return;
      case 'Escape':
        e.preventDefault();
        finish('cancel');
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        if (seed.kind !== 'overwrite') return; // caret movement inside an existing edit
        e.preventDefault();
        finish(
          e.code === 'ArrowUp'
            ? 'up'
            : e.code === 'ArrowDown'
              ? 'down'
              : e.code === 'ArrowLeft'
                ? 'left'
                : 'right',
        );
        return;
      default:
        return;
    }
  };

  return (
    <textarea
      ref={ref}
      rows={1}
      className="gd-cell__editor"
      aria-label={address === undefined ? 'Cell' : `Edit ${address}`}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        finish(null);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      spellCheck={false}
    />
  );
}
