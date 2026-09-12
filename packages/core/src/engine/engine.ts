/**
 * The reactive formula engine (PRD §20 "DAG state engine"; FX-02, FX-06).
 *
 * `FormulaEngine` owns a plain-data copy of the workbook, the dependency
 * graph and a result per formula cell. `apply(changes)` is the only entry
 * point: it folds the changes in, re-resolves the references whose targets
 * moved, evaluates the dirty nodes in topological batches and returns the
 * results that changed. It never touches Yjs, React or the DOM, so it runs
 * unchanged in a Web Worker, in Node and inline in tests.
 *
 * Invariants
 * - Graph nodes are `WorkbookCellId`s and stored references are id-bound
 *   tokens (`formula/bound.ts`), so a structural edit never changes what a
 *   formula reads. Only the formulas bound into the edited table are
 *   re-resolved, and only a changed dependency set re-evaluates.
 * - A bound target that is gone yields `⚠ reference removed`; undoing the
 *   delete brings the id back and the binding with it.
 * - An address that bound to nothing at commit time (empty canvas) stays
 *   positional and resolves through the sheet index, as does an unknown
 *   `@` path through the entity index.
 * - Evaluation order is topological; a cycle yields `circular` on every
 *   member and on everything downstream (FX-06).
 * - Errors are values. Nothing here throws for user input.
 */
import { DependencyGraph } from '../graph.js';
import { references, type Ast, type ParseError, type Reference } from '../formula/ast.js';
import type { BoundReference } from '../formula/bound.js';
import { evaluate, type BoundOperand, type CellValue, type Resolver } from '../formula/evaluate.js';
import { parse } from '../formula/parser.js';
import type { CellKey, Id } from '../ids.js';
import { cellsInColumnOn, entityKey, positionKey, type SheetIndex } from './sheet-index.js';
import {
  workbookCellId,
  type CellError,
  type CellResult,
  type CellSnapshot,
  type EngineRequest,
  type EngineResponse,
  type ResolvedOperand,
  type TableStructure,
  type WorkbookCellId,
  type WorkbookChange,
} from './types.js';
import { inferCellValue } from './values.js';
import { WorkbookIndex } from './workbook-index.js';

interface FormulaState {
  readonly source: string;
  readonly ast: Ast | null;
  readonly parseError: ParseError | null;
  /** Tables the bound references point into; a structural edit there re-resolves this formula. */
  readonly boundTables: ReadonlySet<Id>;
  /** Has an address, range or column that bound to nothing: resolves through the sheet index. */
  readonly usesPosition: boolean;
  /** Has an `@` path that bound to nothing: resolves through the entity index. */
  readonly usesEntity: boolean;
  operands: readonly ResolvedOperand[];
  /** Sorted dependency ids plus missing flags, to skip re-evaluation when nothing moved. */
  depsKey: string | null;
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
    private readonly sheet: SheetIndex,
    private readonly blocked: ReadonlySet<WorkbookCellId>,
  ) {}

  valueAt(ref: { col: number; row: number }): CellValue | undefined {
    const cell = this.sheet.byPosition.get(positionKey(ref));
    if (cell === undefined) return undefined;
    return this.engine.valueOf(cell.cellId, this.blocked);
  }

  entity(path: readonly string[]): CellValue | undefined {
    const entry = this.engine.index.entityIndex().byKey.get(entityKey(path));
    if (entry === undefined) return undefined;
    return this.engine.valueOf(entry.cellId, this.blocked);
  }

  columnValues(col: number): { row: number; value: CellValue }[] {
    const out: { row: number; value: CellValue }[] = [];
    for (const cell of cellsInColumnOn(this.sheet, col)) {
      const value = this.engine.valueOf(cell.cellId, this.blocked);
      if (value.kind !== 'blank') out.push({ row: cell.ref.row, value });
    }
    return out;
  }

  bound(ref: BoundReference): readonly BoundOperand[] | undefined {
    const ids = this.engine.index.boundCells(ref);
    if (ids === undefined) return undefined;
    const out: BoundOperand[] = [];
    for (const id of ids) {
      const value = this.engine.valueOf(id, this.blocked);
      // A column reads its populated cells; a range reads every position (blanks are zero).
      if (ref.kind === 'column' && value.kind === 'blank') continue;
      out.push({ address: this.engine.index.addressOf(id), value });
    }
    return out;
  }
}

