/**
 * Cross-table references (PRD §14; REF-01..REF-05; HIER-07 `Split()`):
 * reference cells, pulls, mapping columns, derived columns and the guard
 * that keeps them read-only and out of graph dimensions.
 *
 * Contract for the integrator and the graph agent:
 *   - `isGraphDimensionCandidate(column)` — REF-05: only `entered` columns
 *     are offered as graph dimensions.
 *   - `cellReadOnlyReason` / `rowReadOnlyReason` (doc/schema.ts) — REF-05 in
 *     every write path.
 *   - `observePulls(gd)` — install once per editable document.
 *   - `reconcileSplitChildren(gd, tableId, pieces)` — feed engine results.
 */
export {
  isReferenceSource,
  referenceSource,
  referenceTargetOf,
  setReferenceCell,
  type ReferenceTarget,
} from './reference.js';
export {
  addDerivedColumn,
  derivedColumnsOf,
  deriveSignature,
  lineageOf,
  refreshDerivedLabels,
  renameColumn,
  setDerivedColumn,
  type LineageBand,
} from './derive.js';
export {
  addMappingColumn,
  distinctValues,
  mappingLabel,
  mappingOf,
  setMappingValue,
} from './mapping.js';
export {
  clearPull,
  pullLabel,
  pullOf,
  pullPlan,
  pulledCellSource,
  reconcileAllPulls,
  reconcilePull,
  REF_ORIGIN,
  rowMatchesPull,
  setPull,
  sourceRowText,
  type PullReader,
  tablesWithPulls,
} from './pull.js';
export {
  reconcileSplitChildren,
  SPLIT_ORIGIN,
  splitChildId,
  splitColumnOf,
  splitPiecesOf,
  type SplitPieces,
} from './split.js';
export {
  cachingPullReader,
  observePulls,
  pullsAffectedBy,
  reconcileFilteredPulls,
  touchedTables,
  type ObservePullsOptions,
  type TableTouch,
} from './observe.js';
export { isGraphDimensionCandidate } from './graph.js';
export { boundTableIds, crossTableReferenceCount, isCrossTableFormula } from './cross-table.js';
