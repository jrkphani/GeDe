/**
 * The reactive formula engine's data model (PRD §20 "DAG state engine"; FX-06).
 *
 * Everything that crosses the Worker boundary is plain data: the main thread
 * observes the Y.Doc and ships `WorkbookChange`s; the engine (in a Worker, or
 * inline in tests) answers with `CellResult`s. Nothing here references Yjs,
 * so the same engine runs in Node, a Worker and the main-thread fallback.
 *
 * Cells are identified by `WorkbookCellId` — `${tableId}/${rowId}:${colId}` —
 * a stable id that survives insert, delete, move and reorder. A1 addresses are
 * resolved against the current geometry at evaluation time and never stored.
 */
import type { CellRange, CellRef } from '../address.js';
import type { UnitBounds } from '../doc/geometry.js';
import type { CellKey, Id } from '../ids.js';
import type { ParseError, Span } from '../formula/ast.js';
import type { CellValue, FormulaError } from '../formula/evaluate.js';

/** `${tableId}/${rowId}:${colId}` — see `workbookCellId`. */
export type WorkbookCellId = string;

export function workbookCellId(tableId: Id, key: CellKey): WorkbookCellId {
  return `${tableId}/${key}`;
}

export function splitWorkbookCellId(id: WorkbookCellId): { tableId: Id; key: CellKey } {
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) {
    throw new RangeError(`malformed workbook cell id ${JSON.stringify(id)}`);
  }
  return { tableId: id.slice(0, at), key: id.slice(at + 1) as CellKey };
}

export interface ColumnStructure {
  readonly id: Id;
  readonly label: string;
  /** Lattice units (GRID-01). */
  readonly width: number;
}

/** A table's geometry and labels — everything but its cell contents. */
export interface TableStructure {
  readonly id: Id;
  readonly sheetId: Id;
  readonly title: string;
  readonly gridCol: number;
  readonly gridRow: number;
  readonly columns: readonly ColumnStructure[];
  readonly rows: readonly Id[];
  /** Per row, in row order; 2 for a wrapped row (GRID-09). */
  readonly rowHeights: readonly number[];
  /** Outline depth per row (HIER); `@` paths are qualified by parent row. */
  readonly rowDepths: readonly number[];
}

export type CellSnapshot =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'formula'; readonly source: string };

export interface TableSnapshot extends TableStructure {
  readonly cells: Readonly<Record<CellKey, CellSnapshot>>;
}

export interface WorkbookSnapshot {
  readonly tables: readonly TableSnapshot[];
}

/**
 * One transaction's worth of change, as the observer sees it. `reset` replaces
 * everything (first load, or an observer that lost track); `table` upserts a
 * table's structure without touching its cells; `cells` sets (or, with `null`,
 * clears) individual cells.
 */
export type WorkbookChange =
  | { readonly type: 'reset'; readonly snapshot: WorkbookSnapshot }
  | { readonly type: 'table'; readonly table: TableStructure }
  | { readonly type: 'table-removed'; readonly tableId: Id }
  | {
      readonly type: 'cells';
      readonly tableId: Id;
      readonly cells: Readonly<Record<CellKey, CellSnapshot | null>>;
    };

/** Why a formula cell shows `⚠`: a parse failure or an evaluation error. */
export type CellError = FormulaError | { readonly kind: 'parse'; readonly error: ParseError };

/**
 * One operand of a formula, in operand order (FX-08 colours by `index`).
 * `rect` is the lattice block to outline — a range is one block, a column the
 * span of its populated cells — or `null` when nothing on the sheet answers.
 */
export interface OperandOutline {
  readonly index: number;
  readonly kind: 'address' | 'range' | 'column' | 'entity';
  /** As written: `B14`, `B2:B14`, `B:B`, `@Group.Entity`. */
  readonly label: string;
  readonly span: Span;
  readonly rect: UnitBounds | null;
  /** Cells the operand reads, for the dependency graph. */
  readonly cellIds: readonly WorkbookCellId[];
}

export interface CellResult {
  readonly cellId: WorkbookCellId;
  /** Increments whenever the result changes; React subscribes on it. */
  readonly version: number;
  readonly source: string;
  readonly value: CellValue | null;
  readonly error: CellError | null;
  readonly operands: readonly OperandOutline[];
}

// ---------------------------------------------------------------------------
// Worker protocol — plain objects both ways, correlated by `seq`.
// ---------------------------------------------------------------------------

export interface ApplyRequest {
  readonly type: 'apply';
  readonly seq: number;
  readonly changes: readonly WorkbookChange[];
}

export type EngineRequest = ApplyRequest;

export interface ResultsResponse {
  readonly type: 'results';
  readonly seq: number;
  readonly results: readonly CellResult[];
  /** Formula cells that no longer exist or are no longer formulas. */
  readonly removed: readonly WorkbookCellId[];
  /** Engine time in milliseconds, for the performance budget (PRD §20). */
  readonly elapsedMs: number;
}

export type EngineResponse = ResultsResponse;

/** A resolved position on a sheet's lattice: the cell there and how many units it covers. */
export interface IndexedCell {
  readonly cellId: WorkbookCellId;
  readonly tableId: Id;
  readonly key: CellKey;
  readonly ref: CellRef;
  readonly cols: number;
  readonly rows: number;
}

export interface EntityEntry {
  /** Unquoted segments: `[tableTitle, ...ancestorRowLabels, rowLabel, columnLabel?]`. */
  readonly path: readonly string[];
  /** Formatted for insertion: `@Table.Row` or `@"Everest trek".Row`. */
  readonly text: string;
  readonly cellId: WorkbookCellId;
  readonly tableId: Id;
}

export type { CellRange, CellRef };
