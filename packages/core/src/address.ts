/**
 * A1 addressing (PRD §12, GRID-02, GRID-09).
 *
 * An address is a *projection* of lattice position: column letters along the
 * top, row numbers down the left, A1 at the origin. Nothing in the document
 * stores an address — rows, columns and cells carry stable ULIDs, and the
 * address of a cell is recomputed from where its table sits on the lattice and
 * how many lattice units the rows and columns before it occupy. A wrapped row
 * occupies two lattice rows, so the row after it is two addresses down.
 */
import type { LatticeUnits } from './lattice.js';
import { err, ok, type Result } from './result.js';

/** A cell position in lattice coordinates, both axes 0-based (A1 is `{col: 0, row: 0}`). */
export interface CellRef {
  readonly col: number;
  readonly row: number;
}

/** A rectangular block of cells, normalised so `start` is top-left and `end` bottom-right (inclusive). */
export interface CellRange {
  readonly start: CellRef;
  readonly end: CellRef;
}

/** A whole lattice column, as written `B:B`. */
export interface ColumnRef {
  readonly col: number;
}

export interface AddressError {
  readonly message: string;
  readonly input: string;
}

const LETTER_A = 65;
const RADIX = 26;

function assertIndex(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(value)}`);
  }
}

/** 0 → `A`, 25 → `Z`, 26 → `AA`, 701 → `ZZ`, 702 → `AAA`. */
export function columnLetter(index0: number): string {
  assertIndex(index0, 'column index');
  let n = index0;
  let out = '';
  for (;;) {
    out = String.fromCharCode(LETTER_A + (n % RADIX)) + out;
    n = Math.floor(n / RADIX) - 1;
    if (n < 0) return out;
  }
}

/** `A` → 0, `Z` → 25, `AA` → 26. Case-insensitive. Throws on anything that is not letters. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]+$/.test(letters)) {
    throw new RangeError(`column letters must be A–Z, got ${JSON.stringify(letters)}`);
  }
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * RADIX + (ch.charCodeAt(0) - LETTER_A + 1);
  }
  return n - 1;
}

/** `{col: 1, row: 13}` → `B14`. */
export function formatAddress(ref: CellRef): string {
  assertIndex(ref.row, 'row index');
  return `${columnLetter(ref.col)}${ref.row + 1}`;
}

/** `B2:B14`. The range is normalised before formatting. */
export function formatRange(range: CellRange): string {
  const n = normaliseRange(range);
  return `${formatAddress(n.start)}:${formatAddress(n.end)}`;
}

/** `B:B`. */
export function formatColumn(ref: ColumnRef): string {
  const letters = columnLetter(ref.col);
  return `${letters}:${letters}`;
}

/** Matches a whole address token: 1–3 letters then a positive row number. */
const ADDRESS_RE = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/;

/** Whether a string is exactly one A1 address (`B14`, case-insensitive). */
export function isAddressText(text: string): boolean {
  return ADDRESS_RE.test(text);
}

/** `B14` → `{col: 1, row: 13}`. Never throws. */
export function parseAddress(text: string): Result<CellRef, AddressError> {
  const m = ADDRESS_RE.exec(text.trim());
  if (!m) {
    return err({
      message: `${JSON.stringify(text)} is not a cell address such as B14`,
      input: text,
    });
  }
  const letters = m[1] ?? '';
  const digits = m[2] ?? '';
  return ok({ col: columnIndex(letters), row: Number(digits) - 1 });
}

/** `B2:B14` → normalised range. `B14:B2` is accepted and normalised. Never throws. */
export function parseRange(text: string): Result<CellRange, AddressError> {
  const parts = text.trim().split(':');
  if (parts.length !== 2) {
    return err({ message: `${JSON.stringify(text)} is not a range such as B2:B14`, input: text });
  }
  const start = parseAddress(parts[0] ?? '');
  if (!start.ok) return err({ message: start.error.message, input: text });
  const end = parseAddress(parts[1] ?? '');
  if (!end.ok) return err({ message: end.error.message, input: text });
  return ok(normaliseRange({ start: start.value, end: end.value }));
}

/** `B:B` → `{col: 1}`. Both sides must name the same column. Never throws. */
export function parseColumn(text: string): Result<ColumnRef, AddressError> {
  const m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(text.trim());
  if (!m) {
    return err({ message: `${JSON.stringify(text)} is not a column such as B:B`, input: text });
  }
  const a = columnIndex(m[1] ?? '');
  const b = columnIndex(m[2] ?? '');
  if (a !== b) {
    return err({ message: `a column reference names one column, got ${text}`, input: text });
  }
  return ok({ col: a });
}

export function normaliseRange(range: CellRange): CellRange {
  return {
    start: {
      col: Math.min(range.start.col, range.end.col),
      row: Math.min(range.start.row, range.end.row),
    },
    end: {
      col: Math.max(range.start.col, range.end.col),
      row: Math.max(range.start.row, range.end.row),
    },
  };
}

/** Number of cells a range covers. */
export function rangeSize(range: CellRange): number {
  const n = normaliseRange(range);
  return (n.end.col - n.start.col + 1) * (n.end.row - n.start.row + 1);
}

/** Every cell in a range, row-major (B2, C2, B3, C3 …). */
export function cellsInRange(range: CellRange): CellRef[] {
  const n = normaliseRange(range);
  const cells: CellRef[] = [];
  for (let row = n.start.row; row <= n.end.row; row += 1) {
    for (let col = n.start.col; col <= n.end.col; col += 1) {
      cells.push({ col, row });
    }
  }
  return cells;
}

export function sameRef(a: CellRef, b: CellRef): boolean {
  return a.col === b.col && a.row === b.row;
}

export function rangeContains(range: CellRange, ref: CellRef): boolean {
  const n = normaliseRange(range);
  return (
    ref.col >= n.start.col && ref.col <= n.end.col && ref.row >= n.start.row && ref.row <= n.end.row
  );
}

// ---------------------------------------------------------------------------
// Addresses derived from lattice geometry
// ---------------------------------------------------------------------------

/**
 * Lattice geometry of a table: its origin and the size, in whole units, of each
 * column and row in ordinal order. A wrapped row has height 2 (GRID-09); a hidden
 * row or column has size 0 and therefore does not advance the address of what
 * follows it (GRID-02).
 */
export interface TableGeometry {
  readonly origin: LatticeUnits;
  readonly columnWidths: readonly number[];
  readonly rowHeights: readonly number[];
}

/** Start offset, in units, of each ordinal position given the sizes before it. */
export function offsetsFromSizes(sizes: readonly number[]): number[] {
  const offsets: number[] = new Array<number>(sizes.length);
  let acc = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const size = sizes[i] ?? 0;
    assertIndex(size, 'size');
    offsets[i] = acc;
    acc += size;
  }
  return offsets;
}

/**
 * The A1 position of the cell at (column ordinal, row ordinal) in a table. The
 * result is the top-left lattice cell the table cell covers; a column two units
 * wide is addressed by its first letter.
 */
export function cellRefInTable(
  geometry: TableGeometry,
  columnOrdinal: number,
  rowOrdinal: number,
): CellRef {
  assertIndex(columnOrdinal, 'column ordinal');
  assertIndex(rowOrdinal, 'row ordinal');
  if (columnOrdinal >= geometry.columnWidths.length || rowOrdinal >= geometry.rowHeights.length) {
    throw new RangeError(`cell (${columnOrdinal}, ${rowOrdinal}) is outside the table`);
  }
  const cols = offsetsFromSizes(geometry.columnWidths);
  const rows = offsetsFromSizes(geometry.rowHeights);
  return {
    col: geometry.origin.col + (cols[columnOrdinal] ?? 0),
    row: geometry.origin.row + (rows[rowOrdinal] ?? 0),
  };
}

/**
 * Every cell address in a table, indexed `[rowOrdinal][columnOrdinal]`. Computed
 * in one pass so the renderer can call it once per structural edit rather than
 * per cell.
 */
export function addressGrid(geometry: TableGeometry): string[][] {
  const cols = offsetsFromSizes(geometry.columnWidths);
  const rows = offsetsFromSizes(geometry.rowHeights);
  return rows.map((rowOffset) =>
    cols.map((colOffset) =>
      formatAddress({ col: geometry.origin.col + colOffset, row: geometry.origin.row + rowOffset }),
    ),
  );
}
