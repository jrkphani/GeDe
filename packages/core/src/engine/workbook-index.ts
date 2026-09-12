/**
 * The workbook index: id ↔ position ↔ name, built from table structures and
 * row labels (PRD §20 "address-to-id resolution is a separate index rebuilt
 * on structural edits"). The engine keeps one in the Worker for evaluation;
 * the app keeps one on the main thread (cached per document, see
 * `apps/web/src/doc/workbook-index.ts`) for binding at commit, projecting
 * stored formulas to today's A1 text and drawing outlines.
 *
 * Nothing here evaluates. Sheet indexes and the entity index are built
 * lazily and dropped by `invalidateStructure` / `invalidateLabels`.
 */
import { formatAddress, formatColumn, formatRange, type CellRef } from '../address.js';
import type { UnitBounds } from '../doc/geometry.js';
import { cellKey, type CellKey, type Id } from '../ids.js';
import { references, type Ast, type Reference } from '../formula/ast.js';
import { encodeBound, type BoundReference } from '../formula/bound.js';
import {
  bindFormula,
  projectFormula,
  type Binder,
  type BoundTarget,
  type Projector,
} from '../formula/project.js';
import { buildEntityIndex, type EntityIndex } from './entities.js';
import {
  buildSheetIndex,
  cellsInColumnOn,
  cellsInRangeOn,
  entityKey,
  positionKey,
  type SheetIndex,
} from './sheet-index.js';
import {
  workbookCellId,
  type EntityEntry,
  type IndexedCell,
  type OperandOutline,
  type TableStructure,
  type WorkbookCellId,
} from './types.js';

interface TableOrdinals {
  readonly rows: ReadonlyMap<Id, number>;
  readonly cols: ReadonlyMap<Id, number>;
}

export type LabelReader = (tableId: Id, key: CellKey) => string;

export class WorkbookIndex {
  private readonly tables = new Map<Id, TableStructure>();
  private readonly ordinals = new Map<Id, TableOrdinals>();
  private readonly sheets = new Map<Id, SheetIndex>();
  private entities: EntityIndex | null = null;
  private entityByCell: Map<WorkbookCellId, EntityEntry> | null = null;

  constructor(
    tables: Iterable<TableStructure>,
    private readonly textOf: LabelReader,
  ) {
    for (const t of tables) this.tables.set(t.id, t);
  }

  table(tableId: Id): TableStructure | undefined {
    return this.tables.get(tableId);
  }

  allTables(): IterableIterator<TableStructure> {
    return this.tables.values();
  }

  /** Replace a table's structure (or add it). Drops derived indexes that depend on it. */
  setTable(structure: TableStructure): void {
    const previous = this.tables.get(structure.id);
    this.tables.set(structure.id, structure);
    this.ordinals.delete(structure.id);
    if (previous !== undefined) this.sheets.delete(previous.sheetId);
    this.sheets.delete(structure.sheetId);
    this.invalidateLabels();
  }

  removeTable(tableId: Id): void {
    const previous = this.tables.get(tableId);
    if (previous === undefined) return;
    this.tables.delete(tableId);
    this.ordinals.delete(tableId);
    this.sheets.delete(previous.sheetId);
    this.invalidateLabels();
  }

  invalidateStructure(): void {
    this.ordinals.clear();
    this.sheets.clear();
    this.invalidateLabels();
  }

  /** Row labels changed (a first-column cell): `@` paths must be re-read. */
  invalidateLabels(): void {
    this.entities = null;
    this.entityByCell = null;
  }

  private ordinalsOf(tableId: Id): TableOrdinals | undefined {
    let o = this.ordinals.get(tableId);
    if (o === undefined) {
      const t = this.tables.get(tableId);
      if (t === undefined) return undefined;
      o = {
        rows: new Map(t.rows.map((id, i) => [id, i])),
        cols: new Map(t.columns.map((c, i) => [c.id, i])),
      };
      this.ordinals.set(tableId, o);
    }
    return o;
  }

  /** Whether the row (when named) and column still exist in the table. */
  hasCell(target: BoundTarget): boolean {
    const o = this.ordinalsOf(target.tableId);
    if (o === undefined) return false;
    return (target.rowId === '' || o.rows.has(target.rowId)) && o.cols.has(target.colId);
  }

  sheetIndex(sheetId: Id): SheetIndex {
    let index = this.sheets.get(sheetId);
    if (index === undefined) {
      index = buildSheetIndex(sheetId, this.tables.values());
      this.sheets.set(sheetId, index);
    }
    return index;
  }

  entityIndex(): EntityIndex {
    this.entities ??= buildEntityIndex(this.tables.values(), this.textOf);
    return this.entities;
  }

