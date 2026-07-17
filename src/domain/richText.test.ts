// @vitest-environment jsdom
// Issue 081 test-first plan item 7 — the rich-text security boundary.
// jsdom is required here (not the repo's default 'node' environment,
// vite.config.ts) purely for DOMPurify, which needs a `window`/`document` to
// sanitize against; the parse-guard tests below don't need a DOM at all
// (Lexical's headless `createEditor` runs fine in plain Node) but share the
// file for topical cohesion.
import { describe, expect, it } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import {
  plainTextToRichJson,
  richTextToPlainText,
  RICH_TEXT_NODES,
  safeRichTextJson,
  sanitizeRichTextHtml,
} from './richText'

// A real, valid serialized EditorState built through the SAME registered
// node set the app editor uses (RICH_TEXT_NODES) — a paragraph with a bold
// run, plus a bulleted list, exercising every node type this field can hold.
function validEditorStateJson(): string {
  const editor = createEditor({
    namespace: 'test',
    nodes: RICH_TEXT_NODES,
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = $createParagraphNode()
      const text = $createTextNode('Comfort, on demand.')
      text.toggleFormat('bold')
      paragraph.append(text)
      const list = $createListNode('bullet')
      const item = $createListItemNode()
      item.append($createTextNode('First point'))
      list.append(item)
      root.append(paragraph, list)
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

describe('safeRichTextJson — parse guard (test-first plan item 7)', () => {
  it('accepts a well-formed payload built from the registered node whitelist', () => {
    const json = validEditorStateJson()
    expect(safeRichTextJson(json)).toBe(json)
  })

  it('null and empty-string input both normalize to null', () => {
    expect(safeRichTextJson(null)).toBeNull()
    expect(safeRichTextJson('')).toBeNull()
    expect(safeRichTextJson('   ')).toBeNull()
  })

  it('unparseable JSON fails closed to null — never throws', () => {
    expect(() => safeRichTextJson('not json{')).not.toThrow()
    expect(safeRichTextJson('not json{')).toBeNull()
  })

  // Simulates a tampered/future-version sync delta whose EditorState JSON
  // references a node type this editor never registers (a LinkNode-shaped
  // node carrying an href, exactly the injection vector §081's whitelist-by-
  // construction defense exists to make unrepresentable in the state).
  it('a payload referencing a node type outside the whitelist (simulated LinkNode) fails closed to null', () => {
    const malicious = JSON.stringify({
      root: {
        children: [
          {
            children: [
              { detail: 0, format: 0, mode: 'normal', style: '', text: 'click me', type: 'text', version: 1 },
            ],
            direction: null,
            format: '',
            indent: 0,
            type: 'link',
            url: 'javascript:alert(1)',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    })
    expect(() => safeRichTextJson(malicious)).not.toThrow()
    expect(safeRichTextJson(malicious)).toBeNull()
  })

  // A DecoratorNode-shaped payload (Lexical's own escape hatch for arbitrary
  // embedded React/HTML) — never registered here, so it must fail closed too.
  it('a payload referencing a decorator-shaped node type fails closed to null', () => {
    const malicious = JSON.stringify({
      root: {
        children: [{ type: 'raw-html-embed', version: 1, html: '<img src=x onerror=alert(1)>' }],
        direction: null,
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    })
    expect(safeRichTextJson(malicious)).toBeNull()
  })

  it('RICH_TEXT_NODES is exactly ListNode + ListItemNode — no LinkNode/HeadingNode/CodeNode/DecoratorNode', () => {
    expect(RICH_TEXT_NODES).toEqual([ListNode, ListItemNode])
  })
})

// Issue 089 D1 Phase 2 — the Lexical-JSON <-> plain-text helpers that let the
// two real prose consumers (palette keyword corpus, documented-status) keep
// working once a cell's value becomes Lexical JSON instead of a plain string,
// BEFORE any data is converted (P4 depends on this closure).
describe('richTextToPlainText — reads prose out of either shape (089 D1 P2)', () => {
  it('extracts the text content of a real Lexical JSON payload (no JSON syntax)', () => {
    const json = validEditorStateJson()
    const text = richTextToPlainText(json)
    // The prose the editor state carries, in document order — not JSON keys.
    expect(text).toContain('Comfort, on demand.')
    expect(text).toContain('First point')
    expect(text).not.toContain('root')
    expect(text).not.toContain('paragraph')
    expect(text).not.toContain('"type"')
  })

  it('returns a legacy plain string verbatim (not valid Lexical JSON → passthrough)', () => {
    expect(richTextToPlainText('Reflects the primary beneficiaries')).toBe(
      'Reflects the primary beneficiaries',
    )
  })

  it('null and empty string both normalize to an empty string, never throwing', () => {
    expect(richTextToPlainText(null)).toBe('')
    expect(richTextToPlainText('')).toBe('')
    expect(() => richTextToPlainText('not json{')).not.toThrow()
    // A non-Lexical string is treated as legacy plain text (returned verbatim),
    // which is the correct, non-throwing behavior on the pre-conversion corpus.
    expect(richTextToPlainText('not json{')).toBe('not json{')
  })
})

describe('plainTextToRichJson — the P4-critical round-trip closure (089 D1 P2)', () => {
  it("output validates via safeRichTextJson AND round-trips back through richTextToPlainText", () => {
    const json = plainTextToRichJson('hi')
    // P4 will call plainTextToRichJson in a loop guarded by safeRichTextJson;
    // if the output didn't validate, that loop would re-convert forever.
    expect(safeRichTextJson(json)).toBe(json)
    expect(richTextToPlainText(json)).toBe('hi')
  })

  it('an empty string becomes a valid (empty-paragraph) doc that round-trips to ""', () => {
    const json = plainTextToRichJson('')
    expect(safeRichTextJson(json)).toBe(json)
    expect(richTextToPlainText(json)).toBe('')
  })
})

describe('sanitizeRichTextHtml — DOMPurify defense-in-depth (test-first plan item 7)', () => {
  it('strips a <script> tag and its content entirely', () => {
    const out = sanitizeRichTextHtml('<p>Hello <script>alert(1)</script>world</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('Hello')
    expect(out).toContain('world')
  })

  it('strips an onerror/on* attribute but keeps the allowed tag', () => {
    const out = sanitizeRichTextHtml('<p onmouseover="alert(1)">Text</p>')
    expect(out).not.toContain('onmouseover')
    expect(out).not.toContain('alert')
    expect(out).toBe('<p>Text</p>')
  })

  it('strips a disallowed tag (img/onerror) but is not fooled into keeping the attribute', () => {
    const out = sanitizeRichTextHtml('<p>Look <img src="x" onerror="alert(1)">here</p>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('alert')
  })

  it('strips a javascript: href on a disallowed <a> tag, keeping only its text content', () => {
    const out = sanitizeRichTextHtml('<p><a href="javascript:alert(1)">link</a></p>')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('href')
    expect(out).toContain('link')
  })

  it('keeps exactly the requested formatting set: p/strong/em/u/ul/ol/li survive untouched', () => {
    const html =
      '<p>A <strong>bold</strong> and <em>italic</em> and <u>underline</u> word.</p>' +
      '<ul><li>one</li></ul><ol><li>two</li></ol>'
    expect(sanitizeRichTextHtml(html)).toBe(html)
  })

  it('a bare <b>/<i> pair (Lexical bold/italic DOM tags) also survives — same allow-list', () => {
    const html = '<p><b>bold</b> <i>italic</i></p>'
    expect(sanitizeRichTextHtml(html)).toBe(html)
  })
})
