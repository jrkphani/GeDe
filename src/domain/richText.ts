// Issue 081 — the rich-text security boundary (docs/issues/081-tier1-
// existing-scenario-rich-text.md "Security — sanitization requirement").
// Pure and store/DB-free, like projectEnvelope.ts/syncDelta.ts — the only
// caller is the React editor primitive (src/components/ui/rich-text-editor.tsx).
//
// `existing_scenario` streams through Electric to every workspace member's
// browser (src/domain/syncScope.ts's SYNCED_TABLES), so content authored by
// one user renders inside another user's DOM without that second user having
// reviewed it. A malicious or buggy client (compromised device, tampered
// write, a future write-path bug) is a realistic threat model here, not a
// hypothetical.
import DOMPurify from 'dompurify'
import { ListItemNode, ListNode } from '@lexical/list'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type Klass,
  type LexicalNode,
} from 'lexical'

// The XSS whitelist-by-construction (081's rich-text-library decision):
// ParagraphNode/TextNode are Lexical built-ins (always registered, no entry
// needed here); ListNode/ListItemNode are the only EXTRA node types this
// editor knows how to construct. No LinkNode (no href attribute to inject
// into), no HeadingNode, no CodeNode, no custom DecoratorNode (Lexical's
// escape hatch for arbitrary embedded React/HTML) — those types are not
// representable in the editor state at all, synced or not, because nothing
// here knows how to construct them. Shared by the real editor
// (rich-text-editor.tsx) and this module's own parse-guard probe so both use
// the IDENTICAL whitelist — one enforcement point, not two.
export const RICH_TEXT_NODES: readonly Klass<LexicalNode>[] = [ListNode, ListItemNode]

// A throwaway headless editor used only to validate JSON shape against
// RICH_TEXT_NODES — never mounted, never rendered. `createEditor`'s onError
// is required by its type but should never fire here: every code path that
// could throw goes through the explicit try/catch in safeRichTextJson below,
// never through an `editor.update()` call (the only thing onError guards).
function probeEditor() {
  return createEditor({
    namespace: 'gede-rich-text-probe',
    nodes: RICH_TEXT_NODES,
    onError: (error) => {
      throw error
    },
  })
}

// Fail-closed parse guard (081 security item 2): hydrating a synced
// existingScenario JSON blob must never throw further into the DOM. Returns
// the JSON string unchanged when it parses cleanly against RICH_TEXT_NODES,
// or `null` when it's unparseable JSON, or when it decodes to a well-formed
// Lexical EditorState that references a node type OUTSIDE the whitelist (a
// simulated LinkNode/DecoratorNode/raw-HTML-shaped payload — Lexical's own
// node registry throws "Create node: Type ... does not match registered
// node" in that case, since this editor's node map has nothing to construct
// it with). The rejection is logged so it's diagnosable — mirrors
// src/domain/syncScope.ts:161's "fail closed on the untrusted boundary"
// convention (CLAUDE.md: no unchecked trust boundaries) — but never thrown
// further; every caller falls back to empty/plain content.
export function safeRichTextJson(json: string | null): string | null {
  if (json === null || json.trim() === '') return null
  try {
    probeEditor().parseEditorState(json)
    return json
  } catch (error) {
    console.error(
      'rich-text: rejected an existingScenario payload — unparseable, or a node type outside the registered whitelist (fail-closed to empty)',
      error,
    )
    return null
  }
}

// Issue 089 D1 Phase 2 — the Lexical-JSON <-> plain-text bridge. Direction D1
// turns grid cells that used to hold plain strings into rich text (Lexical
// JSON). The two live consumers of that prose — the palette's keyword corpus
// (coreCommands.ts) and the documented-status dot (completeness.ts) — must
// read the AUTHORED TEXT, never the JSON envelope. These two helpers are that
// bridge, and P4 (the data conversion) leans on the round-trip closure below.

// Reads the plain prose out of a field that may be EITHER shape, correctly and
// without ever throwing:
//   - valid Lexical JSON (a converted cell)  → the editor's own text content,
//     via the same `editorState.read(() => $getRoot().getTextContent())` API
//     the real editor uses (rich-text-editor.tsx).
//   - a legacy plain string (not yet converted) → returned verbatim, because
//     safeRichTextJson rejects it as non-Lexical (that's exactly the "not a
//     Lexical payload" signal, not an error).
//   - null / empty  → ''.
// So it is correct on BOTH the pre-conversion and post-conversion corpus,
// which is why the consumers can adopt it now, before any data moves.
export function richTextToPlainText(value: string | null): string {
  if (value === null) return ''
  // A serialized Lexical EditorState is always a JSON object literal
  // (`{"root":...}`). A legacy plain string is prose that (almost) never
  // starts with `{`, so this fast path returns it verbatim WITHOUT routing it
  // through safeRichTextJson — whose fail-closed `console.error` is meant for a
  // tampered sync payload at the security boundary (081), NOT for the expected
  // "this cell hasn't been converted to rich text yet" case. Pre-P4 that is
  // EVERY cell, so skipping the log here keeps the console clean. Output is
  // identical either way: a non-`{` string is exactly what safeRichTextJson
  // would reject to null, and every valid EditorState still goes through it.
  if (!value.trimStart().startsWith('{')) return value
  const safe = safeRichTextJson(value)
  if (safe === null) return value
  return probeEditor()
    .parseEditorState(safe)
    .read(() => $getRoot().getTextContent())
}

// Wraps a plain string as a single-paragraph Lexical doc and returns its
// serialized JSON. Uses ONLY the built-in ParagraphNode/TextNode (registered
// via RICH_TEXT_NODES' probeEditor) so its output is guaranteed to pass
// safeRichTextJson — the P4-critical closure: P4 converts legacy strings in a
// loop guarded by safeRichTextJson, so output that failed to validate would be
// re-converted forever. An empty string yields a valid empty-paragraph doc
// (no text node), which round-trips back to '' through richTextToPlainText.
export function plainTextToRichJson(text: string): string {
  const editor = probeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      if (text !== '') paragraph.append($createTextNode(text))
      root.append(paragraph)
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

// Defense-in-depth (081 security item 3), required even though it is not on
// the critical path today: any future code path that converts this field to
// an HTML string (e.g. $generateHtmlFromNodes for a print/export view) must
// run the result through this before it ever reaches dangerouslySetInnerHTML
// or an equivalent. Exactly the requested formatting set, nothing else — no
// style/class/on* attributes, no href (so no link-based injection either).
const ALLOWED_HTML_TAGS = ['p', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li']

export function sanitizeRichTextHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ALLOWED_HTML_TAGS, ALLOWED_ATTR: [] })
}
