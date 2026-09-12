import * as RadixCheckbox from '@radix-ui/react-checkbox';
import clsx from 'clsx';
import { useId, type ReactNode } from 'react';

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean | 'indeterminate') => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

export function Checkbox({
  label,
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
}: CheckboxProps) {
  const autoId = useId();
  const boxId = id ?? autoId;
  return (
    <div className={clsx('gd-checkbox', className)}>
      <RadixCheckbox.Root
        id={boxId}
        className="gd-checkbox__box"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        <RadixCheckbox.Indicator className="gd-checkbox__mark">
          <svg
            viewBox="0 0 18 18"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {checked === 'indeterminate' ? (
              <path d="M4 9h10" />
            ) : (
              <path d="M3.5 9.5l3.5 3.5 7.5-8" />
            )}
          </svg>
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <label htmlFor={boxId} className="gd-checkbox__label">
        {label}
      </label>
    </div>
  );
}
