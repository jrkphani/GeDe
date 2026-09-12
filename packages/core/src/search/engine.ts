/**
 * The search engine behind the Find bar: an index of snapshot entries plus
 * the message-shaped API the Worker speaks (`apps/web/src/workers/search.worker.ts`)
 * and the main-thread fallback reuses. Plain objects in, plain objects out.
 *
 * Indexing is incremental: tables are replaced one at a time as they change,
 * graphs and documents as whole sets (both small).
 */
import { graphemes } from './graphemes.js';
import { search, type SearchMatch, type SearchOptions } from './matcher.js';
import type {
  DocumentEntry,
  GraphEntry,
  SearchEntry,
  SearchSnapshot,
  TableEntries,
} from './snapshot.js';

export type SearchRequest =
  | { readonly type: 'reset'; readonly snapshot: SearchSnapshot }
  | { readonly type: 'upsertTables'; readonly tables: readonly TableEntries[] }
  | { readonly type: 'removeTables'; readonly tableIds: readonly string[] }
  | { readonly type: 'setGraphs'; readonly graphs: readonly GraphEntry[] }
  | { readonly type: 'setDocuments'; readonly documents: readonly DocumentEntry[] }
  | {
      readonly type: 'query';
      readonly id: number;
      readonly query: string;
      readonly options: SearchOptions;
    };

export interface SearchResults {
  readonly type: 'results';
  readonly id: number;
  readonly matches: readonly SearchMatch[];
  /** Entries in the index when the query ran (diagnostics, the "of m" is `matches.length`). */
  readonly indexed: number;
}

export type SearchResponse = SearchResults;

export interface SearchEngine {
  handle(request: SearchRequest): SearchResponse | null;
  /** Entries currently indexed. */
  size(): number;
}

export function createSearchEngine(): SearchEngine {
  const tables = new Map<string, TableEntries>();
  let graphs: readonly GraphEntry[] = [];
  let documents: readonly DocumentEntry[] = [];

  function* entries(): Generator<SearchEntry> {
    for (const t of tables.values()) yield* t.entries;
    yield* graphs;
    yield* documents;
  }
  const size = () => {
    let n = graphs.length + documents.length;
    for (const t of tables.values()) n += t.entries.length;
    return n;
  };

  return {
    size,
    handle(request) {
      switch (request.type) {
        case 'reset':
          tables.clear();
          for (const t of request.snapshot.tables) tables.set(t.tableId, t);
          graphs = request.snapshot.graphs;
          documents = request.snapshot.documents;
          return null;
        case 'upsertTables':
          for (const t of request.tables) tables.set(t.tableId, t);
          return null;
        case 'removeTables':
          for (const id of request.tableIds) tables.delete(id);
          return null;
        case 'setGraphs':
          graphs = request.graphs;
          return null;
        case 'setDocuments':
          documents = request.documents;
          return null;
        case 'query':
          return {
            type: 'results',
            id: request.id,
            matches: search(entries(), request.query, request.options),
            indexed: size(),
          };
      }
    },
  };
}

/**
 * FIND-08: the text after replacing one match's span. Offsets are grapheme
 * clusters of the case-folded text; when folding changed the cluster count
 * (rare: some scripts lower-case to a different number of clusters) the span
 * cannot be trusted and the whole text is replaced instead. An operator-only
 * match (empty span) is left alone — there is nothing to replace.
 */
export function replaceInText(
  text: string,
  span: { readonly start: number; readonly end: number },
  replacement: string,
): string {
  if (span.end <= span.start) return text;
  const clusters = graphemes(text);
  const folded = graphemes(text.toLocaleLowerCase());
  if (clusters.length !== folded.length || span.end > clusters.length) return replacement;
  return clusters.slice(0, span.start).join('') + replacement + clusters.slice(span.end).join('');
}
