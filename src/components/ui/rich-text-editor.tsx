import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Bold as BoldIcon,
  Indent as IndentIcon,
  Italic as ItalicIcon,
  List as BulletListIcon,
  ListOrdered as NumberedListIcon,
  Outdent as OutdentIcon,
  Underline as UnderlineIcon,
} from 'lucide-react'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  KEY_DOWN_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type EditorState,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical'
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { $getNearestNodeOfType } from '@lexical/utils'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { cn } from '@/lib/utils'
import { RICH_TEXT_NODES, safeRichTextJson } from '../../domain/richText'
import { Button } from './button'

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

interface ToolbarButtonSpec {
  key: string
  label: string
  Icon: typeof BoldIcon
  pressed: boolean
  onClick: () => void
}

function useToolbarState(editor: LexicalEditor) {
  const [isBold, setIsBold] = useState(false)
  const [isItalic, setIsItalic] = useState(false)
  const [isUnderline, setIsUnderline] = useState(false)
  const [isBulletList, setIsBulletList] = useState(false)
  const [isNumberedList, setIsNumberedList] = useState(false)

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          setIsBold(false)
          setIsItalic(false)
          setIsUnderline(false)
          setIsBulletList(false)
          setIsNumberedList(false)
          return
        }
        setIsBold(selection.hasFormat('bold'))
        setIsItalic(selection.hasFormat('italic'))
        setIsUnderline(selection.hasFormat('underline'))
        const listItem = $getNearestNodeOfType(selection.anchor.getNode(), ListItemNode)
        const list = listItem ? listItem.getParent() : null
        const listType = $isListNode(list) ? list.getListType() : null
        setIsBulletList(listType === 'bullet')
        setIsNumberedList(listType === 'number')
      })
    })
  }, [editor])

  return { isBold, isItalic, isUnderline, isBulletList, isNumberedList }
}

// WAI-ARIA toolbar pattern: roving tabindex — one button is tabbable at a
// time; ArrowLeft/ArrowRight move focus between buttons (STYLE_GUIDE §10,
// full keyboard operability is a per-issue acceptance criterion).
function Toolbar({ editor }: { editor: LexicalEditor }) {
  const { isBold, isItalic, isUnderline, isBulletList, isNumberedList } = useToolbarState(editor)
  const [activeIndex, setActiveIndex] = useState(0)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const buttons: ToolbarButtonSpec[] = [
    {
      key: 'bold',
      label: 'Bold',
      Icon: BoldIcon,
      pressed: isBold,
      onClick: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'),
    },
    {
      key: 'italic',
      label: 'Italic',
      Icon: ItalicIcon,
      pressed: isItalic,
      onClick: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'),
    },
    {
      key: 'underline',
      label: 'Underline',
      Icon: UnderlineIcon,
      pressed: isUnderline,
      onClick: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline'),
    },
    {
      key: 'bulleted-list',
      label: 'Bulleted list',
      Icon: BulletListIcon,
      pressed: isBulletList,
      onClick: () =>
        editor.dispatchCommand(
          isBulletList ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND,
          undefined,
        ),
    },
    {
      key: 'numbered-list',
      label: 'Numbered list',
      Icon: NumberedListIcon,
      pressed: isNumberedList,
      onClick: () =>
        editor.dispatchCommand(
          isNumberedList ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
          undefined,
        ),
    },
    {
      key: 'indent',
      label: 'Indent',
      Icon: IndentIcon,
      pressed: false,
      onClick: () => editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined),
    },
    {
      key: 'outdent',
      label: 'Outdent',
      Icon: OutdentIcon,
      pressed: false,
      onClick: () => editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined),
    },
  ]

  function handleToolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = (activeIndex + delta + buttons.length) % buttons.length
    setActiveIndex(next)
    buttonRefs.current[next]?.focus()
  }

  return (
    <div
      className="rich-text-editor__toolbar"
      role="toolbar"
      aria-label="Existing scenario formatting"
      onKeyDown={handleToolbarKeyDown}
    >
      {buttons.map((button, index) => (
        <Button
          key={button.key}
          ref={(el) => {
            buttonRefs.current[index] = el
          }}
          variant="command"
          aria-label={button.label}
          aria-pressed={button.pressed}
          tabIndex={index === activeIndex ? 0 : -1}
          // Preserves the editor's text selection — a mousedown on a
          // <button> steals focus (and with it, Lexical's selection anchor)
          // before the click handler ever runs; without this, "select text
          // then click Bold" would format nothing.
          onMouseDown={(event) => event.preventDefault()}
          onFocus={() => setActiveIndex(index)}
          onClick={button.onClick}
        >
          <button.Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}

function EditorChrome({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  readOnly,
}: {
  value: string | null
  onCommit: (next: string | null) => void
  ariaLabel: string
  placeholder: string
  readOnly: boolean
}) {
  const [editor] = useLexicalComposerContext()
  // Shared between the external-sync plugin and the blur-commit handler
  // below so neither re-processes the other's own write (see
  // SyncExternalValuePlugin's doc comment).
  const lastSyncedRef = useRef<string | null>(value)

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

  function handleBlur() {
    if (readOnly) return
    const next = serializeForCommit(editor.getEditorState())
    if (next === lastSyncedRef.current) return
    lastSyncedRef.current = next
    onCommit(next)
  }

  return (
    <div className="rich-text-editor" data-readonly={readOnly || undefined}>
      {!readOnly && <Toolbar editor={editor} />}
      <div className="rich-text-editor__scroller" onBlur={handleBlur}>
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
  className?: string
}

export function RichTextEditor({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  readOnly = false,
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
          namespace: 'gede-existing-scenario',
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
        />
      </LexicalComposer>
    </div>
  )
}
