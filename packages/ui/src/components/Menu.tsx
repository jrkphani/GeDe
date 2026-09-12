import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { ReactNode } from 'react';

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
  | { kind: 'separator'; id: string };

export interface MenuProps {
  /** The trigger element; receives the menu's ARIA wiring via `asChild`. */
  trigger: ReactNode;
  entries: readonly MenuEntry[];
  align?: 'start' | 'center' | 'end' | undefined;
  /** Accessible name for the menu surface. */
  label?: string | undefined;
  className?: string | undefined;
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

/**
 * Dropdown menu on Radix: anchors to the trigger, flips before leaving the
 * viewport, Escape closes and focus returns to the trigger, arrows move,
 * typeahead works. Checkmark left, shortcut right, disabled shown never hidden.
 */
export function Menu({ trigger, entries, align = 'start', label, className }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={clsx('gd-menu', className)}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
        >
          {entries.map((e) => {
            if (e.kind === 'separator')
              return <DropdownMenu.Separator key={e.id} className="gd-menu__separator" />;
            const disabled = e.disabledReason !== undefined;
            const common = {
              className: clsx('gd-menu__item', {
                'gd-menu__item--danger': e.kind === 'item' && e.danger === true,
              }),
              disabled,
              title: e.disabledReason,
              'aria-disabled': disabled || undefined,
            };
            const body = (
              <>
                <span className="gd-menu__lead">
                  {e.kind === 'check' && (
                    <DropdownMenu.ItemIndicator>
                      <Check />
                    </DropdownMenu.ItemIndicator>
                  )}
                </span>
                <span className="gd-menu__label">{e.label}</span>
                {e.shortcut !== undefined && <kbd className="gd-menu__shortcut">{e.shortcut}</kbd>}
              </>
            );
            return e.kind === 'check' ? (
              <DropdownMenu.CheckboxItem
                key={e.id}
                checked={e.checked}
                onCheckedChange={e.onCheckedChange}
                {...common}
              >
                {body}
              </DropdownMenu.CheckboxItem>
            ) : (
              <DropdownMenu.Item key={e.id} onSelect={e.onSelect} {...common}>
                {body}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
