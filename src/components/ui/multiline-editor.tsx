import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/*
 * Multiline in-place editor (issue 009) — the auto-grow textarea grammar,
 * extracted for reuse outside `EditableGrid` for standalone prose fields that
 * aren't a grid cell (e.g. Foundation's purpose statement, FoundationSurface.tsx)
 * — bound by the "compose the shared primitives" lint rule `EditableGrid.tsx`
 * is explicitly exempted from. Modeled on `InlineEdit` (ui/inline-editor.tsx)
 * but deliberately NOT reusing it: unlike a name/label, this content is
 * nullable and clearable, so Enter must commit an emptied value too, not
 * refuse it.
 */
export interface MultilineEditProps {
  /** Current committed value (also the initial draft when editing starts). */
  value: string
  /** Called with the trimmed next value whenever it differs from `value` —
   *  including an emptied value (justification can be cleared). */
  onCommit: (next: string) => void
  /** Display content shown when not editing; clicking it enters edit mode. */
  display: ReactNode
  displayClassName?: string
  inputClassName?: string
  ariaLabel?: string
  // Issue 035 — a viewer's read-only affordance: the display renders, but
  // clicking it never enters edit mode. Defaults to false (every existing
  // caller — Composer's justification, Foundation's purpose — is unchanged).
  readOnly?: boolean
}

export function MultilineEdit({
  value,
  onCommit,
  display,
  displayClassName,
  inputClassName,
  ariaLabel,
  readOnly = false,
}: MultilineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const cancelling = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (editing && el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [editing, draft])

  function commit(next: string) {
    if (next !== value) onCommit(next)
    setEditing(false)
  }

  if (!editing || readOnly) {
    return (
      <span
        className={displayClassName}
        onClick={
          readOnly
            ? undefined
            : () => {
                setDraft(value)
                setEditing(true)
              }
        }
      >
        {display}
      </span>
    )
  }

  return (
    <textarea
      ref={textareaRef}
      className={cn('inplace-input', inputClassName)}
      rows={1}
      autoFocus
      aria-label={ariaLabel}
      onFocus={(e) => e.target.select()}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit(draft.trim())
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          cancelling.current = true
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      onBlur={() => {
        if (cancelling.current) {
          cancelling.current = false
          setEditing(false)
          return
        }
        commit(draft.trim())
      }}
    />
  )
}
