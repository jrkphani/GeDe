/**
 * The editor's schema: `@gede/core`'s `richSchemaSpec` plus `parseDOM` rules,
 * which are the one DOM concern (pasting and drag-in read HTML). Names,
 * attributes and `toDOM` are the core's, so a document the editor produces is
 * exactly the JSON the algebra and the fragment codec expect.
 */
import { isHighlightToken, isTextColourToken, richSchemaSpec } from '@gede/core';
import { Schema, type MarkSpec, type ParseRule } from 'prosemirror-model';

function attribute(dom: HTMLElement | string, name: string): string | null {
  return typeof dom === 'string' ? null : dom.getAttribute(name);
}

const parseRules: Record<keyof typeof richSchemaSpec.marks, readonly ParseRule[]> = {
  bold: [
    { tag: 'strong' },
    {
      tag: 'b',
      getAttrs: (dom) =>
        attribute(dom, 'style')?.includes('font-weight: normal') === true ? false : null,
    },
    { style: 'font-weight=bold' },
    { style: 'font-weight=600' },
    { style: 'font-weight=700' },
  ],
  italic: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
  underline: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
  strikethrough: [
    { tag: 's' },
    { tag: 'del' },
    { tag: 'strike' },
    { style: 'text-decoration=line-through' },
  ],
  superscript: [{ tag: 'sup' }],
  subscript: [{ tag: 'sub' }],
  link: [
    {
      tag: 'a[href]',
      getAttrs: (dom) => {
        const href = attribute(dom, 'href');
        return href === null ? false : { href };
      },
    },
  ],
  textColour: [
    {
      tag: 'span[data-ink]',
      getAttrs: (dom) => {
        const token = attribute(dom, 'data-ink');
        return isTextColourToken(token) ? { token } : false;
      },
    },
  ],
  highlight: [
    {
      tag: 'mark[data-highlight]',
      getAttrs: (dom) => {
        const token = attribute(dom, 'data-highlight');
        return isHighlightToken(token) ? { token } : false;
      },
    },
    // A `<mark>` from elsewhere (or the browser's own) is a highlight in the default tint.
    { tag: 'mark', getAttrs: () => ({ token: 'amber' }) },
  ],
};

type MarkKey = keyof typeof richSchemaSpec.marks;

function withParseDOM(name: MarkKey): MarkSpec {
  return { ...richSchemaSpec.marks[name], parseDOM: [...parseRules[name]] };
}

const marks: Record<MarkKey, MarkSpec> = {
  bold: withParseDOM('bold'),
  italic: withParseDOM('italic'),
  underline: withParseDOM('underline'),
  strikethrough: withParseDOM('strikethrough'),
  superscript: withParseDOM('superscript'),
  subscript: withParseDOM('subscript'),
  link: withParseDOM('link'),
  textColour: withParseDOM('textColour'),
  highlight: withParseDOM('highlight'),
};

export const editorSchema = new Schema({
  nodes: {
    ...richSchemaSpec.nodes,
    paragraph: { ...richSchemaSpec.nodes.paragraph, parseDOM: [{ tag: 'p' }, { tag: 'div' }] },
  },
  marks,
});

export type EditorSchema = typeof editorSchema;
