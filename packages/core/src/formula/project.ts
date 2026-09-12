/**
 * Binding and projection between what a person types and what is stored.
 *
 *   bindFormula('=Sum(B5:B6)', binder)   → '=Sum({r:T:R5:C:R6:C})'   at commit (once)
 *   projectFormula(stored, projector)     → '=Sum(B5:B6)'             for display, every time
 *
 * Both are pure text rewrites over the parser's spans; the callbacks answer
 * from the workbook (`engine/workbook-index.ts`). A range with one corner
 * past the table binds that corner open-ended (`^` first, `*` last row or
 * column) so it follows the table; a reference that names nothing at all
 * (an address over empty canvas, an unknown `@` path, a range across two
 * tables) is left as typed and keeps its address semantics — the UI marks
 * such operands as not anchored. A `#REF` / `#hidden` the editor showed
 * keeps the token the cell already held at that operand.
 */
import {
  formatAddress,
  formatColumn,
  formatRange,
  type CellRange,
  type CellRef,
} from '../address.js';
import type { Id } from '../ids.js';
import { references, type Reference } from './ast.js';
import {
  encodeBound,
  HIDDEN_REFERENCE_TEXT,
  isOpenCorner,
  REMOVED_REFERENCE_TEXT,
  type BoundReference,
  type CornerId,
  type OpenCorner,
} from './bound.js';
import { parse } from './parser.js';

