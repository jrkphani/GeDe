/**
 * Conditional rule writes (INSP-05): the column's `rules` list, replaced
 * whole in one transaction. Kept apart from `rules.ts` (pure evaluation,
 * imported by the schema readers) so evaluation never depends on the writers.
 */
import type { GedeDoc } from '../doc/schema.js';
import { newId, type Id } from '../ids.js';
import { readRules, type ConditionalRule } from './rules.js';
import { requireColumn, requireTable, transact } from './write.js';

/** Replace a column's rule list. Returns what is stored. */
export function setColumnRules(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  rules: readonly ConditionalRule[],
): readonly ConditionalRule[] {
  return transact(gd, () => {
    const column = requireColumn(requireTable(gd, tableId), tableId, colId);
    const clean = readRules(rules);
    if (clean.length === 0) column.delete('rules');
    else
      column.set(
        'rules',
        clean.map((r) => ({ id: r.id, when: r.when, style: r.style })),
      );
    return clean;
  });
}

function rulesOf(gd: GedeDoc, tableId: Id, colId: Id): readonly ConditionalRule[] {
  return readRules(requireColumn(requireTable(gd, tableId), tableId, colId).get('rules'));
}

export function addColumnRule(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  rule: Omit<ConditionalRule, 'id'>,
): ConditionalRule {
  const created: ConditionalRule = { id: newId(), ...rule };
  setColumnRules(gd, tableId, colId, [...rulesOf(gd, tableId, colId), created]);
  return created;
}

export function updateColumnRule(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  ruleId: string,
  patch: Partial<Omit<ConditionalRule, 'id'>>,
): boolean {
  const rules = rulesOf(gd, tableId, colId);
  if (!rules.some((r) => r.id === ruleId)) return false;
  setColumnRules(
    gd,
    tableId,
    colId,
    rules.map((r) => (r.id === ruleId ? { ...r, ...patch, id: r.id } : r)),
  );
  return true;
}

/** Move a rule one place up (earlier, higher priority) or down. False when it cannot move. */
export function moveColumnRule(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  ruleId: string,
  direction: 'up' | 'down',
): boolean {
  const rules = [...rulesOf(gd, tableId, colId)];
  const from = rules.findIndex((r) => r.id === ruleId);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= rules.length) return false;
  const [moved] = rules.splice(from, 1);
  if (moved === undefined) return false;
  rules.splice(to, 0, moved);
  setColumnRules(gd, tableId, colId, rules);
  return true;
}

export function removeColumnRule(gd: GedeDoc, tableId: Id, colId: Id, ruleId: string): boolean {
  const rules = rulesOf(gd, tableId, colId);
  if (!rules.some((r) => r.id === ruleId)) return false;
  setColumnRules(
    gd,
    tableId,
    colId,
    rules.filter((r) => r.id !== ruleId),
  );
  return true;
}
