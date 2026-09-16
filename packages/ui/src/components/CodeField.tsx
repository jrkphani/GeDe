import { forwardRef, useId, type ChangeEvent, type InputHTMLAttributes } from 'react';
import clsx from 'clsx';

/**
 * The lengths Cognito's codes come in: six digits for a sign-up (or attribute) verification
 * code, eight for the passwordless EMAIL_OTP sign-in code. Which step expects which is the
 * auth boundary's knowledge (`apps/web/src/auth/cognito.ts`); the field only needs to know
 * the longest, so that it never drops a digit of any code Cognito can send (AUTH-06).
 */
export type CodeLength = 6 | 8;
export const MAX_CODE_LENGTH: CodeLength = 8;

export interface CodeFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'maxLength' | 'inputMode'
> {
  /** How many digits the step expects: the complete state fires at exactly this many. */
  length: CodeLength;
  label: string;
  value: string;
  /** Receives the digits-only value (at most `MAX_CODE_LENGTH`) and whether it is complete. */
  onChange: (value: string, complete: boolean) => void;
  error?: string | undefined;
  hint?: string | undefined;
}

/**
 * Strip anything that is not an ASCII digit and cap at the longest code Cognito sends
 * (AUTH-06). The cap is the maximum, not the step's own length: a step that expected six
 * and received eight would otherwise truncate the code to something that can never match,
 * and the person would have no way to see why (the production defect this replaced).
 */
export function normaliseCode(raw: string): string {
  return raw.replace(/\D+/g, '').slice(0, MAX_CODE_LENGTH);
}

export function isCodeComplete(value: string, length: CodeLength): boolean {
  return value.length === length;
}

/**
 * One-time code input. `inputMode="numeric"` for the phone keypad,
 * `autoComplete="one-time-code"` so iOS/Android offer the SMS/mail code.
 * No `maxLength` on the element: the browser would truncate a pasted
 * "123 456" to "123 45" before the digits are stripped; `normaliseCode` caps
 * the value after stripping instead.
 */
export const CodeField = forwardRef<HTMLInputElement, CodeFieldProps>(function CodeField(
  { length, label, value, onChange, error, hint, id, className, disabled, ...rest },
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
    onChange(next, isCodeComplete(next, length));
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
        data-length={length}
        data-complete={isCodeComplete(value, length) || undefined}
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
