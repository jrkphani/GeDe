/**
 * Find query grammar (FIND-04). A query is whitespace-separated tokens:
 *
 *   col:Group          restrict to columns whose label matches "Group"
 *   col:"Work Group"   quoted when the label has spaces
 *   is:currency        restrict to cells whose resolved format is currency
 *   is:date|number     several formats, any of them
 *   anything else      a bare term; bare terms join into one phrase that
 *                      matches anywhere in the text
 *
 * Operators are ASCII and case-insensitive; the phrase may be any script.
 */

export const FORMAT_KINDS = ['currency', 'date', 'number', 'text'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];

export interface ParsedQuery {
  /** Bare terms joined by single spaces; '' when the query is operators only. */
  readonly phrase: string;
  /** `col:` operands, unquoted, in order. Empty means every column. */
  readonly columns: readonly string[];
  /** `is:` operands. Empty means every format. */
  readonly formats: readonly FormatKind[];
}

export function isFormatKind(value: string): value is FormatKind {
  return (FORMAT_KINDS as readonly string[]).includes(value);
}

/** Split on whitespace, keeping double-quoted runs together (quotes removed). */
function tokens(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let seen = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      seen = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (seen) out.push(current);
      current = '';
      seen = false;
      continue;
    }
    current += ch;
    seen = true;
  }
  if (seen) out.push(current);
  return out;
}

export function parseQuery(raw: string): ParsedQuery {
  const terms: string[] = [];
  const columns: string[] = [];
  const formats: FormatKind[] = [];
  for (const token of tokens(raw)) {
    const colon = token.indexOf(':');
    const op = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const operand = colon > 0 ? token.slice(colon + 1) : '';
    if (op === 'col' && operand !== '') {
      columns.push(operand);
    } else if (op === 'is' && operand !== '') {
      for (const part of operand.toLowerCase().split(/[|,]/)) {
        if (isFormatKind(part) && !formats.includes(part)) formats.push(part);
      }
    } else if (token !== '') {
      terms.push(token);
    }
  }
  return { phrase: terms.join(' '), columns, formats };
}

/** True when the query would match nothing by construction (no phrase and no operator). */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.phrase === '' && q.columns.length === 0 && q.formats.length === 0;
}
