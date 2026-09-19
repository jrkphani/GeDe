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
  OperandKind,
  OperandOutline,
  LocaleRequest,
  PingRequest,
  PongResponse,
  ResolvedOperand,
  ResultsResponse,
  TableSnapshot,
  TableStructure,
  WorkbookCellId,
  WorkbookChange,
  WorkbookSnapshot,
} from './types.js';
export { splitWorkbookCellId, workbookCellId } from './types.js';
export { derivedCellSource, FormulaEngine, type ApplyOutcome } from './engine.js';
export { inferCellValue } from './values.js';
export {
  buildSheetIndex,
  cellAtPosition,
  cellsInColumnOn,
  cellsInRangeOn,
  dataOriginRow,
  entityKey,
  indexTable,
  positionKey,
  type SheetIndex,
} from './sheet-index.js';
export { WorkbookIndex, type LabelReader } from './workbook-index.js';
export { commitCellText, projectCellText, workbookIndexOf } from './commit.js';
export {
  buildEntityIndex,
  cellMayRelabel,
  columnSegment,
  formatEntityPath,
  formatEntitySegment,
  rowLabelOf,
  searchEntities,
  type EntityIndex,
  type EntitySearch,
  type EntitySearchOptions,
  type TextReader,
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