export interface BoundTarget {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

/** A range corner: a cell, or an open edge of the table (`^` first, `*` last). */
export interface CornerTarget {
  readonly tableId: Id;
  readonly rowId: CornerId;
  readonly colId: CornerId;
}

/** Lattice extent of a table's data cells, inclusive, for open-ended corners. */
export interface TableExtent {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

/** Answers "what sits at this address / path right now" for one sheet. */
export interface Binder {
  cellAt(ref: CellRef): BoundTarget | null;
  /** Table columns whose cells occupy the lattice column, in table order. */
  columnsAt(col: number): readonly { readonly tableId: Id; readonly colId: Id }[];
  entity(path: readonly string[]): BoundTarget | null;
  /** Where a table's data cells lie on the lattice, or null when it has none. */
  extentOf(tableId: Id): TableExtent | null;
}

/** Answers "where is this id now" for the whole workbook. */
export interface Projector {
  /** Lattice position of a cell or open corner, or null when it has none (gone, or in a hidden column). */
  positionOf(target: CornerTarget): CellRef | null;
  /** Whether the cell's row, column and table still exist (an open corner needs only the table). */
  exists(target: CornerTarget): boolean;
  /** Written `@` path of a cell (`@Table.Row` for a row's first cell), or null when gone. */
  entityPathOf(target: BoundTarget): string | null;
  /** Lattice column of a table column, or null when gone. */
  columnOf(tableId: Id, colId: Id): number | null;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function splice(text: string, edits: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/** Which edge a position past the table clamps to, or null when it is inside (no cell there: hidden). */
function openRow(row: number, extent: TableExtent): OpenCorner | null {
  if (row < extent.firstRow) return '^';
  if (row > extent.lastRow) return '*';
  return null;
}

function openCol(col: number, extent: TableExtent): OpenCorner | null {
  if (col < extent.firstCol) return '^';
  if (col > extent.lastCol) return '*';
  return null;
}

/** Bind a range with one corner on a table and the other past its edge. */
function bindOpenRange(
  binder: Binder,
  anchored: BoundTarget,
  loose: CellRef,
  anchorIsFrom: boolean,
): BoundReference | null {
  const extent = binder.extentOf(anchored.tableId);
  if (extent === null) return null;
  const rowOpen = openRow(loose.row, extent);
  const colOpen = openCol(loose.col, extent);
  // Inside the table's box yet no cell there (a hidden column): stay positional.
  if (rowOpen === null && colOpen === null) return null;
  let open: { rowId: CornerId; colId: CornerId };
  if (rowOpen !== null && colOpen !== null) {
    open = { rowId: rowOpen, colId: colOpen };
  } else if (rowOpen !== null) {
    // The column is inside the table: the loose corner is that column at the open edge.
    const row = rowOpen === '^' ? extent.firstRow : extent.lastRow;
    const edge = binder.cellAt({ col: loose.col, row });
    if (edge?.tableId !== anchored.tableId) return null;
    open = { rowId: rowOpen, colId: edge.colId };
  } else {
    const col = colOpen === '^' ? extent.firstCol : extent.lastCol;
    const edge = binder.cellAt({ col, row: loose.row });
    if (edge?.tableId !== anchored.tableId || colOpen === null) return null;
    open = { rowId: edge.rowId, colId: colOpen };
  }
  const anchor = { rowId: anchored.rowId, colId: anchored.colId };
  return {
    kind: 'range',
    tableId: anchored.tableId,
    from: anchorIsFrom ? anchor : open,
    to: anchorIsFrom ? open : anchor,
  };
}

function bindOne(ref: Reference, binder: Binder): BoundReference | null {
  switch (ref.kind) {
    case 'address': {
      const t = binder.cellAt(ref.ref);
      return t === null ? null : { kind: 'cell', ...t, spelling: 'address' };
    }
    case 'range': {
      const from = binder.cellAt(ref.range.start);
      const to = binder.cellAt(ref.range.end);
      if (from !== null && to !== null) {
        if (from.tableId !== to.tableId) return null;
        return {
          kind: 'range',
          tableId: from.tableId,
          from: { rowId: from.rowId, colId: from.colId },
          to: { rowId: to.rowId, colId: to.colId },
        };
      }
      if (from !== null) return bindOpenRange(binder, from, ref.range.end, true);
      if (to !== null) return bindOpenRange(binder, to, ref.range.start, false);
      return null;
    }
    case 'column': {
      const columns = binder.columnsAt(ref.col);
      return columns.length === 0 ? null : { kind: 'column', columns };
    }
    case 'entity': {
      const t = binder.entity(ref.path);
      return t === null ? null : { kind: 'cell', ...t, spelling: 'entity' };
    }
    case 'bound':
    case 'placeholder':
      return null;
  }
}

function isPlaceholderText(text: string): boolean {
  return text === REMOVED_REFERENCE_TEXT || text === HIDDEN_REFERENCE_TEXT;
}

/** The stored source the cell held before this commit, so placeholders keep their tokens. */
export interface PreviousSource {
  readonly source: string;
  readonly projector: Projector;
}

/**
 * Bind every reference in a typed formula to ids. Text that does not parse
 * is returned unchanged (the engine will report the parse error). Given the
 * cell's previous source, each `#REF` / `#hidden` in the typed text keeps, in
 * order, the previous token that projects to a placeholder: opening a
 * formula that shows `#hidden`, adding an operand and committing leaves the
 * hidden reference bound.
 */
export function bindFormula(text: string, binder: Binder, previous?: PreviousSource): string {
  const parsed = parse(text);
  if (!parsed.ok) return text;
  const kept = previous === undefined ? [] : placeholderTokens(previous);
  let next = 0;
  const edits: Edit[] = [];
  for (const ref of references(parsed.value)) {
    if (ref.kind === 'placeholder') {
      const token = kept[next];
      next += 1;
      if (token !== undefined) edits.push({ ...ref.span, text: token });
      continue;
    }
    const bound = bindOne(ref, binder);
    if (bound !== null) edits.push({ ...ref.span, text: encodeBound(bound) });
  }
  return edits.length === 0 ? text : splice(text, edits);
}

/** The previous source's bound tokens that currently project to a placeholder, in order. */
function placeholderTokens(previous: PreviousSource): string[] {
  const parsed = parse(previous.source);
  if (!parsed.ok) return [];
  const out: string[] = [];
  for (const ref of references(parsed.value)) {
    if (ref.kind !== 'bound') continue;
    if (isPlaceholderText(projectOne(ref.ref, previous.projector))) {
      out.push(previous.source.slice(ref.span.start, ref.span.end));
    }
  }
  return out;
}

function projectOne(ref: BoundReference, projector: Projector): string {
  switch (ref.kind) {
    case 'cell': {
      if (ref.spelling === 'entity') {
        return projector.entityPathOf(ref) ?? REMOVED_REFERENCE_TEXT;
      }
      const at = projector.positionOf(ref);
      if (at !== null) return formatAddress(at);
      return projector.exists(ref) ? HIDDEN_REFERENCE_TEXT : REMOVED_REFERENCE_TEXT;
    }
    case 'range': {
      const a: CornerTarget = { tableId: ref.tableId, ...ref.from };
      const b: CornerTarget = { tableId: ref.tableId, ...ref.to };
      const from = projector.positionOf(a);
      const to = projector.positionOf(b);
      if (from === null || to === null) {
        return projector.exists(a) && projector.exists(b)
          ? HIDDEN_REFERENCE_TEXT
          : REMOVED_REFERENCE_TEXT;
      }
      const range: CellRange = { start: from, end: to };
      return formatRange(range);
    }
    case 'column': {
      let hidden = false;
      for (const c of ref.columns) {
        const col = projector.columnOf(c.tableId, c.colId);
        if (col !== null) return formatColumn({ col });
        hidden ||= projector.exists({ tableId: c.tableId, rowId: '^', colId: c.colId });
      }
      return hidden ? HIDDEN_REFERENCE_TEXT : REMOVED_REFERENCE_TEXT;
    }
  }
}

/** Whether a range corner is an open edge rather than a cell. */
export function isOpenTarget(target: CornerTarget): boolean {
  return isOpenCorner(target.rowId) || isOpenCorner(target.colId);
}

/** The stored formula as the person should see it: ids projected to today's addresses. */
export function projectFormula(source: string, projector: Projector): string {
  if (!source.includes('{')) return source;
  const parsed = parse(source);
  if (!parsed.ok) return source;
  const edits: Edit[] = [];
  for (const ref of references(parsed.value)) {
    if (ref.kind === 'bound') edits.push({ ...ref.span, text: projectOne(ref.ref, projector) });
  }
  return edits.length === 0 ? source : splice(source, edits);
}
