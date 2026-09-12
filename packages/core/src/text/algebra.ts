/**
 * The text algebra (PRD §13, §20; ARCHITECTURE §1.3.1): Split, Extract,
 * Replace, Format and Concat on marked text. Every operation is defined on
 * one primitive pair — `slice` and `concat` over the plain-text offset space —
 * so marks survive by construction: a character keeps the marks it had, and
 * the plain-text projection of the result is exactly what the same operation
 * on `plainText(doc)` would give.
 *
 * Offsets are UTF-16 indices into `plainText(doc)`, where a paragraph break
 * counts as one character (`\n`). Patterns are literal strings or regular
 * expressions; a regex is run with the `g` and `d` flags so match and group
 * positions come from the engine, not from re-scanning. Zero-length matches
 * never split or replace anything (there is nothing to cut).
 *
 * Pure JSON in, pure JSON out; nothing here touches ProseMirror's classes, so
 * the same functions run in a Worker.
 */
import {
  docNode,
  EMPTY_DOC,
  normalise,
  paragraphNode,
  paragraphText,
  PARAGRAPH_BREAK,
  plainText,
  richFromText,
  textNode,
  type Mark,
  type Paragraph,
  type RichDoc,
  type TextNode,
} from './types.js';

export type Pattern = string | RegExp;

/** A match in the plain-text offset space. `group` is capture group 1 when the pattern has one. */
export interface Match {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly group?: { readonly start: number; readonly end: number; readonly text: string };
}

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

interface ParagraphSpan {
  readonly p: Paragraph;
  readonly start: number;
  readonly end: number;
}

function spans(d: RichDoc): ParagraphSpan[] {
  const out: ParagraphSpan[] = [];
  let start = 0;
  for (const p of d.content) {
    const end = start + paragraphText(p).length;
    out.push({ p, start, end });
    start = end + PARAGRAPH_BREAK.length;
  }
  return out;
}

function sliceParagraph(p: Paragraph, from: number, to: number): Paragraph {
  const out: TextNode[] = [];
  let at = 0;
  for (const node of p.content ?? []) {
    const nodeEnd = at + node.text.length;
    const lo = Math.max(from, at);
    const hi = Math.min(to, nodeEnd);
    if (lo < hi) out.push(textNode(node.text.slice(lo - at, hi - at), node.marks ?? []));
    at = nodeEnd;
  }
  return paragraphNode(out);
}

/**
 * The sub-document between two plain-text offsets. Paragraph breaks inside
 * the range stay breaks, so `plainText(slice(d, a, b)) === plainText(d).slice(a, b)`.
 */
export function slice(d: RichDoc, from: number, to: number): RichDoc {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(lo, from, to);
  const out: Paragraph[] = [];
  for (const span of spans(d)) {
    // Inclusive at both ends: a range that starts at a paragraph's end or ends
    // at its start still contributes the (empty) paragraph, because the break
    // it touches is a character of the range.
    if (lo > span.end || hi < span.start) continue;
    out.push(sliceParagraph(span.p, lo - span.start, hi - span.start));
  }
  return out.length === 0 ? EMPTY_DOC : docNode(out);
}

