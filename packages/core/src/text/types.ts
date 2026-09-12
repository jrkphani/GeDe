/**
 * The rich-text value type (PRD §3, §20 "ProseMirror-family schema").
 *
 * A cell's text is a ProseMirror JSON document: a `doc` of `paragraph`s, each
 * holding `text` nodes that carry marks. This is the shape `y-prosemirror`
 * reads from and writes to the cell's `Y.XmlFragment`, the shape the text
 * algebra transforms, and the shape the renderer lays out. Nothing in this
 * package holds a ProseMirror `Node` across a boundary — plain JSON only, so
 * the same value crosses into a Worker unchanged.
 *
 * Colour marks name a token, never a colour (`packages/tokens` is the only
 * place a hex may be written). The vocabularies below are closed: the
 * renderer maps each name to a `--token` custom property and a value outside
 * them is dropped by `normalise`.
 */

/** Inline marks the editor applies with the KEYS-05 chords. */
export const TOGGLE_MARKS = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'superscript',
  'subscript',
] as const;
export type ToggleMark = (typeof TOGGLE_MARKS)[number];

/**
 * Text colours by semantic token. Each is at least 4.5:1 on the light surface
 * (DESIGN-SYSTEM-DIGEST §2: ink 16.8:1, ink-muted 6.1:1, brand 10.6:1,
 * live 4.8:1, success 7.4:1, warning 4.8:1, danger 5.9:1, info 7.0:1).
 */
export const TEXT_COLOUR_TOKENS = [
  'ink',
  'ink-muted',
  'brand',
  'live',
  'success',
  'warning',
  'danger',
  'info',
] as const;
export type TextColourToken = (typeof TEXT_COLOUR_TOKENS)[number];

/**
 * Highlight tints by ramp: the 100 step of each ramp that has one, so ink on
 * the highlight keeps its contrast. Pink and blue tints (prototype) need new
 * ramps in `packages/tokens` before they can be named here.
 */
export const HIGHLIGHT_TOKENS = ['amber', 'forest', 'slate'] as const;
export type HighlightToken = (typeof HIGHLIGHT_TOKENS)[number];

export type Mark =
  | { readonly type: ToggleMark }
  | { readonly type: 'link'; readonly attrs: { readonly href: string } }
  | { readonly type: 'textColour'; readonly attrs: { readonly token: TextColourToken } }
  | { readonly type: 'highlight'; readonly attrs: { readonly token: HighlightToken } };

export type MarkName = Mark['type'];

export const MARK_NAMES: readonly MarkName[] = [...TOGGLE_MARKS, 'link', 'textColour', 'highlight'];

export interface TextNode {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly Mark[];
}

export interface Paragraph {
  readonly type: 'paragraph';
  readonly content?: readonly TextNode[];
}

export interface RichDoc {
  readonly type: 'doc';
  readonly content: readonly Paragraph[];
}

/** Separator between paragraphs in the plain-text projection. */
export const PARAGRAPH_BREAK = '\n';

export function isToggleMark(name: string): name is ToggleMark {
  return (TOGGLE_MARKS as readonly string[]).includes(name);
}

export function isTextColourToken(value: unknown): value is TextColourToken {
  return typeof value === 'string' && (TEXT_COLOUR_TOKENS as readonly string[]).includes(value);
}

export function isHighlightToken(value: unknown): value is HighlightToken {
  return typeof value === 'string' && (HIGHLIGHT_TOKENS as readonly string[]).includes(value);
}

/** Structural equality of two marks (type and attrs). */
export function marksEqual(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'link':
      return b.type === 'link' && a.attrs.href === b.attrs.href;
    case 'textColour':
      return b.type === 'textColour' && a.attrs.token === b.attrs.token;
    case 'highlight':
      return b.type === 'highlight' && a.attrs.token === b.attrs.token;
    default:
      return true;
  }
}

/** Same mark set regardless of order. */
export function markSetsEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m) => b.some((n) => marksEqual(m, n)));
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/**
 * A link may point at `http`, `https` or `mailto` only. The same JSON is read
 * by the projection worker and the chip Worker, so the scheme is checked here,
 * once, rather than trusted to a renderer's neutralisation of `javascript:`.
 */
