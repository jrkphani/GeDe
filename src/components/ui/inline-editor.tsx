import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
 *
 * Issue 082 (Phase 1) — EditableChain: a lightweight ordered-focus registry so
 * a linear list of InlineEdit/PhantomInput fields (e.g. the dimension rail:
 * dimension name -> its parameter names -> its own phantom -> next dimension)
 * gets the same commit-then-move grammar EditableGrid already has for its 2D
 * cell matrix (EditableGrid.tsx `nextEditableCell`/`advance`) — Enter moves
 * down, Tab moves right, Shift+Tab moves left, arrow keys walk the (unedited)
 * display nodes, and Tab-from-a-phantom can continue into a row that doesn't
 * exist yet (`focusWhenReady`). Deliberately NOT a copy of EditableGrid's 2D
 * nav — this list is a single ordered chain, so "down"/"right" and "up"/"left"
 * are synonyms (next/previous); callers pick whichever reads naturally.
 */

export type ChainDirection = 'down' | 'up' | 'right' | 'left'

interface ChainEntry {
  focus: () => void
  /** Opens edit mode instead of merely focusing the display node — omitted
   *  by PhantomInput, which is always "open" already. */
  startEditing?: () => void
}

interface EditableChainContextValue {
  register: (id: string, entry: ChainEntry) => () => void
  /** Moves from `fromId` in `dir`. `edit` (default true) opens the target's
   *  editor when it has one — Enter/Tab callers want that (EditableGrid's own
   *  `advance` always opens a text/mono/multiline target); arrow-key nav on a
   *  resting display passes `edit: false` so it only moves focus, matching
   *  EditableGrid's `handleGridArrowKeys` (never opens the cell). */
  advance: (fromId: string, dir: ChainDirection, edit?: boolean) => void
  /** Focuses (and, unless `edit` is false, edits) `id` immediately if it's
   *  already registered; otherwise remembers it and activates it the moment
   *  it registers (Tab-from-phantom into a row that's still being created —
   *  the phantom's onSubmit is async). */
  focusWhenReady: (id: string, edit?: boolean) => void
}

const EditableChainContext = createContext<EditableChainContextValue | null>(null)

interface Pending {
  id: string
  edit: boolean
}

/** Wrap a linear group of chain-aware InlineEdit/PhantomInput fields. `order`
 *  is the full, current nav sequence of chain ids (recomputed by the caller
 *  every render from live data — e.g. dimensions -> their params -> phantoms)
 *  so newly created/removed rows are always reflected without extra wiring. */
export function EditableChainProvider({ order, children }: { order: string[]; children: ReactNode }) {
  const entries = useRef(new Map<string, ChainEntry>())
  const pending = useRef<Pending | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order

  const activate = useCallback((entry: ChainEntry, edit: boolean) => {
    if (edit && entry.startEditing) entry.startEditing()
    else entry.focus()
  }, [])

  const register = useCallback(
    (id: string, entry: ChainEntry) => {
      entries.current.set(id, entry)
      if (pending.current?.id === id) {
        const { edit } = pending.current
        pending.current = null
        activate(entry, edit)
      }
      return () => {
        if (entries.current.get(id) === entry) entries.current.delete(id)
      }
    },
    [activate],
  )

  const advance = useCallback(
    (fromId: string, dir: ChainDirection, edit = true) => {
      const order_ = orderRef.current
      const idx = order_.indexOf(fromId)
      if (idx === -1) return
      const step = dir === 'down' || dir === 'right' ? 1 : -1
      const targetId = order_[idx + step]
      // No target (start/end of the chain): stay put rather than stranding
      // focus — mirrors EditableGrid's advance(null, ...) no-op.
      if (targetId === undefined) return
      const entry = entries.current.get(targetId)
      if (entry) activate(entry, edit)
      else pending.current = { id: targetId, edit }
    },
    [activate],
  )

  const focusWhenReady = useCallback(
    (id: string, edit = true) => {
      const entry = entries.current.get(id)
      if (entry) activate(entry, edit)
      else pending.current = { id, edit }
    },
    [activate],
  )

  const value = useMemo(() => ({ register, advance, focusWhenReady }), [register, advance, focusWhenReady])
  return <EditableChainContext.Provider value={value}>{children}</EditableChainContext.Provider>
}

