import * as ToggleGroup from '@radix-ui/react-toggle-group';
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
 * Switch a view. Exactly one segment is always on: Radix ToggleGroup `single`
 * with an empty selection rejected, so the control never reads as "nothing".
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
    <ToggleGroup.Root
      type="single"
      className={clsx('gd-segmented', className)}
      aria-label={label}
      value={value}
      disabled={disabled === true}
      onValueChange={(next) => {
        if (next !== '') onChange(next as V);
      }}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="gd-segmented__item"
          disabled={o.disabled}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
