import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/*
 * Inline-edit primitives (issue 019) — the single home for the Enter/Esc/blur
 * grammar that was duplicated across ProjectsList, ParameterList,
 * DimensionManager and EditableGrid. They own the behaviour; styling stays on
 * the existing seamless `.inplace-input` class (STYLE_GUIDE §6), which carries
 * per-context metric overrides in base.css.
 *
 * Two shapes:
 *  - InlineEdit    — click a display node to edit in place; Enter commits a
 *                    trimmed, changed, non-empty value, then exits; Esc/blur
 *                    cancel without committing.
 *  - PhantomInput  — a persistent "type to create" input; Enter submits a
 *                    trimmed non-empty value, clears, and refocuses; Esc clears.
 */

export interface InlineEditProps {
  /** Current committed value (also the initial draft when editing starts). */
  value: string
  /** Called with the trimmed next value only when it is non-empty and changed. */
  onCommit: (next: string) => void
  /** Display content shown when not editing; clicking it enters edit mode. */
  display: ReactNode
  /** Class on the display span. Kept configurable so callers preserve hooks
   *  like `.project-name` (targeted by the F2 shortcut) or `.param-row__name`. */
  displayClassName?: string
  /** Extra class on the input, in addition to `inplace-input`. */
  inputClassName?: string
  ariaLabel?: string
  /** Select the whole draft on focus (ParameterName / dimension rename do). */
  selectOnFocus?: boolean
  /** Stop click + keydown propagation — needed when an ancestor row is itself
   *  interactive (clickable project row, Alt+arrow reorder on the dim row). */
  stopPropagation?: boolean
  /** Controlled editing state. Omit for self-managed editing; provide both
   *  when editing must live elsewhere — e.g. DimensionManager keeps it in the
   *  store so add() can open a freshly-created row atomically (HANDOFF race). */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  // Issue 035 — a viewer's read-only affordance: the display renders, but
  // clicking it never enters edit mode. Defaults to false (every existing
  // caller is unchanged).
  readOnly?: boolean
}

export function InlineEdit({
  value,
  onCommit,
  display,
  displayClassName,
  inputClassName,
  ariaLabel,
  selectOnFocus = false,
  stopPropagation = false,
  editing: editingProp,
  onEditingChange,
  readOnly = false,
}: InlineEditProps) {
  const [internalEditing, setInternalEditing] = useState(false)
  const controlled = editingProp !== undefined
  const editing = !readOnly && (controlled ? editingProp : internalEditing)
  const setEditing = (next: boolean) => {
    if (controlled) onEditingChange?.(next)
    else setInternalEditing(next)
  }
  const [draft, setDraft] = useState(value)

  if (!editing) {
    return (
      <span
        className={displayClassName}
        onClick={
          readOnly
            ? undefined
            : (e) => {
                if (stopPropagation) e.stopPropagation()
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
    <input
      className={cn('inplace-input', inputClassName)}
      value={draft}
      aria-label={ariaLabel}
      autoFocus
      onFocus={selectOnFocus ? (e) => e.target.select() : undefined}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (stopPropagation) e.stopPropagation()
        if (e.key === 'Enter') {
          const next = draft.trim()
          if (next && next !== value) onCommit(next)
          setEditing(false)
        }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

export interface PhantomInputProps {
  placeholder: string
  /** Called with the trimmed value when the user commits a non-empty draft.
   *  May return a promise; while it is pending, a second Enter is a no-op
   *  (issue 069) — guards against an impatient double-submit (or a stray
   *  duplicate keydown) starting a second, independent create for the same
   *  input before the first has settled. */
  onSubmit: (value: string) => void | Promise<void>
  inputClassName?: string
  ariaLabel?: string
  stopPropagation?: boolean
}

export function PhantomInput({
  placeholder,
  onSubmit,
  inputClassName,
  ariaLabel,
  stopPropagation = false,
}: PhantomInputProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // A ref, not state: it must be readable synchronously within the very next
  // keydown, which state (batched, re-render-dependent) can't guarantee.
  const submittingRef = useRef(false)

  return (
    <input
      ref={inputRef}
      className={cn('inplace-input', inputClassName)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (stopPropagation) e.stopPropagation()
        if (e.key === 'Enter' && draft.trim() && !submittingRef.current) {
          const value = draft.trim()
          submittingRef.current = true
          setDraft('')
          inputRef.current?.focus()
          void Promise.resolve(onSubmit(value)).finally(() => {
            submittingRef.current = false
          })
        }
        if (e.key === 'Escape') setDraft('')
      }}
    />
  )
}
