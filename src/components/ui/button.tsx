import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * Shared button primitive (issue 019). shadcn-shaped: cva variants + forwardRef
 * + className merge via cn(). Variants map to the app's existing chrome classes
 * in base.css rather than re-styling with utilities, because those classes carry
 * contextual cascade rules the hand-rolled buttons depend on — e.g.
 * `.project-row:hover .row-action` reveals the Archive action. Keeping the class
 * preserves pixel parity; new variants can use Tailwind utilities directly.
 */
export const buttonVariants = cva('', {
  variants: {
    variant: {
      rowAction: 'row-action',
      // No chrome of its own — for buttons that carry a bespoke class
      // (e.g. the dnd drag handle) but must still be a real <button> primitive.
      bare: '',
      // The one destructive action in the app (issue 007: dimension remove
      // confirm) — same shape as rowAction, recolored via the Tailwind bridge
      // to --danger (theme-bridge.css), never a hardcoded color.
      danger: 'row-action bg-destructive text-destructive-foreground border-destructive hover:opacity-90',
    },
  },
  defaultVariants: { variant: 'rowAction' },
})

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
  )
})
