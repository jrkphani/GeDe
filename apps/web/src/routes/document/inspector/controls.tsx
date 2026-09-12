/**
 * The inspector's building blocks (DESIGN-SYSTEM §4 "Inspector rail"):
 * sections opened by a mono uppercase label, a stepper for counts, and the
 * one way an unimplemented control is shown — disabled, with its reason,
 * never styled as operable (INSP-11).
 */
import { Button, Icon, Tooltip } from '@gede/ui';
import type { ReactNode } from 'react';

export function Section({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** A one-line note under the label (INSP-10 scope, FMT-06). */
  hint?: ReactNode | undefined;
}) {
  return (
    <section className="gd-insp__section" aria-label={label}>
      <h3 className="gd-mono gd-insp__label">{label}</h3>
      {hint !== undefined && <p className="gd-insp__hint">{hint}</p>}
      {children}
    </section>
  );
}

export interface StepperProps {
  label: string;
  value: number;
  /** Displayed unit, e.g. "rows". */
  unit?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  onChange: (next: number) => void;
  /** MENU-02 / INSP-11: disabled with the reason, never hidden. */
  disabledReason?: string | undefined;
  /** Why the decrement alone is unavailable (e.g. the last row). */
  decrementReason?: string | undefined;
}

/**
 * A count with − and + (INSP-04 row and column counts, INSP-07 position).
 * The value is stated, not typed: every change is one command and one undo
 * step, and the canvas updates on each press (INSP-12).
 */
export function Stepper({
  label,
  value,
  unit,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  onChange,
  disabledReason,
  decrementReason,
}: StepperProps) {
  const downReason =
    disabledReason ?? (value <= min ? (decrementReason ?? 'at the minimum') : undefined);
  const upReason = disabledReason ?? (value >= max ? 'at the maximum' : undefined);
  return (
    <div className="gd-insp__stepper" role="group" aria-label={label}>
      <span className="gd-insp__stepper-label">{label}</span>
      <span className="gd-mono gd-insp__stepper-value" aria-live="polite">
        {value}
        {unit !== undefined && <span className="gd-insp__stepper-unit"> {unit}</span>}
      </span>
      <span className="gd-insp__stepper-keys">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Fewer ${unit ?? label}`}
          title={downReason === undefined ? `Fewer ${unit ?? label}` : `Fewer — ${downReason}`}
          aria-disabled={downReason !== undefined || undefined}
          onClick={
            downReason === undefined
              ? () => {
                  onChange(value - 1);
                }
              : undefined
          }
        >
          −
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`More ${unit ?? label}`}
          title={upReason === undefined ? `More ${unit ?? label}` : `More — ${upReason}`}
          aria-disabled={upReason !== undefined || undefined}
          onClick={
            upReason === undefined
              ? () => {
                  onChange(value + 1);
                }
              : undefined
          }
        >
          +
        </Button>
      </span>
    </div>
  );
}

/** The reason every not-yet-implemented control carries (INSP-11). Sentence case, specific. */
export const NOT_YET = 'not implemented in this release';

/**
 * A control whose effect is not implemented: rendered as a disabled button
 * carrying its reason (tooltip and `aria-disabled`), so it reads as a real
 * command that is unavailable, not as a placeholder.
 */
export function Unavailable({
  label,
  reason = NOT_YET,
  icon,
}: {
  label: string;
  reason?: string | undefined;
  icon?: ReactNode | undefined;
}) {
  return (
    <Tooltip content={`${label} — ${reason}`}>
      <Button
        size="sm"
        variant="secondary"
        className="gd-insp__unavailable"
        aria-disabled="true"
        title={`${label} — ${reason}`}
        icon={icon}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/** A row of unavailable controls under one label. */
export function UnavailableRow({ labels, reason }: { labels: readonly string[]; reason?: string }) {
  return (
    <div className="gd-insp__row">
      {labels.map((label) => (
        <Unavailable key={label} label={label} reason={reason} />
      ))}
    </div>
  );
}

/** The inspector's own "nothing here" line, for a slot another release fills. */
export function Slot({ name, reason }: { name: string; reason: string }) {
  return (
    <p className="gd-insp__slot" data-slot={name}>
      <Icon name="draft" size={13} /> {reason}
    </p>
  );
}