  private entityOf(cellId: WorkbookCellId): EntityEntry | undefined {
    if (this.entityByCell === null) {
      this.entityByCell = new Map();
      // Earliest entry wins: the row's own path before its column paths.
      for (const e of this.entityIndex().entries) {
        if (!this.entityByCell.has(e.cellId)) this.entityByCell.set(e.cellId, e);
      }
    }
    return this.entityByCell.get(cellId);
  }

  indexedCell(target: BoundTarget): IndexedCell | undefined {
    const t = this.tables.get(target.tableId);
    if (t === undefined || !this.hasCell(target)) return undefined;
    return this.sheetIndex(t.sheetId).byCellId.get(
      workbookCellId(target.tableId, cellKey(target.rowId, target.colId)),
    );
  }

  positionOf(target: BoundTarget): CellRef | null {
    return this.indexedCell(target)?.ref ?? null;
  }

  /** Current A1 label of a cell id, for messages; `#REF`-style when gone. */
  addressOf(cellId: WorkbookCellId): string {
    const at = cellId.indexOf('/');
    const tableId = cellId.slice(0, at);
    const key = cellId.slice(at + 1);
    const colon = key.indexOf(':');
    const ref = this.positionOf({
      tableId,
      rowId: key.slice(0, colon),
      colId: key.slice(colon + 1),
    });
    return ref === null ? '#REF' : formatAddress(ref);
  }

