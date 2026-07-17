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
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type LexicalEditor,
} from 'lexical'
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { $getNearestNodeOfType } from '@lexical/utils'
import { Button } from './ui/button'
import { useFocusedEditorStore } from '../store/focusedEditor'

/*
 * Issue 089 D1 P1 — the global rich-text FormatStrip. This is the editor's old
 * in-line Toolbar (issue 081), extracted verbatim in its command set and ARIA
 * pattern, but detached into ONE persistent strip that binds to whichever rich
 * editor is focused (focusedEditor store). The command dispatches are unchanged
 * and editor-agnostic — only the active-editor indirection is new. When nothing
 * is focused the strip renders disabled (aria-disabled, non-tabbable) rather
 * than unmounting, so its state reads as muted-not-broken; the shell (AppShell)
 * decides whether to even reveal the band (focus-reveal — see AppShell).
 */

interface ToolbarButtonSpec {
  key: string
  label: string
  Icon: typeof BoldIcon
  pressed: boolean
  onClick: () => void
}

// Re-subscribes to whichever editor is active: the update-listener registration
// is keyed on `editor`, so when the active editor changes (or drops to null),
// the effect tears down the old listener and (re)binds to the new one. A null
// editor reports all-inactive — the disabled strip.
function useToolbarState(editor: LexicalEditor | null) {
  const [isBold, setIsBold] = useState(false)
  const [isItalic, setIsItalic] = useState(false)
  const [isUnderline, setIsUnderline] = useState(false)
  const [isBulletList, setIsBulletList] = useState(false)
  const [isNumberedList, setIsNumberedList] = useState(false)

  useEffect(() => {
    if (editor === null) {
      setIsBold(false)
      setIsItalic(false)
      setIsUnderline(false)
      setIsBulletList(false)
      setIsNumberedList(false)
      return
    }
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
// time; ArrowLeft/ArrowRight move focus between buttons (STYLE_GUIDE §10).
// When no rich editor is focused, every button is non-tabbable (tabIndex -1)
// and inert.
export function FormatStrip() {
  const activeEditor = useFocusedEditorStore((s) => s.activeEditor)
  const { isBold, isItalic, isUnderline, isBulletList, isNumberedList } = useToolbarState(activeEditor)
  const [activeIndex, setActiveIndex] = useState(0)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const disabled = activeEditor === null

  const buttons: ToolbarButtonSpec[] = [
    {
      key: 'bold',
      label: 'Bold',
      Icon: BoldIcon,
      pressed: isBold,
      onClick: () => activeEditor?.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'),
    },
    {
      key: 'italic',
      label: 'Italic',
      Icon: ItalicIcon,
      pressed: isItalic,
      onClick: () => activeEditor?.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'),
    },
    {
      key: 'underline',
      label: 'Underline',
      Icon: UnderlineIcon,
      pressed: isUnderline,
      onClick: () => activeEditor?.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline'),
    },
    {
      key: 'bulleted-list',
      label: 'Bulleted list',
      Icon: BulletListIcon,
      pressed: isBulletList,
      onClick: () =>
        activeEditor?.dispatchCommand(
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
        activeEditor?.dispatchCommand(
          isNumberedList ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
          undefined,
        ),
    },
    {
      key: 'indent',
      label: 'Indent',
      Icon: IndentIcon,
      pressed: false,
      onClick: () => activeEditor?.dispatchCommand(INDENT_CONTENT_COMMAND, undefined),
    },
    {
      key: 'outdent',
      label: 'Outdent',
      Icon: OutdentIcon,
      pressed: false,
      onClick: () => activeEditor?.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined),
    },
  ]

  function handleToolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = (activeIndex + delta + buttons.length) % buttons.length
    setActiveIndex(next)
    buttonRefs.current[next]?.focus()
  }

  return (
    <div
      className="format-strip"
      role="toolbar"
      aria-label="Formatting"
      aria-disabled={disabled || undefined}
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
          aria-disabled={disabled || undefined}
          // Non-tabbable while inert; otherwise roving tabindex (one button 0).
          tabIndex={disabled ? -1 : index === activeIndex ? 0 : -1}
          // Preserves the focused editor's text selection — a mousedown on a
          // <button> steals focus (and with it, Lexical's selection anchor)
          // before the click handler ever runs. Critical for a GLOBAL strip:
          // the button lives outside the editor's DOM, so without this a click
          // would blur the editor entirely (losing selection AND the active
          // binding) rather than format it.
          onMouseDown={(event) => event.preventDefault()}
          onFocus={() => setActiveIndex(index)}
          onClick={() => {
            if (disabled) return
            button.onClick()
          }}
        >
          <button.Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}
