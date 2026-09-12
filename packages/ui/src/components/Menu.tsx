import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { ReactNode } from 'react';

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

export interface MenuProps {
  /** The trigger element; receives the menu's ARIA wiring via `asChild`. */
  trigger: ReactNode;
  entries: readonly MenuEntry[];
  align?: 'start' | 'center' | 'end' | undefined;
  /** Accessible name for the menu surface. */
  label?: string | undefined;
  className?: string | undefined;
  /**
   * Fires as the menu closes, before focus returns to the trigger. Call
   * `event.preventDefault()` to send focus elsewhere — an item that opens a
   * panel hands focus to that panel rather than back to the trigger (MENU-05).
   */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /**
   * `true` (default) hides the rest of the page from assistive tech and blocks
   * pointer events outside while open, as a toolbar menu should. `false` for a
   * menu embedded in content (a column header's ▼): the page stays readable
   * and focusable around it, so an open menu leaves no `aria-hidden` element
   * holding a tab stop.
   */
  modal?: boolean | undefined;
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

/**
 * Dropdown menu on Radix: anchors to the trigger, flips before leaving the
 * viewport, Escape closes and focus returns to the trigger, arrows move,
 * typeahead works. Checkmark left, shortcut right, disabled shown never hidden.
 */
export function Menu({
  trigger,
  entries,
  align = 'start',
  label,
  className,
  onCloseAutoFocus,
  modal = true,
}: MenuProps) {
  return (
    <DropdownMenu.Root modal={modal}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={clsx('gd-menu', className)}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {entries.map((e) => {
            switch (e.kind) {
              case 'separator':
                return <DropdownMenu.Separator key={e.id} className="gd-menu__separator" />;
              case 'radio':
                return (
                  <DropdownMenu.Group key={e.id} className="gd-menu__group">
                    <DropdownMenu.Label className="gd-menu__heading">{e.label}</DropdownMenu.Label>
                    <DropdownMenu.RadioGroup value={e.value} onValueChange={e.onValueChange}>
                      {e.options.map((o) => (
                        <DropdownMenu.RadioItem
                          key={o.value}
                          value={o.value}
                          {...itemProps(o.disabledReason)}
                        >
                          <span className="gd-menu__lead">
                            <DropdownMenu.ItemIndicator>
                              <Check />
                            </DropdownMenu.ItemIndicator>
                          </span>
                          <span className="gd-menu__label">{o.label}</span>
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Group>
                );
              case 'check':
                return (
                  <DropdownMenu.CheckboxItem
                    key={e.id}
                    checked={e.checked}
                    onCheckedChange={e.onCheckedChange}
                    {...itemProps(e.disabledReason)}
                  >
                    <span className="gd-menu__lead">
                      <DropdownMenu.ItemIndicator>
                        <Check />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    <span className="gd-menu__label">{e.label}</span>
                    {e.shortcut !== undefined && (
                      <kbd className="gd-menu__shortcut">{e.shortcut}</kbd>
                    )}
                  </DropdownMenu.CheckboxItem>
                );
              case 'item':
                return (
                  <DropdownMenu.Item
                    key={e.id}
                    onSelect={e.onSelect}
                    {...itemProps(e.disabledReason, e.danger === true)}
                  >
                    <span className="gd-menu__lead" />
                    <span className="gd-menu__label">{e.label}</span>
                    {e.shortcut !== undefined && (
                      <kbd className="gd-menu__shortcut">{e.shortcut}</kbd>
                    )}
                  </DropdownMenu.Item>
                );
            }
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
