/**
 * Live derivation of a context graph from its table (PRD §19, GRAPH-06,
 * GRAPH-07): the marked columns are the dimensions, each dimension's distinct
 * values (in row order) are its parameters, and every row is a context — one
 * coordinate per dimension. Pure and message-shaped: plain objects in, plain
 * objects out, so it runs unchanged on the main thread, in a Worker and in
 * the sync service. Nothing here reads Yjs; `input.ts` builds the input.
 */
import type { Id } from '../ids.js';

/** What the derivation needs to know about the source table. */
export interface GraphInput {
  /** The table's columns in order, with the eligibility guard already applied by the caller. */
  readonly columns: readonly GraphInputColumn[];
  /** Rows in document order. Category bands and split children are left out by the caller. */
  readonly rows: readonly GraphInputRow[];
  /** Column ids marked as dimensions, in checklist order; unknown or ineligible ids are ignored. */
  readonly dimensions: readonly Id[];
}

export interface GraphInputColumn {
  readonly id: Id;
  readonly label: string;
  /** REF-05: only an `entered` column can be a dimension — a context must be typeable back. */
  readonly eligible: boolean;
}

export interface GraphInputRow {
  readonly id: Id;
  /** Plain text per column id (a formula cell contributes its evaluated value). Missing = empty. */
  readonly values: Readonly<Record<Id, string>>;
}

export interface GraphParameter {
  /** `${dimensionId}|${value}` — the key spokes, dots and coverage cells share. */
  readonly key: string;
  readonly dimensionId: Id;
  readonly value: string;
  /** Position within the dimension, by first appearance in row order. */
  readonly index: number;
  /** Contexts bound to this parameter, in row order. */
  readonly contextIds: readonly Id[];
}

export interface GraphDimension {
  readonly id: Id;
  readonly label: string;
  /** Position in the dimension list; the palette index. */
  readonly index: number;
  readonly parameters: readonly GraphParameter[];
}

export interface GraphContext {
  /** The source row id. */
  readonly id: Id;
  /** Position among the contexts, in row order; what the symbol is generated from. */
  readonly index: number;
  /** α, β, γ … then α2, β2 … (GRAPH-06 "symbols are generated in row order"). */
  readonly symbol: string;
  /** Parameter value per dimension (dimension order); null where the row is unbound. */
  readonly bindings: readonly (string | null)[];
  /** Every dimension bound (GRAPH-06 "complete"); a partial row is a draft. */
  readonly complete: boolean;
  /** Values joined with ` · `, `∅` for a gap — the coverage lookup key and the child sheet's label. */
  readonly tupleKey: string;
}

export interface GraphDerivation {
  readonly dimensions: readonly GraphDimension[];
  readonly contexts: readonly GraphContext[];
  /** Distinct complete tuples the contexts cover (GRAPH-07 header numerator). */
  readonly coveredTuples: number;
  /** Product of the parameter counts (GRAPH-07 header denominator); 0 with no dimensions. */
  readonly tupleSpace: number;
  /** Contexts that are not complete. */
  readonly draftCount: number;
}

export const GREEK_SYMBOLS: readonly string[] = [
  'α',
  'β',
  'γ',
  'δ',
  'ε',
  'ζ',
  'η',
  'θ',
  'ι',
  'κ',
  'λ',
  'μ',
  'ν',
  'ξ',
  'ο',
  'π',
  'ρ',
  'σ',
  'τ',
  'υ',
  'φ',
  'χ',
  'ψ',
  'ω',
];

/** Where a value is absent in a tuple key. */
export const UNBOUND_MARK = '∅';
export const TUPLE_SEPARATOR = ' · ';

/**
 * The symbol for the n-th context (0-based): the Greek alphabet, then the
 * alphabet again with a cycle number (`α2`, `β2` …) so symbols stay unique
 * however long the table grows.
 */
export function symbolFor(index: number): string {
  const n = Math.max(0, Math.floor(index));
  const letter = GREEK_SYMBOLS[n % GREEK_SYMBOLS.length] ?? 'α';
  const cycle = Math.floor(n / GREEK_SYMBOLS.length);
  return cycle === 0 ? letter : `${letter}${String(cycle + 1)}`;
}

