/**
 * Find (FIND-01..10, SORT-03): grapheme-cluster fuzzy matching, the query
 * grammar, the serialisable snapshot and the message-shaped engine that runs
 * in a Worker.
 */
export { graphemes, foldGraphemes } from './graphemes.js';
export { editDistance, exactFind, approximateFind, type Found } from './distance.js';
// The `is:` operator's four kinds (no `auto`): aliased so they do not shadow
// the column data formats' `FormatKind` / `FORMAT_KINDS` (packages/core/src/format).
export {
  FORMAT_KINDS as SEARCH_FORMAT_KINDS,
  isEmptyQuery,
  isFormatKind as isSearchFormatKind,
  parseQuery,
  type FormatKind as SearchFormatKind,
  type ParsedQuery,
} from './query.js';
export { inferFormat, resolveFormat } from './format.js';
export {
  buildSearchSnapshot,
  cellTexts,
  documentEntriesOf,
  graphEntriesOf,
  graphTitle,
  tableEntries,
  type CellEntry,
  type DocumentEntry,
  type DocumentName,
  type GraphEntry,
  type HeaderEntry,
  type SearchEntry,
  type SearchField,
  type SearchSnapshot,
  type SearchText,
  type SearchValueReader,
  type TableEntries,
} from './snapshot.js';
export {
  DEFAULT_SEARCH_OPTIONS,
  fuzzyBudget,
  indexEntry,
  matchReadOnly,
  MAX_EDIT_DISTANCE,
  search,
  type IndexedEntry,
  type IndexedText,
  type MatchTarget,
  type SearchMatch,
  type SearchOptions,
} from './matcher.js';
export {
  createSearchEngine,
  replaceInText,
  type SearchEngine,
  type SearchRequest,
  type SearchResponse,
  type SearchResults,
} from './engine.js';
