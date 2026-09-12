/**
 * The matched conditional rule of every cell in a table (INSP-05): for each
 * column that carries rules, the cell texts (a formula's evaluated result,
 * FX-07) go to the rules Worker and the answer — the first matching rule per
 * cell — is held here as a map by cell key. React never evaluates a rule;
 * this hook only keeps the last answer, as `useTableProjection` does for
 * sort. A table with no rules costs nothing: no request, an empty map.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  cellsMap,
  evaluatedText,
  fragmentText,
  isFormula,
  ruleOutcome,
  workbookCellId,
  type CellKey,
  type Id,
  type RuleOutcome,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import { engineFor, peekEngine } from '../../../doc/engine.js';
import { createRuleEvaluator, type RuleEvaluator } from './rules-client.js';

export type RuleMatches = ReadonlyMap<CellKey, RuleOutcome>;

const NONE: RuleMatches = new Map();

let shared: RuleEvaluator | null = null;

/** One Worker for every column of every open document. */
export function sharedRuleEvaluator(): RuleEvaluator {
  shared ??= createRuleEvaluator();
  return shared;
}

/** Test seam: replace the shared evaluator (e.g. with a main-thread one). */
export function setSharedRuleEvaluatorForTests(evaluator: RuleEvaluator | null): void {
  shared?.dispose();
  shared = evaluator;
}

/** The formula engine's result version, subscribed only while a rules column exists. */
function useEngineVersion(table: TableMap, wanted: boolean): number {
  const doc = table.doc;
  useEffect(() => {
    if (wanted && doc !== null) engineFor(doc);
  }, [doc, wanted]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!wanted || doc === null) return () => undefined;
      return engineFor(doc).subscribeAll(onChange);
    },
    [doc, wanted],
  );
  return useSyncExternalStore(
    subscribe,
    () => (doc === null ? 0 : (peekEngine(doc)?.version ?? 0)),
    () => 0,
  );
}

/**
 * @param version the table's change counter, so a text or rule edit re-evaluates.
 */
export function useColumnRules(table: TableMap, record: TableRecord, version: number): RuleMatches {
  const ruled = useMemo(() => record.columns.filter((c) => c.rules.length > 0), [record.columns]);
  const active = ruled.length > 0;
  const engineVersion = useEngineVersion(table, active);
  const [result, setResult] = useState<{ tableId: Id; matches: RuleMatches } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const doc = table.doc;
    const engine = doc === null ? undefined : peekEngine(doc);
    const tableId = record.id;
    const cells = cellsMap(table);
    const evaluator = sharedRuleEvaluator();
    const answers = ruled.map((column) => {
      const texts = record.rows.map((rowId) => {
        const key: CellKey = `${rowId}:${column.id}`;
        const content = cells.get(key);
        const text =
          content === undefined
            ? ''
            : isFormula(content)
              ? evaluatedText(engine?.result(workbookCellId(tableId, key))?.value)
              : fragmentText(content);
        return { key, text };
      });
      return evaluator
        .evaluate({ tableId, colId: column.id, rules: column.rules, cells: texts })
        .then((r) => ({ column, r }));
    });
    void Promise.all(answers).then((all) => {
      if (cancelled) return;
      const next = new Map<CellKey, RuleOutcome>();
      let complete = true;
      for (const { column, r } of all) {
        if (!r.ok) {
          complete = false;
          continue;
        }
        const byId = new Map(column.rules.map((rule) => [rule.id, rule]));
        for (const m of r.matches) {
          const rule = byId.get(m.ruleId);
          if (rule !== undefined) next.set(m.key, ruleOutcome(rule));
        }
      }
      // A stale or failed column keeps the previous answer rather than blanking the table.
      if (complete) setResult({ tableId, matches: next });
    });
    return () => {
      cancelled = true;
    };
    // `version` (the table) and `engineVersion` (formula results) tick on every change.
  }, [table, record.id, record.rows, ruled, version, engineVersion, active]);

  if (!active) return NONE;
  return result?.tableId === record.id ? result.matches : NONE;
}