export function parameterKey(dimensionId: Id, value: string): string {
  return `${dimensionId}|${value}`;
}

/** The lookup key for a tuple of bindings (dimension order). */
export function tupleKeyOf(bindings: readonly (string | null)[]): string {
  return bindings.map((b) => b ?? UNBOUND_MARK).join(TUPLE_SEPARATOR);
}

/** A cell's contribution to a dimension: trimmed text, empty meaning unbound. */
export function normaliseValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  return text === '' ? null : text;
}

/** The dimension ids that are actually usable: known, eligible and unique, in the given order. */
export function resolveDimensionIds(input: GraphInput): Id[] {
  const eligible = new Set(input.columns.filter((c) => c.eligible).map((c) => c.id));
  const out: Id[] = [];
  for (const id of input.dimensions) {
    if (eligible.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Derive dimensions, parameters and contexts. O(rows × dimensions); the
 * 160 × 22 budget (16 ms) is met with two passes and no sorting.
 */
export function deriveGraph(input: GraphInput): GraphDerivation {
  const dimensionIds = resolveDimensionIds(input);
  const labels = new Map(input.columns.map((c) => [c.id, c.label]));
  // Pass 1: parameters per dimension, first appearance wins the order.
  const parameterIndex = dimensionIds.map(() => new Map<string, number>());
  const parameterContexts = dimensionIds.map(() => [] as Id[][]);
  const contexts: GraphContext[] = [];
  const covered = new Set<string>();
  for (const row of input.rows) {
    const bindings: (string | null)[] = [];
    let bound = 0;
    dimensionIds.forEach((dimId, di) => {
      const value = normaliseValue(row.values[dimId]);
      bindings.push(value);
      if (value === null) return;
      bound += 1;
      const index = parameterIndex[di];
      const lists = parameterContexts[di];
      if (index === undefined || lists === undefined) return;
      let at = index.get(value);
      if (at === undefined) {
        at = index.size;
        index.set(value, at);
        lists.push([]);
      }
      lists[at]?.push(row.id);
    });
    // A row with nothing on any dimension is not a context yet (PRD §19: "type into a row
    // of the table to place the first context").
    if (bound === 0) continue;
    const complete = dimensionIds.length > 0 && bound === dimensionIds.length;
    const tupleKey = tupleKeyOf(bindings);
    if (complete) covered.add(tupleKey);
    const index = contexts.length;
    contexts.push({ id: row.id, index, symbol: symbolFor(index), bindings, complete, tupleKey });
  }
  const dimensions: GraphDimension[] = dimensionIds.map((id, di) => {
    const index = parameterIndex[di] ?? new Map<string, number>();
    const lists = parameterContexts[di] ?? [];
    const parameters: GraphParameter[] = [];
    for (const [value, at] of index) {
      parameters.push({
        key: parameterKey(id, value),
        dimensionId: id,
        value,
        index: at,
        contextIds: lists[at] ?? [],
      });
    }
    return { id, label: labels.get(id) ?? id, index: di, parameters };
  });
  const tupleSpace =
    dimensions.length === 0
      ? 0
      : dimensions.reduce((acc, d) => acc * Math.max(1, d.parameters.length), 1);
  return {
    dimensions,
    contexts,
    coveredTuples: covered.size,
    tupleSpace,
    draftCount: contexts.filter((c) => !c.complete).length,
  };
}

/** Distinct non-empty values of a column, in row order — the checklist's count (GRAPH-05). */
export function distinctValueCount(rows: readonly GraphInputRow[], colId: Id): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = normaliseValue(row.values[colId]);
    if (value !== null) seen.add(value);
  }
  return seen.size;
}

/** The GRAPH-07 header: "covered / space" (e.g. `3 / 8`), or `—` while nothing can be counted. */
export function coverageLabel(derivation: GraphDerivation): string {
  if (derivation.dimensions.length === 0) return '—';
  return `${String(derivation.coveredTuples)} / ${String(derivation.tupleSpace)}`;
}
