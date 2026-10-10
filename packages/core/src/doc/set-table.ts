/**
 * What a set table states about itself (SET-02..07; ADR-056, SPEC §3, §5): its counts,
 * its special status, what its definition says, each row's degree, a repeated element's
 * flag and a family row's kind. Pure projections over the table's rows — none of it is
 * stored, none of it is a Yjs row, and none of it moves an A1 address (SET-07): the meta
 * and title rows are drawn in the title bar's two lattice rows, the degree rail outside
 * the footprint, the counts in GRID-11's footer strip.
 *
 * The one write here is Split into rows (SET-02), offered when a comma value lands in a
 * set's range cell.
 */
import { valueElements, type CellValue } from '../formula/evaluate.js';
import { dedupe, normaliseElement, splitSetPieces, splitSetSpans } from '../formula/sets.js';
import { effectiveDepths, hasDescendants, parentIndex, subtreeEnd } from '../hier/outline.js';
import { cellKey, type Id } from '../ids.js';
import {
  cellReadOnlyReason,
  cellsMap,
  cellText,
  isFormula,
  rowMeta,
  rowsArray,
  tableMap,
  tableRecord,
  type GedeDoc,
  type TableKind,
  type TableMap,
  type TableRecord,
} from './schema.js';
import { deterministicId } from '../ref/split.js';
import { RowEditor } from '../ref/rows.js';
import { slice } from '../text/algebra.js';
import { cellRich } from '../text/mutations.js';
import { normalise, plainText } from '../text/types.js';
import { richToFragment } from '../text/yjs.js';
import { rowMetaFor, settleCollapsed } from './mutations.js';

/** SET-01: every kind but a plain table is a set table. */
export function isSetKind(kind: TableKind): boolean {
  return kind !== 'plain';
}

/**
 * SET-02: a set table's range column — the first column of a simple set or a family, the
 * first one-column computed column of a computed table. A product spread across columns
 * has no single range column, whatever its kind: a spread Filled into a set's first column
 * is a tuple's first member, not the set. Null for a plain table.
 */
export function setRangeColumn(record: TableRecord): Id | null {
  if (record.kind === 'plain') return null;
  if (record.kind === 'simple' || record.kind === 'family') {
    const first = record.columns[0];
    return first === undefined || first.computed?.shape === 'spread' ? null : first.id;
  }
  const computed = record.columns.filter((c) => c.computed !== null);
  if (computed.length === 0) return record.columns[0]?.id ?? null;
  return computed.find((c) => c.computed?.shape === 'column')?.id ?? null;
}

/** SET-07: the rail's fixed labels, in mono with the degree sign U+00B0 (never U+00BA). */
export const SET_DEGREE = { meta: '−2°', title: '−1°', header: '±0°' } as const;

/**
 * SET-07: each row's degree, in row order, from its effective depth (HIER-02): `+n°` at the
 * top level, `+n.m°` one level down, `+n.m.k°` below that. A row hidden under a collapsed
 * parent keeps its degree, so expanding never renumbers anything.
 */
export function degreeLabels(depths: readonly number[]): string[] {
  const effective = effectiveDepths(depths);
  const counters: number[] = [];
  return effective.map((depth) => {
    counters.length = Math.min(counters.length, depth + 1);
    while (counters.length < depth + 1) counters.push(0);
    counters[depth] = (counters[depth] ?? 0) + 1;
    return `+${counters.join('.')}°`;
  });
}

/** SET-06: what a row of a family is — a plain element, a set of elements, or a family of sets. */
export type SetRowKind = 'element' | 'set' | 'family';

/** SET-03: the special status a cardinality gives; null when it gives none (“—”). */
export type SpecialStatus = 'null' | 'singleton';

export function specialStatus(cardinality: number): SpecialStatus | null {
  if (cardinality === 0) return 'null';
  if (cardinality === 1) return 'singleton';
  return null;
}

/**
 * SET-03, v1 default 1 (SPEC §7): what a definition says, each null — rendered “—” — unless
 * the caption is notation GeDe recognises. Never a guess.
 */
export interface DefinitionFacts {
  /** Every v1 set table lists its elements (v1 default 2), so a recognised definition is finite. */
  readonly finite: 'finite' | null;
  /** A variable bound by a set builder `{x | …}` or by a quantifier `∀x`, `there exists x`. */
  readonly variable: 'bound' | null;
  /** The outermost quantifier: the first of ∀ / “for all” and ∃ / “there exists”. */
  readonly quantifier: 'universal' | 'existential' | null;
}

