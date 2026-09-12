/**
 * The reactive formula engine (PRD §20 "DAG state engine"; FX-02, FX-06).
 *
 * `FormulaEngine` owns a plain-data copy of the workbook, the dependency
 * graph and a result per formula cell. `apply(changes)` is the only entry
 * point: it folds the changes in, re-resolves references whose geometry or
 * entity index moved, evaluates the dirty nodes in topological batches and
 * returns the results that changed. It never touches Yjs, React or the DOM,
 * so it runs unchanged in a Web Worker, in Node and inline in tests.
 *
 * Invariants
 * - Graph nodes are `WorkbookCellId`s. Addresses are resolved against the
 *   current geometry on every structural edit; no stale reads (GRID-02).
 * - Evaluation order is topological; a cycle yields `circular` on every
 *   member and on everything downstream (FX-06).
 * - Errors are values. Nothing here throws for user input.
 */
import type { UnitBounds } from '../doc/geometry.js';
import { DependencyGraph } from '../graph.js';
import { references, type Ast, type ParseError } from '../formula/ast.js';
import { evaluate, type CellValue, type Resolver } from '../formula/evaluate.js';
import { parse } from '../formula/parser.js';
import type { CellKey, Id } from '../ids.js';
import { buildEntityIndex, type EntityIndex } from './entities.js';
import { buildSheetIndex, entityKey, resolveOperands, type SheetIndex } from './sheet-index.js';
import {
  workbookCellId,
  type CellError,
  type CellResult,
  type CellSnapshot,
  type EngineRequest,
  type EngineResponse,
  type OperandOutline,
  type TableStructure,
  type WorkbookCellId,
  type WorkbookChange,
} from './types.js';
import { inferCellValue } from './values.js';

interface FormulaState {
  readonly source: string;
  readonly ast: Ast | null;
  readonly parseError: ParseError | null;
  readonly usesAddress: boolean;
  readonly usesEntity: boolean;
  operands: readonly OperandOutline[];
}

interface CellState {
  readonly id: WorkbookCellId;
  readonly key: CellKey;
  readonly tableId: Id;
  snapshot: CellSnapshot;
  /** Lazily inferred for text cells; null until read. */
  value: CellValue | null;
  formula: FormulaState | null;
}

interface TableState {
  structure: TableStructure;
  readonly cells: Map<CellKey, CellState>;
}

interface ParsedFormula {
  readonly ast: Ast | null;
  readonly parseError: ParseError | null;
}

export interface ApplyOutcome {
  readonly results: CellResult[];
  readonly removed: WorkbookCellId[];
}

/** A resolver that never recurses: every input was evaluated in an earlier batch. */
class EngineResolver implements Resolver {
  constructor(
    private readonly engine: FormulaEngine,
    private readonly index: SheetIndex,
    private readonly blocked: ReadonlySet<WorkbookCellId>,
  ) {}

  valueAt(ref: { col: number; row: number }): CellValue | undefined {
    const cell = this.index.byPosition.get(`${String(ref.col)},${String(ref.row)}`);
    if (cell === undefined) return undefined;
    return this.engine.valueOf(cell.cellId, this.blocked);
  }

  entity(path: readonly string[]): CellValue | undefined {
    const entry = this.engine.entityIndex().byKey.get(entityKey(path));
    if (entry === undefined) return undefined;
    return this.engine.valueOf(entry.cellId, this.blocked);
  }

  columnValues(col: number): { row: number; value: CellValue }[] {
    const out: { row: number; value: CellValue }[] = [];
    for (const cell of this.index.byColumn.get(col) ?? []) {
      const value = this.engine.valueOf(cell.cellId, this.blocked);
      if (value.kind !== 'blank') out.push({ row: cell.ref.row, value });
    }
    return out;
  }
}

export class FormulaEngine {
  private readonly tables = new Map<Id, TableState>();
  private readonly cells = new Map<WorkbookCellId, CellState>();
  private readonly graph = new DependencyGraph();
  private readonly results = new Map<WorkbookCellId, CellResult>();
  private readonly sheetIndexes = new Map<Id, SheetIndex>();
  private readonly parseCache = new Map<string, ParsedFormula>();
  private readonly needsResolve = new Set<WorkbookCellId>();
  private entities: EntityIndex | null = null;
  private version = 0;

