import { cn } from '@/lib/utils'

/*
 * Quiet keyboard-shortcut hint (issue 084 Direction 3 P5). A small, decorative
 * `<kbd>`-cap chip that makes the keyboard-fast editing grammar discoverable
 * without a manual — honoring the drafting-table identity (STYLE_GUIDE: "a
 * precision instrument, not a dashboard" — quiet until relevant, never always-on
 * chrome). Callers reveal it on focus/hover (see base.css `.t2-add-table` /
 * `.grid-cell__phantom` focus-within rules) or render it only while a cell is
 * actively editing (EditableGrid).
 *
 * Purely visual: the root is `aria-hidden`, because the real shortcut is already
 * announced by the labeled control the hint sits beside (an input's aria-label,
 * a cell editor). The hint therefore adds ZERO screen-reader noise. All styling
 * lives on the `.key-hint` / `.key-hint__cap` classes in base.css using design
 * tokens only (no raw px, no inline styles, no `::after content` key-caps).
 */
export interface KeyHintProps {
  /** Each entry renders as its own `<kbd>` cap, e.g. `['⌘', '⏎']` or `['Tab']`. */
  keys: string[]
  className?: string
}

export function KeyHint({ keys, className }: KeyHintProps) {
  return (
    <span className={cn('key-hint', className)} aria-hidden="true">
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className="key-hint__cap">
          {key}
        </kbd>
      ))}
    </span>
  )
}
