import type { ButtonHTMLAttributes } from 'react';
import { Icon } from './Icon.js';

export type AppleSignInWording = 'Sign in with Apple' | 'Continue with Apple';

export interface AppleSignInButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'style'
> {
  /** Apple-approved wording only. */
  wording?: AppleSignInWording | undefined;
  loading?: boolean | undefined;
}

/**
 * Sign in with Apple — Apple's button, not ours. Black variant, Apple's glyph,
 * 44 pt minimum height, label at ~43 % of height, approved wording, never
 * restyled by consumers (no `className`/`style` props on purpose).
 */
export function AppleSignInButton({
  wording = 'Sign in with Apple',
  loading = false,
  disabled,
  type = 'button',
  ...rest
}: AppleSignInButtonProps) {
  return (
    <button
      type={type}
      className="gd-apple"
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      aria-label={wording}
      {...rest}
    >
      <Icon name="apple" size={18} className="gd-apple__glyph" />
      <span className="gd-apple__label">{wording}</span>
    </button>
  );
}
