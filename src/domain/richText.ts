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
import { createEditor, type Klass, type LexicalNode } from 'lexical'

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
