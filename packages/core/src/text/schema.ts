/**
 * The ProseMirror schema for cell text (PRD §20: "ProseMirror-family schema:
 * typed marks, stable transform algebra"). One node hierarchy — `doc` >
 * `paragraph` > `text` — and the marks of `types.ts`.
 *
 * This module builds the schema without touching the DOM: `toDOM` specs are
 * the array form ProseMirror serialises itself, and `parseDOM` (clipboard
 * parsing, a DOM concern) is added by `apps/web` on top of `richSchemaSpec`.
 * The schema exists here so the algebra's tests can validate every document
 * they produce (`checkDoc`) and so the Worker and the browser agree on names.
 */
import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';

import {
  isHighlightToken,
  isTextColourToken,
  normalise,
  type Mark,
  type RichDoc,
  type TextNode,
} from './types.js';

export const richNodes: Record<'doc' | 'paragraph' | 'text', NodeSpec> = {
  doc: { content: 'paragraph+' },
  paragraph: {
    content: 'text*',
    toDOM: () => ['p', 0],
  },
  text: { inline: true },
};

function requireString(value: unknown): void {
  if (typeof value !== 'string') throw new RangeError('expected a string attribute');
}

export const richMarks: Record<Mark['type'], MarkSpec> = {
  bold: { toDOM: () => ['strong', 0] },
  italic: { toDOM: () => ['em', 0] },
  underline: { toDOM: () => ['u', 0] },
  strikethrough: { toDOM: () => ['s', 0] },
  // Super and subscript exclude each other: a character is one or the other. Each
  // must keep excluding itself (the default `excludes` is replaced, not extended):
  // y-prosemirror keys a self-overlapping mark as `name--hash` in the fragment.
  superscript: { excludes: 'superscript subscript', toDOM: () => ['sup', 0] },
  subscript: { excludes: 'subscript superscript', toDOM: () => ['sub', 0] },
  link: {
    attrs: { href: { validate: requireString } },
    inclusive: false,
    toDOM: (mark) => [
      'a',
      { href: String(mark.attrs.href), rel: 'noopener noreferrer', tabindex: '-1' },
      0,
    ],
  },
  textColour: {
    attrs: {
      token: {
        validate: (value: unknown) => {
          if (!isTextColourToken(value)) throw new RangeError('textColour must name a token');
        },
      },
    },
    toDOM: (mark) => ['span', { 'data-ink': String(mark.attrs.token) }, 0],
  },
  highlight: {
    attrs: {
      token: {
        validate: (value: unknown) => {
          if (!isHighlightToken(value)) throw new RangeError('highlight must name a token');
        },
      },
    },
    toDOM: (mark) => ['mark', { 'data-highlight': String(mark.attrs.token) }, 0],
  },
};

export const richSchemaSpec = { nodes: richNodes, marks: richMarks };

/** The schema instance used for validation here and, extended with `parseDOM`, by the editor. */
export const richSchema = new Schema(richSchemaSpec);

export type RichSchema = typeof richSchema;

/**
 * Validate a JSON document against the schema. Throws (a `RangeError` from
 * ProseMirror) when content or attributes are off. Used by tests and by the
 * Yjs reader to refuse a shape a newer client might have written.
 */
export function checkDoc(d: RichDoc): void {
  richSchema.nodeFromJSON(d).check();
}

/** Marks of a text node as ProseMirror expects them in JSON (attrs only when present). */
export function marksJSON(node: TextNode): readonly Mark[] {
  return node.marks ?? [];
}

/** True when the document validates; `normalise` first so empty text nodes never fail it. */
export function isValidDoc(d: RichDoc): boolean {
  try {
    checkDoc(normalise(d));
    return true;
  } catch {
    return false;
  }
}
