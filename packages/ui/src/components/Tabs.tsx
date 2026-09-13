import * as RadixTabs from '@radix-ui/react-tabs';
import clsx from 'clsx';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  content?: ReactNode | undefined;
  disabled?: boolean | undefined;
  /**
   * Rendered in the tab's place while it is being renamed inline (the sheet
   * strip's F2). A text field can be neither inside the tab button (a nested
   * interactive control) nor a child of the tablist (which may own only tabs,
   * WCAG 4.1.2 / axe `aria-required-children`), so the trigger steps aside
   * for an inert spacer and the editor sits over the spacer, outside the
   * list; the trigger comes back, with focus, when the editor unmounts.
   */
  editor?: ReactNode | undefined;
}

export interface TabsProps<V extends string> {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string | undefined;
}

interface Slot {
  left: number;
  width: number;
}

/** Switch a pane. Underline in forest, active label at 600 weight. */
export function Tabs<V extends string>({ label, items, value, onChange, className }: TabsProps<V>) {
  const editing = items.find((t) => t.editor !== undefined);
  const spacer = useRef<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  // Where the spacer landed, measured before paint so the editor is never seen elsewhere.
  useLayoutEffect(() => {
    const el = spacer.current;
    if (el === null) {
      setSlot(null);
      return;
    }
    setSlot({ left: el.offsetLeft, width: el.offsetWidth });
  }, [editing?.value]);
  return (
    <RadixTabs.Root
      className={clsx('gd-tabs', className)}
      value={value}
      onValueChange={(v) => {
        onChange(v as V);
      }}
    >
      <RadixTabs.List className="gd-tabs__list" aria-label={label}>
        {items.map((t) =>
          t.editor !== undefined ? (
            <div
              key={t.value}
              ref={spacer}
              className="gd-tabs__slot"
              aria-hidden="true"
              data-value={t.value}
            />
          ) : (
            <RadixTabs.Trigger
              key={t.value}
              value={t.value}
              className="gd-tabs__tab"
              disabled={t.disabled}
              data-value={t.value}
            >
              {t.label}
            </RadixTabs.Trigger>
          ),
        )}
      </RadixTabs.List>
      {editing !== undefined && (
        <div
          className="gd-tabs__editor"
          style={
            slot === null
              ? undefined
              : { left: `${String(slot.left)}px`, width: `${String(slot.width)}px` }
          }
        >
          {editing.editor}
        </div>
      )}
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