  /** Message-shaped entry point for the Worker. */
  handle(request: EngineRequest): EngineResponse {
    const started = now();
    const outcome = this.apply(request.changes);
    return {
      type: 'results',
      seq: request.seq,
      results: outcome.results,
      removed: outcome.removed,
      elapsedMs: now() - started,
    };
  }

  /** Fold changes in and evaluate. Returns only the results that changed. */
  apply(changes: readonly WorkbookChange[]): ApplyOutcome {
    const removed: WorkbookCellId[] = [];
    for (const change of changes) {
      switch (change.type) {
        case 'reset':
          this.reset(removed);
          for (const table of change.snapshot.tables) {
            this.upsertTable(table, removed);
            this.setCells(table.id, table.cells, removed);
          }
          break;
        case 'table':
          this.upsertTable(change.table, removed);
          break;
        case 'table-removed':
          this.removeTable(change.tableId, removed);
          break;
        case 'cells':
          this.setCells(change.tableId, change.cells, removed);
          break;
      }
    }
    const results = this.evaluate();
    return { results, removed };
  }

  result(cellId: WorkbookCellId): CellResult | undefined {
    return this.results.get(cellId);
  }

  get resultCount(): number {
    return this.results.size;
  }

  /** The current dependency edges, for tests and the inspector. */
  dependenciesOf(cellId: WorkbookCellId): ReadonlySet<WorkbookCellId> {
    return this.graph.dependenciesOf(cellId);
  }

  sheetIndex(sheetId: Id): SheetIndex {
    let index = this.sheetIndexes.get(sheetId);
    if (index === undefined) {
      index = buildSheetIndex(
        sheetId,
        [...this.tables.values()].map((t) => t.structure),
      );
      this.sheetIndexes.set(sheetId, index);
    }
    return index;
  }

  entityIndex(): EntityIndex {
    this.entities ??= buildEntityIndex(
      [...this.tables.values()].map((t) => t.structure),
      (tableId, key) => {
        const cell = this.tables.get(tableId)?.cells.get(key);
        return cell?.snapshot.kind === 'text' ? cell.snapshot.text : '';
      },
    );
    return this.entities;
  }

  /** The value a formula reads from a cell: inferred text, or a formula's result (errors propagate). */
  valueOf(cellId: WorkbookCellId, blocked: ReadonlySet<WorkbookCellId>): CellValue {
    const cell = this.cells.get(cellId);
    if (cell === undefined) return { kind: 'blank' };
    if (cell.formula !== null) {
      if (blocked.has(cellId)) return { kind: 'error', error: { kind: 'circular' } };
      const result = this.results.get(cellId);
      if (result === undefined) return { kind: 'blank' };
      if (result.error !== null) {
        return {
          kind: 'error',
          error:
            result.error.kind === 'parse'
              ? { kind: 'invalid-argument', message: result.error.error.message }
              : result.error,
        };
      }
      return result.value ?? { kind: 'blank' };
    }
    cell.value ??= inferCellValue(cell.snapshot.kind === 'text' ? cell.snapshot.text : '');
    return cell.value;
  }

  // -- state --------------------------------------------------------------------

  private reset(removed: WorkbookCellId[]): void {
    for (const id of this.results.keys()) removed.push(id);
    for (const id of [...this.cells.keys()]) this.graph.removeNode(id);
    this.tables.clear();
    this.cells.clear();
    this.results.clear();
    this.sheetIndexes.clear();
    this.needsResolve.clear();
    this.entities = null;
  }

  private upsertTable(structure: TableStructure, removed: WorkbookCellId[]): void {
    const existing = this.tables.get(structure.id);
    if (existing === undefined) {
      this.tables.set(structure.id, { structure, cells: new Map() });
    } else {
      if (existing.structure.sheetId !== structure.sheetId) {
        this.invalidateSheet(existing.structure.sheetId);
      }
      existing.structure = structure;
      // Rows or columns that vanished take their cells with them.
      const rows = new Set(structure.rows);
      const cols = new Set(structure.columns.map((c) => c.id));
      for (const [key, cell] of existing.cells) {
        const at = key.indexOf(':');
        if (!rows.has(key.slice(0, at)) || !cols.has(key.slice(at + 1))) {
          this.dropCell(cell, removed);
          existing.cells.delete(key);
        }
      }
    }
    this.invalidateSheet(structure.sheetId);
    this.invalidateEntities();
  }