// A variable is one letter, optionally indexed (`x`, `x1`, `x_2`): `for all of them` binds none.
const VARIABLE = String.raw`\p{L}[\p{N}_]*(?![\p{L}\p{N}_])`;
// What a set builder binds before its bar: `x`, `(x, y)`, either with a domain (`x ∈ E`, `x in E`).
const BUILDER_HEAD = String.raw`(?:${VARIABLE}|\(\s*${VARIABLE}(?:\s*,\s*${VARIABLE})*\s*\))(?:\s*(?:∈|∊|\bin\b)\s*[^|∣:{}]+?)?`;
const BUILDER = new RegExp(String.raw`^\s*\{\s*${BUILDER_HEAD}\s*[|∣:]\s*\S[\s\S]*\}\s*$`, 'u');
const SYMBOL_QUANTIFIER = /[∀∃]/gu;
const SYMBOL_VARIABLE = new RegExp(String.raw`[∀∃]\s*${VARIABLE}`, 'u');
const WORD_QUANTIFIER = new RegExp(String.raw`\b(for all|there exists?)\s+(${VARIABLE})`, 'giu');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * “for all” / “there exists” in quantifier position: followed by a variable that the rest of
 * the caption goes on to use (`for all x, x is a vowel`). Prose that merely contains the
 * words — “Snacks for all ages”, “there exists a window” — is not a definition.
 */
function wordQuantifiers(caption: string): { index: number; universal: boolean }[] {
  const out: { index: number; universal: boolean }[] = [];
  for (const m of caption.matchAll(WORD_QUANTIFIER)) {
    const variable = m[2] ?? '';
    const rest = caption.slice(m.index + m[0].length);
    const used = new RegExp(
      String.raw`(?<![\p{L}\p{N}_])${escapeRegExp(variable)}(?![\p{L}\p{N}_])`,
      'u',
    );
    if (used.test(rest)) {
      out.push({ index: m.index, universal: (m[1] ?? '').toLowerCase() === 'for all' });
    }
  }
  return out;
}

/** SET-03: read the caption as a definition (SPEC §7 v1 default 1). */
export function readDefinition(caption: string): DefinitionFacts {
  const builder = BUILDER.test(caption);
  const found = [
    ...[...caption.matchAll(SYMBOL_QUANTIFIER)].map((m) => ({
      index: m.index,
      universal: m[0] === '∀',
    })),
    ...wordQuantifiers(caption),
  ].sort((a, b) => a.index - b.index);
  const first = found[0];
  const quantifier = first === undefined ? null : first.universal ? 'universal' : 'existential';
  const words = found.some((q) => !/[∀∃]/u.test(caption.charAt(q.index)));
  const recognised = builder || quantifier !== null;
  return {
    finite: recognised ? 'finite' : null,
    variable: builder || words || SYMBOL_VARIABLE.test(caption) ? 'bound' : null,
    quantifier,
  };
}

/** One row of a set table as the rail, the range cell and the counts read it. */
export interface SetRowFacts {
  /** SET-07: `+n°`, `+n.m°`. */
  readonly degree: string;
  /**
   * The elements the row's range cell holds, as every set formula reads that cell (FX-09,
   * SET-02): an unsplit comma value is several, a formula's are its evaluated value's, a
   * computed row's is its key. Empty for an empty or lost row, or a formula not yet answered.
   */
  readonly elements: readonly string[];
  /** The row's element when it holds exactly one, else null. */
  readonly element: string | null;
  /** SET-02: the degree of the earlier sibling holding the same (one) element, or null. */
  readonly repeatOf: string | null;
  /** SET-06: element, set or family, from the row's children. */
  readonly kind: SetRowKind;
}

export interface SetTableFacts {
  /** SET-05 / SET-06: distinct top-level members under FX-09 equality. */
  readonly cardinality: number;
  /** SET-05 / SET-06: every entry that is a leaf, at any depth, repeats included. */
  readonly bag: number;
  /** SET-03. */
  readonly status: SpecialStatus | null;
  /** SET-03, from the caption (SET-04: the caption is the definition). */
  readonly definition: DefinitionFacts;
  /** By row id; every row of the table, lost and hidden ones included. */
  readonly rows: ReadonlyMap<Id, SetRowFacts>;
}

/**
 * A formula cell's evaluated value, as the Worker answered it; undefined while it has not.
 * The main thread never evaluates (apps/web CLAUDE.md), so the caller hands this in.
 */
export type SetCellValue = (rowId: Id, colId: Id) => CellValue | null | undefined;

interface RowEntries {
  /** Distinct elements, first-seen order: what the cell is as a set operand. */
  readonly elements: readonly string[];
  /** Every entry, repeats kept: what the bag counts. */
  readonly entries: number;
  /** The range cell's whole text, normalised: a set row's name. */
  readonly name: string;
}

