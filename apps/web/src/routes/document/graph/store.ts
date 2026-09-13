/**
 * Graph-local store, one per Y.Doc (review of #90, finding 6): the hover
 * emphasis a pair shares, the table and engine change counters the models
 * key on, and the per-pair model cache — so a hover re-renders the graphs
 * that show it and nothing above them, and a pair is derived once however
 * many components read it (both halves, the Graph tab).
 *
 * Viewer state only; nothing here is document state. Subscriptions go
 * through `useSyncExternalStore`, so the counters are bumped before React
 * re-renders (the same shape as `grid/cell-versions.ts`).
 */
import { useCallback, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  adjacencyOf,
  openDocument,
  readString,
  type GedeDoc,
  type GraphDerivation,
  type GraphEmphasis,
  type Id,
} from '@gede/core';

import { engineFor } from '../../../doc/engine.js';

export interface GraphHover {
  readonly pairId: Id;
  readonly tableId: Id | null;
  readonly emphasis: GraphEmphasis;
  /**
   * GRAPH-09: the source rows the emphasis lights — the context's own row, or
   * every context bound to a hovered parameter dot (#141). Read from the
   * derivation by whoever sets the hover, so this store stays free of it.
   */
  readonly rows: ReadonlySet<Id>;
}

const NO_ROWS: ReadonlySet<Id> = new Set();

/** The hover a half reports for an emphasis, rows included (GRAPH-09). */
export function hoverFor(
  pairId: Id,
  tableId: Id | null,
  derivation: GraphDerivation,
  emphasis: GraphEmphasis,
): GraphHover {
  return { pairId, tableId, emphasis, rows: adjacencyOf(derivation, emphasis).contextIds };
}

type Listener = () => void;

export interface CachedModel<M> {
  readonly key: string;
  readonly model: M;
}

class GraphStore {
  hover: GraphHover | null = null;
  private readonly hoverListeners = new Set<Listener>();
  /** Deep change counter per table id; a structural change of the tables map bumps `structure`. */
  private readonly tableVersions = new Map<Id, number>();
  private readonly tableListeners = new Map<Id, Set<Listener>>();
  private structure = 0;
  private readonly structureListeners = new Set<Listener>();
  private engine = 0;
  private readonly engineListeners = new Set<Listener>();
  private observing = false;
  private engineObserving = false;
  private readonly models = new Map<Id, CachedModel<unknown>>();

  constructor(private readonly gd: GedeDoc) {}

  // -- hover ----------------------------------------------------------------
  setHover(next: GraphHover | null): void {
    if (sameHover(this.hover, next)) return;
    this.hover = next;
    for (const l of this.hoverListeners) l();
  }
  subscribeHover = (l: Listener): (() => void) => {
    this.hoverListeners.add(l);
    return () => {
      this.hoverListeners.delete(l);
    };
  };

