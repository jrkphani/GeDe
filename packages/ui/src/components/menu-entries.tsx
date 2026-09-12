/**
 * One entry model, two Radix surfaces. `Menu` (dropdown, opened from a
 * trigger) and `ContextMenu` (opened at the pointer or from the keyboard)
 * render the same `MenuEntry[]` through the same skin (`Menu.css`), so a
 * command reads identically wherever it appears (MENU-01) and a disabled
 * command carries its reason in both (MENU-02).
 */
import clsx from 'clsx';
import type { ElementType, ReactNode } from 'react';

export interface MenuRadioOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabledReason?: string | undefined;
}

export type MenuEntry =
  | {
      kind: 'item';
      id: string;
      label: ReactNode;
      onSelect: () => void;
      /** Shown on the right in mono, e.g. "⌘C". Purely informational; the shortcut is bound elsewhere. */
      shortcut?: string | undefined;
      /** When set the item is shown disabled — never hidden — with this reason as its tooltip. */
      disabledReason?: string | undefined;
      /** Irreversible actions get the danger treatment. */
      danger?: boolean | undefined;
    }
  | {
      kind: 'check';
      id: string;
      label: ReactNode;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      shortcut?: string | undefined;
      disabledReason?: string | undefined;
    }
  | {
      /** Exactly one of `options` is on; a heading names the group. */
      kind: 'radio';
      id: string;
      label: ReactNode;
      value: string;
      onValueChange: (value: string) => void;
      options: readonly MenuRadioOption[];
    }
  | { kind: 'separator'; id: string };

/**
 * The Radix parts both menu packages export under the same names. Typed as
 * `ElementType` on purpose: the two packages declare structurally identical
 * but nominally distinct prop types, and this renderer passes only the
 * subset they share.
 */
export interface MenuParts {
  Item: ElementType;
  CheckboxItem: ElementType;
  RadioGroup: ElementType;
  RadioItem: ElementType;
  ItemIndicator: ElementType;
  Separator: ElementType;
  Group: ElementType;
  Label: ElementType;
}

function Check() {
  return (
    <svg
      className="gd-menu__check"
      viewBox="0 0 18 18"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 9.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

function itemProps(disabledReason: string | undefined, danger = false) {
  const disabled = disabledReason !== undefined;
  return {
    className: clsx('gd-menu__item', { 'gd-menu__item--danger': danger }),
    disabled,
    title: disabledReason,
    'aria-disabled': disabled || undefined,
  };
}

export function MenuEntries({
  parts,
  entries,
}: {
  parts: MenuParts;
  entries: readonly MenuEntry[];
}) {
  const { Item, CheckboxItem, RadioGroup, RadioItem, ItemIndicator, Separator, Group, Label } =
    parts;
  return (
    <>
      {entries.map((e) => {
        switch (e.kind) {
          case 'separator':
            return <Separator key={e.id} className="gd-menu__separator" />;
          case 'radio':
            return (
              <Group key={e.id} className="gd-menu__group">
                <Label className="gd-menu__heading">{e.label}</Label>
                <RadioGroup value={e.value} onValueChange={e.onValueChange}>
                  {e.options.map((o) => (
                    <RadioItem key={o.value} value={o.value} {...itemProps(o.disabledReason)}>
                      <span className="gd-menu__lead">
                        <ItemIndicator>
                          <Check />
                        </ItemIndicator>
                      </span>
                      <span className="gd-menu__label">{o.label}</span>
                    </RadioItem>
                  ))}
                </RadioGroup>
              </Group>
            );
          case 'check':
            return (
              <CheckboxItem
                key={e.id}
                checked={e.checked}
                onCheckedChange={e.onCheckedChange}
                {...itemProps(e.disabledReason)}
              >
                <span className="gd-menu__lead">
                  <ItemIndicator>
                    <Check />
                  </ItemIndicator>
                </span>
                <span className="gd-menu__label">{e.label}</span>
                {e.shortcut !== undefined && <kbd className="gd-menu__shortcut">{e.shortcut}</kbd>}
              </CheckboxItem>
            );
          case 'item':
            return (
              <Item
                key={e.id}
                onSelect={e.onSelect}
                {...itemProps(e.disabledReason, e.danger === true)}
              >
                <span className="gd-menu__lead" />
                <span className="gd-menu__label">{e.label}</span>
                {e.shortcut !== undefined && <kbd className="gd-menu__shortcut">{e.shortcut}</kbd>}
              </Item>
            );
        }
      })}
    </>
  );
}
