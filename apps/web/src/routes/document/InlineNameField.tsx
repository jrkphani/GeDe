import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { announce } from '../../announce.js';

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
   * Write the trimmed name. False when the document refused it: the field
   * stays open and says why. True closes the field.
   */
  commit: (name: string) => boolean;
  cancel: () => void;
  /**
   * Where the keyboard goes once the field closes (MENU-05: back where it
   * came from). Called after commit or cancel with the element that had
   * focus when the field opened, or null when that element is gone or was
   * the menu that opened the field.
   */
  onDone?: ((returnTo: HTMLElement | null) => void) | undefined;
  className: string;
  /** A data attribute the menu's return-focus rule finds the open field by. */
  data: Record<`data-${string}`, string>;
}

/**
 * The inline name field a sheet tab (ADR-048), a column header and a table
 * title (ADR-051) stand aside for while they are renamed. Enter commits,
 * Escape cancels, leaving the field commits what is there; an empty name is
 * refused with the reason beside the field (as its placeholder, through
 * `aria-describedby`) and in the live region. Keys resolve from `event.code`
 * and nothing happens while an IME composes. The text is selected on open;
 * one commit is one write and one undo step (the caller's command).
 */
export function InlineNameField({
  value,
  label,
  emptyReason,
  commit,
  cancel,
  onDone,
  className,
  data,
}: InlineNameFieldProps) {
  const [invalid, setInvalid] = useState(false);
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
  const finish = (how: 'commit' | 'cancel') => {
    if (done.current) return;
    const text = input.current?.value ?? '';
    if (how === 'commit') {
      if (text.trim() !== '' && commit(text)) {
        done.current = true;
        onDone?.(returnTo.current?.isConnected === true ? returnTo.current : null);
        return;
      }
      setInvalid(true);
      announce(emptyReason);
      input.current?.focus();
      return;
    }
    done.current = true;
    cancel();
    onDone?.(returnTo.current?.isConnected === true ? returnTo.current : null);
  };
  return (
    <>
      <input
        ref={input}
        className={className}
        type="text"
        defaultValue={value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? reasonId : undefined}
        // The reason shows where the missing name would be — exactly while it applies (A11Y-04).
        placeholder={invalid ? emptyReason : undefined}
        autoComplete="off"
        spellCheck={false}
        {...data}
        onChange={() => {
          if (invalid) setInvalid(false);
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
          // Leaving the field keeps a typed name; an empty one is not kept, and the label returns.
          if ((input.current?.value ?? '').trim() === '') finish('cancel');
          else finish('commit');
        }}
      />
      {invalid && (
        <span id={reasonId} className="gd-visually-hidden">
          {emptyReason}
        </span>
      )}
    </>
  );
}
