/**
 * Appearance on the grid (INSP-04..07, MENU-04): the resolved look of a cell
 * and of a table as paint attributes, the rules Worker client and hook, and
 * fit-to-content measurement. The inspector tabs write through
 * `GridCommands`; this module only reads and paints.
 */
export {
  looksEqual,
  paintLook,
  PLAIN_LOOK,
  styleOf,
  type CellLook,
  type LookPaint,
} from './cell-look.js';
export { paintTable, type TablePaint } from './table-look.js';
export { DagEdges, type DagEdgesProps } from './DagEdges.js';
export { useTableFlags } from './useTableFlags.js';
export {
  createRuleEvaluator,
  DEFAULT_RULES_TIMEOUT_MS,
  type EvaluateResult,
  type RuleEvaluator,
  type RuleEvaluatorOptions,
} from './rules-client.js';
export {
  setSharedRuleEvaluatorForTests,
  sharedRuleEvaluator,
  useColumnRules,
  type RuleMatches,
} from './useColumnRules.js';
export {
  canMeasure,
  canvasMeasure,
  fitColumnsToContent,
  fitRowsToContent,
  memoised,
  rowsToMeasure,
  widestLine,
  wrappedLines,
  type FitMeasure,
  type FitOptions,
  type MeasureFont,
  type RowNeed,
} from './fit.js';
export { NO_MEASURE_REASON, useFitter, type Fitter } from './use-fit.js';
