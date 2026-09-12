/**
 * Sort, filter and grouping (SORT-01..06, HIER-08): the table's view state,
 * its mutations, locale collation, the pure projection and the message-shaped
 * engine the Worker speaks.
 */
export {
  EMPTY_VIEW,
  FACET_KINDS,
  FACET_LABELS,
  SORT_MODES,
  SORT_MODE_LABELS,
  isEmptyFilter,
  isFacetKind,
  isSortMode,
  isViewActive,
  normaliseTableView,
  type Band,
  type FacetKind,
  type ProjectionColumn,
  type ProjectionInput,
  type ProjectionRow,
  type SortBy,
  type SortMode,
  type TableFilter,
  type TableViewState,
  type ViewProjection,
} from './types.js';
export {
  charCount,
  createCollator,
  createComparator,
  freqKey,
  sortKey,
  wordCount,
  type Comparable,
  type SortKey,
} from './collate.js';
export { bandKey, projectTableView } from './project.js';
export {
  buildProjectionInput,
  columnsRead,
  evaluatedText,
  handleViewRequest,
  isViewRequest,
  type ProjectionInputOptions,
  type ViewRequest,
  type ViewResponse,
} from './engine.js';
