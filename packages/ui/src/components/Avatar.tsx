import clsx from 'clsx';

export type AvatarSize = 24 | 30;

export interface AvatarProps {
  /** Display name or, failing that, the email; initials are derived from it. */
  name: string;
  size?: AvatarSize | undefined;
  /** Decorative when a text label sits next to it; otherwise the avatar names the person. */
  decorative?: boolean | undefined;
  className?: string | undefined;
}

/** Up to two initials from the first and last word; an email yields its first letter. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  if (first.includes('@')) return first.charAt(0).toUpperCase();
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** Initials on forest 900. Never a generated face. */
export function Avatar({ name, size = 30, decorative = false, className }: AvatarProps) {
  return (
    <span
      className={clsx('gd-avatar', `gd-avatar--${size}`, className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
    >
      {initialsOf(name)}
    </span>
  );
}