const NO_ENTRIES: RowEntries = { elements: [], entries: 0, name: '' };

/**
 * What a row's range cell holds, read as every set formula reads it (FX-09; SET-02 “the
 * range column is an operand to every set formula”): typed text splits on FX-09's
 * separators, a formula contributes its evaluated value's elements, a computed row its key
 * (one element, never re-split), and a lost row (SET-12) nothing — it is no longer in the
 * set. For a product spread across columns the row's tuple is its element.
 */
function rowEntries(
  table: TableMap,
  rowId: Id,
  rangeColId: Id | null,
  valueOf: SetCellValue | undefined,
): RowEntries {
  const meta = rowMeta(table, rowId);
  if (meta.lostFrom !== null) return NO_ENTRIES;
  if (rangeColId === null || meta.computedKey !== null) {
    const key = normaliseElement(
      rangeColId === null ? (meta.computedKey ?? '') : cellText(table, rowId, rangeColId),
    );
    return key === '' ? NO_ENTRIES : { elements: [key], entries: 1, name: key };
  }
  const stored = cellsMap(table).get(cellKey(rowId, rangeColId));
  if (stored !== undefined && isFormula(stored)) {
    const value = valueOf?.(rowId, rangeColId);
    const elements = value == null ? [] : valueElements(value, () => []);
    return { elements, entries: elements.length, name: normaliseElement(stored) };
  }
  const text = cellText(table, rowId, rangeColId);
  const pieces = splitSetPieces(text);
  return { elements: dedupe(pieces), entries: pieces.length, name: normaliseElement(text) };
}

/**
 * SET-02..07: the facts of a set table, or null for a plain table. `valueOf` answers a
 * formula range cell with the value the engine evaluated; without it such a cell counts
 * nothing until it is answered.
 */
export function setTableFacts(
  table: TableMap,
  record: TableRecord = tableRecord(table),
  valueOf?: SetCellValue,
): SetTableFacts | null {
  if (!isSetKind(record.kind)) return null;
  const rangeColId = setRangeColumn(record);
  const depths = effectiveDepths(record.rows.map((rowId) => rowMeta(table, rowId).depth));
  const degrees = degreeLabels(depths);
  const read = record.rows.map((rowId) => rowEntries(table, rowId, rangeColId, valueOf));
  // SET-02: a repeat is a repeat among siblings — the same element under two different
  // parents is in two different sets.
  const firstSeen = new Map<string, string>();
  const rows = new Map<Id, SetRowFacts>();
  const topLevel = new Set<string>();
  let bag = 0;
  record.rows.forEach((rowId, i) => {
    const { elements, entries, name } = read[i] ?? NO_ENTRIES;
    const degree = degrees[i] ?? '';
    const depth = depths[i] ?? 0;
    const kind = rowKind(depths, i);
    const parent = String(parentIndex(depths, i) ?? -1);
    let repeatOf: string | null = null;
    for (const element of elements) {
      const key = `${parent}\u0000${element}`;
      const earlier = firstSeen.get(key);
      if (earlier === undefined) firstSeen.set(key, degree);
      else if (elements.length === 1) repeatOf = earlier;
    }
    if (depth === 0) {
      // SET-06: a top-level set is one member however many elements it holds — named by
      // its range cell, or, with no name, a member of its own.
      if (kind === 'element') for (const element of elements) topLevel.add(element);
      else topLevel.add(name === '' ? `\u0001${rowId}` : `\u0002${name}`);
    }
    if (kind === 'element') bag += entries;
    rows.set(rowId, {
      degree,
      elements,
      element: elements.length === 1 ? (elements[0] ?? null) : null,
      repeatOf,
      kind,
    });
  });
  return {
    cardinality: topLevel.size,
    bag,
    status: specialStatus(topLevel.size),
    definition: readDefinition(record.look.caption),
    rows,
  };
}

/** SET-06: no children → element; children that are all elements → set; else family. */
function rowKind(depths: readonly number[], index: number): SetRowKind {
  if (!hasDescendants(depths, index)) return 'element';
  const depth = depths[index] ?? 0;
  const end = subtreeEnd(depths, index);
  for (let j = index + 1; j < end; j += 1) {
    if (depths[j] === depth + 1 && hasDescendants(depths, j)) return 'family';
  }
  return 'set';
}

