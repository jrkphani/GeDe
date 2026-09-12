import clsx from 'clsx';
import type { CSSProperties, HTMLAttributes, SVGAttributes } from 'react';

export interface BrandMarkProps extends Omit<SVGAttributes<SVGSVGElement>, 'width' | 'height'> {
  /** Rendered size in CSS px. Use 20 or more in chrome; gridlines drop below 32, only frame + node below 20. */
  size?: number | undefined;
  /** Accessible name; omit when a neighbouring wordmark names the brand. */
  label?: string | undefined;
}

/**
 * The brand mark: a single lattice cell — a 36 × 36 frame, the gridlines that
 * give the cell its address, and the node in the cell. Inherits `currentColor`.
 */
export function BrandMark({ size = 36, label, className, ...rest }: BrandMarkProps) {
  const px = size;
  const tiny = px < 20;
  const showLines = px >= 32;
  const a11y =
    label === undefined ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <svg
      className={clsx('gd-mark', className)}
      width={px}
      height={px}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      focusable="false"
      {...a11y}
      {...rest}
    >
      <rect x="2" y="2" width="36" height="36" rx={tiny ? 3 : 4} strokeWidth={tiny ? 3 : 2.5} />
      {showLines && <path d="M2 13h36M13 2v36" strokeWidth="1.4" opacity="0.55" />}
      <circle
        cx={tiny ? 25 : 26}
        cy={tiny ? 25 : 26}
        r={tiny ? 7 : 5}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export interface WordmarkProps extends HTMLAttributes<HTMLSpanElement> {
  /** Mark size in CSS px; the wordmark scales with it. */
  size?: number | undefined;
}

/** Mark + "GeDe" lockup with the 12 px gap. Title Case lives only here. */
export function Wordmark({ size = 28, className, ...rest }: WordmarkProps) {
  return (
    <span
      className={clsx('gd-wordmark', className)}
      style={{ '--gd-mark-size': `${size}px` } as CSSProperties}
      {...rest}
    >
      <BrandMark size={size} />
      <span className="gd-wordmark__text">GeDe</span>
    </span>
  );
}
