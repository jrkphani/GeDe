import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** Mono uppercase label naming the collection, e.g. "recents". */
  label: string;
  title: ReactNode;
  description?: ReactNode | undefined;
  /** One primary action that fills the state. */
  action?: ReactNode | undefined;
  className?: string | undefined;
}

/** Dashed frame, mono label, prose, one action. */
export function EmptyState({ label, title, description, action, className }: EmptyStateProps) {
  return (
    <section
      className={clsx('gd-empty', className)}
      aria-label={typeof title === 'string' ? title : label}
    >
      <span className="gd-empty__label">{label}</span>
      <h2 className="gd-empty__title">{title}</h2>
      {description !== undefined && <p className="gd-empty__description">{description}</p>}
      {action !== undefined && <div className="gd-empty__action">{action}</div>}
    </section>
  );
}
