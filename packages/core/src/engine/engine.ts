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
import { deriveArgValues, type DeriveSpec } from '../doc/schema.js';
import { references, type Ast, type ParseError, type Reference } from '../formula/ast.js';
import { encodeBound, type BoundReference } from '../formula/bound.js';
import { evaluate, type BoundOperand, type CellValue, type Resolver } from '../formula/evaluate.js';
import { formatMethodCall } from '../formula/methods.js';
import { parse } from '../formula/parser.js';
import { AUTO_FORMAT, isFormatLocale, type CellFormat } from '../format/types.js';
import { cellValueOf } from '../format/value.js';
import { cellKey, splitCellKey, type CellKey, type Id } from '../ids.js';
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
  /** A derived column's cell (REF-04): synthesised from the column, never from the document. */
  readonly synthetic: boolean;
}

interface TableState {
  structure: TableStructure;
  readonly cells: Map<CellKey, CellState>;
  /** Columns whose cells the engine synthesises (REF-04). */
  derivedColumns: ReadonlySet<Id>;
  /** Column id → the column's format, resolved once per structure (FMT-01). */
  columnFormats: ReadonlyMap<Id, CellFormat>;
}

function columnFormatsOf(structure: TableStructure): ReadonlyMap<Id, CellFormat> {
  return new Map(structure.columns.map((c) => [c.id, c.format ?? AUTO_FORMAT]));
}

function sameFormat(a: CellFormat | undefined, b: CellFormat | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.kind === b.kind &&
    a.opts.decimals === b.opts.decimals &&
    a.opts.grouping === b.opts.grouping &&
    a.opts.currency === b.opts.currency &&
    a.opts.datePattern === b.opts.datePattern &&
    a.opts.textCase === b.opts.textCase
  );
}

/**
 * The formula a derived column's cell evaluates (REF-04): the row's source
 * cell, bound by id, carrying the method. `Split` on it yields the child rows
 * (HIER-07). Public so the app can show the same expression in the inspector.
 */
