import { useEffect, useId, useRef, useState } from 'react'
import {
  $createParagraphNode,
  $getRoot,
  COMMAND_PRIORITY_NORMAL,
  FORMAT_TEXT_COMMAND,
  KEY_DOWN_COMMAND,
  type EditorState,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { cn } from '@/lib/utils'
import { RICH_TEXT_NODES, safeRichTextJson } from '../../domain/richText'
import { useFocusedEditorStore } from '../../store/focusedEditor'

/*
 * Rich-text editor primitive (issue 081) — Lexical, storing the editor's own
 * serialized JSON (JSON.stringify(editorState.toJSON())), never HTML. This is
 * the ONE new UI primitive this issue introduces; see docs/issues/081-tier1-
 * existing-scenario-rich-text.md's "Rich-text library decision" for the full
 * why-Lexical justification and src/domain/richText.ts for the security
 * boundary (RICH_TEXT_NODES whitelist + the parse guard this component uses
 * on every external value it's handed).
 *
 * Interaction contract (013/mirrors MultilineEdit, but this editor is always
 * "live" — no click-to-edit toggle, since a contentEditable region already
 * serves as both display and edit surface): commits happen ON BLUR, not per
 * keystroke — one gesture (focus -> format/type -> blur) is one commit, one
 * command-log undo step, matching multiline-editor.tsx's own blur-commit
 * contract. A readOnly instance mounts the SAME restricted node set but is
 * never editable and never shows the toolbar (013/035 precedent).
 */

function isEmptyEditorState(editorState: EditorState): boolean {
  let empty = true
  editorState.read(() => {
    empty = $getRoot().getTextContent().trim().length === 0
  })
  return empty
}

// Returns the committed shape: null for an empty editor (the schema's
// legitimate "not written yet" state — see schema.ts's existingScenario
// comment), else the editor's own serialized JSON.
function serializeForCommit(editorState: EditorState): string | null {
  if (isEmptyEditorState(editorState)) return null
  return JSON.stringify(editorState.toJSON())
}

function resetToEmptyParagraph(editor: LexicalEditor): void {
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    root.append($createParagraphNode())
  })
}

// Cmd/Ctrl+B/I/U — NOT wired by @lexical/react's RichTextPlugin/registerRichText
// by default in this installed version (0.47): registerRichText only handles
// block-level Enter/Delete/selection commands, never binds a keyboard
// shortcut to FORMAT_TEXT_COMMAND. The design brief (081) requires these
// shortcuts, so this plugin adds them explicitly — scoped to bold/italic/
// underline only, the exact set this editor's toolbar exposes.
function ShortcutsPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const modifier = event.metaKey || event.ctrlKey
        if (!modifier || event.altKey) return false
        const key = event.key.toLowerCase()
        let format: TextFormatType | null = null
        if (key === 'b') format = 'bold'
        else if (key === 'i') format = 'italic'
        else if (key === 'u') format = 'underline'
        if (format === null) return false
        event.preventDefault()
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)
        return true
      },
      COMMAND_PRIORITY_NORMAL,
    )
  }, [editor])
  return null
}

// Keeps the editor in sync with an externally-changed `value` (undo/redo, or
// a synced delta streaming in from another workspace member) WITHOUT
// clobbering an in-progress edit: `lastSyncedRef` only ever advances from
// this plugin's own sync or from the blur-commit handler below (shared via
// the same ref), so a parent re-render during active typing (which never
// changes `value` mid-edit — only blur does, via onCommit) is a no-op here.
function SyncExternalValuePlugin({
  value,
  lastSyncedRef,
}: {
  value: string | null
  lastSyncedRef: React.RefObject<string | null>
}) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (value === lastSyncedRef.current) return
    lastSyncedRef.current = value
    const safe = safeRichTextJson(value)
    if (safe === null) {
      resetToEmptyParagraph(editor)
      return
    }
    try {
      const parsed = editor.parseEditorState(safe)
      editor.setEditorState(parsed)
    } catch (error) {
      // Belt-and-suspenders: safeRichTextJson already probed this JSON
      // against the identical node whitelist, so this should be unreachable
      // — but the parse guard's fail-closed contract (081 security item 2)
      // applies here too, never a partially-applied state.
      console.error('rich-text-editor: setEditorState failed on an already-probed payload — falling back to empty', error)
      resetToEmptyParagraph(editor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor])
  return null
}

