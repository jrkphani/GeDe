import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/*
 * Input primitive (issue 020). A thin, unstyled-by-default `<input>` wrapper so
 * every input in the app flows through the ui/ layer (the no-restricted-syntax
 * rule forbids raw <input> elsewhere). Callers pass the app's seamless
 * `.inplace-input` classes; the InlineEdit/PhantomInput primitives cover the
 * common edit/create grammars — reach for Input directly only for bespoke cases
 * (e.g. the hex color field, which validates on its own).
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...props }, ref) {
    return <input ref={ref} type={type} className={cn(className)} {...props} />
  },
)
