import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon } from './Icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** In-flight state: keeps width, swaps the label to `loadingLabel`, sets `aria-busy` (LOAD-04). */
  loading?: boolean | undefined;
  /** Present participle shown while loading, e.g. "Inviting…". */
  loadingLabel?: string | undefined;
  /** Leading glyph. */
  icon?: ReactNode | undefined;
  children?: ReactNode | undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel,
    icon,
    className,
    disabled,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('gd-btn', `gd-btn--${variant}`, `gd-btn--${size}`, className, {
        'gd-btn--loading': loading,
        'gd-btn--icon-only': icon !== undefined && children === undefined,
      })}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      {...rest}
    >
      {/* The resting label reserves the width; it is hidden (not removed) while loading. */}
      <span className="gd-btn__body" aria-hidden={loading || undefined}>
        {icon !== undefined && <span className="gd-btn__icon">{icon}</span>}
        {children !== undefined && <span className="gd-btn__label">{children}</span>}
      </span>
      {loading && (
        <span className="gd-btn__loading" role="status">
          <Icon name="loading" size={size === 'sm' ? 13 : 15} className="gd-btn__spinner" />
          <span>{loadingLabel ?? 'Working…'}</span>
        </span>
      )}
    </button>
  );
});
