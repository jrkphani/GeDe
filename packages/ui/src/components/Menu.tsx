import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { useLayoutEffect, useState, type ReactNode } from 'react';

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
  const [open, setOpen] = useState(false);
  // A modal menu marks the rest of the page `aria-hidden` (Radix `hideOthers`) while the
  // page's own tab stops stay focusable — axe `aria-hidden-focus`, serious (#131). The same
  // elements are made `inert` for the duration, as `Select` does: Radix already keeps focus
  // inside the menu; this makes the DOM say so. A layout effect, so on close `inert` is gone
  // before Radix returns focus to the trigger, which sits inside the hidden subtree.
  useLayoutEffect(() => {
    if (!open || !modal || typeof document === 'undefined') return undefined;
    const touched: HTMLElement[] = [];
    const apply = (): void => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"]')) {
        if (el.inert) continue;
        el.inert = true;
        touched.push(el);
      }
    };
    // Radix marks the rest of the page once the content has mounted (a frame later than `open`).
    apply();
    const frame = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(frame);
      for (const el of touched) el.inert = false;
    };
  }, [open, modal]);
  return (
    <DropdownMenu.Root modal={modal} open={open} onOpenChange={setOpen}>
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
