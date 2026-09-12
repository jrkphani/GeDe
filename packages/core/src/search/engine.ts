/**
 * The search engine behind the Find bar: an index of snapshot entries plus
 * the message-shaped API the Worker speaks (`apps/web/src/workers/search.worker.ts`)
 * and the main-thread fallback reuses. Plain objects in, plain objects out.
 *
 * Indexing is incremental: tables are replaced one at a time as they change,
 * graphs and documents as whole sets (both small).
 */
import { graphemes } from './graphemes.js';
import {
  indexEntry,
  search,
  type IndexedEntry,
  type SearchMatch,
  type SearchOptions,
} from './matcher.js';
import type { DocumentEntry, GraphEntry, SearchSnapshot, TableEntries } from './snapshot.js';

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
  const tables = new Map<string, readonly IndexedEntry[]>();
  let graphs: readonly IndexedEntry[] = [];
  let documents: readonly IndexedEntry[] = [];
  const indexAll = (list: readonly (GraphEntry | DocumentEntry)[]) => list.map(indexEntry);
  const indexTable = (t: TableEntries) => {
    tables.set(t.tableId, t.entries.map(indexEntry));
  };

  function* entries(): Generator<IndexedEntry> {
    for (const t of tables.values()) yield* t;
    yield* graphs;
    yield* documents;
  }
  const size = () => {
    let n = graphs.length + documents.length;
    for (const t of tables.values()) n += t.length;
    return n;
  };

  return {
    size,
    handle(request) {
      switch (request.type) {
        case 'reset':
          tables.clear();
          for (const t of request.snapshot.tables) indexTable(t);
          graphs = indexAll(request.snapshot.graphs);
          documents = indexAll(request.snapshot.documents);
          return null;
        case 'upsertTables':
          for (const t of request.tables) indexTable(t);
          return null;
        case 'removeTables':
          for (const id of request.tableIds) tables.delete(id);
          return null;
        case 'setGraphs':
          graphs = indexAll(request.graphs);
          return null;
        case 'setDocuments':
          documents = indexAll(request.documents);
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
 * cannot be trusted and the text is left unchanged — Replace never rewrites
 * more than the match it can locate. An operator-only match (empty span) is
 * left alone too: there is nothing to replace.
 */
export function replaceInText(
  text: string,
  span: { readonly start: number; readonly end: number },
  replacement: string,
): string {
  if (span.end <= span.start) return text;
  const clusters = graphemes(text);
  const folded = graphemes(text.toLocaleLowerCase());
  if (clusters.length !== folded.length || span.end > clusters.length) return text;
  return clusters.slice(0, span.start).join('') + replacement + clusters.slice(span.end).join('');
}
