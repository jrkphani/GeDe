import clsx from 'clsx';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { lattice, loading as loadingTiers } from '@gede/tokens';

export interface SkeletonProps {
  /** True while the content is loading. */
  active: boolean;
  /** Milliseconds before the skeleton appears (LOAD-01). Default 200. */
  delay?: number | undefined;
  /** Milliseconds it stays once shown, so it cannot flash (LOAD-02). Default 400. */
  minHold?: number | undefined;
  /** Reserve N lattice rows of 22 px so a table's geometry does not shift on arrival (LOAD-03). */
  rows?: number | undefined;
  /** Over one second: name the object in a polite status line (LOAD-01 tier 3). */
  statusLabel?: string | undefined;
  /** The real content, rendered when `active` is false and the hold has elapsed. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** Varied bar widths so the placeholder reads as content, not a barcode. */
const BAR_WIDTHS = [72, 56, 84, 40, 64, 48, 76, 60] as const;

/**
 * Three-tier loading state. Nothing shows under `delay`; a content-shaped
 * skeleton from then; after one second the status line names what is loading.
 */
export function Skeleton({
  active,
  delay = loadingTiers.delay,
  minHold = loadingTiers.minHold,
  rows,
  statusLabel,
  children,
  className,
}: SkeletonProps) {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      const show = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
      const tier3 = window.setTimeout(() => {
        setSlow(true);
      }, 1000);
      return () => {
        window.clearTimeout(show);
        window.clearTimeout(tier3);
      };
    }
    setSlow(false);
    if (shownAt.current === null) {
      setVisible(false);
      return undefined;
    }
    const remaining = Math.max(0, minHold - (Date.now() - shownAt.current));
    const hide = window.setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, remaining);
    return () => {
      window.clearTimeout(hide);
    };
  }, [active, delay, minHold]);

  if (!active && !visible) return <>{children}</>;
  if (!visible) return null;

  const count = rows ?? 4;
  const style =
    rows !== undefined ? ({ '--gd-skeleton-row': `${lattice.row}px` } as CSSProperties) : undefined;
  return (
    <div
      className={clsx('gd-skeleton', className, { 'gd-skeleton--lattice': rows !== undefined })}
      aria-busy="true"
      style={style}
    >
      <div className="gd-skeleton__bars" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className="gd-skeleton__bar"
            style={{ width: `${BAR_WIDTHS[i % BAR_WIDTHS.length] ?? 60}%` }}
          />
        ))}
      </div>
      {slow && statusLabel !== undefined && (
        <div className="gd-skeleton__status" role="status" aria-live="polite">
          <span className="gd-skeleton__progress" aria-hidden="true" />
          {statusLabel}
        </div>
      )}
    </div>
  );
}
