/**
 * The inspector's building blocks (DESIGN-SYSTEM §4 "Inspector rail"):
 * sections opened by a mono uppercase label, a stepper for counts, and the
 * one way an unimplemented control is shown — disabled, with its reason,
 * never styled as operable (INSP-11).
 */
import { Button, Icon, Tooltip, type ButtonProps } from '@gede/ui';
import { useId, useState, type ReactNode } from 'react';

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

export interface SizeFieldProps {
  /** "Height" / "Width". */
  label: string;
  /** The size in lattice units, or null when the selection has none (mixed sizes read the first). */
  value: number | null;
  /** Pixels per unit at 100 % (22 for a row, 160 for a column), for `aria-valuetext`. */
  unitPx: number;
  /** What the value describes: "row 5", "3 rows", "column B". */
  subject: string;
  onChange: (units: number) => void;
  /** Fit to content beside the field; `fitReason` says why it cannot run. */
  onFit?: (() => void) | undefined;
  fitReason?: string | undefined;
  /** MENU-02 / INSP-11: disabled with the reason, never hidden. */
  disabledReason?: string | undefined;
}

/**
 * The Table tab's Height and Width (INSP-04, #167 criteria 8–9, Numbers N4):
 * a spinbutton in whole lattice units for the selected rows or columns. ↑ ↓
 * step one unit, Shift four; a typed value snaps to a whole unit ≥ 1 on
 * Enter or blur; the value is read back in units and pixels at 100 %. Every
 * change is one command and one undo step, live on the canvas (INSP-12).
 */
export function SizeField({
  label,
  value,
  unitPx,
  subject,
  onChange,
  onFit,
  fitReason,
  disabledReason,
}: SizeFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));
  const reason = disabledReason ?? (value === null ? `select a ${subject} first` : undefined);
  const commit = (raw: string) => {
    setDraft(null);
    const n = Number.parseFloat(raw.trim());
    if (!Number.isFinite(n)) return;
    const snapped = Math.max(1, Math.round(n));
    if (snapped !== value) onChange(snapped);
  };
  const step = (delta: number) => {
    if (value === null) return;
    onChange(Math.max(1, value + delta));
  };
  return (
    <div className="gd-insp__size" role="group" aria-label={label}>
      <label className="gd-insp__stepper-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="gd-mono gd-insp__size-input"
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-valuenow={value ?? undefined}
        aria-valuemin={1}
        aria-valuetext={
          value === null
            ? undefined
            : `${String(value)} ${value === 1 ? 'unit' : 'units'}, ${String(value * unitPx)} px, ${subject}`
        }
        aria-disabled={reason !== undefined || undefined}
        aria-describedby={reason === undefined ? undefined : `${id}-reason`}
        title={
          reason === undefined ? `${label} of ${subject} in lattice units` : `${label} — ${reason}`
        }
        readOnly={reason !== undefined}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={(e) => {
          if (draft !== null) commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || reason !== undefined) return;
          switch (e.code) {
            case 'ArrowUp':
              e.preventDefault();
              step(e.shiftKey ? 4 : 1);
              break;
            case 'ArrowDown':
              e.preventDefault();
              step(e.shiftKey ? -4 : -1);
              break;
            case 'Enter':
            case 'NumpadEnter':
              e.preventDefault();
              commit(e.currentTarget.value);
              break;
            case 'Escape':
              if (draft !== null) {
                e.stopPropagation();
                setDraft(null);
              }
              break;
            default:
              break;
          }
        }}
      />
      <span className="gd-insp__stepper-unit" aria-hidden="true">
        units
      </span>
      <ReasonedButton
        size="sm"
        variant="ghost"
        aria-label={`Fit ${label.toLowerCase()} to content`}
        label={`Fit ${label.toLowerCase()} to content`}
        reason={disabledReason ?? fitReason ?? (value === null ? reason : undefined)}
        onClick={onFit}
      >
        Fit
      </ReasonedButton>
      {reason !== undefined && (
        <span id={`${id}-reason`} className="gd-visually-hidden" aria-hidden="true">
          {reason}
        </span>
      )}
    </div>
  );
}