export function isSafeHref(value: unknown): value is string {
  return typeof value === 'string' && SAFE_HREF.test(value);
}

/** Runtime guard for a mark coming from JSON or a Yjs attribute. */
export function toMark(value: unknown): Mark | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const type = value.type;
  if (typeof type !== 'string') return null;
  const attrs: unknown = 'attrs' in value ? value.attrs : undefined;
  if (isToggleMark(type)) return { type };
  if (typeof attrs !== 'object' || attrs === null) return null;
  if (type === 'link') {
    const href = 'href' in attrs ? attrs.href : undefined;
    return isSafeHref(href) ? { type, attrs: { href } } : null;
  }
  if (type === 'textColour') {
    const token = 'token' in attrs ? attrs.token : undefined;
    return isTextColourToken(token) ? { type, attrs: { token } } : null;
  }
  if (type === 'highlight') {
    const token = 'token' in attrs ? attrs.token : undefined;
    return isHighlightToken(token) ? { type, attrs: { token } } : null;
  }
  return null;
}

export function textNode(str: string, marks: readonly Mark[] = []): TextNode {
  return marks.length === 0 ? { type: 'text', text: str } : { type: 'text', text: str, marks };
}

export function paragraphNode(content: readonly TextNode[] = []): Paragraph {
  return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
}

export function docNode(paragraphs: readonly Paragraph[]): RichDoc {
  return { type: 'doc', content: paragraphs.length === 0 ? [paragraphNode()] : paragraphs };
}

/** The empty document: one empty paragraph, which is what ProseMirror's schema requires. */
export const EMPTY_DOC: RichDoc = docNode([]);

/** A document from plain text: one paragraph per line, no marks. */
export function richFromText(plain: string): RichDoc {
  return docNode(
    plain.split(PARAGRAPH_BREAK).map((line) => paragraphNode(line === '' ? [] : [textNode(line)])),
  );
}

export function paragraphText(p: Paragraph): string {
  return (p.content ?? []).map((n) => n.text).join('');
}

/** Plain-text projection: paragraphs joined by `\n`, marks dropped. */
export function plainText(d: RichDoc): string {
  return d.content.map(paragraphText).join(PARAGRAPH_BREAK);
}

/** True when the document holds no text at all. */
export function isEmptyDoc(d: RichDoc): boolean {
  return d.content.every((p) => paragraphText(p) === '');
}

/**
 * Canonical form: drop empty text nodes, merge neighbours with the same marks,
 * drop marks outside the vocabulary, order marks as the schema does (so a
 * document read back through ProseMirror compares equal), keep at least one
 * paragraph. Two documents that render the same normalise the same; the
 * algebra's tests compare normalised values.
 */
export function normalise(d: RichDoc): RichDoc {
  const paragraphs = d.content.map((p) => {
    const out: TextNode[] = [];
    for (const node of p.content ?? []) {
      if (node.text === '') continue;
      const marks = (node.marks ?? [])
        .map(toMark)
        .filter((m): m is Mark => m !== null)
        .sort((a, b) => MARK_NAMES.indexOf(a.type) - MARK_NAMES.indexOf(b.type));
      const last = out[out.length - 1];
      if (last !== undefined && markSetsEqual(last.marks ?? [], marks)) {
        out[out.length - 1] = textNode(last.text + node.text, last.marks ?? []);
      } else {
        out.push(textNode(node.text, marks));
      }
    }
    return paragraphNode(out);
  });
  return docNode(paragraphs);
}

/** Runtime guard for a document from JSON (a Worker message, a Yjs read). */
export function isRichDoc(value: unknown): value is RichDoc {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || value.type !== 'doc') return false;
  if (!('content' in value) || !Array.isArray(value.content)) return false;
  return value.content.every((p: unknown) => {
    if (typeof p !== 'object' || p === null || !('type' in p) || p.type !== 'paragraph')
      return false;
    if (!('content' in p)) return true;
    if (!Array.isArray(p.content)) return false;
    return p.content.every(
      (n: unknown) =>
        typeof n === 'object' &&
        n !== null &&
        'type' in n &&
        n.type === 'text' &&
        'text' in n &&
        typeof n.text === 'string',
    );
  });
}