/**
 * SET-02: the elements a range cell would split into, when Split into rows is on offer —
 * a simple set's or a family's range cell holding typed text of two or more elements
 * (FX-09's separators; one inside brackets or braces does not split) on a row a person
 * may edit. Null otherwise: another column, a plain or computed table, a formula, a single
 * element, a read-only row (pulled from another set, SET-06 / REF-02; a split child).
 */
export function splitOffer(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string[] | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  const record = tableRecord(table);
  if (record.kind !== 'simple' && record.kind !== 'family') return null;
  if (setRangeColumn(record) !== colId || !record.rows.includes(rowId)) return null;
  if (cellReadOnlyReason(table, rowId, colId) !== null) return null;
  const stored = cellsMap(table).get(cellKey(rowId, colId));
  if (stored === undefined || isFormula(stored)) return null;
  const pieces = splitSetPieces(cellText(table, rowId, colId));
  return pieces.length > 1 ? pieces : null;
}

/**
 * SET-02: the row ids a split of `rowId` holding `text` adds, derived from the row, the text
 * and the piece alone (`deterministicId`), so two replicas that both accept the same offer
 * add the same rows and converge on one row per element once `settleSetRows` has dropped
 * the second copy of each. `attempt` moves past ids an earlier split already used.
 */
function splitRowId(rowId: Id, text: string, index: number, attempt: number): Id {
  return deterministicId(`set-split~${rowId}~${text}~${String(index)}~${String(attempt)}`);
}

/**
 * SET-02: Split into rows, as one undo step. The cell keeps the first element; each other
 * element gets a row of its own, at the row's depth, after the row and anything nested
 * under it, in typed order, repeats kept (they are flagged, not dropped). Each element keeps
 * the marks it was typed with. Returns the new rows' ids, or null when the cell is not on
 * offer (`splitOffer`).
 */
export function splitIntoRows(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): Id[] | null {
  let added = null as Id[] | null;
  gd.doc.transact(() => {
    const table = tableMap(gd, tableId);
    if (table === null || splitOffer(gd, tableId, rowId, colId) === null) return;
    const rich = cellRich(table, rowId, colId);
    const text = plainText(rich);
    const pieces = splitSetSpans(text).map(({ start, end }) => normalise(slice(rich, start, end)));
    const rows = rowsArray(table).toArray();
    const present = new Set(rows);
    const index = rows.indexOf(rowId);
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const depth = depths[index] ?? 0;
    const outlineColumn = rowMeta(table, rowId).outlineColumn;
    const [first, ...rest] = pieces;
    if (first === undefined) return;
    let attempt = 0;
    let ids = rest.map((_p, i) => splitRowId(rowId, text, i + 1, attempt));
    while (ids.some((id) => present.has(id))) {
      attempt += 1;
      ids = rest.map((_p, i) => splitRowId(rowId, text, i + 1, attempt));
    }
    // A fresh fragment rather than an edit in place: two replicas that both split the cell
    // then hold one value each under the same key, and the map keeps one (an edit in place
    // would merge both rewrites into the cell twice).
    const cells = cellsMap(table);
    cells.set(cellKey(rowId, colId), richToFragment(first));
    const at = subtreeEnd(depths, index);
    rowsArray(table).insert(at, ids);
    ids.forEach((id, i) => {
      const meta = rowMetaFor(table, id);
      if (depth > 0) meta.set('depth', depth);
      if (outlineColumn !== null) meta.set('outlineColumn', outlineColumn);
      cells.set(cellKey(id, colId), richToFragment(rest[i] ?? first));
    });
    settleCollapsed(table);
    added = ids;
  }, gd.origin);
  return added;
}

/**
 * SET-02 after a merge: two replicas that both split the same value inserted the same row
 * ids (`splitIntoRows`); a Yjs insert is a fresh item, so each id is in the rows twice.
 * Drop the later copy (`RowEditor.dedupe`): both replicas hold the same order and delete the
 * same items. Run for a simple set or a family after a remote change; returns the rows
 * removed, and transacts nothing when there are none.
 */
export function settleSetRows(
  gd: GedeDoc,
  tableId: Id,
  origin: unknown = SET_SETTLE_ORIGIN,
): number {
  const table = tableMap(gd, tableId);
  if (table === null) return 0;
  const kind = tableRecord(table).kind;
  if (kind !== 'simple' && kind !== 'family') return 0;
  const ids = rowsArray(table).toArray();
  if (new Set(ids).size === ids.length) return 0;
  let removed = 0;
  gd.doc.transact(() => {
    removed = new RowEditor(rowsArray(table)).dedupe();
  }, origin);
  return removed;
}

/** Transaction origin of `settleSetRows`: never an undo step of its own. */
export const SET_SETTLE_ORIGIN = 'set-settle';