export function useEditableChain(): EditableChainContextValue | null {
  return useContext(EditableChainContext)
}

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
  // Issue 082 Phase 1 — this field's stable id in the enclosing
  // EditableChainProvider's `order`. Omit to keep the pre-082 standalone
  // behavior (Enter/Esc/blur only, no advance, no arrow-nav, no chain
  // discoverability tell change beyond the always-on hover/focus underline).
  chainId?: string
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
  chainId,
}: InlineEditProps) {
  const [internalEditing, setInternalEditing] = useState(false)
  const controlled = editingProp !== undefined
  const editing = !readOnly && (controlled ? editingProp : internalEditing)
  const setEditing = (next: boolean) => {
    if (controlled) onEditingChange?.(next)
    else setInternalEditing(next)
  }
  const [draft, setDraft] = useState(value)
  const spanRef = useRef<HTMLSpanElement>(null)
  const chain = useEditableChain()

  // Issue 082 Phase 1 — register this field into the chain so Enter/Tab from
  // elsewhere (or a Tab-from-phantom continuation) can land here. Re-registers
  // whenever the chain identity/id changes so a reordered/renamed row is
  // always reachable under its current id.
  useEffect(() => {
    if (!chain || !chainId || readOnly) return
    return chain.register(chainId, {
      focus: () => spanRef.current?.focus(),
      startEditing: () => {
        setDraft(value)
        setEditing(true)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, chainId, readOnly, value])

  function startEditingFromDisplay(e: { stopPropagation: () => void }) {
    if (stopPropagation) e.stopPropagation()
    setDraft(value)
    setEditing(true)
  }

  if (!editing) {
    const chainNav = chain && chainId && !readOnly
    return (
      <span
        ref={spanRef}
        className={cn(!readOnly && 'inline-edit-display', displayClassName)}
        tabIndex={chainNav ? 0 : undefined}
        onClick={
          readOnly
            ? undefined
            : (e) => {
                if (stopPropagation) e.stopPropagation()
                setDraft(value)
                setEditing(true)
              }
        }
        onKeyDown={
          chainNav
            ? (e) => {
                if (e.metaKey || e.ctrlKey || e.altKey) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  startEditingFromDisplay(e)
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  chain.advance(chainId, e.key === 'ArrowDown' ? 'down' : 'right', false)
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  chain.advance(chainId, e.key === 'ArrowUp' ? 'up' : 'left', false)
                }
              }
            : undefined
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
          if (chain && chainId) chain.advance(chainId, 'down')
        } else if (e.key === 'Tab' && chain && chainId) {
          e.preventDefault()
          const next = draft.trim()
          if (next && next !== value) onCommit(next)
          setEditing(false)
          chain.advance(chainId, e.shiftKey ? 'left' : 'right')
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
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
  // Issue 082 Phase 1 — this phantom's stable id in the enclosing
  // EditableChainProvider's `order`. Omit to keep the pre-082 standalone
  // behavior (Enter creates + self-refocuses; Tab is native).
  chainId?: string
  /** Overrides Tab-with-content's default (create via `onSubmit`, then
   *  self-refocus — EditableGrid's own single-column phantom fallback,
   *  EditableGrid.tsx:744-745) — used by the dimension phantom to continue
   *  into the freshly created row's OWN phantom instead (Numbers/Excel
   *  "Tab creates a row and continues into it"). Receives the trimmed value;
   *  the caller is responsible for creating the row and calling
   *  `chain.focusWhenReady(...)` on its successor once known. */
  onTabSubmit?: (value: string) => void
}

export function PhantomInput({
  placeholder,
  onSubmit,
  inputClassName,
  ariaLabel,
  stopPropagation = false,
  chainId,
  onTabSubmit,
}: PhantomInputProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // A ref, not state: it must be readable synchronously within the very next
  // keydown, which state (batched, re-render-dependent) can't guarantee.
  const submittingRef = useRef(false)
  const chain = useEditableChain()

  useEffect(() => {
    if (!chain || !chainId) return
    return chain.register(chainId, { focus: () => inputRef.current?.focus() })
  }, [chain, chainId])

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
        } else if (e.key === 'Escape') {
          setDraft('')
        } else if (e.key === 'Tab' && chain && chainId) {
          if (e.shiftKey) {
            // Go back to the previous chain field — mirrors EditableGrid's
            // phantom Shift+Tab ("previous row's last editable cell").
            e.preventDefault()
            chain.advance(chainId, 'left')
          } else if (draft.trim() && !submittingRef.current) {
            // Forward Tab with content: create, then continue (default:
            // self-refocus; a caller-supplied onTabSubmit can instead jump
            // into the new row it creates via chain.focusWhenReady).
            e.preventDefault()
            const value = draft.trim()
            submittingRef.current = true
            setDraft('')
            if (onTabSubmit) {
              onTabSubmit(value)
              submittingRef.current = false
            } else {
              inputRef.current?.focus()
              void Promise.resolve(onSubmit(value)).finally(() => {
                submittingRef.current = false
              })
            }
          }
          // Empty phantom + forward Tab: let native Tab move focus out,
          // rather than trapping the user on an empty phantom.
        }
      }}
    />
  )
}
