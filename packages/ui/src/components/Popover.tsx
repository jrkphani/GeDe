import * as RadixPopover from '@radix-ui/react-popover';
import clsx from 'clsx';
import { useMemo, type ReactNode } from 'react';

export interface PopoverProps {
  open: boolean;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * What the surface anchors to. Pass an element (a cell editor, a caret
   * marker) when the popover is not opened by a trigger of its own; otherwise
   * pass `trigger`.
   */
  anchor?: Element | null | undefined;
  /** A trigger element; receives the popover's ARIA wiring via `asChild`. */
  trigger?: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  align?: 'start' | 'center' | 'end' | undefined;
  /** Accessible name of the surface. */
  label?: string | undefined;
  /**
   * Keep focus where it is when the surface opens (default true). An
   * autocomplete or forms menu must not take the keyboard away from the
   * editor it annotates; the host handles ↑ ↓ ⏎ ⎋ and forwards them.
   */
  keepFocus?: boolean | undefined;
  /**
   * With `keepFocus` false: where focus goes on close. By default Radix
   * returns it to whatever was focused on open; pass an element when the
   * opener is gone by then (a menu item that closed with its menu), so focus
   * lands on that menu's trigger (MENU-05).
   */
  returnFocusTo?: HTMLElement | null | undefined;
  className?: string | undefined;
}

/**
 * Popover on Radix: anchored, flips before leaving the viewport, Escape and
 * outside-pointer close it. Unlike `Menu` it never moves focus unless asked,
 * so it can annotate a text editor while the person keeps typing.
 */
export function Popover({
  open,
  onOpenChange,
  anchor,
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  label,
  keepFocus = true,
  returnFocusTo,
  className,
}: PopoverProps) {
  const virtualRef = useMemo(
    () =>
      anchor === null || anchor === undefined
        ? null
        : { current: { getBoundingClientRect: () => anchor.getBoundingClientRect() } },
    [anchor],
  );
  return (
    <RadixPopover.Root open={open} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      {virtualRef !== null && <RadixPopover.Anchor virtualRef={virtualRef} />}
      {trigger !== undefined && <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>}
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={clsx('gd-popover', className)}
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          onOpenAutoFocus={(e) => {
            if (keepFocus) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            if (keepFocus) {
              e.preventDefault();
              return;
            }
            if (returnFocusTo?.isConnected) {
              e.preventDefault();
              returnFocusTo.focus();
            }
          }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
