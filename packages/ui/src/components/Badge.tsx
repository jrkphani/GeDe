import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BadgeTone = 'brand' | 'live' | 'neutral';

export interface BadgeProps {
  children: ReactNode;
  /** brand = forest (Shared, Owner); live = amber (Draft); neutral = slate. */
  tone?: BadgeTone | undefined;
  className?: string | undefined;
}

/** Pill label. The text carries the meaning; the tone only reinforces it. */
export function Badge({ children, tone = 'brand', className }: BadgeProps) {
  return <span className={clsx('gd-badge', `gd-badge--${tone}`, className)}>{children}</span>;
}