  private removeTable(tableId: Id, removed: WorkbookCellId[]): void {
    const table = this.tables.get(tableId);
    if (table === undefined) return;
    for (const cell of table.cells.values()) this.dropCell(cell, removed);
    this.tables.delete(tableId);
    this.invalidateSheet(table.structure.sheetId);
    this.invalidateEntities();
  }

  private setCells(
    tableId: Id,
    cells: Readonly<Record<string, CellSnapshot | null>>,
    removed: WorkbookCellId[],
  ): void {
    const table = this.tables.get(tableId);
    if (table === undefined) return;
    const firstCol = table.structure.columns[0]?.id;
    for (const [rawKey, snapshot] of Object.entries(cells)) {
      const key = rawKey as CellKey;
      const id = workbookCellId(tableId, key);
      const existing = table.cells.get(key);
      if (snapshot === null) {
        if (existing !== undefined) {
          this.dropCell(existing, removed, true);
          table.cells.delete(key);
        }
        continue;
      }
      const cell: CellState = existing ?? {
        id,
        key,
        tableId,
        snapshot,
        value: null,
        formula: null,
      };
      cell.snapshot = snapshot;
      cell.value = null;
      if (existing === undefined) {
        table.cells.set(key, cell);
        this.cells.set(id, cell);
      }
      if (snapshot.kind === 'formula') {
        if (cell.formula?.source !== snapshot.source) {
          cell.formula = this.formulaState(snapshot.source);
          this.needsResolve.add(id);
        }
      } else {
        if (cell.formula !== null) {
          cell.formula = null;
          this.needsResolve.delete(id);
          this.graph.setDeps(id, []);
          if (this.results.delete(id)) removed.push(id);
        }
        if (this.graph.hasNode(id)) this.graph.markDirty(id);
      }
      // A label in the first column names a row; `@` paths must re-resolve.
      if (firstCol !== undefined && key.endsWith(`:${firstCol}`)) this.invalidateEntities();
    }
  }

  /** Forget a cell: dependents go dirty (their input is gone) and its result is withdrawn. */
  private dropCell(cell: CellState, removed: WorkbookCellId[], keepNode = false): void {
    this.cells.delete(cell.id);
    this.needsResolve.delete(cell.id);
    if (this.results.delete(cell.id)) removed.push(cell.id);
    if (keepNode) {
      // The position still exists (a cleared cell); readers see blank.
      if (this.graph.hasNode(cell.id)) {
        this.graph.setDeps(cell.id, []);
      }
    } else {
      this.graph.removeNode(cell.id);
    }
  }

  private invalidateSheet(sheetId: Id): void {
    this.sheetIndexes.delete(sheetId);
    for (const cell of this.cells.values()) {
      if (cell.formula?.usesAddress === true) {
        const table = this.tables.get(cell.tableId);
        if (table?.structure.sheetId === sheetId) this.needsResolve.add(cell.id);
      }
    }
  }

  private invalidateEntities(): void {
    this.entities = null;
    for (const cell of this.cells.values()) {
      if (cell.formula?.usesEntity === true) this.needsResolve.add(cell.id);
    }
  }

  private formulaState(source: string): FormulaState {
    let parsed = this.parseCache.get(source);
    if (parsed === undefined) {
      const r = parse(source);
      parsed = r.ok ? { ast: r.value, parseError: null } : { ast: null, parseError: r.error };
      if (this.parseCache.size > 10_000) this.parseCache.clear();
      this.parseCache.set(source, parsed);
    }
    const refs = parsed.ast === null ? [] : references(parsed.ast);
    return {
      source,
      ast: parsed.ast,
      parseError: parsed.parseError,
      usesAddress: refs.some((r) => r.kind !== 'entity'),
      usesEntity: refs.some((r) => r.kind === 'entity'),
      operands: [],
    };
  }

  // -- evaluation ---------------------------------------------------------------

  private entityRect(cellId: WorkbookCellId): UnitBounds | null {
    const cell = this.cells.get(cellId);
    if (cell === undefined) return null;
    const table = this.tables.get(cell.tableId);
    if (table === undefined) return null;
    const indexed = this.sheetIndex(table.structure.sheetId).byCellId.get(cellId);
    if (indexed === undefined) return null;
    return { col: indexed.ref.col, row: indexed.ref.row, cols: indexed.cols, rows: indexed.rows };
  }

