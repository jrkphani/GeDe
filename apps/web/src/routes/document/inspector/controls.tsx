/**
 * The inspector's building blocks (DESIGN-SYSTEM §4 "Inspector rail"):
 * sections opened by a mono uppercase label, a stepper for counts, and the
 * one way an unimplemented control is shown — disabled, with its reason,
 * never styled as operable (INSP-11).
 */
import { Button, Icon, Tooltip, type ButtonProps } from '@gede/ui';
import { useId, type ReactNode } from 'react';

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
  /** What the − and + buttons name ("Fewer …", "More …"); defaults to the unit, else the label. */
  name?: string | undefined;
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
  name,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  onChange,
  disabledReason,
  decrementReason,
}: StepperProps) {
  const downReason =
    disabledReason ?? (value <= min ? (decrementReason ?? 'at the minimum') : undefined);
  const upReason = disabledReason ?? (value >= max ? 'at the maximum' : undefined);
  const reasonId = useId();
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
          aria-label={`Fewer ${name ?? unit ?? label}`}
          title={
            downReason === undefined ? `Fewer ${name ?? unit ?? label}` : `Fewer — ${downReason}`
          }
          aria-disabled={downReason !== undefined || undefined}
          aria-describedby={downReason === undefined ? undefined : `${reasonId}-down`}
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
          aria-label={`More ${name ?? unit ?? label}`}
          title={upReason === undefined ? `More ${name ?? unit ?? label}` : `More — ${upReason}`}
          aria-disabled={upReason !== undefined || undefined}
          aria-describedby={upReason === undefined ? undefined : `${reasonId}-up`}
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
      {downReason !== undefined && (
        <span id={`${reasonId}-down`} className="gd-visually-hidden" aria-hidden="true">
          {downReason}
        </span>
      )}
      {upReason !== undefined && (
        <span id={`${reasonId}-up`} className="gd-visually-hidden" aria-hidden="true">
          {upReason}
        </span>
      )}
    </div>
  );
}

export interface ReasonedButtonProps extends Omit<ButtonProps, 'onClick' | 'title'> {
  /** The command's name: the tooltip, and the label unless `children` is given. */
  label: string;
  /** Why the command is unavailable; undefined when it can run. */
  reason: string | undefined;
  onClick?: (() => void) | undefined;
  /** A hint shown beside the label while the command is available. */
  available?: string | undefined;
}

/**
 * INSP-11 / MENU-02: a command button that, when unavailable, looks disabled
 * and carries its reason where every reader can reach it — the tooltip for
 * the pointer and for the keyboard (the button stays focusable, so the
 * tooltip opens on focus), `title` for hover, and `aria-describedby` to a
 * visually hidden sentence for assistive tech (#126). One component, so no
 * tab renders a disabled control its own way.
 */
export function ReasonedButton({
  label,
  reason,
  onClick,
  available,
  children,
  ...rest
}: ReasonedButtonProps) {
  const reasonId = useId();
  const unavailable = reason !== undefined;
  const tip = unavailable ? `${label} — ${reason}` : (available ?? label);
  return (
    <>
      <Tooltip content={tip}>
        <Button
          size="sm"
          variant="secondary"
          {...rest}
          aria-disabled={unavailable || undefined}
          aria-describedby={unavailable ? reasonId : undefined}
          title={tip}
          onClick={unavailable ? undefined : onClick}
        >
          {children ?? label}
        </Button>
      </Tooltip>
      {unavailable && (
        <span
          id={reasonId}
          className="gd-visually-hidden"
          aria-hidden="true"
          data-testid="control-reason"
        >
          {reason}
        </span>
      )}
    </>
  );
}

/**
 * The issues that own the controls the PRD names but no release has built yet.
 * Every disabled control carries one of these as its reason (INSP-11), so a
 * reader can find the plan; a control with no owner here is removed, not stubbed.
 */
export const TRACKED = {
  /** INSP-08 / GRAPH-*: graphs, "Graph this table", the Graph tab. */
  graph: 'arrives with #86 (context graphs)',
} as const;

/**
 * A control whose effect is not implemented: rendered as a disabled button
 * carrying its reason (tooltip and `aria-disabled`), so it reads as a real
 * command that is unavailable, not as a placeholder.
 */
export function Unavailable({
  label,
  reason,
  icon,
}: {
  label: string;
  /** One of `TRACKED`, or a reason of its own. */
  reason: string;
  icon?: ReactNode | undefined;
}) {
  return (
    <ReasonedButton label={label} reason={reason} className="gd-insp__unavailable" icon={icon} />
  );
}

/** A row of unavailable controls under one label. */
export function UnavailableRow({ labels, reason }: { labels: readonly string[]; reason: string }) {
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
