/**
 * The reactive formula engine: Y.Doc observation → plain-data changes →
 * dependency graph + evaluator → results per cell (PRD §20; FX-02..FX-08).
 *
 * `FormulaEngine` and everything it needs is Worker-safe. `observeWorkbook`
 * and the snapshot helpers are the main-thread side and touch Yjs only.
 */
export type {
  ApplyRequest,
  CellError,
  CellResult,
  CellSnapshot,
  ColumnStructure,
  EngineRequest,
  EngineResponse,
  EntityEntry,
  IndexedCell,
  OperandOutline,
  ResultsResponse,
  TableSnapshot,
  TableStructure,
  WorkbookCellId,
  WorkbookChange,
  WorkbookSnapshot,
} from './types.js';
export { splitWorkbookCellId, workbookCellId } from './types.js';
export { FormulaEngine, type ApplyOutcome } from './engine.js';
export { inferCellValue, inferColumnFormat, isSummable, type InferredFormat } from './values.js';
export {
  buildSheetIndex,
  cellAtPosition,
  cellsInColumnOn,
  cellsInRangeOn,
  dataOriginRow,
  entityKey,
  entityLabel,
  indexTable,
  positionKey,
  resolveOperands,
  resolveReference,
  type SheetIndex,
} from './sheet-index.js';
export {
  buildEntityIndex,
  formatEntityPath,
  formatEntitySegment,
  searchEntities,
  type EntityIndex,
} from './entities.js';
export {
  cellSnapshot,
  observeWorkbook,
  tableCells,
  tableSnapshot,
  tableStructure,
  workbookSnapshot,
} from './snapshot.js';
export { cellErrorLabel, cellErrorMessage } from './errors.js';
