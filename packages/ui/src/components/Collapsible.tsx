import * as RadixCollapsible from '@radix-ui/react-collapsible';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface CollapsibleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A single button; Radix wires `aria-expanded` and `aria-controls` onto it. */
  trigger: ReactNode;
  children: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
}

/**
 * Disclosure on Radix Collapsible: the trigger announces its expanded state,
 * the content is removed from the tree when closed (no hidden tab stops).
 */
export function Collapsible({
  open,
  onOpenChange,
  trigger,
  children,
  className,
  contentClassName,
}: CollapsibleProps) {
  return (
    <RadixCollapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className={clsx('gd-collapsible', className)}
    >
      <RadixCollapsible.Trigger asChild>{trigger}</RadixCollapsible.Trigger>
      <RadixCollapsible.Content className={clsx('gd-collapsible__content', contentClassName)}>
        {children}
      </RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}
