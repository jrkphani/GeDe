import * as RadioGroup from '@radix-ui/react-radio-group';
import clsx from 'clsx';
import type { KeyboardEvent, ReactNode } from 'react';

export interface RadioCardOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A sentence beneath the label. */
  description?: ReactNode | undefined;
  /** A short mono sign at the right of the label (`A × B`); decorative, hidden from assistive technology. */
  glyph?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

export interface RadioCardsProps<V extends string> {
  /** Accessible name for the group. */
  label: string;
  options: readonly RadioCardOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /**
   * Enter on a card (Radix keeps Enter from checking a radio, per the ARIA pattern):
   * a dialog's confirm, so a preselected choice is one key away.
   */
  onEnter?: (() => void) | undefined;
  /** `grid` lays the cards out two across where there is room; `list` stacks them. */
  layout?: 'grid' | 'list' | undefined;
  className?: string | undefined;
}

/**
 * One choice from a few that each need a sentence (the kind of a table, the shape of a
 * product): a Radix radio group drawn as cards. Tab lands on the checked card, the arrows
 * move the selection, Space checks; the checked card carries a heavier border and a filled
 * mark, never colour alone.
 */
export function RadioCards<V extends string>({
  label,
  options,
  value,
  onChange,
  onEnter,
  layout = 'list',
  className,
}: RadioCardsProps<V>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onEnter === undefined || event.nativeEvent.isComposing) return;
    if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return;
    event.preventDefault();
    onEnter();
  };
  return (
    <RadioGroup.Root
      className={clsx('gd-radio-cards', `gd-radio-cards--${layout}`, className)}
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        onChange(next as V);
      }}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="gd-radio-cards__item"
          disabled={o.disabled}
        >
          <span className="gd-radio-cards__mark" aria-hidden="true">
            <RadioGroup.Indicator className="gd-radio-cards__dot" />
          </span>
          <span className="gd-radio-cards__text">
            <span className="gd-radio-cards__head">
              <span className="gd-radio-cards__label">{o.label}</span>
              {o.glyph !== undefined && (
                <span className="gd-radio-cards__glyph" aria-hidden="true">
                  {o.glyph}
                </span>
              )}
            </span>
            {o.description !== undefined && (
              <span className="gd-radio-cards__description">{o.description}</span>
            )}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
