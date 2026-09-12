import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export interface BannerProps {
  /** What happened, in bold. */
  cause: ReactNode;
  /** What to do about it. */
  remedy?: ReactNode | undefined;
  /** Optional action, a verb. */
  action?: ReactNode | undefined;
  /** Amber for consequences you can act on; red for failures on our side. */
  tone?: 'warning' | 'danger' | undefined;
  className?: string | undefined;
}

/** Persistent and consequential. Amber surface, warning glyph, cause + remedy. */
export function Banner({ cause, remedy, action, tone = 'warning', className }: BannerProps) {
  return (
    <div
      className={clsx('gd-banner', `gd-banner--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={tone === 'danger' ? 'error' : 'warning'} size={18} className="gd-banner__icon" />
      <p className="gd-banner__text">
        <strong className="gd-banner__cause">{cause}</strong>
        {remedy !== undefined && <span className="gd-banner__remedy"> {remedy}</span>}
      </p>
      {action !== undefined && <div className="gd-banner__action">{action}</div>}
    </div>
  );
}
