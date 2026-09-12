import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import { useId, type ReactNode } from 'react';

import { Icon } from './Icon.js';

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A second line beneath the label, for options that need a sentence. */
  description?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

export interface SelectProps<V extends string> {
  /** Visible label above the trigger; `hideLabel` keeps it for assistive technology only. */
  label: ReactNode;
  hideLabel?: boolean | undefined;
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  disabled?: boolean | undefined;
  /** `sm` for a select that sits inside a list row; `md` for a form field. */
  size?: 'sm' | 'md' | undefined;
  id?: string | undefined;
  className?: string | undefined;
  /** Optional accessible name override for the trigger (e.g. "Permission for Meena"). */
  'aria-label'?: string | undefined;
}

/**
 * Single choice from a short list, on Radix Select (DS §4 "Text field, select":
 * native + Radix Select as needed). Keyboard-complete: arrows move, type-ahead
 * jumps, Enter and Space choose, Escape closes; focus returns to the trigger.
 * The label is a real `<label>` bound to the trigger, never a placeholder.
 */
export function Select<V extends string>({
  label,
  hideLabel = false,
  value,
  onValueChange,
  options,
  disabled,
  size = 'md',
  id,
  className,
  'aria-label': ariaLabel,
}: SelectProps<V>) {
  const autoId = useId();
  const triggerId = id ?? autoId;
  return (
    <div className={clsx('gd-select', `gd-select--${size}`, className)}>
      <label
        htmlFor={triggerId}
        className={clsx('gd-select__label', { 'gd-visually-hidden': hideLabel })}
      >
        {label}
      </label>
      <RadixSelect.Root
        value={value}
        onValueChange={onValueChange}
        {...(disabled !== undefined && { disabled })}
      >
        <RadixSelect.Trigger id={triggerId} className="gd-select__trigger" aria-label={ariaLabel}>
          <RadixSelect.Value />
          <RadixSelect.Icon className="gd-select__chevron">
            <Icon name="chevron-down" size={13} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content className="gd-select__content" position="popper" sideOffset={4}>
            <RadixSelect.Viewport className="gd-select__viewport">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  {...(option.disabled !== undefined && { disabled: option.disabled })}
                  className="gd-select__item"
                >
                  <span className="gd-select__check" aria-hidden="true">
                    <RadixSelect.ItemIndicator>
                      <Icon name="check" size={13} />
                    </RadixSelect.ItemIndicator>
                  </span>
                  <span className="gd-select__text">
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    {option.description !== undefined && (
                      <span className="gd-select__description">{option.description}</span>
                    )}
                  </span>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