export function derivedCellSource(tableId: Id, rowId: Id, derive: DeriveSpec): string {
  const target = encodeBound({
    kind: 'cell',
    tableId,
    rowId,
    colId: derive.sourceColId,
    spelling: 'address',
  });
  return `=${target}.${formatMethodCall(derive.method, deriveArgValues(derive))}`;
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
  private locale: string | undefined;

  constructor() {
    this.index = new WorkbookIndex([], (tableId, key) => {
      const cell = this.tables.get(tableId)?.cells.get(key);
      return cell?.snapshot.kind === 'text' ? cell.snapshot.text : '';
    });
  }

  /** Message-shaped entry point for the Worker. */
  handle(request: EngineRequest): EngineResponse {
    if (request.type === 'ping') return { type: 'pong', seq: request.seq };
    const started = now();
    const outcome =
      request.type === 'locale' ? this.setLocale(request.locale) : this.apply(request.changes);
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
    return { results: this.evaluate(), removed };
  }

  /**
   * Change the locale `Format` cases and formatted cells render for; every
   * formula re-evaluates (their text may change) and every cached cell value
   * is dropped (a formatted cell's `text` is its rendering for the locale).
   */
  setLocale(locale: string): ApplyOutcome {
    if (locale === this.locale) return { results: [], removed: [] };
    this.locale = locale;
    for (const cell of this.cells.values()) {
      cell.value = null;
      if (cell.formula !== null && this.graph.hasNode(cell.id)) this.graph.markDirty(cell.id);
    }
    return { results: this.evaluate(), removed: [] };
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

  /**
   * The format in force for a cell (FMT-01, FMT-06): its own override, else
   * its column's, else Automatic — the engine's `effectiveCellFormat`, read
   * from the projected structure rather than the document.
   */
  formatOf(cellId: WorkbookCellId): CellFormat {
    const cell = this.cells.get(cellId);
    if (cell === undefined) return AUTO_FORMAT;
    const table = this.tables.get(cell.tableId);
    if (table === undefined) return AUTO_FORMAT;
    return (
      table.structure.cellFormats?.[cell.key] ??
      table.columnFormats.get(splitCellKey(cell.key).colId) ??
      AUTO_FORMAT
    );
  }

  /**
   * The value a formula reads from a cell: its text under the cell's format
   * (FMT-02, FMT-03, FMT-05) — inferred from the text under Automatic — or a
   * formula's result (errors propagate).
   */
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
    if (cell.value === null) {
      const text = cell.snapshot.kind === 'text' ? cell.snapshot.text : '';
      const format = this.formatOf(cellId);
      // Automatic keeps the inference from the typed text (FMT-01); an explicit format decides
      // the value and excludes what it cannot parse (FMT-05).
      const value =
        format.kind === 'auto'
          ? inferCellValue(text)
          : cellValueOf(text, format, isFormatLocale(this.locale) ? this.locale : undefined);
      const rich = cell.snapshot.kind === 'text' ? cell.snapshot.rich : undefined;
      cell.value = value.kind === 'text' && rich !== undefined ? { ...value, rich } : value;
    }
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

  private upsertTable(structure: TableStructure, removed: WorkbookCellId[]): void {
    const existing = this.tables.get(structure.id);
    let table = existing;
    if (table === undefined) {
      table = {
        structure,
        cells: new Map(),
        derivedColumns: new Set(),
        columnFormats: columnFormatsOf(structure),
      };
      this.tables.set(structure.id, table);
    } else {
      // Cells of a row or column that vanished stay in the state: their content is
      // still in the document (a delete removes it separately, an undo brings the
      // row back and the binding with it). They are simply not addressable.
      const previous = table.structure;
      const previousFormats = table.columnFormats;
      table.structure = structure;
      table.columnFormats = columnFormatsOf(structure);
      this.reformat(table, previous, previousFormats);
    }
    this.index.setTable(structure);
    this.touchStructure(structure.id, structure.sheetId, existing?.structure.sheetId);
    this.syncDerived(table, removed);
  }

  /**
   * A format change re-evaluates what depends on it (FMT-02 "changing the
   * format re-renders without re-typing"; FMT-03; FMT-05): every cell whose
   * effective format moved — the column's cells when the column's format
   * changed, one cell when its override did — forgets its cached value and
   * dirties its dependents. Nothing else in the table is touched, so a
   * rename or a wrap still evaluates nothing.
   */
  private reformat(
    table: TableState,
    previous: TableStructure,
    previousFormats: ReadonlyMap<Id, CellFormat>,
  ): void {
    const columns = new Set<Id>();
    for (const [colId, format] of table.columnFormats) {
      if (!sameFormat(previousFormats.get(colId), format)) columns.add(colId);
    }
    const before = previous.cellFormats ?? {};
    const after = table.structure.cellFormats ?? {};
    const overrides = new Set<CellKey>();
    for (const key of Object.keys(before) as CellKey[]) {
      if (!sameFormat(before[key], after[key])) overrides.add(key);
    }
    for (const key of Object.keys(after) as CellKey[]) {
      if (!(key in before)) overrides.add(key);
    }
    if (columns.size === 0 && overrides.size === 0) return;
    for (const cell of table.cells.values()) {
      if (cell.formula !== null) continue;
      const inColumn = columns.size > 0 && columns.has(splitCellKey(cell.key).colId);
      // A cell with its own override does not follow the column's change.
      const follows = inColumn && after[cell.key] === undefined && before[cell.key] === undefined;
      if (!follows && !overrides.has(cell.key)) continue;
      cell.value = null;
      if (this.graph.hasNode(cell.id)) this.graph.markDirty(cell.id);
    }
  }

  /**
   * Derived columns own their cells (REF-04): one synthetic formula per row,
   * re-synthesised when the column's spec or the row set changes and dropped
   * when the column stops being derived or the row goes.
   */
  private syncDerived(table: TableState, removed: WorkbookCellId[]): void {
    const { structure } = table;
    const wanted = new Map<CellKey, string>();
    const derivedColumns = new Set<Id>();
    for (const column of structure.columns) {
      if (column.derive === undefined) continue;
      derivedColumns.add(column.id);
      for (const rowId of structure.rows) {
        wanted.set(
          cellKey(rowId, column.id),
          derivedCellSource(structure.id, rowId, column.derive),
        );
      }
    }
    table.derivedColumns = derivedColumns;
    for (const cell of [...table.cells.values()]) {
      if (cell.synthetic && !wanted.has(cell.key)) {
        this.dropCell(cell, removed);
        table.cells.delete(cell.key);
      }
    }
    if (wanted.size === 0) return;
    const changes: Record<CellKey, CellSnapshot> = {};
    for (const [key, source] of wanted) {
      const existing = table.cells.get(key);
      // The document's own cell (a `Split()` child's piece) keeps precedence.
      if (existing !== undefined && (!existing.synthetic || existing.formula?.source === source)) {
        continue;
      }
      changes[key] = { kind: 'formula', source };
    }
    this.setCells(structure.id, changes, removed, true);
  }

  /** Put the synthesised formula back for one derived cell whose document cell was cleared. */
  private resynthesise(table: TableState, key: CellKey, removed: WorkbookCellId[]): void {
    const { rowId, colId } = splitCellKey(key);
    const column = table.structure.columns.find((c) => c.id === colId);
    if (column?.derive === undefined || !table.structure.rows.includes(rowId)) return;
    const source = derivedCellSource(table.structure.id, rowId, column.derive);
    this.setCells(table.structure.id, { [key]: { kind: 'formula', source } }, removed, true);
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
    synthetic = false,
  ): void {
    const table = this.tables.get(tableId);
    if (table === undefined) return;
    const firstCol = table.structure.columns[0]?.id;
    for (const [rawKey, snapshot] of Object.entries(cells)) {
      const key = rawKey as CellKey;
      const id = workbookCellId(tableId, key);
      let existing = table.cells.get(key);
      // In a derived column the document's own cell wins over the synthesised one: a
      // `Split()` child holds its piece as text (HIER-07); nothing else writes there.
      const derivedColumn =
        table.derivedColumns.size > 0 && table.derivedColumns.has(splitCellKey(key).colId);
      if (!synthetic && derivedColumn && existing?.synthetic === true && snapshot !== null) {
        this.dropCell(existing, removed, true);
        table.cells.delete(key);
        existing = undefined;
      }
      if (snapshot === null) {
        if (existing?.synthetic === synthetic) {
          this.dropCell(existing, removed, true);
          table.cells.delete(key);
          // The document's cell went: the column's synthesised value returns.
          if (!synthetic && derivedColumn) this.resynthesise(table, key, removed);
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
        synthetic,
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
          anchored: false,
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
        return { index, kind: 'range', cellIds: ids, missing: false, anchored: false };
      }
      case 'column':
        return {
          index,
          kind: 'column',
          cellIds: cellsInColumnOn(sheet, ref.col).map((c) => c.cellId),
          missing: false,
          anchored: false,
        };
      case 'entity': {
        const entry = this.index.entityIndex().byKey.get(entityKey(ref.path));
        return {
          index,
          kind: 'entity',
          cellIds: entry === undefined ? [] : [entry.cellId],
          missing: false,
          anchored: false,
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
        return { index, kind, cellIds: ids ?? [], missing: ids === undefined, anchored: true };
      }
      case 'placeholder':
        // Nothing stood behind it at commit: the target is gone.
        return { index, kind: 'address', cellIds: [], missing: true, anchored: true };
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
        { locale: this.locale },
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
      return b.kind === 'blank' && a.text === b.text;
    case 'list':
      return (
        b.kind === 'list' &&
        a.items.length === b.items.length &&
        a.items.every((item, i) => sameValue(item, b.items[i] ?? null))
      );
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
