import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/*
 * Swatch primitives (issue 019) — the colored square that represents a
 * dimension's data color (STYLE_GUIDE principle 3: color is data, so the fill
 * stays an inline style). `Swatch` is display-only; `SwatchButton` is the
 * interactive form (dimension color trigger, palette picker options).
 */
export function Swatch({
  color,
  className,
  ...props
}: { color?: string } & HTMLAttributes<HTMLSpanElement>) {
  // color may be absent (ComboboxOption.color is optional) — matches the prior
  // `style={{ background: undefined }}`, i.e. no fill, rather than dropping the
  // square, so grid rows keep their alignment.
  return <span className={cn('swatch', className)} style={{ background: color }} {...props} />
}

export function SwatchButton({
  color,
  className,
  ...props
}: { color: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn('swatch', className)} style={{ background: color }} {...props} />
  )
}
