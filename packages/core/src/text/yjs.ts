/**
 * Rich text ↔ the cell's `Y.XmlFragment` (ARCHITECTURE §1.5.3).
 *
 * The fragment layout is the one `y-prosemirror` reads and writes: one
 * `Y.XmlElement('paragraph')` per paragraph, each holding one `Y.XmlText`
 * whose delta attributes are the marks, keyed by mark name with the mark's
 * attrs as value (`{ bold: {}, link: { href } }`). Reproducing it here keeps
 * `@gede/core` free of the editor packages while the browser's live binding
 * and this reader agree byte for byte — `apps/web` cross-checks both against
 * `y-prosemirror` itself.
 *
 * Wave 1's `textFragment` / `fragmentText` (doc/schema.ts) are the plain-text
 * special case of these two functions and stay valid.
 */
import * as Y from 'yjs';

import {
  docNode,
  normalise,
  paragraphNode,
  textNode,
  toMark,
  type Mark,
  type Paragraph,
  type RichDoc,
  type TextNode,
} from './types.js';

/** y-prosemirror suffixes overlapping marks as `name--hash`; the name is what matters. */
function markNameOf(attribute: string): string {
  const at = attribute.indexOf('--');
  return at < 0 ? attribute : attribute.slice(0, at);
}

function marksFromAttributes(attributes: unknown): Mark[] {
  if (typeof attributes !== 'object' || attributes === null) return [];
  const out: Mark[] = [];
  for (const [key, attrs] of Object.entries(attributes as Record<string, unknown>)) {
    const mark = toMark({ type: markNameOf(key), attrs });
    if (mark !== null) out.push(mark);
  }
  return out;
}

function textNodesOf(xml: Y.XmlText): TextNode[] {
  // `toDelta()` is untyped upstream; treat every op as unknown and guard.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- untyped upstream
  const delta: unknown = xml.toDelta();
  if (!Array.isArray(delta)) return [];
  const out: TextNode[] = [];
  for (const op of delta as readonly unknown[]) {
    if (typeof op !== 'object' || op === null || !('insert' in op)) continue;
    const insert: unknown = op.insert;
    if (typeof insert !== 'string' || insert === '') continue;
    const attributes: unknown = 'attributes' in op ? op.attributes : undefined;
    out.push(textNode(insert, marksFromAttributes(attributes)));
  }
  return out;
}

function paragraphOf(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Paragraph {
  if (node instanceof Y.XmlText) return paragraphNode(textNodesOf(node));
  if (node instanceof Y.XmlElement) {
    const nodes: TextNode[] = [];
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) nodes.push(...textNodesOf(child));
    }
    return paragraphNode(nodes);
  }
  return paragraphNode();
}

/** Read a fragment as a normalised document. An empty fragment is the empty document. */
export function fragmentToRich(fragment: Y.XmlFragment): RichDoc {
  return normalise(docNode(fragment.toArray().map(paragraphOf)));
}

function attributesOf(marks: readonly Mark[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mark of marks) out[mark.type] = 'attrs' in mark ? mark.attrs : {};
  return out;
}

function xmlParagraph(p: Paragraph): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  const nodes = p.content ?? [];
  if (nodes.length === 0) return element;
  const xmlText = new Y.XmlText();
  xmlText.applyDelta(
    nodes.map((n) => {
      const marks = n.marks ?? [];
      return marks.length === 0
        ? { insert: n.text }
        : { insert: n.text, attributes: attributesOf(marks) };
    }),
  );
  element.insert(0, [xmlText]);
  return element;
}

/** A prelim fragment for a document; integrate it by setting it into a `Y.Map`. */
export function richToFragment(d: RichDoc): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  fragment.insert(0, normalise(d).content.map(xmlParagraph));
  return fragment;
}

/**
 * Replace an integrated fragment's content in place. The caller wraps this in
 * a transaction (one gesture, one undo step). Replacing whole is right for a
 * commit from a detached editor; a live binding merges at character level and
 * never calls this.
 */
export function writeRich(fragment: Y.XmlFragment, d: RichDoc): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length);
  fragment.insert(0, normalise(d).content.map(xmlParagraph));
}
