/**
 * Binding and projection between what a person types and what is stored.
 *
 *   bindFormula('=Sum(B5:B6)', binder)   → '=Sum({r:T:R5:C:R6:C})'   at commit (once)
 *   projectFormula(stored, projector)     → '=Sum(B5:B6)'             for display, every time
 *
 * Both are pure text rewrites over the parser's spans; the callbacks answer
 * from the workbook (`engine/workbook-index.ts`). References that cannot be
 * bound (an address over empty canvas, an unknown `@` path) are left as typed
 * and keep their address semantics until re-committed.
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
  REMOVED_REFERENCE_TEXT,
  type BoundReference,
} from './bound.js';
import { parse } from './parser.js';

export interface BoundTarget {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

/** Answers "what sits at this address / path right now" for one sheet. */
export interface Binder {
  cellAt(ref: CellRef): BoundTarget | null;
  /** Table columns whose cells occupy the lattice column, in table order. */
  columnsAt(col: number): readonly { readonly tableId: Id; readonly colId: Id }[];
  entity(path: readonly string[]): BoundTarget | null;
}

/** Answers "where is this id now" for the whole workbook. */
export interface Projector {
  /** Lattice position of a cell, or null when it has none (gone, or in a hidden column). */
  positionOf(target: BoundTarget): CellRef | null;
  /** Whether the cell's row, column and table still exist. */
  exists(target: BoundTarget): boolean;
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

function bindOne(ref: Reference, binder: Binder): BoundReference | null {
  switch (ref.kind) {
    case 'address': {
      const t = binder.cellAt(ref.ref);
      return t === null ? null : { kind: 'cell', ...t, spelling: 'address' };
    }
    case 'range': {
      const from = binder.cellAt(ref.range.start);
      const to = binder.cellAt(ref.range.end);
      if (from === null || to === null) return null;
      if (from.tableId !== to.tableId) return null;
      return {
        kind: 'range',
        tableId: from.tableId,
        from: { rowId: from.rowId, colId: from.colId },
        to: { rowId: to.rowId, colId: to.colId },
      };
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
      return null;
  }
}

/**
 * Bind every reference in a typed formula to ids. Text that does not parse
 * is returned unchanged (the engine will report the parse error).
 */
export function bindFormula(text: string, binder: Binder): string {
  const parsed = parse(text);
  if (!parsed.ok) return text;
  const edits: Edit[] = [];
  for (const ref of references(parsed.value)) {
    const bound = bindOne(ref, binder);
    if (bound !== null) edits.push({ ...ref.span, text: encodeBound(bound) });
  }
  return edits.length === 0 ? text : splice(text, edits);
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
      const a = { tableId: ref.tableId, ...ref.from };
      const b = { tableId: ref.tableId, ...ref.to };
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
        hidden ||= projector.exists({ tableId: c.tableId, rowId: '', colId: c.colId });
      }
      return hidden ? HIDDEN_REFERENCE_TEXT : REMOVED_REFERENCE_TEXT;
    }
  }
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
