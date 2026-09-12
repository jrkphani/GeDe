import { forwardRef, useId, type ChangeEvent, type InputHTMLAttributes } from 'react';
import clsx from 'clsx';

export const CODE_LENGTH = 6;

export interface CodeFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'maxLength' | 'inputMode'
> {
  label?: string | undefined;
  value: string;
  /** Receives the digits-only value (max six) and whether it is complete. */
  onChange: (value: string, complete: boolean) => void;
  error?: string | undefined;
  hint?: string | undefined;
}

/** Strip anything that is not an ASCII digit and cap at six (AUTH-06). */
export function normaliseCode(raw: string): string {
  return raw.replace(/\D+/g, '').slice(0, CODE_LENGTH);
}

export function isCodeComplete(value: string): boolean {
  return value.length === CODE_LENGTH;
}

/**
 * Six-digit one-time code input. `inputMode="numeric"` for the phone keypad,
 * `autoComplete="one-time-code"` so iOS/Android offer the SMS/mail code.
 * No `maxLength` on the element: the browser would truncate a pasted
 * "123 456" to "123 45" before the digits are stripped; `normaliseCode` caps
 * the value at six after stripping instead.
 */
export const CodeField = forwardRef<HTMLInputElement, CodeFieldProps>(function CodeField(
  { label = 'Six-digit code', value, onChange, error, hint, id, className, disabled, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const next = normaliseCode(e.target.value);
    onChange(next, isCodeComplete(next));
  };

  return (
    <div
      className={clsx('gd-field gd-code', className, { 'gd-field--error': error !== undefined })}
    >
      <label htmlFor={inputId} className="gd-field__label">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className="gd-field__input gd-code__input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        value={value}
        onChange={handle}
        disabled={disabled}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        data-complete={isCodeComplete(value) || undefined}
        {...rest}
      />
      {hint !== undefined && (
        <div id={hintId} className="gd-field__hint">
          {hint}
        </div>
      )}
      {error !== undefined && (
        <div id={errorId} className="gd-field__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
});
