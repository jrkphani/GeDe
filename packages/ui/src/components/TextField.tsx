import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'size'> {
  /** Visible label, rendered above the input. A placeholder never carries the label. */
  label: ReactNode;
  /** Optional help text beneath the input. */
  hint?: ReactNode | undefined;
  /** Error message naming the problem; sets `aria-invalid` and describes the input. */
  error?: ReactNode | undefined;
  /** Visually hide the label (it stays in the accessibility tree). */
  hideLabel?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, hideLabel = false, id, className, disabled, ...rest },
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

  return (
    <div
      className={clsx('gd-field', className, {
        'gd-field--error': error !== undefined,
        'gd-field--disabled': disabled,
      })}
    >
      <label
        htmlFor={inputId}
        className={clsx('gd-field__label', { 'gd-visually-hidden': hideLabel })}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className="gd-field__input"
        disabled={disabled}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
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
