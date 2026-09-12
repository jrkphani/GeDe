import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element; the tooltip attaches via `asChild`. */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
}

/** Wrap the app once so tooltips share a delay group. */
export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="gd-tooltip"
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
