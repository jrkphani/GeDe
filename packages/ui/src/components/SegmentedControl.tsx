import * as RadioGroup from '@radix-ui/react-radio-group';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean | undefined;
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name for the group. */
  label: string;
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string | undefined;
  disabled?: boolean | undefined;
}

/**
 * Switch a view. Exactly one segment is always on, so the control is a radio
 * group and follows the ARIA radio pattern: Tab lands on the checked segment,
 * the arrow keys move the selection (not just focus), Space checks. Radix
 * RadioGroup supplies that; a ToggleGroup announces its items as radios but
 * moves only focus on arrows (#144).
 */
export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
  disabled,
}: SegmentedControlProps<V>) {
  return (
    <RadioGroup.Root
      className={clsx('gd-segmented', className)}
      aria-label={label}
      value={value}
      disabled={disabled === true}
      onValueChange={(next) => {
        onChange(next as V);
      }}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="gd-segmented__item"
          disabled={o.disabled}
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
