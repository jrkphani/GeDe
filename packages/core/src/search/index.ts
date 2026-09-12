/**
 * Find (FIND-01..10, SORT-03): grapheme-cluster fuzzy matching, the query
 * grammar, the serialisable snapshot and the message-shaped engine that runs
 * in a Worker.
 */
export { graphemes, foldGraphemes } from './graphemes.js';
export { editDistance, exactFind, approximateFind, type Found } from './distance.js';
export {
  FORMAT_KINDS,
  isEmptyQuery,
  isFormatKind,
  parseQuery,
  type FormatKind,
  type ParsedQuery,
} from './query.js';
export { inferFormat, resolveFormat } from './format.js';
export {
  buildSearchSnapshot,
  cellTexts,
  documentEntriesOf,
  graphEntriesOf,
  isReadOnlyCell,
  tableEntries,
  type CellEntry,
  type DocumentEntry,
  type DocumentName,
  type GraphEntry,
  type SearchEntry,
  type SearchField,
  type SearchSnapshot,
  type SearchText,
  type TableEntries,
} from './snapshot.js';
export {
  DEFAULT_SEARCH_OPTIONS,
  fuzzyBudget,
  MAX_EDIT_DISTANCE,
  search,
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