/** Marks in force at a plain-text offset: those of the character at `at`, else of the one before. */
export function marksAt(d: RichDoc, at: number): readonly Mark[] {
  for (const span of spans(d)) {
    if (at < span.start || at > span.end) continue;
    let pos = 0;
    let previous: readonly Mark[] = [];
    for (const node of span.p.content ?? []) {
      const local = at - span.start;
      if (local >= pos && local < pos + node.text.length) return node.marks ?? [];
      pos += node.text.length;
      previous = node.marks ?? [];
    }
    return previous;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Concat
// ---------------------------------------------------------------------------

function joinInline(a: RichDoc, b: RichDoc): RichDoc {
  const head = a.content.slice(0, -1);
  const last = a.content[a.content.length - 1] ?? paragraphNode();
  const first = b.content[0] ?? paragraphNode();
  const joined = paragraphNode([...(last.content ?? []), ...(first.content ?? [])]);
  return docNode([...head, joined, ...b.content.slice(1)]);
}

/**
 * Join documents end to end with a separator between each pair (FX-01
 * `Concat`). A `\n` in the separator becomes a paragraph break; a rich
 * separator keeps its own marks.
 */
export function concat(docs: readonly RichDoc[], separator: string | RichDoc = ''): RichDoc {
  const sep = typeof separator === 'string' ? richFromText(separator) : separator;
  let out: RichDoc | null = null;
  for (const d of docs) {
    out = out === null ? d : joinInline(joinInline(out, sep), d);
  }
  return normalise(out ?? EMPTY_DOC);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function withFlags(re: RegExp): RegExp {
  const flags = new Set(re.flags.split(''));
  flags.add('g');
  flags.add('d');
  return new RegExp(re.source, [...flags].join(''));
}

/** Every non-empty match of `pattern` in the plain text, left to right, non-overlapping. */
export function matches(d: RichDoc, pattern: Pattern): Match[] {
  const flat = plainText(d);
  const out: Match[] = [];
  if (typeof pattern === 'string') {
    if (pattern === '') return out;
    let from = 0;
    for (;;) {
      const at = flat.indexOf(pattern, from);
      if (at < 0) break;
      out.push({ start: at, end: at + pattern.length, text: pattern });
      from = at + pattern.length;
    }
    return out;
  }
  const re = withFlags(pattern);
  for (const m of flat.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) continue;
    const groupRange = m.indices?.[1];
    const group =
      groupRange === undefined
        ? undefined
        : {
            start: groupRange[0],
            end: groupRange[1],
            text: flat.slice(groupRange[0], groupRange[1]),
          };
    out.push(group === undefined ? { start, end, text: m[0] } : { start, end, text: m[0], group });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Split / Extract / Replace
// ---------------------------------------------------------------------------

/**
 * Cut the document at every match of `pattern`, dropping the matches
 * (PRD §4 `@Paragraph.Split(". ")` — each piece becomes a child row). With no
 * match the whole document is the single piece.
 */
export function split(d: RichDoc, pattern: Pattern): RichDoc[] {
  const flat = plainText(d);
  const out: RichDoc[] = [];
  let from = 0;
  for (const m of matches(d, pattern)) {
    out.push(normalise(slice(d, from, m.start)));
    from = m.end;
  }
  out.push(normalise(slice(d, from, flat.length)));
  return out;
}

/**
 * Every match of `pattern` as its own document, marks intact. When the
 * pattern has a capture group, the group is what is extracted (a
 * Parenthetical chip yields the text inside the parentheses).
 */
export function extract(d: RichDoc, pattern: Pattern): RichDoc[] {
  return matches(d, pattern).map((m) => {
    const range = m.group ?? m;
    return normalise(slice(d, range.start, range.end));
  });
}

/**
 * Replace every match with `replacement`. A plain-string replacement takes
 * the marks in force at the start of the match — replacing a bold word keeps
 * the bold — and a rich replacement keeps its own. Group references (`$1`)
 * are not interpreted; the replacement is literal.
 */
export function replace(d: RichDoc, pattern: Pattern, replacement: string | RichDoc): RichDoc {
  const flat = plainText(d);
  const pieces: RichDoc[] = [];
  let from = 0;
  for (const m of matches(d, pattern)) {
    pieces.push(slice(d, from, m.start));
    if (typeof replacement === 'string') {
      const marks = marksAt(d, m.start);
      pieces.push(
        docNode(
          replacement
            .split(PARAGRAPH_BREAK)
            .map((line) => paragraphNode(line === '' ? [] : [textNode(line, marks)])),
        ),
      );
    } else {
      pieces.push(replacement);
    }
    from = m.end;
  }
  pieces.push(slice(d, from, flat.length));
  return concat(pieces);
}

// ---------------------------------------------------------------------------
// Format (PRD §22 Text presets)
// ---------------------------------------------------------------------------

export type TextPreset = 'titleCase' | 'upper' | 'lower' | 'trimmed';

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LEADING_SPACE = /^\s+/u;
const TRAILING_SPACE = /\s+$/u;

function mapNodes(
  d: RichDoc,
  fn: (node: TextNode, index: number, p: Paragraph) => TextNode,
): RichDoc {
  return docNode(d.content.map((p) => paragraphNode((p.content ?? []).map((n, i) => fn(n, i, p)))));
}

function titleCaseParagraph(p: Paragraph, locale: string | undefined): Paragraph {
  let atWordStart = true;
  return paragraphNode(
    (p.content ?? []).map((node) => {
      let out = '';
      for (const ch of node.text) {
        const isWord = WORD_CHAR.test(ch);
        out += atWordStart && isWord ? ch.toLocaleUpperCase(locale) : ch.toLocaleLowerCase(locale);
        atWordStart = !isWord;
      }
      return textNode(out, node.marks ?? []);
    }),
  );
}

function trimParagraph(p: Paragraph): Paragraph {
  const nodes = [...(p.content ?? [])];
  // Leading: strip whitespace node by node until a node keeps something.
  while (nodes.length > 0) {
    const first = nodes[0];
    if (first === undefined) break;
    const stripped = first.text.replace(LEADING_SPACE, '');
    if (stripped === '') {
      nodes.shift();
      continue;
    }
    nodes[0] = textNode(stripped, first.marks ?? []);
    break;
  }
  while (nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    if (last === undefined) break;
    const stripped = last.text.replace(TRAILING_SPACE, '');
    if (stripped === '') {
      nodes.pop();
      continue;
    }
    nodes[nodes.length - 1] = textNode(stripped, last.marks ?? []);
    break;
  }
  return paragraphNode(nodes);
}

/**
 * Case and whitespace presets. Case conversion is per text node, so marks
 * keep their extent even where a locale changes the length (`ß` → `SS`).
 * `titleCase` capitalises the first letter of every word and lowercases the
 * rest, tracking word boundaries across marked runs. `trimmed` strips the
 * ends of every paragraph.
 */
export function format(d: RichDoc, kind: TextPreset, locale?: string): RichDoc {
  switch (kind) {
    case 'upper':
      return normalise(
        mapNodes(d, (n) => textNode(n.text.toLocaleUpperCase(locale), n.marks ?? [])),
      );
    case 'lower':
      return normalise(
        mapNodes(d, (n) => textNode(n.text.toLocaleLowerCase(locale), n.marks ?? [])),
      );
    case 'titleCase':
      return normalise(docNode(d.content.map((p) => titleCaseParagraph(p, locale))));
    case 'trimmed':
      return normalise(docNode(d.content.map(trimParagraph)));
  }
}
