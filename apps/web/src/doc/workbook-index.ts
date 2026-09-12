/**
 * One `WorkbookIndex` per open document, rebuilt lazily after the document
 * changes shape and re-labelled after a row label changes. Binding a formula
 * at commit, projecting stored formulas to today's A1 text and drawing
 * outlines all read from here, so a keystroke in the editor — which does not
 * change the document — never rebuilds anything (PRD §20: the index is
 * rebuilt on structural edits, not on input).
 */
import { useCallback, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { cellsMap, openDocument, workbookIndexOf, type WorkbookIndex } from '@gede/core';

interface Entry {
  index: WorkbookIndex | null;
  /** Ticks on structure or label changes; React subscribes to it. */
  version: number;
  readonly listeners: Set<() => void>;
  /** stored source → projected text, valid for one version. */
  readonly projected: Map<string, string>;
}

const entries = new WeakMap<Y.Doc, Entry>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types `parent` as AbstractType<any>
type AnyType = Y.AbstractType<any>;

function entryFor(doc: Y.Doc): Entry {
  const entry = entries.get(doc);
  if (entry !== undefined) return entry;
  const created: Entry = { index: null, version: 0, listeners: new Set(), projected: new Map() };
  entries.set(doc, created);
  const gd = openDocument(doc);
  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    let touched = false;
    for (const event of events) {
      let node: AnyType | null = event.target;
      let insideCells = false;
      while (node !== null && node !== gd.tables) {
        const parent: AnyType | null = node.parent;
        if (parent instanceof Y.Map && parent.parent === gd.tables && node === cellsMap(parent)) {
          insideCells = true;
          break;
        }
        node = parent;
      }
      if (insideCells) {
        // A cell edit: only the row labels can have changed. Cheap to re-read, so
        // the index is kept and its entity view dropped.
        created.index?.invalidateLabels();
        if (!labelChangeAffectsIndex(event, gd.tables)) continue;
        touched = true;
      } else {
        created.index = null;
        touched = true;
      }
    }
    if (touched) {
      created.version += 1;
      created.projected.clear();
      for (const cb of created.listeners) cb();
    }
  };
  gd.tables.observeDeep(handler);
  doc.on('destroy', () => {
    gd.tables.unobserveDeep(handler);
    entries.delete(doc);
  });
  return created;
}

/** A first-column cell changed: `@` paths may re-spell. Any other cell edit is invisible to the index. */
function labelChangeAffectsIndex(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  tables: Y.Map<Y.Map<unknown>>,
): boolean {
  // Find the table and the key of the cell the event lives under.
  let node: AnyType | null = event.target;
  let key: string | null = null;
  while (node !== null) {
    const parent: AnyType | null = node.parent;
    if (parent instanceof Y.Map && parent.parent === tables) {
      const table = parent;
      const columns = table.get('columns') as Y.Array<Y.Map<unknown>> | undefined;
      const firstCol =
        columns === undefined || columns.length === 0 ? undefined : columns.get(0).get('id');
      if (typeof firstCol !== 'string') return false;
      if (key === null) {
        // The cells map itself changed: look at the keys.
        for (const k of event.changes.keys.keys()) if (k.endsWith(`:${firstCol}`)) return true;
        return false;
      }
      return key.endsWith(`:${firstCol}`);
    }
    key = node._item?.parentSub ?? key;
    node = parent;
  }
  return false;
}

export function workbookIndexFor(doc: Y.Doc): WorkbookIndex {
  const entry = entryFor(doc);
  entry.index ??= workbookIndexOf(openDocument(doc));
  return entry.index;
}

/** A stored formula projected to today's A1 / `@` text, memoised until the workbook changes shape. */
export function projectFormulaFor(doc: Y.Doc, source: string): string {
  const entry = entryFor(doc);
  let text = entry.projected.get(source);
  if (text === undefined) {
    text = workbookIndexFor(doc).project(source);
    if (entry.projected.size > 5000) entry.projected.clear();
    entry.projected.set(source, text);
  }
  return text;
}

/** Re-render when the workbook's shape or labels change; returns a change counter (0 without a document). */
export function useWorkbookIndexVersion(doc: Y.Doc | null): number {
  const entry = doc === null ? null : entryFor(doc);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (entry === null) return () => undefined;
      entry.listeners.add(onChange);
      return () => {
        entry.listeners.delete(onChange);
      };
    },
    [entry],
  );
  return useSyncExternalStore(
    subscribe,
    () => entry?.version ?? 0,
    () => 0,
  );
}
