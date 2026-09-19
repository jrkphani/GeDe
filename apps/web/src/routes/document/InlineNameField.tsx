import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { announce } from '../../announce.js';
import type { RenameResult } from './grid/rename.js';

/** I18N-01: nothing commits or cancels while an IME composes (`keyCode 229` is the legacy signal). */
export function isComposingEvent(event: KeyboardEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 is the legacy IME signal
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export interface InlineNameFieldProps {
  /** The current name, selected when the field opens. */
  value: string;
  /** The field's accessible name: "Sheet name", "Column name", "Table title". */
  label: string;
  /** Why an empty name is refused — shown as the placeholder and said (A11Y-04, A11Y-05). */
  emptyReason: string;
  /**
   * Write the trimmed name. A refusal carries its reason — a duplicate, a
   * lineage label, view-only — which the field shows beside itself; the
   * command has already said it (an empty name never reaches it: the field
   * refuses and says `emptyReason` itself). `ok` closes the field.
   */
  commit: (name: string) => RenameResult;
  cancel: () => void;
  /**
   * Where the keyboard goes once the field closes (MENU-05: back where it
   * came from). Called after commit or cancel with the element that had
   * focus when the field opened, or null when that element is gone or was
   * the menu that opened the field.
   */
  onDone?: ((returnTo: HTMLElement | null) => void) | undefined;
  className: string;
  /**
   * How the reason renders beside the field: visually hidden (the sheet tab,
   * where `aria-describedby` and the placeholder carry it) or as a visible
   * note under the field (a header, ADR-051).
   */
  reasonClassName?: string | undefined;
  /** A data attribute the menu's return-focus rule finds the open field by. */
  data: Record<`data-${string}`, string>;
}

/**
 * The inline name field a sheet tab (ADR-048), a column header and a table
 * title (ADR-051) stand aside for while they are renamed. Enter commits,
 * Escape cancels, leaving the field commits what is there; an empty name is
 * refused with the reason beside the field (as its placeholder, through
 * `aria-describedby`) and in the live region, and so is a name the command
 * refuses (a duplicate, view-only) — the field keeps the text, selected, so
 * the next keystroke replaces it. Leaving the field with a refused name
 * cancels: the label returns and focus is not taken back (the person went
 * elsewhere). Keys resolve from `event.code` and nothing happens while an
 * IME composes. The text is selected on open; one commit is one write and
 * one undo step (the caller's command).
 */
export function InlineNameField({
  value,
  label,
  emptyReason,
  commit,
  cancel,
  onDone,
  className,
  reasonClassName = 'gd-visually-hidden',
  data,
}: InlineNameFieldProps) {
  const [invalid, setInvalid] = useState<string | null>(null);
  const reasonId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  // The element the keyboard came from: a header, a cell, a tab — or a menu item on its way
  // out, which is not somewhere to go back to (its portal unmounts with the menu).
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    returnTo.current =
      active instanceof HTMLElement && active.closest('[role="menu"]') === null ? active : null;
    input.current?.focus();
    input.current?.select();
  }, []);
  const leave = () => {
    done.current = true;
    onDone?.(returnTo.current?.isConnected === true ? returnTo.current : null);
  };
  const finish = (how: 'commit' | 'cancel' | 'blur') => {
    if (done.current) return;
    const text = input.current?.value ?? '';
    if (how === 'cancel') {
      cancel();
      leave();
      return;
    }
    if (text.trim() === '') {
      // Leaving an empty field keeps the old name; Enter on it asks for a name.
      if (how === 'blur') {
        cancel();
        leave();
        return;
      }
      setInvalid(emptyReason);
      announce(emptyReason);
      input.current?.focus();
      return;
    }
    const result = commit(text);
    if (result.ok) {
      leave();
      return;
    }
    if (how === 'blur') {
      // Refused and the person has gone elsewhere: the label returns, focus is not retaken.
      cancel();
      leave();
      return;
    }
    setInvalid(result.reason);
    input.current?.focus();
    input.current?.select();
  };
  return (
    <>
      <input
        ref={input}
        className={className}
        type="text"
        defaultValue={value}
        aria-label={label}
        aria-invalid={invalid !== null || undefined}
        aria-describedby={invalid === null ? undefined : reasonId}
        // The reason shows where the missing name would be — exactly while it applies (A11Y-04).
        placeholder={invalid ?? undefined}
        title={invalid ?? undefined}
        autoComplete="off"
        spellCheck={false}
        {...data}
        onChange={() => {
          if (invalid !== null) setInvalid(null);
        }}
        onKeyDown={(event) => {
          if (isComposingEvent(event)) return;
          if (event.code === 'Enter' || event.code === 'NumpadEnter') {
            event.preventDefault();
            event.stopPropagation();
            finish('commit');
          } else if (event.code === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish('cancel');
          }
        }}
        onBlur={() => {
          finish('blur');
        }}
      />
      {invalid !== null && (
        <span id={reasonId} className={clsx('gd-name-field__reason', reasonClassName)}>
          {invalid}
        </span>
      )}
    </>
  );
}
