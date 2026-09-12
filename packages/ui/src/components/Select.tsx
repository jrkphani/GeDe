import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import { useId, useLayoutEffect, useState, type ReactNode } from 'react';

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
  /**
   * INSP-11 / MENU-02: disabled with the reason as the trigger's tooltip —
   * a control that cannot act says why, and is never hidden.
   */
  disabledReason?: string | undefined;
  /** Short mono note at the right of the label, e.g. the scope of the change (INSP-10). */
  hint?: ReactNode | undefined;
  /** `sm` for a select that sits inside a list row; `md` for a form field. */
  size?: 'sm' | 'md' | undefined;
  id?: string | undefined;
  className?: string | undefined;
  /** Optional accessible name override for the trigger (e.g. "Permission for Meena"). */
  'aria-label'?: string | undefined;
  /** Shown in the trigger while the value is `''` (`''` itself shows the chevron alone). */
  placeholder?: string | undefined;
  /** Offers an item that clears the value to `''` (`V` must admit it); omit for a required choice. */
  clearLabel?: string | undefined;
  /** Sentence shown in the list when `options` is empty. */
  emptyText?: string | undefined;
  /** Controlled open state (a host that opens the list from its own key handling). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Take the trigger out of the Tab order (a picker inside a roving-tabindex grid). */
  triggerTabIndex?: number | undefined;
  /**
   * Where focus goes when the list closes. By default the trigger; a host whose
   * own focus management owns the trigger's ancestor (a grid cell) calls
   * `preventDefault()` and focuses that instead.
   */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Item value that clears the selection; never a real option value. */
const CLEAR = '\u0000clear';

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
  disabledReason,
  hint,
  size = 'md',
  id,
  className,
  'aria-label': ariaLabel,
  placeholder,
  clearLabel,
  emptyText,
  open,
  onOpenChange,
  triggerTabIndex,
  onCloseAutoFocus,
}: SelectProps<V>) {
  const autoId = useId();
  const triggerId = id ?? autoId;
  const isDisabled = disabled === true || disabledReason !== undefined;
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  // Radix Select is modal: while the list is open it marks everything else `aria-hidden`.
  // Hidden content must not stay focusable (WCAG 4.1.2, axe `aria-hidden-focus`), so the
  // same elements are made `inert` for the duration — Radix already traps focus inside
  // the list, this makes the DOM say so too. A layout effect, so that on close `inert`
  // is gone in the same commit: Radix restores focus a macrotask later, and `focus()` on
  // an element still inside an inert subtree is a no-op (focus would land on `body`).
  useLayoutEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;
    const touched: HTMLElement[] = [];
    const apply = (): void => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"]')) {
        if (el.inert) continue;
        el.inert = true;
        touched.push(el);
      }
    };
    // Radix marks the rest of the page once the list has mounted (a frame later than `open`).
    apply();
    const frame = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(frame);
      for (const el of touched) el.inert = false;
    };
  }, [isOpen]);
  // Radix treats '' as "no value" (the placeholder shows); an item cannot carry '', so the
  // clear item uses a sentinel that maps back to ''.
  return (
    <div className={clsx('gd-select', `gd-select--${size}`, className)}>
      <span className="gd-select__head">
        <label
          htmlFor={triggerId}
          className={clsx('gd-select__label', { 'gd-visually-hidden': hideLabel })}
        >
          {label}
        </label>
        {hint !== undefined && <span className="gd-select__hint">{hint}</span>}
      </span>
      <RadixSelect.Root
        value={value}
        onValueChange={(next) => {
          onValueChange((next === CLEAR ? '' : next) as V);
        }}
        disabled={isDisabled}
        open={isOpen}
        onOpenChange={(next) => {
          setInnerOpen(next);
          onOpenChange?.(next);
        }}
      >
        <RadixSelect.Trigger
          id={triggerId}
          className="gd-select__trigger"
          aria-label={ariaLabel}
          title={disabledReason}
          data-placeholder={value === '' ? '' : undefined}
          {...(triggerTabIndex !== undefined && { tabIndex: triggerTabIndex })}
        >
          <RadixSelect.Value placeholder={placeholder ?? ''} />
          <RadixSelect.Icon className="gd-select__chevron">
            <Icon name="chevron-down" size={13} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            className="gd-select__content"
            position="popper"
            sideOffset={4}
            collisionPadding={8}
            {...(onCloseAutoFocus !== undefined && { onCloseAutoFocus })}
          >
            <RadixSelect.Viewport className="gd-select__viewport">
              {value !== '' && clearLabel !== undefined && (
                <RadixSelect.Item value={CLEAR} className="gd-select__item gd-select__item--clear">
                  <span className="gd-select__check" aria-hidden="true" />
                  <span className="gd-select__text">
                    <RadixSelect.ItemText>{clearLabel}</RadixSelect.ItemText>
                  </span>
                </RadixSelect.Item>
              )}
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
              {options.length === 0 && emptyText !== undefined && (
                <div className="gd-select__empty" role="note">
                  {emptyText}
                </div>
              )}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
