import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

/*
 * Popover primitive (issue 019) — the single wrapper over Radix Popover so no
 * component imports @radix-ui/react-popover directly (Phase 3 lint enforces
 * this). PopoverContent bundles the Portal, applies the app's `.popover` chrome
 * (single shadow token, zero radius — STYLE_GUIDE §4) and sensible defaults.
 */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
// Anchor without a toggle: for popovers whose open state is controlled
// externally (e.g. the delete-with-link resolution opens only when the store
// reports a linked parameter — issue 014), positioned against a plain button.
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn('popover', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
