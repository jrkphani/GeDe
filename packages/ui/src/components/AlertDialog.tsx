import * as RadixAlertDialog from '@radix-ui/react-alert-dialog';
import clsx from 'clsx';
import { useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button.js';

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the decision: "Permanently delete 3 workscapes?". */
  title: ReactNode;
  /**
   * Required: what happens and whether it can be undone. A permanent action
   * must say so here (LIB-D8), because nothing after this point does.
   */
  description: ReactNode;
  /** The verb on the confirming button, e.g. "Delete All". */
  actionLabel: string;
  onAction: () => void;
  /** `danger` for destruction (default); `primary` for an irreversible but benign step. */
  actionVariant?: Extract<ButtonVariant, 'danger' | 'primary'> | undefined;
  cancelLabel?: string | undefined;
  /**
   * Where focus goes on close. By default it returns to whatever was focused
   * when the dialog opened (the toolbar button); pass an element when that
   * opener is gone by then (a menu item that closed with its menu).
   */
  returnFocusTo?: HTMLElement | null | undefined;
  className?: string | undefined;
}

/**
 * A blocking confirmation for an action that cannot be undone. Unlike
 * `Dialog`, clicking outside does not dismiss it (Radix AlertDialog), focus
 * starts on Cancel so the destructive verb is never the default, Escape
 * cancels, and focus returns to the opener. Announced as `alertdialog`.
 * Shares the modal dialog's surface and motion.
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onAction,
  actionVariant = 'danger',
  cancelLabel = 'Cancel',
  returnFocusTo,
  className,
}: AlertDialogProps) {
  // Radix's modal content returns focus to its own Trigger, which this
  // component does not use (the opener is a toolbar button or a menu item),
  // so the opener is remembered here as the content mounts.
  const opener = useRef<HTMLElement | null>(null);
  const onOpenAutoFocus = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const onCloseAutoFocus = (event: Event) => {
    const target = returnFocusTo?.isConnected ? returnFocusTo : opener.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
  return (
    <RadixAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="gd-dialog__overlay" />
        <RadixAlertDialog.Content
          className={clsx('gd-dialog', 'gd-dialog--modal', 'gd-alert-dialog', className)}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <RadixAlertDialog.Title className="gd-dialog__title">{title}</RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="gd-dialog__description">
            {description}
          </RadixAlertDialog.Description>
          <div className="gd-dialog__actions">
            <RadixAlertDialog.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </RadixAlertDialog.Cancel>
            <RadixAlertDialog.Action asChild>
              <Button variant={actionVariant} onClick={onAction}>
                {actionLabel}
              </Button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
