import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { MenuEntries, type MenuEntry, type MenuParts } from './menu-entries.js';

export type { MenuEntry, MenuRadioOption } from './menu-entries.js';

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

const PARTS: MenuParts = {
  Item: DropdownMenu.Item,
  CheckboxItem: DropdownMenu.CheckboxItem,
  RadioGroup: DropdownMenu.RadioGroup,
  RadioItem: DropdownMenu.RadioItem,
  ItemIndicator: DropdownMenu.ItemIndicator,
  Separator: DropdownMenu.Separator,
  Group: DropdownMenu.Group,
  Label: DropdownMenu.Label,
};

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
          <MenuEntries parts={PARTS} entries={entries} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
