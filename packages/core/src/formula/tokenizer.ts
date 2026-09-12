/**
 * Formula tokenizer. Produces a flat token list with spans; the parser decides
 * meaning (an identifier is an address only where an address is expected, and
 * in list mode anything that is not a reference is separator text).
 */
import type { ParseError, Span } from './ast.js';
import { decodeBound, type BoundReference } from './bound.js';

export type TokenKind =
  | 'equals'
  | 'ident'
  | 'number'
  | 'string'
  | 'at'
  | 'dot'
  | 'comma'
  | 'colon'
  | 'lparen'
  | 'rparen'
  | 'space'
  | 'bound'
  | 'other'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Raw text as typed. */
  readonly text: string;
  /** Decoded value for strings; numeric value for numbers; the reference for bound tokens. */
  readonly value: string | number | BoundReference | undefined;
  readonly span: Span;
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{M}\p{N}_]/u;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

export type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; error: ParseError };

export function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;

  const push = (
    kind: TokenKind,
    start: number,
    end: number,
    value?: string | number | BoundReference,
  ): void => {
    tokens.push({ kind, text: text.slice(start, end), value, span: { start, end } });
  };

  while (i < n) {
    const ch = text[i] ?? '';
    const start = i;

    if (ch === '=') {
      push('equals', start, ++i);
    } else if (ch === '@') {
      push('at', start, ++i);
    } else if (ch === '.') {
      push('dot', start, ++i);
    } else if (ch === ',') {
      push('comma', start, ++i);
    } else if (ch === ':') {
      push('colon', start, ++i);
    } else if (ch === '(') {
      push('lparen', start, ++i);
    } else if (ch === ')') {
      push('rparen', start, ++i);
    } else if (ch === '{') {
      // An id-bound token (`{c:…}`); a brace that is not one is ordinary text.
      const close = text.indexOf('}', i);
      const bound = close < 0 ? null : decodeBound(text.slice(i, close + 1));
      if (bound === null) {
        push('other', start, ++i);
      } else {
        i = close + 1;
        push('bound', start, i, bound);
      }
    } else if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = '';
      let closed = false;
      while (i < n) {
        const c = text[i] ?? '';
        if (c === '\\' && i + 1 < n) {
          value += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) {
        return {
          ok: false,
          error: { message: 'unterminated string literal', span: { start, end: n } },
        };
      }
      push('string', start, i, value);
    } else if (DIGIT.test(ch)) {
      i += 1;
      while (i < n && DIGIT.test(text[i] ?? '')) i += 1;
      if (i + 1 < n && text[i] === '.' && DIGIT.test(text[i + 1] ?? '')) {
        i += 1;
        while (i < n && DIGIT.test(text[i] ?? '')) i += 1;
      }
      push('number', start, i, Number(text.slice(start, i)));
    } else if (IDENT_START.test(ch)) {
      i += 1;
      while (i < n && IDENT_PART.test(text[i] ?? '')) i += 1;
      push('ident', start, i);
    } else if (SPACE.test(ch)) {
      i += 1;
      while (i < n && SPACE.test(text[i] ?? '')) i += 1;
      push('space', start, i);
    } else {
      // One code point of anything else (punctuation, symbols, emoji).
      const cp = text.codePointAt(i) ?? 0;
      i += cp > 0xffff ? 2 : 1;
      push('other', start, i);
    }
  }
  push('eof', n, n);
  return { ok: true, tokens };
}
