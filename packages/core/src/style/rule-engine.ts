/**
 * Conditional highlighting as a Worker service (INSP-05; root CLAUDE.md:
 * "Regex and fuzzy matching run in Web Workers"). One request carries a
 * column's rules and the texts of its cells; the response names, per cell,
 * the first rule that matched. Plain objects both ways, so the same handler
 * serves `workers/rules.worker.ts` and the main-thread fallback in tests.
 * Never throws: a malformed rule list reads as empty (`readRules`).
 */
import type { CellKey } from '../ids.js';
import { evaluateRules, readRules, type ConditionalRule } from './rules.js';

export interface RulesRequest {
  readonly id: number;
  readonly tableId: string;
  readonly colId: string;
  readonly rules: readonly ConditionalRule[];
  /** The cells to evaluate, with the text the renderer shows (a formula's result, not its source). */
  readonly cells: readonly { readonly key: CellKey; readonly text: string }[];
}

export interface RuleMatch {
  readonly key: CellKey;
  readonly ruleId: string;
}

export type RulesResponse =
  | {
      readonly id: number;
      readonly tableId: string;
      readonly colId: string;
      readonly ok: true;
      /** Only the cells a rule matched; every other cell of the column is unstyled. */
      readonly matches: readonly RuleMatch[];
    }
  | {
      readonly id: number;
      readonly tableId: string;
      readonly colId: string;
      readonly ok: false;
      readonly error: string;
    };

export function isRulesRequest(value: unknown): value is RulesRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' &&
    typeof v.tableId === 'string' &&
    typeof v.colId === 'string' &&
    Array.isArray(v.rules) &&
    Array.isArray(v.cells) &&
    v.cells.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).key === 'string' &&
        typeof (c as Record<string, unknown>).text === 'string',
    )
  );
}

export function handleRulesRequest(request: RulesRequest): RulesResponse {
  const { id, tableId, colId } = request;
  try {
    const rules = readRules(request.rules);
    const matches: RuleMatch[] = [];
    if (rules.length > 0) {
      for (const cell of request.cells) {
        const outcome = evaluateRules(rules, cell.text);
        if (outcome !== null) matches.push({ key: cell.key, ruleId: outcome.rule.id });
      }
    }
    return { id, tableId, colId, ok: true, matches };
  } catch (error) {
    return {
      id,
      tableId,
      colId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
