import * as RadixTabs from '@radix-ui/react-tabs';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  content?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

export interface TabsProps<V extends string> {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string | undefined;
}

/** Switch a pane. Underline in forest, active label at 600 weight. */
export function Tabs<V extends string>({ label, items, value, onChange, className }: TabsProps<V>) {
  return (
    <RadixTabs.Root
      className={clsx('gd-tabs', className)}
      value={value}
      onValueChange={(v) => {
        onChange(v as V);
      }}
    >
      <RadixTabs.List className="gd-tabs__list" aria-label={label}>
        {items.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            className="gd-tabs__tab"
            disabled={t.disabled}
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((t) =>
        t.content !== undefined ? (
          <RadixTabs.Content key={t.value} value={t.value} className="gd-tabs__panel">
            {t.content}
          </RadixTabs.Content>
        ) : (
          // A trigger always names its panel (`aria-controls`), so a tab that switches
          // something outside the component (the sheet strip) still gets a panel: empty,
          // and out of the tab order (WCAG 4.1.2, axe aria-valid-attr-value).
          <RadixTabs.Content
            key={t.value}
            value={t.value}
            className="gd-tabs__panel gd-tabs__panel--empty"
            tabIndex={-1}
          />
        ),
      )}
    </RadixTabs.Root>
  );
}
