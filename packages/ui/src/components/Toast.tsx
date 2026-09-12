import * as RadixToast from '@radix-ui/react-toast';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface ToastProviderProps {
  children: ReactNode;
  /** Auto-dismiss in ms; reversible actions stay long enough to undo. */
  duration?: number | undefined;
}

/** Mount once near the app root; hosts the viewport in the bottom-left corner. */
export function ToastProvider({ children, duration = 6000 }: ToastProviderProps) {
  return (
    <RadixToast.Provider duration={duration} swipeDirection="down" label="Notification">
      {children}
      <RadixToast.Viewport className="gd-toast__viewport" />
    </RadixToast.Provider>
  );
}

export interface ToastProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Reversible actions expose Undo; the label is the verb, in amber. */
  undo?: { label?: string | undefined; onUndo: () => void } | undefined;
  className?: string | undefined;
}

/** Reversible and transient. Dark ink surface, white text, Undo in amber-100. */
export function Toast({ open, onOpenChange, title, description, undo, className }: ToastProps) {
  return (
    <RadixToast.Root
      className={clsx('gd-toast', className)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="gd-toast__text">
        <RadixToast.Title className="gd-toast__title">{title}</RadixToast.Title>
        {description !== undefined && (
          <RadixToast.Description className="gd-toast__description">
            {description}
          </RadixToast.Description>
        )}
      </div>
      {undo !== undefined && (
        <RadixToast.Action asChild altText={`${undo.label ?? 'Undo'} the last change`}>
          <button type="button" className="gd-toast__undo" onClick={undo.onUndo}>
            {undo.label ?? 'Undo'}
          </button>
        </RadixToast.Action>
      )}
      <RadixToast.Close className="gd-toast__close" aria-label="Dismiss">
        ×
      </RadixToast.Close>
    </RadixToast.Root>
  );
}
