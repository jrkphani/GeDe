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
import { normaliseElement, splitSetPieces } from '../formula/sets.js';
import { effectiveDepths, hasDescendants, parentIndex, subtreeEnd } from '../hier/outline.js';
import { cellKey, type Id } from '../ids.js';
import {
  cellsMap,
  cellText,
  isFormula,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableMap,
  tableRecord,
  type GedeDoc,
  type TableKind,
  type TableMap,
  type TableRecord,
} from './schema.js';
import { addRow, setCellText } from './mutations.js';

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

const BUILDER = /^\s*\{\s*\p{L}[\p{L}\p{N}_]*\s*[|∣:]\s*\S[\s\S]*\}\s*$/u;
const UNIVERSAL = /∀|\bfor all\b/iu;
const EXISTENTIAL = /∃|\bthere exists?\b/iu;
// A variable is one letter, optionally indexed (`x`, `x1`, `x_2`): `for all of them` binds none.
const QUANTIFIED_VARIABLE = /(?:[∀∃]\s*|\b(?:for all|there exists?)\s+)\p{L}[\p{N}_]*(?!\p{L})/iu;

/** SET-03: read the caption as a definition (SPEC §7 v1 default 1). */
export function readDefinition(caption: string): DefinitionFacts {
  const builder = BUILDER.test(caption);
  const universal = caption.search(UNIVERSAL);
  const existential = caption.search(EXISTENTIAL);
  const quantifier =
    universal < 0 && existential < 0
      ? null
      : existential < 0 || (universal >= 0 && universal < existential)
        ? 'universal'
        : 'existential';
  const recognised = builder || quantifier !== null;
  return {
    finite: recognised ? 'finite' : null,
    variable: builder || QUANTIFIED_VARIABLE.test(caption) ? 'bound' : null,
    quantifier,
  };
}

/** One row of a set table as the rail, the range cell and the counts read it. */
export interface SetRowFacts {
  /** SET-07: `+n°`, `+n.m°`. */
  readonly degree: string;
  /** The row's element (trimmed, NFC), or null for an empty, formula or lost row. */
  readonly element: string | null;
  /** SET-02: the degree of the earlier sibling holding the same element, or null. */
  readonly repeatOf: string | null;
  /** SET-06: element, set or family, from the row's children. */
  readonly kind: SetRowKind;
}

export interface SetTableFacts {
  /** SET-05 / SET-06: distinct top-level elements under FX-09 equality. */
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
 * The element a row stands for: its range cell's text (a computed cell's projection
 * included), or for a product spread across columns, its tuple. A formula typed into a
 * range cell is not read as an element here — its value is the Worker's, not the text —
 * and a lost row (SET-12) is no longer in the set.
 */
function rowElement(table: TableMap, rowId: Id, rangeColId: Id | null): string | null {
  const meta = rowMeta(table, rowId);
  if (meta.lostFrom !== null) return null;
  if (rangeColId === null) return meta.computedKey;
  const stored = cellsMap(table).get(cellKey(rowId, rangeColId));
  if (stored !== undefined && isFormula(stored)) return null;
  const element = normaliseElement(cellText(table, rowId, rangeColId));
  return element === '' ? null : element;
}

/** SET-02..07: the facts of a set table, or null for a plain table. */
export function setTableFacts(
  table: TableMap,
  record: TableRecord = tableRecord(table),
): SetTableFacts | null {
  if (!isSetKind(record.kind)) return null;
  const rangeColId = setRangeColumn(record);
  const depths = effectiveDepths(record.rows.map((rowId) => rowMeta(table, rowId).depth));
  const degrees = degreeLabels(depths);
  const elements = record.rows.map((rowId) => rowElement(table, rowId, rangeColId));
  const leaf = depths.map((_, i) => !hasDescendants(depths, i));
  // SET-02: a repeat is a repeat among siblings — the same element under two different
  // parents is in two different sets.
  const firstSeen = new Map<string, string>();
  const rows = new Map<Id, SetRowFacts>();
  const topLevel = new Set<string>();
  let bag = 0;
  record.rows.forEach((rowId, i) => {
    const element = elements[i] ?? null;
    const degree = degrees[i] ?? '';
    const depth = depths[i] ?? 0;
    let repeatOf: string | null = null;
    if (element !== null) {
      const key = `${String(parentIndex(depths, i) ?? -1)}\u0000${element}`;
      repeatOf = firstSeen.get(key) ?? null;
      if (repeatOf === null) firstSeen.set(key, degree);
      if (depth === 0) topLevel.add(element);
      if (leaf[i] === true) bag += 1;
    }
    rows.set(rowId, { degree, element, repeatOf, kind: rowKind(depths, i) });
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
 * (FX-09's separators; one inside brackets or braces does not split). Null otherwise:
 * another column, a plain or computed table, a formula, a single element.
 */
export function splitOffer(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string[] | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  const record = tableRecord(table);
  if (record.kind !== 'simple' && record.kind !== 'family') return null;
  if (setRangeColumn(record) !== colId || !record.rows.includes(rowId)) return null;
  const stored = cellsMap(table).get(cellKey(rowId, colId));
  if (stored === undefined || isFormula(stored)) return null;
  const pieces = splitSetPieces(cellText(table, rowId, colId));
  return pieces.length > 1 ? pieces : null;
}

/**
 * SET-02: Split into rows, as one undo step. The cell keeps the first element; each other
 * element gets a row of its own, at the row's depth, after the row and anything nested
 * under it, in typed order, repeats kept (they are flagged, not dropped). Returns the new
 * rows' ids, or null when the cell is not on offer (`splitOffer`).
 */
export function splitIntoRows(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): Id[] | null {
  let added = null as Id[] | null;
  gd.doc.transact(() => {
    const pieces = splitOffer(gd, tableId, rowId, colId);
    const table = tableMap(gd, tableId);
    if (pieces === null || table === null) return;
    const rows = rowsArray(table).toArray();
    const index = rows.indexOf(rowId);
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const depth = depths[index] ?? 0;
    const outlineColumn = rowMeta(table, rowId).outlineColumn;
    let after = rows[subtreeEnd(depths, index) - 1] ?? rowId;
    const [first = '', ...rest] = pieces;
    setCellText(gd, tableId, rowId, colId, first);
    added = rest.map((piece) => {
      const id = addRow(gd, tableId, after);
      const meta = rowMetaMap(table).get(id);
      if (depth > 0) meta?.set('depth', depth);
      if (outlineColumn !== null) meta?.set('outlineColumn', outlineColumn);
      setCellText(gd, tableId, id, colId, piece);
      after = id;
      return id;
    });
  }, gd.origin);
  return added;
}