export class FormulaEngine {
  private readonly tables = new Map<Id, TableState>();
  private readonly cells = new Map<WorkbookCellId, CellState>();
  private readonly graph = new DependencyGraph();
  private readonly results = new Map<WorkbookCellId, CellResult>();
  private readonly parseCache = new Map<string, ParsedFormula>();
  private readonly needsResolve = new Set<WorkbookCellId>();
  /** tableId → formulas whose bound references point into it. */
  private readonly boundInto = new Map<Id, Set<WorkbookCellId>>();
  readonly index: WorkbookIndex;
  private version = 0;

  constructor() {
    this.index = new WorkbookIndex([], (tableId, key) => {
      const cell = this.tables.get(tableId)?.cells.get(key);
      return cell?.snapshot.kind === 'text' ? cell.snapshot.text : '';
    });
  }

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
            this.upsertTable(table);
            this.setCells(table.id, table.cells, removed);
          }
          break;
        case 'table':
          this.upsertTable(change.table);
          break;
        case 'table-removed':
          this.removeTable(change.tableId, removed);
          break;
        case 'cells':
          this.setCells(change.tableId, change.cells, removed);
          break;
      }
    }
    return { results: this.evaluate(), removed };
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
    for (const id of [...this.tables.keys()]) this.index.removeTable(id);
    this.tables.clear();
    this.cells.clear();
    this.results.clear();
    this.needsResolve.clear();
    this.boundInto.clear();
  }

  private upsertTable(structure: TableStructure): void {
    const existing = this.tables.get(structure.id);
    if (existing === undefined) {
      this.tables.set(structure.id, { structure, cells: new Map() });
    } else {
      // Cells of a row or column that vanished stay in the state: their content is
      // still in the document (a delete removes it separately, an undo brings the
      // row back and the binding with it). They are simply not addressable.
      existing.structure = structure;
    }
    this.index.setTable(structure);
    this.touchStructure(structure.id, structure.sheetId, existing?.structure.sheetId);
  }

  private removeTable(tableId: Id, removed: WorkbookCellId[]): void {
    const table = this.tables.get(tableId);
    if (table === undefined) return;
    for (const cell of table.cells.values()) this.dropCell(cell, removed);
    this.tables.delete(tableId);
    this.index.removeTable(tableId);
    this.touchStructure(tableId, table.structure.sheetId, undefined);
  }

  /**
   * After a table's structure changed: formulas bound into it re-resolve
   * (a diff decides whether they re-evaluate); positional formulas on its
   * sheet re-resolve; entity paths re-read. Nothing else is touched.
   */
  private touchStructure(tableId: Id, sheetId: Id, previousSheetId: Id | undefined): void {
    for (const id of this.boundInto.get(tableId) ?? []) this.needsResolve.add(id);
    for (const cell of this.cells.values()) {
      const f = cell.formula;
      if (f === null) continue;
      if (f.usesEntity) this.needsResolve.add(cell.id);
      if (f.usesPosition) {
        const sheet = this.tables.get(cell.tableId)?.structure.sheetId;
        if (sheet === sheetId || sheet === previousSheetId) this.needsResolve.add(cell.id);
      }
    }
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
        if (firstCol !== undefined && key.endsWith(`:${firstCol}`)) this.labelsChanged();
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
          this.unbind(cell);
          cell.formula = this.formulaState(snapshot.source);
          this.needsResolve.add(id);
        }
      } else {
        if (cell.formula !== null) {
          this.unbind(cell);
          cell.formula = null;
          this.needsResolve.delete(id);
          this.graph.setDeps(id, []);
          if (this.results.delete(id)) removed.push(id);
        }
        if (this.graph.hasNode(id)) this.graph.markDirty(id);
      }
      // A label in the first column names a row; `@` paths must re-resolve.
      if (firstCol !== undefined && key.endsWith(`:${firstCol}`)) this.labelsChanged();
    }
  }

  private labelsChanged(): void {
    this.index.invalidateLabels();
    for (const cell of this.cells.values()) {
      if (cell.formula?.usesEntity === true) this.needsResolve.add(cell.id);
    }
  }

  /** Forget a cell: dependents go dirty (their input is gone) and its result is withdrawn. */
  private dropCell(cell: CellState, removed: WorkbookCellId[], keepNode = false): void {
    this.unbind(cell);
    this.cells.delete(cell.id);
    this.needsResolve.delete(cell.id);
    if (this.results.delete(cell.id)) removed.push(cell.id);
    if (keepNode) {
      // The position still exists (a cleared cell); readers see blank.
      if (this.graph.hasNode(cell.id)) this.graph.setDeps(cell.id, []);
    } else {
      this.graph.removeNode(cell.id);
    }
  }

  private unbind(cell: CellState): void {
    const f = cell.formula;
    if (f === null) return;
    for (const tableId of f.boundTables) this.boundInto.get(tableId)?.delete(cell.id);
  }

  private formulaState(source: string): FormulaState {
    let parsed = this.parseCache.get(source);
    if (parsed === undefined) {
      const r = parse(source);
      parsed = r.ok ? { ast: r.value, parseError: null } : { ast: null, parseError: r.error };
      if (this.parseCache.size > 10_000) this.parseCache.clear();
      this.parseCache.set(source, parsed);
    }
    const refs: Reference[] = parsed.ast === null ? [] : references(parsed.ast);
    const boundTables = new Set<Id>();
    for (const ref of refs) {
      if (ref.kind !== 'bound') continue;
      if (ref.ref.kind === 'column') for (const c of ref.ref.columns) boundTables.add(c.tableId);
      else boundTables.add(ref.ref.tableId);
    }
    return {
      source,
      ast: parsed.ast,
      parseError: parsed.parseError,
      boundTables,
      usesPosition: refs.some(
        (r) => r.kind === 'address' || r.kind === 'range' || r.kind === 'column',
      ),
      usesEntity: refs.some((r) => r.kind === 'entity'),
      operands: [],
      depsKey: null,
    };
  }

  // -- resolution ---------------------------------------------------------------

  private resolveOperand(sheet: SheetIndex, ref: Reference, index: number): ResolvedOperand {
    switch (ref.kind) {
      case 'address': {
        const cell = sheet.byPosition.get(positionKey(ref.ref));
        return {
          index,
          kind: 'address',
          cellIds: cell === undefined ? [] : [cell.cellId],
          missing: false,
        };
      }
      case 'range': {
        const ids: WorkbookCellId[] = [];
        for (let row = ref.range.start.row; row <= ref.range.end.row; row += 1) {
          for (let col = ref.range.start.col; col <= ref.range.end.col; col += 1) {
            const cell = sheet.byPosition.get(positionKey({ col, row }));
            if (cell !== undefined) ids.push(cell.cellId);
          }
        }
        return { index, kind: 'range', cellIds: ids, missing: false };
      }
      case 'column':
        return {
          index,
          kind: 'column',
          cellIds: cellsInColumnOn(sheet, ref.col).map((c) => c.cellId),
          missing: false,
        };
      case 'entity': {
        const entry = this.index.entityIndex().byKey.get(entityKey(ref.path));
        return {
          index,
          kind: 'entity',
          cellIds: entry === undefined ? [] : [entry.cellId],
          missing: false,
        };
      }
      case 'bound': {
        const ids = this.index.boundCells(ref.ref);
        const kind =
          ref.ref.kind === 'cell'
            ? ref.ref.spelling === 'entity'
              ? 'entity'
              : 'address'
            : ref.ref.kind;
        return { index, kind, cellIds: ids ?? [], missing: ids === undefined };
      }
    }
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
        if (formula.depsKey !== '') {
          formula.depsKey = '';
          this.graph.setDeps(id, []);
        }
        continue;
      }
      for (const tableId of formula.boundTables) {
        let set = this.boundInto.get(tableId);
        if (set === undefined) {
          set = new Set();
          this.boundInto.set(tableId, set);
        }
        set.add(id);
      }
      const sheet = this.index.sheetIndex(table.structure.sheetId);
      formula.operands = references(formula.ast).map((ref, i) =>
        this.resolveOperand(sheet, ref, i),
      );
      const deps = new Set<WorkbookCellId>();
      let missing = false;
      for (const operand of formula.operands) {
        for (const dep of operand.cellIds) deps.add(dep);
        missing ||= operand.missing;
      }
      const depsKey = `${missing ? '!' : ''}${[...deps].sort().join(' ')}`;
      // Only a dependency set that actually moved dirties the node (a title rename or wrap never does).
      if (depsKey !== formula.depsKey) {
        formula.depsKey = depsKey;
        this.graph.setDeps(id, deps);
      }
    }
    this.needsResolve.clear();
  }

  // -- evaluation ---------------------------------------------------------------

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
        new EngineResolver(this, this.index.sheetIndex(sheetId), blocked),
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
  operands: readonly ResolvedOperand[],
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

function sameOperands(a: readonly ResolvedOperand[], b: readonly ResolvedOperand[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.kind !== y.kind || x.missing !== y.missing || x.cellIds.length !== y.cellIds.length) {
      return false;
    }
    for (let j = 0; j < x.cellIds.length; j += 1) if (x.cellIds[j] !== y.cellIds[j]) return false;
  }
  return true;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
