import * as RadixSwitch from '@radix-ui/react-switch';
import clsx from 'clsx';
import { useId, type ReactNode } from 'react';

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

export function Switch({ label, checked, onCheckedChange, disabled, className, id }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  return (
    <div className={clsx('gd-switch', className)}>
      <RadixSwitch.Root
        id={switchId}
        className="gd-switch__track"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        <RadixSwitch.Thumb className="gd-switch__thumb" />
      </RadixSwitch.Root>
      <label htmlFor={switchId} className="gd-switch__label">
        {label}
      </label>
    </div>
  );
}