  // -- table versions --------------------------------------------------------
  tableVersion(tableId: Id | null): number {
    return tableId === null ? 0 : (this.tableVersions.get(tableId) ?? 0);
  }
  subscribeTable(tableId: Id | null, l: Listener): () => void {
    this.observe();
    if (tableId === null) return () => undefined;
    let set = this.tableListeners.get(tableId);
    if (set === undefined) {
      set = new Set();
      this.tableListeners.set(tableId, set);
    }
    set.add(l);
    return () => {
      set.delete(l);
    };
  }
  structureVersion(): number {
    return this.structure;
  }
  subscribeStructure = (l: Listener): (() => void) => {
    this.observe();
    this.structureListeners.add(l);
    return () => {
      this.structureListeners.delete(l);
    };
  };
  private observe(): void {
    if (this.observing) return;
    this.observing = true;
    const { tables } = this.gd;
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const touched = new Set<Id>();
      let structural = false;
      for (const event of events) {
        const target: Y.AbstractType<unknown> = event.target;
        if ((target as unknown) === tables) {
          structural = true;
          continue;
        }
        // Walk up to the table map (the child of the top-level `tables` map).
        let type: Y.AbstractType<unknown> = target;
        while (type.parent !== null && (type.parent as unknown) !== tables) type = type.parent;
        const id = readString(type as Y.Map<unknown>, 'id');
        if (id !== '') touched.add(id);
      }
      for (const id of touched) {
        this.tableVersions.set(id, (this.tableVersions.get(id) ?? 0) + 1);
        for (const l of this.tableListeners.get(id) ?? []) l();
      }
      if (structural) {
        this.structure += 1;
        for (const l of this.structureListeners) l();
      }
    };
    tables.observeDeep(handler);
    this.gd.doc.on('destroy', () => {
      tables.unobserveDeep(handler);
    });
  }

  // -- engine ---------------------------------------------------------------
  engineVersion(): number {
    return this.engine;
  }
  subscribeEngine = (l: Listener): (() => void) => {
    if (!this.engineObserving) {
      this.engineObserving = true;
      engineFor(this.gd.doc).subscribeAll(() => {
        this.engine += 1;
        for (const x of this.engineListeners) x();
      });
    }
    this.engineListeners.add(l);
    return () => {
      this.engineListeners.delete(l);
    };
  };

  // -- model cache ----------------------------------------------------------
  /**
   * The model for a pair under `key`, computed once per key. `compute` receives
   * the previous model (if any) so it can keep the parts that did not change.
   */
  model<M>(pairId: Id, key: string, compute: (previous: M | null) => M): M {
    const cached = this.models.get(pairId) as CachedModel<M> | undefined;
    if (cached?.key === key) return cached.model;
    const model = compute(cached?.model ?? null);
    this.models.set(pairId, { key, model });
    return model;
  }
}

function sameHover(a: GraphHover | null, b: GraphHover | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.pairId !== b.pairId || a.tableId !== b.tableId) return false;
  const x = a.emphasis;
  const y = b.emphasis;
  if (x.role !== y.role) return false;
  return x.role === 'context' && y.role === 'context'
    ? x.id === y.id
    : x.role === 'parameter' && y.role === 'parameter' && x.key === y.key;
}

const stores = new WeakMap<Y.Doc, GraphStore>();

export function graphStoreFor(doc: Y.Doc): GraphStore {
  let store = stores.get(doc);
  if (store === undefined) {
    store = new GraphStore(openDocument(doc));
    stores.set(doc, store);
  }
  return store;
}

/** The emphasis a pair shows from the pointer or keyboard, or null (GRAPH-09). */
export function useGraphHover(doc: Y.Doc, pairId: Id): GraphEmphasis | null {
  const store = graphStoreFor(doc);
  return useSyncExternalStore(
    store.subscribeHover,
    () => (store.hover?.pairId === pairId ? store.hover.emphasis : null),
    () => null,
  );
}

/** GRAPH-09: the rows a hovered node, dot or cell lights in `tableId` (empty when none). */
export function useGraphLitRows(doc: Y.Doc | null, tableId: Id): ReadonlySet<Id> {
  const store = doc === null ? null : graphStoreFor(doc);
  const subscribe = useCallback(
    (l: Listener) => (store === null ? () => undefined : store.subscribeHover(l)),
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      const hover = store?.hover ?? null;
      return hover !== null && hover.tableId === tableId ? hover.rows : NO_ROWS;
    },
    () => NO_ROWS,
  );
}

/** The change counters a model's cache key is built from. */
export interface GraphModelKeyParts {
  readonly table: number;
  readonly structure: number;
  readonly engine: number;
}

export function useGraphVersions(doc: Y.Doc, tableId: Id | null): GraphModelKeyParts {
  const store = graphStoreFor(doc);
  const subscribeTable = useCallback(
    (l: Listener) => store.subscribeTable(tableId, l),
    [store, tableId],
  );
  const table = useSyncExternalStore(
    subscribeTable,
    () => store.tableVersion(tableId),
    () => 0,
  );
  const structure = useSyncExternalStore(
    store.subscribeStructure,
    () => store.structureVersion(),
    () => 0,
  );
  const engine = useSyncExternalStore(
    store.subscribeEngine,
    () => store.engineVersion(),
    () => 0,
  );
  return { table, structure, engine };
}