function EditorChrome({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  readOnly,
  onCommitAndAdvance,
  onEscape,
  onTabAdvance,
  autoFocus,
}: {
  value: string | null
  onCommit: (next: string | null) => void
  ariaLabel: string
  placeholder: string
  readOnly: boolean
  onCommitAndAdvance?: ((dir: 'down') => void) | undefined
  onEscape?: (() => void) | undefined
  onTabAdvance?: ((dir: 'forward' | 'backward') => void) | undefined
  autoFocus?: boolean | undefined
}) {
  const [editor] = useLexicalComposerContext()
  // Stable per-instance key for the focused-editor registry (089 D1 P1): the
  // global FormatStrip binds to whichever id is focused.
  const editorId = useId()
  // Shared between the external-sync plugin and the blur-commit handler
  // below so neither re-processes the other's own write (see
  // SyncExternalValuePlugin's doc comment).
  const lastSyncedRef = useRef<string | null>(value)
  // Issue 089 D1 P3 — the grid-cell seam. When Esc reverts an in-progress edit
  // the editor unmounts (the cell collapses to its read-mode display); this
  // flag makes the ensuing blur a no-op so an abandoned edit is never committed
  // (mirrors MultilineCell's `cancelling` ref, EditableGrid.tsx).
  const cancellingRef = useRef(false)

  // Issue 089 D1 P3 — Numbers-grammar reconciliation for a live contentEditable.
  // A rich editor swallows plain Enter (paragraph) and Tab (indent), so the
  // grid's "Enter commits+down / Tab traverses" can't be reused inside it:
  //   • Cmd/Ctrl+Enter = commit + move DOWN (the grid host advances).
  //   • plain Enter    = newline (Lexical default — we return false, untouched).
  //   • Esc            = revert + hand back to the cell (which refocuses its
  //                      read-mode display; Tab/arrows resume from there).
  //   • Tab            = when the host opts in via `onTabAdvance` (issue 105 P0,
  //                      the grid-embedded description/justification cells):
  //                      preventDefault so it never reaches native browser Tab
  //                      (which fell through to the "Add child" <button> and
  //                      armed an accidental sub-child), commit the current
  //                      value, then ask the host to advance to the next/prev
  //                      editable cell — exactly like Tab in a plain text cell.
  //                      When NOT opted in (the always-mounted existing_scenario
  //                      editor), Tab is untouched → native traversal, unchanged.
  // Registered on KEY_DOWN_COMMAND like ShortcutsPlugin, so returning true
  // short-circuits Lexical's own KEY_ENTER_COMMAND (LexicalEvents onKeyDown).
  useEffect(() => {
    if (readOnly) return
    if (!onCommitAndAdvance && !onEscape && !onTabAdvance) return
    // Commit the current content (same path as handleBlur / Cmd+Enter); the
    // ensuing unmount-blur is then idempotent (next === lastSyncedRef).
    const commitNow = () => {
      const next = serializeForCommit(editor.getEditorState())
      if (next !== lastSyncedRef.current) {
        lastSyncedRef.current = next
        onCommit(next)
      }
    }
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const modifier = event.metaKey || event.ctrlKey
        if (event.key === 'Enter' && modifier && onCommitAndAdvance) {
          event.preventDefault()
          commitNow()
          onCommitAndAdvance('down')
          return true
        }
        if (event.key === 'Tab' && onTabAdvance) {
          event.preventDefault()
          commitNow()
          onTabAdvance(event.shiftKey ? 'backward' : 'forward')
          return true
        }
        if (event.key === 'Escape' && onEscape) {
          event.preventDefault()
          cancellingRef.current = true
          onEscape()
          return true
        }
        return false
      },
      COMMAND_PRIORITY_NORMAL,
    )
  }, [editor, readOnly, onCommitAndAdvance, onEscape, onTabAdvance, onCommit])

  // Land focus when the cell swaps its read-mode display for this editor
  // (click / Enter / commit-and-advance). Focus the root element directly (DOM
  // focus): it fires focusin → handleFocus → the FormatStrip binds, and the
  // browser places the caret in the contentEditable. Deliberately NOT
  // editor.focus() — that forces a Lexical selection-scroll (getBoundingClientRect)
  // that jsdom can't service; the caret from native focus is enough, and the
  // strip/shortcuts operate on whatever range the user then makes. Off by
  // default → the always-mounted existing_scenario editor is unchanged.
  useEffect(() => {
    if (readOnly || !autoFocus) return
    const root = editor.getRootElement()
    root?.focus()
    // Assert the FormatStrip binding here, rather than relying SOLELY on the
    // focusin this focus() fires (089 D2). React StrictMode's dev double-invoke
    // (and any Offscreen-style passive-effect reconnect) runs this mount effect
    // a SECOND time — but the register effect's intervening cleanup has already
    // cleared focusedId, and the 2nd focus() is a no-op on the still-focused
    // root, so it fires NO focusin and handleFocus never re-runs setFocused.
    // The register effect's re-run then sees focusedId === null and its
    // `focusedId === id` reconcile misses, leaving a grid rich cell's editor
    // UNBOUND on its first autoFocus (the FormatStrip stays hidden until a
    // manual re-focus). Setting focusedId directly makes the binding
    // order-independent: whichever of the autoFocus / register effects runs
    // last, register's reconcile (or this call) lands the active binding. This
    // is scoped to the autoFocus path — the always-mounted existing_scenario
    // editor (autoFocus undefined) early-returns above and is untouched.
    if (root && document.activeElement === root) {
      useFocusedEditorStore.getState().setFocused(editorId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `initialConfig.editable` is read ONCE on mount (LexicalComposer's own
  // contract) — it does not react to a `readOnly` prop that flips after
  // mount, which genuinely happens here: useWorkspaceRole (FoundationSurface)
  // resolves the caller's role asynchronously, so the first render or two can
  // be `readOnly={false}` before settling on `true` for a viewer. Without
  // this effect, a viewer's editor would stay stuck editable forever (issue
  // 035's contract: no click-to-edit, no edit affordance at all for a viewer).
  useEffect(() => {
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  // Register this editable instance in the focused-editor registry (089 D1 P1)
  // so the shell's global FormatStrip can bind to it when focused. Read-only
  // instances never register (viewers get no formatting strip, matching 035).
  // getState() is used throughout this component so EditorChrome never
  // re-renders on strip focus changes — it only writes to the store.
  useEffect(() => {
    if (readOnly) return
    useFocusedEditorStore.getState().register(editorId, editor)
    return () => useFocusedEditorStore.getState().unregister(editorId)
  }, [editorId, editor, readOnly])

  // focusin/focusout on the scroller drive BOTH the strip binding and the
  // existing commit-on-blur. The strip's buttons preventDefault their own
  // mousedown, so clicking one never blurs the editor here — selection and the
  // active binding both survive, and no spurious commit fires (081 contract).
  function handleFocus() {
    if (readOnly) return
    useFocusedEditorStore.getState().setFocused(editorId)
  }

  function handleBlur() {
    if (readOnly) return
    useFocusedEditorStore.getState().setFocused(null)
    // Esc-revert (089 D1 P3): the edit was abandoned, never commit it.
    if (cancellingRef.current) {
      cancellingRef.current = false
      return
    }
    const next = serializeForCommit(editor.getEditorState())
    if (next === lastSyncedRef.current) return
    lastSyncedRef.current = next
    onCommit(next)
  }

  return (
    <div className="rich-text-editor" data-readonly={readOnly || undefined}>
      <div className="rich-text-editor__scroller" onFocus={handleFocus} onBlur={handleBlur}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable className="rich-text-editor__content" aria-label={ariaLabel} />
          }
          placeholder={<div className="rich-text-editor__ghost">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      {!readOnly && <ShortcutsPlugin />}
      <SyncExternalValuePlugin value={value} lastSyncedRef={lastSyncedRef} />
    </div>
  )
}

export interface RichTextEditorProps {
  /** Current committed value: a JSON-stringified Lexical EditorState, or
   *  null when the field has never been written (schema's nullable
   *  existing_scenario column — see schema.ts's own comment). */
  value: string | null
  /** Called on blur with the next committed value (never per-keystroke) —
   *  null when the editor was emptied out. */
  onCommit: (next: string | null) => void
  ariaLabel: string
  placeholder: string
  /** Issue 035 — a viewer sees rendered formatting, no toolbar, no edit affordance. */
  readOnly?: boolean
  /** Lexical namespace (089 D1 P1) — parameterized so multiple rich editors can
   *  coexist behind the single global FormatStrip (P3/P5). Defaults to the
   *  original existing_scenario value, so that field is unchanged. */
  namespace?: string
  /** Grid-cell seam (089 D1 P3): Cmd/Ctrl+Enter commits the current value and
   *  asks the host to move DOWN. Plain Enter stays a newline. Undefined by
   *  default → the always-mounted existing_scenario editor is unchanged. */
  onCommitAndAdvance?: (dir: 'down') => void
  /** Grid-cell seam (089 D1 P3): Esc reverts the in-progress edit (never
   *  commits) and hands control back to the host, which returns focus to its
   *  read-mode display element. Undefined by default. */
  onEscape?: () => void
  /** Grid-cell seam (issue 105 P0): Tab commits the current value and asks the
   *  host to move to the next ('forward') / previous ('backward') editable cell,
   *  matching Tab in a plain text cell. `preventDefault` stops the native Tab
   *  that used to fall through onto the "Add child" button and arm a stray
   *  sub-child. Undefined by default → Tab is untouched (native traversal), so
   *  the always-mounted existing_scenario editor is byte-identical. */
  onTabAdvance?: (dir: 'forward' | 'backward') => void
  /** Focus the editable on mount — a grid cell swaps its read-mode display for
   *  this editor on click / Enter / advance and needs the caret to land. */
  autoFocus?: boolean
  className?: string
}

export function RichTextEditor({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  readOnly = false,
  namespace = 'gede-existing-scenario',
  onCommitAndAdvance,
  onEscape,
  onTabAdvance,
  autoFocus,
  className,
}: RichTextEditorProps) {
  // Read once on mount (Lexical's own contract for initialConfig.editorState
  // — see LexicalComposer's doc comment: "read once when the editor is
  // created... changes after the first render are ignored"). Passing the RAW
  // value string here unguarded would let a malformed/malicious payload
  // throw synchronously out of LexicalComposer's own initialization (that
  // path isn't wrapped in try/catch anywhere in the library) — safeRichTextJson
  // pre-validates against the identical node whitelist first, so only an
  // already-known-safe JSON string (or undefined, seeding an empty
  // paragraph) ever reaches LexicalComposer.
  const [initialEditorStateJson] = useState(() => safeRichTextJson(value))

  return (
    <div className={cn('rich-text-editor-root', className)}>
      <LexicalComposer
        initialConfig={{
          namespace,
          nodes: RICH_TEXT_NODES,
          editable: !readOnly,
          // exactOptionalPropertyTypes: omit the key entirely when there's no
          // initial content, rather than passing `editorState: undefined` —
          // InitialEditorStateType doesn't include `undefined` in its union
          // (only `null | string | EditorState | function`), and the two are
          // NOT interchangeable under this tsconfig setting.
          ...(initialEditorStateJson !== null ? { editorState: initialEditorStateJson } : {}),
          theme: {
            text: { underline: 'rich-text-editor__text--underline' },
            list: {
              ul: 'rich-text-editor__list',
              ol: 'rich-text-editor__list rich-text-editor__list--ordered',
              listitem: 'rich-text-editor__list-item',
              nested: { listitem: 'rich-text-editor__list-item--nested' },
            },
          },
          onError(error) {
            console.error('rich-text-editor: uncaught Lexical error', error)
          },
        }}
      >
        <EditorChrome
          value={value}
          onCommit={onCommit}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          readOnly={readOnly}
          onCommitAndAdvance={onCommitAndAdvance}
          onEscape={onEscape}
          onTabAdvance={onTabAdvance}
          autoFocus={autoFocus}
        />
      </LexicalComposer>
    </div>
  )
}