  /**
   * Cells a bound reference reads now, row-major, or `undefined` when a bound
   * corner, column or table is gone (`⚠ reference removed`). A range's
   * interior is whatever lies between its corners today, so a row inserted
   * inside it joins it and a row deleted inside it leaves it.
   */
  boundCells(ref: BoundReference): WorkbookCellId[] | undefined {
    switch (ref.kind) {
      case 'cell':
        return this.hasCell(ref)
          ? [workbookCellId(ref.tableId, cellKey(ref.rowId, ref.colId))]
          : undefined;
      case 'range': {
        const t = this.tables.get(ref.tableId);
        const o = this.ordinalsOf(ref.tableId);
        if (t === undefined || o === undefined) return undefined;
        const r1 = o.rows.get(ref.from.rowId);
        const r2 = o.rows.get(ref.to.rowId);
        const c1 = o.cols.get(ref.from.colId);
        const c2 = o.cols.get(ref.to.colId);
        if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) {
          return undefined;
        }
        const out: WorkbookCellId[] = [];
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r += 1) {
          for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c += 1) {
            out.push(workbookCellId(t.id, cellKey(t.rows[r] ?? '', t.columns[c]?.id ?? '')));
          }
        }
        return out;
      }
      case 'column': {
        const out: WorkbookCellId[] = [];
        let found = false;
        for (const { tableId, colId } of ref.columns) {
          const t = this.tables.get(tableId);
          if (t === undefined) continue;
          if (!t.columns.some((c) => c.id === colId)) continue;
          found = true;
          for (const rowId of t.rows) out.push(workbookCellId(tableId, cellKey(rowId, colId)));
        }
        return found ? out : undefined;
      }
    }
  }

  // -- binding and projection ------------------------------------------------

  binder(sheetId: Id): Binder {
    const index = this.sheetIndex(sheetId);
    return {
      cellAt: (ref) => {
        const cell = index.byPosition.get(positionKey(ref));
        if (cell === undefined) return null;
        const colon = cell.key.indexOf(':');
        return {
          tableId: cell.tableId,
          rowId: cell.key.slice(0, colon),
          colId: cell.key.slice(colon + 1),
        };
      },
      columnsAt: (col) => {
        const seen = new Set<string>();
        const out: { tableId: Id; colId: Id }[] = [];
        for (const cell of cellsInColumnOn(index, col)) {
          const colId = cell.key.slice(cell.key.indexOf(':') + 1);
          const k = `${cell.tableId}/${colId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ tableId: cell.tableId, colId });
        }
        return out;
      },
      entity: (path) => {
        const entry = this.entityIndex().byKey.get(entityKey(path));
        if (entry === undefined) return null;
        const key = entry.cellId.slice(entry.cellId.indexOf('/') + 1);
        const colon = key.indexOf(':');
        return { tableId: entry.tableId, rowId: key.slice(0, colon), colId: key.slice(colon + 1) };
      },
    };
  }

  projector(): Projector {
    return {
      positionOf: (target) => this.positionOf(target),
      exists: (target) => this.hasCell(target),
      entityPathOf: (target) => {
        if (!this.hasCell(target)) return null;
        const entry = this.entityOf(
          workbookCellId(target.tableId, cellKey(target.rowId, target.colId)),
        );
        return entry?.text ?? null;
      },
      columnOf: (tableId, colId) => {
        const t = this.tables.get(tableId);
        if (t === undefined) return null;
        const i = t.columns.findIndex((c) => c.id === colId);
        if (i < 0 || t.columns[i]?.width === 0) return null; // gone, or hidden (no lattice presence)
        let col = t.gridCol;
        for (let k = 0; k < i; k += 1) col += t.columns[k]?.width ?? 0;
        return col;
      },
    };
  }

  /** Bind a typed formula on `sheetId` (the sheet of the cell being committed). */
  bind(sheetId: Id, text: string): string {
    return bindFormula(text, this.binder(sheetId));
  }

  /** Today's A1 / `@` text for a stored formula. */
  project(source: string): string {
    return projectFormula(source, this.projector());
  }

  // -- outlines (FX-08) ------------------------------------------------------

  private rectOfCells(cells: readonly IndexedCell[]): UnitBounds | null {
    if (cells.length === 0) return null;
    let minCol = Infinity;
    let minRow = Infinity;
    let maxCol = -Infinity;
    let maxRow = -Infinity;
    for (const c of cells) {
      minCol = Math.min(minCol, c.ref.col);
      minRow = Math.min(minRow, c.ref.row);
      maxCol = Math.max(maxCol, c.ref.col + c.cols);
      maxRow = Math.max(maxRow, c.ref.row + c.rows);
    }
    return { col: minCol, row: minRow, cols: maxCol - minCol, rows: maxRow - minRow };
  }

  private indexedById(sheetId: Id, ids: readonly WorkbookCellId[]): IndexedCell[] {
    const index = this.sheetIndex(sheetId);
    const out: IndexedCell[] = [];
    for (const id of ids) {
      const c = index.byCellId.get(id);
      if (c !== undefined) out.push(c);
    }
    return out;
  }

  /**
   * One outline per operand of a formula as it reads on `sheetId`: label as
   * the person sees it, the lattice block to draw, and the cells read. Works
   * for a stored (bound) source and for a typed draft alike.
   */
  operands(sheetId: Id, ast: Ast): OperandOutline[] {
    const index = this.sheetIndex(sheetId);
    const projector = this.projector();
    return references(ast).map((ref, i) => this.operand(sheetId, index, projector, ref, i));
  }

  private operand(
    sheetId: Id,
    index: SheetIndex,
    projector: Projector,
    ref: Reference,
    i: number,
  ): OperandOutline {
    switch (ref.kind) {
      case 'address': {
        const cell = index.byPosition.get(positionKey(ref.ref));
        return {
          index: i,
          kind: 'address',
          label: formatAddress(ref.ref),
          span: ref.span,
          rect: {
            col: ref.ref.col,
            row: ref.ref.row,
            cols: cell?.cols ?? 1,
            rows: cell?.rows ?? 1,
          },
          cellIds: cell === undefined ? [] : [cell.cellId],
        };
      }
      case 'range': {
        const cells = cellsInRangeOn(index, ref.range);
        const end = index.byPosition.get(positionKey(ref.range.end));
        return {
          index: i,
          kind: 'range',
          label: formatRange(ref.range),
          span: ref.span,
          rect: {
            col: ref.range.start.col,
            row: ref.range.start.row,
            cols: ref.range.end.col - ref.range.start.col + (end?.cols ?? 1),
            rows: ref.range.end.row - ref.range.start.row + (end?.rows ?? 1),
          },
          cellIds: cells.map((c) => c.cellId),
        };
      }
      case 'column': {
        const cells = cellsInColumnOn(index, ref.col);
        return {
          index: i,
          kind: 'column',
          label: formatColumn({ col: ref.col }),
          span: ref.span,
          rect: this.rectOfCells(cells),
          cellIds: cells.map((c) => c.cellId),
        };
      }
      case 'entity': {
        const target = this.binder(sheetId).entity(ref.path);
        const cell = target === null ? undefined : this.indexedCell(target);
        return {
          index: i,
          kind: 'entity',
          label: `@${ref.path.join('.')}`,
          span: ref.span,
          rect: cell === undefined ? null : this.rectOfCells([cell]),
          cellIds: cell === undefined ? [] : [cell.cellId],
        };
      }
      case 'bound': {
        const ids = this.boundCells(ref.ref) ?? [];
        const cells = this.indexedById(sheetId, ids);
        const kind =
          ref.ref.kind === 'cell'
            ? ref.ref.spelling === 'entity'
              ? 'entity'
              : 'address'
            : ref.ref.kind;
        return {
          index: i,
          kind,
          label: projectFormula(`=${encodeBound(ref.ref)}`, projector).slice(1),
          span: ref.span,
          rect: this.rectOfCells(cells),
          cellIds: ids,
        };
      }
    }
  }
}
