import * as RadixContextMenu from '@radix-ui/react-context-menu';
import clsx from 'clsx';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { MenuEntries, type MenuEntry, type MenuParts } from './menu-entries.js';

export interface ContextMenuProps {
  /**
   * The region the menu serves; receives the menu's wiring via `asChild`.
   * Right-click, long-press (RESP-03) and the keyboard chords below open it.
   */
  trigger: ReactNode;
  entries: readonly MenuEntry[];
  /** Accessible name for the menu surface. */
  label?: string | undefined;
  /** No menu at all — phone is read-only (RESP-02), so nothing opens there. */
  disabled?: boolean | undefined;
  /** Called with the open state; the app resolves what was hit in the trigger's own handlers. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * Where focus goes on close (MENU-05). Called with the element that had
   * focus when the menu opened; return it, another element, or null to let
   * Radix decide. A command that moved the selection returns the new cell.
   */
  returnFocus?: ((opener: HTMLElement | null) => HTMLElement | null) | undefined;
  className?: string | undefined;
}

const PARTS: MenuParts = {
  Item: RadixContextMenu.Item,
  CheckboxItem: RadixContextMenu.CheckboxItem,
  RadioGroup: RadixContextMenu.RadioGroup,
  RadioItem: RadixContextMenu.RadioItem,
  ItemIndicator: RadixContextMenu.ItemIndicator,
  Separator: RadixContextMenu.Separator,
  Group: RadixContextMenu.Group,
  Label: RadixContextMenu.Label,
};

/**
 * Is this keydown the keyboard's "open the context menu" gesture? Physical
 * keys only (KEYS, I18N-02): Shift+F10 everywhere, and the dedicated
 * ContextMenu key where the keyboard has one.
 */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'code' | 'shiftKey'>): boolean {
  return event.code === 'ContextMenu' || (event.code === 'F10' && event.shiftKey);
}

/**
 * Context menu on Radix: opens at the pointer on right-click or long-press,
 * and from the keyboard (Shift+F10 / ContextMenu key) at the focused
 * element; Escape or a click outside closes it and focus returns to the
 * element that had it (MENU-05). Entries render through the same skin as
 * `Menu`, so disabled commands are shown with their reason, never hidden
 * (MENU-02).
 */
export function ContextMenu({
  trigger,
  entries,
  label,
  disabled,
  onOpenChange,
  returnFocus,
  className,
}: ContextMenuProps) {
  // MENU-05: Radix returns focus to its trigger, which here is a whole region;
  // the element that actually had focus (a cell, a header) is what should get it back.
  const opener = useRef<HTMLElement | null>(null);
  const remember = () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  };
  return (
    <RadixContextMenu.Root
      // Non-modal: nothing behind it is aria-hidden (a focused cell would then be a
      // hidden-but-focusable element, axe `aria-hidden-focus`); a click outside both
      // closes the menu and lands where it was aimed, as desktop menus do.
      modal={false}
      onOpenChange={(open) => {
        if (open) remember();
        onOpenChange?.(open);
      }}
    >
      <RadixContextMenu.Trigger
        asChild
        disabled={disabled === true}
        onKeyDown={(event) => {
          if (disabled === true || event.defaultPrevented || !isContextMenuKey(event)) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          event.preventDefault(); // Chrome would otherwise fire its own contextmenu for Shift+F10
          event.stopPropagation();
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }),
          );
        }}
      >
        {trigger}
      </RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className={clsx('gd-menu', className)}
          collisionPadding={8}
          aria-label={label}
          // A long menu scrolls inside 82vh; the region itself is then focusable so it can be
          // scrolled from the keyboard (axe `scrollable-region-focusable`). Radix still keeps
          // Tab inside the menu and moves through items with the arrows.
          tabIndex={0}
          onCloseAutoFocus={(event) => {
            const el = returnFocus === undefined ? opener.current : returnFocus(opener.current);
            if (!el?.isConnected) return;
            event.preventDefault();
            el.focus({ preventScroll: true });
          }}
        >
          <MenuEntries parts={PARTS} entries={entries} />
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
