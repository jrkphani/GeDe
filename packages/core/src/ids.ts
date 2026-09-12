/**
 * Stable identity (PRD §20): rows, columns, tables, sheets and graphs carry
 * position-independent ULIDs generated client-side. Every reference stores ids;
 * A1 is a projection and is never persisted.
 */
import { monotonicFactory } from 'ulid';

/** A 26-character Crockford base32 ULID. */
export type Id = string;

/** `rowId:colId` — the key of a cell inside a table's `cells` map. */
export type CellKey = `${string}:${string}`;

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Monotonic within a process: two ids minted in the same millisecond still sort
 * in creation order, so "objects in creation order" is a plain string sort.
 */
const ulid = monotonicFactory();

export function newId(): Id {
  return ulid();
}

export function isId(value: unknown): value is Id {
  return typeof value === 'string' && ULID_RE.test(value);
}

export function cellKey(rowId: Id, colId: Id): CellKey {
  return `${rowId}:${colId}`;
}

/** Inverse of `cellKey`. Throws on a malformed key — a key is never user input. */
export function splitCellKey(key: string): { rowId: Id; colId: Id } {
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1 || key.includes(':', at + 1)) {
    throw new RangeError(`malformed cell key ${JSON.stringify(key)}`);
  }
  return { rowId: key.slice(0, at), colId: key.slice(at + 1) };
}

export function isCellKey(value: unknown): value is CellKey {
  if (typeof value !== 'string') return false;
  const at = value.indexOf(':');
  return at > 0 && at < value.length - 1 && !value.includes(':', at + 1);
}
