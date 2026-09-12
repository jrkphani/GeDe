import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type DialogVariant = 'modal' | 'sheet';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the dialog. Name the object: "Delete Work-Force?", not "Delete this item?". */
  title: ReactNode;
  description?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** Action row; buttons are verbs. */
  actions?: ReactNode | undefined;
  /** Element that opened the dialog; focus returns to it on close (Radix handles the trap). */
  trigger?: ReactNode | undefined;
  /** `modal` (centred, for blocking decisions) or `sheet` (edge panel, for share/settings). */
  variant?: DialogVariant | undefined;
  /**
   * Where focus goes on close. By default Radix returns it to whatever was
   * focused when the dialog opened; pass an element when the opener is gone by
   * then (a menu item that closed with its menu), so focus lands on its trigger.
   */
  returnFocusTo?: HTMLElement | null | undefined;
  className?: string | undefined;
}

/**
 * Modal dialog for blocking decisions, or a sheet for share and settings:
 * focus trapped, Escape closes, focus returns to the trigger. Enter motion is
 * the longest in the system (300 ms).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  trigger,
  variant = 'modal',
  returnFocusTo,
  className,
}: DialogProps) {
  const onCloseAutoFocus = (event: Event) => {
    if (!returnFocusTo?.isConnected) return;
    event.preventDefault();
    returnFocusTo.focus();
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger !== undefined && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="gd-dialog__overlay" />
        <RadixDialog.Content
          className={clsx('gd-dialog', `gd-dialog--${variant}`, className)}
          data-variant={variant}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <RadixDialog.Title className="gd-dialog__title">{title}</RadixDialog.Title>
          {description !== undefined ? (
            <RadixDialog.Description className="gd-dialog__description">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="gd-visually-hidden">
              {title}
            </RadixDialog.Description>
          )}
          {children !== undefined && <div className="gd-dialog__body">{children}</div>}
          {actions !== undefined && <div className="gd-dialog__actions">{actions}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
