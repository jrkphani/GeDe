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
  /** Lattice units (GRID-01); 0 for a hidden column, which has no lattice presence (GRID-02). */
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
  /**
   * Per row, in row order; 2 for a wrapped row (GRID-09), 0 for a row hidden
   * under a collapsed parent, which has no lattice presence (HIER-06, GRID-02).
   */
  readonly rowHeights: readonly number[];
  /** Effective outline depth per row (HIER-02 applied); `@` paths are qualified by parent row. */
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

export type OperandKind = 'address' | 'range' | 'column' | 'entity';

/**
 * One operand as the engine resolved it, in operand order: the cells it
 * reads (the dependency edges) and whether a bound target is gone. Geometry
 * is deliberately absent — the UI projects labels and blocks from the
 * current lattice (`WorkbookIndex.operands`), so results never go stale
 * when a table moves.
 */
export interface ResolvedOperand {
  readonly index: number;
  readonly kind: OperandKind;
  readonly cellIds: readonly WorkbookCellId[];
  readonly missing: boolean;
  /** False when the operand is not bound to ids and follows the address instead (PRD §20). */
  readonly anchored: boolean;
}

/**
 * One operand for drawing (FX-08 colours by `index`): its label as the person
 * sees it today and the lattice block to outline — a range is one block, a
 * column the span of its populated cells — or `null` when nothing answers.
 */
export interface OperandOutline {
  readonly index: number;
  readonly kind: OperandKind;
  /** As projected today: `B14`, `B2:B14`, `B:B`, `@Group.Entity`, or `#REF`. */
  readonly label: string;
  /** Span in the text the outline was resolved from (a draft or a projected source). */
  readonly span: Span;
  readonly rect: UnitBounds | null;
  readonly cellIds: readonly WorkbookCellId[];
  /**
   * False for an operand in a stored formula that is not bound to ids — an
   * address that named empty canvas at commit — so it follows the position,
   * not a cell, and the UI must say so (PRD §20).
   */
  readonly anchored: boolean;
}

export interface CellResult {
  readonly cellId: WorkbookCellId;
  /** Increments whenever the result changes; React subscribes on it. */
  readonly version: number;
  readonly source: string;
  readonly value: CellValue | null;
  readonly error: CellError | null;
  readonly operands: readonly ResolvedOperand[];
}

// ---------------------------------------------------------------------------
// Worker protocol — plain objects both ways, correlated by `seq`.
// ---------------------------------------------------------------------------

export interface ApplyRequest {
  readonly type: 'apply';
  readonly seq: number;
  readonly changes: readonly WorkbookChange[];
}

/** Liveness probe: a Worker killed without an `error` event (out of memory) answers nothing. */
export interface PingRequest {
  readonly type: 'ping';
  readonly seq: number;
}

export type EngineRequest = ApplyRequest | PingRequest;

export interface ResultsResponse {
  readonly type: 'results';
  readonly seq: number;
  readonly results: readonly CellResult[];
  /** Formula cells that no longer exist or are no longer formulas. */
  readonly removed: readonly WorkbookCellId[];
  /** Engine time in milliseconds, for the performance budget (PRD §20). */
  readonly elapsedMs: number;
}

export interface PongResponse {
  readonly type: 'pong';
  readonly seq: number;
}

export type EngineResponse = ResultsResponse | PongResponse;

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
