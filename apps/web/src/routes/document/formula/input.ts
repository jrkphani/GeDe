/**
 * Pure helpers over the editor's draft text (FX-04, FX-05). No DOM, no
 * React: the editor host owns the textarea and calls these with its value
 * and caret.
 */
import { formatAddress, type CellRef } from '@gede/core';

/** True when the draft is (going to be) a formula: it starts with `=`. */
export function isFormulaInput(text: string): boolean {
  return text.startsWith('=');
}

/** The draft is exactly `=`: the moment the forms menu opens (PRD §13). */
export function isBareEquals(text: string): boolean {
  return text.trim() === '=';
}

/**
 * The `@` path being typed at the caret, if any: `=Sum(@Ever` with the caret
 * at the end yields `{ start: 5, query: 'Ever' }`. Segments may be quoted.
 */
export function entityQueryAt(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  if (!isFormulaInput(text) && !isReferenceDraft(text)) return null;
  const before = text.slice(0, caret);
  const m = /@((?:"[^"]*"?|[^\s,()@"])*)$/u.exec(before);
  if (m === null) return null;
  return { start: caret - m[0].length, query: m[1] ?? '' };
}

/**
 * REF-01: a plain cell whose draft is an `@` path names an entity to
 * reference. Picking one turns the cell into a live reference — the draft
 * becomes `=@Path` and commits — so there is no formula to write.
 */
export function isReferenceDraft(text: string): boolean {
  return text.startsWith('@');
}

export interface Replacement {
  readonly text: string;
  readonly caret: number;
  /** Commit the replaced draft at once (a reference pick in a plain cell, REF-01). */
  readonly commit?: boolean | undefined;
}

/** Replace `[start, end)` with `insert`, leaving the caret after it. */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  insert: string,
): Replacement {
  const next = text.slice(0, start) + insert + text.slice(end);
  return { text: next, caret: start + insert.length };
}

/** Separator to put before an inserted reference so the formula still parses (FX-05). */
export function separatorBefore(before: string): string {
  const trimmed = before.trimEnd();
  if (trimmed === '' || /[=(,:]$/u.test(trimmed)) return '';
  return ', ';
}

/**
 * FX-05: insert a clicked cell's address at the caret with an appropriate
 * separator — none after `=`, `(`, `,` or `:`, otherwise `, `.
 */
export function insertReferenceAt(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  address: string,
): Replacement {
  const before = text.slice(0, selectionStart);
  return replaceRange(text, selectionStart, selectionEnd, separatorBefore(before) + address);
}

export function insertReferenceRefAt(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  ref: CellRef,
): Replacement {
  return insertReferenceAt(text, selectionStart, selectionEnd, formatAddress(ref));
}