  private resolvePending(): void {
    for (const id of this.needsResolve) {
      const cell = this.cells.get(id);
      const formula = cell?.formula;
      if (cell === undefined || formula === undefined || formula === null) continue;
      const table = this.tables.get(cell.tableId);
      if (table === undefined) continue;
      if (formula.ast === null) {
        formula.operands = [];
        this.graph.setDeps(id, []);
        continue;
      }
      const index = this.sheetIndex(table.structure.sheetId);
      const entities = formula.usesEntity ? this.entityIndex().byKey : null;
      formula.operands = resolveOperands(index, formula.ast, entities, (cid) =>
        this.entityRect(cid),
      );
      const deps = new Set<WorkbookCellId>();
      for (const operand of formula.operands) for (const dep of operand.cellIds) deps.add(dep);
      this.graph.setDeps(id, deps);
    }
    this.needsResolve.clear();
  }

  private evaluate(): CellResult[] {
    this.resolvePending();
    const changed: CellResult[] = [];
    if (this.graph.dirtyNodes().size === 0) return changed;
    const topology = this.graph.topologicalBatches();
    const blocked = new Set(topology.blocked);
    const cycleMembers = new Set(topology.cycle ?? []);
    for (const batch of topology.batches) {
      for (const id of batch) this.evaluateCell(id, blocked, cycleMembers, changed);
    }
    for (const id of topology.blocked) this.evaluateCell(id, blocked, cycleMembers, changed);
    this.graph.clearDirty();
    return changed;
  }

  private evaluateCell(
    id: WorkbookCellId,
    blocked: ReadonlySet<WorkbookCellId>,
    cycleMembers: ReadonlySet<WorkbookCellId>,
    changed: CellResult[],
  ): void {
    const cell = this.cells.get(id);
    const formula = cell?.formula;
    if (cell === undefined || formula === undefined || formula === null) return;
    let value: CellValue | null = null;
    let error: CellError | null = null;
    if (formula.parseError !== null || formula.ast === null) {
      error = {
        kind: 'parse',
        error: formula.parseError ?? { message: 'invalid formula', span: { start: 0, end: 0 } },
      };
    } else if (blocked.has(id) || cycleMembers.has(id)) {
      error = { kind: 'circular' };
    } else {
      const sheetId = this.tables.get(cell.tableId)?.structure.sheetId ?? '';
      const outcome = evaluate(
        formula.ast,
        new EngineResolver(this, this.sheetIndex(sheetId), blocked),
      );
      if (outcome.ok) value = outcome.value;
      else error = outcome.error;
    }
    const previous = this.results.get(id);
    if (
      previous !== undefined &&
      unchanged(previous, formula.source, value, error, formula.operands)
    ) {
      return;
    }
    this.version += 1;
    const result: CellResult = {
      cellId: id,
      version: this.version,
      source: formula.source,
      value,
      error,
      operands: formula.operands,
    };
    this.results.set(id, result);
    changed.push(result);
  }
}

function unchanged(
  previous: CellResult,
  source: string,
  value: CellValue | null,
  error: CellError | null,
  operands: readonly OperandOutline[],
): boolean {
  return (
    previous.source === source &&
    sameValue(previous.value, value) &&
    sameError(previous.error, error) &&
    sameOperands(previous.operands, operands)
  );
}

function sameValue(a: CellValue | null, b: CellValue | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.text === b.text;
    case 'number':
      return b.kind === 'number' && a.value === b.value && a.text === b.text;
    case 'currency':
      return b.kind === 'currency' && a.value === b.value && a.code === b.code && a.text === b.text;
    case 'date':
      return b.kind === 'date' && a.iso === b.iso;
    case 'blank':
      return true;
    case 'error':
      return b.kind === 'error' && sameError(a.error, b.error);
  }
}

function sameError(a: CellError | null, b: CellError | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameOperands(a: readonly OperandOutline[], b: readonly OperandOutline[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.label !== y.label || x.cellIds.length !== y.cellIds.length) return false;
    if (JSON.stringify(x.rect) !== JSON.stringify(y.rect)) return false;
    for (let j = 0; j < x.cellIds.length; j += 1) if (x.cellIds[j] !== y.cellIds[j]) return false;
  }
  return true;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
