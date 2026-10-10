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
import * as Y from 'yjs';

import { encodeBound } from '../formula/bound.js';
import { valueElements, type CellValue } from '../formula/evaluate.js';
import { parse } from '../formula/parser.js';
import { dedupe, normaliseElement, splitSetPieces, splitSetSpans } from '../formula/sets.js';
import { cellFormatFor } from '../format/column.js';
import { cellValueOf } from '../format/value.js';
import { effectiveDepths, hasDescendants, parentIndex, subtreeEnd } from '../hier/outline.js';
import { cellKey, newId, type Id } from '../ids.js';
import {
  cellReadOnlyReason,
  cellsMap,
  cellText,
  isFormula,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableMap,
  tableRecord,
  textFragment,
  type ColumnRecord,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from './schema.js';
import { isSetKind, setNameKey, setRangeColumn } from './set-range.js';
import { deterministicId } from '../ref/split.js';
import { orderMembers, RowEditor } from '../ref/rows.js';
import { slice } from '../text/algebra.js';
import { cellRich } from '../text/mutations.js';
import { normalise, plainText } from '../text/types.js';
import { keepTextSpan, richToFragment } from '../text/yjs.js';
import { rowMetaFor, settleCollapsed } from './mutations.js';

export { isSetKind, setRangeColumn, setNameKey };

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

// A variable is one letter, optionally indexed (`x`, `x1`, `x_2`): `for all of them` binds
// none. A letter followed by a combining mark — a vowel sign, a virama — is the start of a
// word in an Indic script (`किताबें`, `கைகள்`), not a variable.
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
const VARIABLE = String.raw`\p{L}[\p{N}_]*(?!${WORD_CHAR})`;
// What a set builder binds before its bar: `x`, `(x, y)`, either with a domain (`x ∈ E`, `x in E`).
const BUILDER_HEAD = String.raw`(?:${VARIABLE}|\(\s*${VARIABLE}(?:\s*,\s*${VARIABLE})*\s*\))(?:\s*(?:∈|∊|\bin\b)\s*[^|∣:{}]+?)?`;
const BUILDER = new RegExp(String.raw`^\s*\{\s*${BUILDER_HEAD}\s*[|∣:]\s*\S[\s\S]*\}\s*$`, 'u');
const SYMBOL_QUANTIFIER = /[∀∃]/gu;
const SYMBOL_VARIABLE = new RegExp(String.raw`[∀∃]\s*${VARIABLE}`, 'u');
/**
 * “for all x” / “there exists x” in quantifier position: the variable is followed by what
 * notation puts after a bound variable — punctuation (`,` `:` `.` `;` `|`), a domain
 * (`∈ E`, `in E`), or `with`, `such that`, `s.t.`, `where`. Prose puts a word there:
 * “there exists a window”, “for all I know”.
 */
const WORD_QUANTIFIER = new RegExp(
  String.raw`\b(for all|there exists?)\s+(${VARIABLE})(?=\s*(?:[,:.;|∣∈∊]|(?:in|with|such that|s\.t\.|where)(?!${WORD_CHAR})))`,
  'giu',
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * “for all” / “there exists” in quantifier position (`WORD_QUANTIFIER`), binding a variable
 * that the rest of the caption goes on to use (`for all x, x is a vowel`). Prose that merely
 * contains the words — “Snacks for all ages”, “there exists a window and a door”, “for all
 * I know, I think” — is not a definition (SET-03: “—”, never a guess).
 */
function wordQuantifiers(caption: string): { index: number; universal: boolean }[] {
  const out: { index: number; universal: boolean }[] = [];
  for (const m of caption.matchAll(WORD_QUANTIFIER)) {
    const variable = m[2] ?? '';
    const rest = caption.slice(m.index + m[0].length);
    const used = new RegExp(
      String.raw`(?<!${WORD_CHAR})${escapeRegExp(variable)}(?!${WORD_CHAR})`,
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
  /** The distinct top-level members behind `cardinality`, each `e\0element` or `s\0{…}` (a set). */
  readonly members: readonly string[];
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
}

const NO_ENTRIES: RowEntries = { elements: [], entries: 0 };

/**
 * Typed text as the engine reads it (FX-09, FMT-01, FMT-05): under Automatic or Text it
 * splits on FX-09's separators; under an explicit Number, Currency or Date format a value
 * the format parses is one element in its locale-independent spelling, so a typed `1,234`
 * or `1,23,456` in a Number column is one number, never `1` and `234`. Null when the
 * text splits as typed.
 */
function formattedElement(
  table: TableMap,
  column: ColumnRecord | null,
  rowId: Id,
  text: string,
): string[] | null {
  const format = cellFormatFor(table, column, rowId);
  if (format.kind === 'auto' || format.kind === 'text') return null;
  const value = cellValueOf(text, format);
  if (value.kind !== 'number' && value.kind !== 'currency' && value.kind !== 'date') return null;
  return valueElements(value, () => []);
}

/**
 * What a row's range cell holds, read as every set formula reads it (FX-09; SET-02 “the
 * range column is an operand to every set formula”): typed text splits on FX-09's
 * separators unless its column's explicit format reads it as one value, a formula
 * contributes its evaluated value's elements, a computed row its key (one element, never
 * re-split), and a lost row (SET-12) nothing — it is no longer in the set. For a product
 * spread across columns the row's tuple is its element.
 */
function rowEntries(
  table: TableMap,
  rowId: Id,
  range: ColumnRecord | null,
  valueOf: SetCellValue | undefined,
): RowEntries {
  const meta = rowMeta(table, rowId);
  if (meta.lostFrom !== null) return NO_ENTRIES;
  if (range === null || meta.computedKey !== null) {
    const key = normaliseElement(
      range === null ? (meta.computedKey ?? '') : cellText(table, rowId, range.id),
    );
    return key === '' ? NO_ENTRIES : { elements: [key], entries: 1 };
  }
  const stored = cellsMap(table).get(cellKey(rowId, range.id));
  if (stored !== undefined && isFormula(stored)) {
    const value = valueOf?.(rowId, range.id);
    const elements = value == null ? [] : valueElements(value, () => []);
    return { elements, entries: elements.length };
  }
  const text = cellText(table, rowId, range.id);
  const formatted = formattedElement(table, range, rowId, text);
  if (formatted !== null) return { elements: formatted, entries: formatted.length };
  const pieces = splitSetPieces(text);
  return { elements: dedupe(pieces), entries: pieces.length };
}

/**
 * SET-06, FX-09: what a set row of a family is as a member — its children's elements and
 * nested sets, compared as a set (order and repeats aside), so two top-level sets named
 * alike but holding different elements are two members, and two holding the same are one.
 * The name in the range cell is a label, not the set.
 */
function memberKeys(
  depths: readonly number[],
  kinds: readonly SetRowKind[],
  read: readonly RowEntries[],
): string[] {
  const keys: string[] = new Array<string>(depths.length).fill('');
  // Last row first: every child's key is known before its parent's.
  for (let i = depths.length - 1; i >= 0; i -= 1) {
    if (kinds[i] === 'element') continue;
    const depth = depths[i] ?? 0;
    const inner = new Set<string>();
    const end = subtreeEnd(depths, i);
    for (let j = i + 1; j < end; j += 1) {
      if (depths[j] !== depth + 1) continue;
      if (kinds[j] === 'element') for (const e of read[j]?.elements ?? []) inner.add(`e\u0000${e}`);
      else inner.add(`s\u0000${keys[j] ?? ''}`);
    }
    keys[i] = `{${[...inner].sort().join('\u0001')}}`;
  }
  return keys;
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
  const range = record.columns.find((c) => c.id === rangeColId) ?? null;
  const depths = effectiveDepths(record.rows.map((rowId) => rowMeta(table, rowId).depth));
  const degrees = degreeLabels(depths);
  const read = record.rows.map((rowId) => rowEntries(table, rowId, range, valueOf));
  const kinds = record.rows.map((_rowId, i) => rowKind(depths, i));
  const members = memberKeys(depths, kinds, read);
  // SET-02: a repeat is a repeat among siblings — the same element under two different
  // parents is in two different sets.
  const firstSeen = new Map<string, string>();
  const rows = new Map<Id, SetRowFacts>();
  const topLevel = new Set<string>();
  let bag = 0;
  record.rows.forEach((rowId, i) => {
    const { elements, entries } = read[i] ?? NO_ENTRIES;
    const degree = degrees[i] ?? '';
    const depth = depths[i] ?? 0;
    const kind = kinds[i] ?? 'element';
    const parent = String(parentIndex(depths, i) ?? -1);
    // An element row is its elements; a set row is the set its children make.
    const keys =
      kind === 'element' ? elements.map((e) => `e\u0000${e}`) : [`s\u0000${members[i] ?? ''}`];
    let repeatOf: string | null = null;
    for (const key of keys) {
      const sibling = `${parent}\u0002${key}`;
      const earlier = firstSeen.get(sibling);
      if (earlier === undefined) firstSeen.set(sibling, degree);
      else if (keys.length === 1) repeatOf = earlier;
    }
    // SET-06: a top-level set is one member however many elements it holds.
    if (depth === 0) for (const key of keys) topLevel.add(key);
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
    members: [...topLevel],
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
 * element, a value its column's explicit format reads as one (`1,234` in a Number column,
 * FX-09), a read-only row (pulled from another set, SET-06 / REF-02; a split child).
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
  const text = cellText(table, rowId, colId);
  const column = record.columns.find((c) => c.id === colId) ?? null;
  if (formattedElement(table, column, rowId, text) !== null) return null;
  const pieces = splitSetPieces(text);
  return pieces.length > 1 ? pieces : null;
}

/**
 * SET-02: which split a row came from. `group` names one split of one row — derived from
 * the row and how many splits of it are already present, so two replicas that split the
 * same row at the same moment name the same group; `batch` names the one gesture that
 * wrote the row (its first new row's id), so the settle pass can tell the two apart.
 */
interface SetSplit {
  readonly group: Id;
  readonly batch: Id;
}

function readSetSplit(value: unknown): SetSplit | null {
  if (typeof value !== 'object' || value === null) return null;
  const { group, batch } = value as Record<string, unknown>;
  return typeof group === 'string' && typeof batch === 'string' && group !== '' && batch !== ''
    ? { group, batch }
    : null;
}

function splitGroupId(rowId: Id, attempt: number): Id {
  return deterministicId(`set-split~${rowId}~${String(attempt)}`);
}

/**
 * SET-02: Split into rows, as one undo step. The cell keeps the first element; each other
 * element gets a row of its own, at the row's depth, after the row and anything nested
 * under it, in typed order, repeats kept (they are flagged, not dropped). Each element keeps
 * the marks it was typed with. Returns the new rows' ids, or null when the cell is not on
 * offer (`splitOffer`).
 *
 * The cell is cut in place — the text around its first element is deleted, nothing is
 * inserted — so a collaborator's concurrent edit to the cell survives, two replicas that
 * split the same value delete the same characters, and Undo puts the characters back
 * whatever the other replica did. The new rows are fresh rows of this gesture (ids of their
 * own, so no two replicas ever write the same cell); `settleSetRows` merges two concurrent
 * splits of the same row into one row per element.
 */
export function splitIntoRows(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): Id[] | null {
  let added = null as Id[] | null;
  gd.doc.transact(() => {
    const table = tableMap(gd, tableId);
    if (table === null || splitOffer(gd, tableId, rowId, colId) === null) return;
    const rich = cellRich(table, rowId, colId);
    const spans = splitSetSpans(plainText(rich));
    const pieces = spans.map(({ start, end }) => normalise(slice(rich, start, end)));
    const [first, ...rest] = pieces;
    const firstSpan = spans[0];
    if (first === undefined || firstSpan === undefined) return;
    const rows = rowsArray(table).toArray();
    const metas = rowMetaMap(table);
    const index = rows.indexOf(rowId);
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const depth = depths[index] ?? 0;
    const outlineColumn = rowMeta(table, rowId).outlineColumn;
    const groups = new Set(rows.map((id) => readSetSplit(metas.get(id)?.get('setSplit'))?.group));
    let attempt = 0;
    while (groups.has(splitGroupId(rowId, attempt))) attempt += 1;
    const group = splitGroupId(rowId, attempt);
    const ids = rest.map(() => newId());
    const batch = ids[0] ?? '';
    const cells = cellsMap(table);
    const key = cellKey(rowId, colId);
    const stored = cells.get(key);
    if (
      !(stored instanceof Y.XmlFragment) ||
      !keepTextSpan(stored, firstSpan.start, firstSpan.end)
    ) {
      cells.set(key, richToFragment(first));
    }
    const at = subtreeEnd(depths, index);
    rowsArray(table).insert(at, ids);
    ids.forEach((id, i) => {
      const meta = rowMetaFor(table, id);
      if (depth > 0) meta.set('depth', depth);
      if (outlineColumn !== null) meta.set('outlineColumn', outlineColumn);
      meta.set('setSplit', { group, batch });
      cells.set(cellKey(id, colId), richToFragment(rest[i] ?? first));
    });
    settleCollapsed(table);
    added = ids;
  }, gd.origin);
  return added;
}

/**
 * SET-02 after a merge. Two replicas that split the same row at the same moment wrote one
 * batch of rows each under the same group (`splitIntoRows`). Keep the batch with the lower
 * id whole and, from every other batch, only the elements it adds — `a, b, c` split on one
 * replica and `a, b, c, d` on the other settle on `a, b, c, d` — then fold what is kept into
 * the surviving batch, so a later edit never re-opens the merge. A row id present twice (an
 * older document's deterministic split) keeps its first copy (`RowEditor.dedupe`). Both
 * replicas decide from the same state and delete the same items. Run for a simple set or a
 * family after a remote change; returns the rows removed, and transacts nothing when
 * nothing is to be done.
 */
export function settleSetRows(
  gd: GedeDoc,
  tableId: Id,
  origin: unknown = SET_SETTLE_ORIGIN,
): number {
  const table = tableMap(gd, tableId);
  if (table === null) return 0;
  const record = tableRecord(table);
  if (record.kind !== 'simple' && record.kind !== 'family') return 0;
  const range = setRangeColumn(record);
  const ids = rowsArray(table).toArray();
  const twice = new Set(ids).size !== ids.length;
  const metas = rowMetaMap(table);
  const groups = new Map<Id, Map<Id, Id[]>>();
  for (const id of new Set(ids)) {
    const split = readSetSplit(metas.get(id)?.get('setSplit'));
    if (split === null) continue;
    const batches = groups.get(split.group) ?? new Map<Id, Id[]>();
    batches.set(split.batch, [...(batches.get(split.batch) ?? []), id]);
    groups.set(split.group, batches);
  }
  const doomed = new Set<Id>();
  const folded: { id: Id; group: Id; batch: Id }[] = [];
  const textOf = (id: Id): string =>
    range === null ? '' : normaliseElement(cellText(table, id, range));
  for (const [group, batches] of groups) {
    if (batches.size < 2) continue;
    const [winner = '', ...others] = [...batches.keys()].sort();
    const counts = new Map<string, number>();
    for (const id of batches.get(winner) ?? [])
      counts.set(textOf(id), (counts.get(textOf(id)) ?? 0) + 1);
    for (const batch of others) {
      const seen = new Map<string, number>();
      for (const id of batches.get(batch) ?? []) {
        const text = textOf(id);
        const n = (seen.get(text) ?? 0) + 1;
        seen.set(text, n);
        if (n <= (counts.get(text) ?? 0)) doomed.add(id);
        else folded.push({ id, group, batch: winner });
      }
      for (const [text, n] of seen) counts.set(text, Math.max(counts.get(text) ?? 0, n));
    }
  }
  if (!twice && doomed.size === 0 && folded.length === 0) return 0;
  let removed = 0;
  gd.doc.transact(() => {
    const editor = new RowEditor(rowsArray(table));
    removed = editor.dedupe();
    const gone = editor.remove((id) => doomed.has(id));
    for (const id of gone) {
      metas.delete(id);
      const prefix = `${id}:`;
      const cells = cellsMap(table);
      for (const key of [...cells.keys()].filter((k) => k.startsWith(prefix))) cells.delete(key);
    }
    removed += gone.length;
    for (const { id, group, batch } of folded) metas.get(id)?.set('setSplit', { group, batch });
    settleCollapsed(table);
  }, origin);
  return removed;
}

/** Transaction origin of `settleSetRows`: never an undo step of its own. */
export const SET_SETTLE_ORIGIN = 'set-settle';

// ---------------------------------------------------------------------------
// SET-06, REF-01: a family row that references another set table through `@`.
// ---------------------------------------------------------------------------

/** Transaction origin of `reconcileSetRefs`: never an undo step (nothing a person did). */
export const SET_REF_ORIGIN = 'set-ref';

/** The set table titled `name` (titles are unique, ADR-051), other than `except`; else null. */
export function setTableNamed(gd: GedeDoc, name: string, except: Id | null = null): Id | null {
  const key = setNameKey(name);
  if (key === '') return null;
  for (const id of [...gd.tables.keys()].sort()) {
    if (id === except) continue;
    const table = gd.tables.get(id);
    if (table === undefined) continue;
    const record = tableRecord(table);
    if (isSetKind(record.kind) && setNameKey(record.title) === key) return id;
  }
  return null;
}

/**
 * SET-06, REF-01: the set tables an `@` draft can name — one segment typed (no `.`), the
 * title starting with it, any case; `except` (the table being edited) left out. Workbook
 * order (by id), as the entity index lists tables.
 */
export function setTablesMatching(
  gd: GedeDoc,
  query: string,
  except: Id | null = null,
): { readonly id: Id; readonly title: string }[] {
  const typed = query.trim().replace(/^"/, '');
  if (typed.includes('.')) return [];
  const key = setNameKey(typed);
  const out: { id: Id; title: string }[] = [];
  for (const id of [...gd.tables.keys()].sort()) {
    if (id === except) continue;
    const table = gd.tables.get(id);
    if (table === undefined) continue;
    const record = tableRecord(table);
    if (!isSetKind(record.kind) || record.title.trim() === '') continue;
    if (setNameKey(record.title).startsWith(key)) out.push({ id, title: record.title });
  }
  return out;
}

/**
 * SET-06: the set table a family row references — its range cell holds `=@E` and nothing
 * else, `E` being another set table's title. Null for any other row, and for a row the
 * family itself follows from elsewhere (one hop, as pulls are: ADR-032).
 */
export function setReferenceOf(gd: GedeDoc, tableId: Id, rowId: Id): Id | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  const record = tableRecord(table);
  if (record.kind !== 'family') return null;
  const range = setRangeColumn(record);
  if (range === null) return null;
  const meta = rowMeta(table, rowId);
  if (meta.setRefOf !== null || meta.pulledFrom !== null) return null;
  const stored = cellsMap(table).get(cellKey(rowId, range));
  if (!isFormula(stored)) return null;
  const parsed = parse(stored);
  if (!parsed.ok || parsed.value.kind !== 'list' || parsed.value.items.length !== 1) return null;
  const item = parsed.value.items[0];
  if (item?.kind !== 'entity' || item.path.length !== 1) return null;
  return setTableNamed(gd, item.path[0] ?? '', tableId);
}

interface FollowedRow {
  readonly sourceRowId: Id;
  /** Depth inside the source, effective (HIER-02). */
  readonly depth: number;
  /** What the followed row's range cell holds: the source's text, or a bound reference to its formula. */
  readonly content:
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'formula'; readonly source: string };
}

/** The rows a reference to `sourceId` follows: the source's rows in order, lost and followed rows aside. */
function followedRows(gd: GedeDoc, sourceId: Id): FollowedRow[] {
  const source = tableMap(gd, sourceId);
  if (source === null) return [];
  const record = tableRecord(source);
  const range = setRangeColumn(record);
  const metas = record.rows.map((rowId) => rowMeta(source, rowId));
  const depths = effectiveDepths(metas.map((m) => m.depth));
  const out: FollowedRow[] = [];
  const seen = new Set<Id>();
  let skipBelow: number | null = null;
  record.rows.forEach((rowId, i) => {
    const meta = metas[i];
    const depth = depths[i] ?? 0;
    if (skipBelow !== null && depth > skipBelow) return;
    skipBelow = null;
    if (meta === undefined || seen.has(rowId)) return;
    seen.add(rowId);
    // A row the source itself follows from elsewhere is not followed again (one hop), nor
    // is anything under it; a lost row is no longer in the set (SET-12).
    if (meta.setRefOf !== null || meta.lostFrom !== null) {
      skipBelow = depth;
      return;
    }
    if (range === null) {
      out.push({
        sourceRowId: rowId,
        depth,
        content: { kind: 'text', text: meta.computedKey ?? '' },
      });
      return;
    }
    const stored = cellsMap(source).get(cellKey(rowId, range));
    out.push({
      sourceRowId: rowId,
      depth,
      content: isFormula(stored)
        ? {
            kind: 'formula',
            source: `=${encodeBound({ kind: 'cell', tableId: sourceId, rowId, colId: range, spelling: 'address' })}`,
          }
        : { kind: 'text', text: cellText(source, rowId, range) },
    });
  });
  // Depths relative to the shallowest followed row, so the first one sits one under the referencing row.
  const floor = Math.min(...out.map((r) => r.depth));
  return out.map((r) => ({ ...r, depth: r.depth - floor }));
}

/** The id of the row that follows `sourceRowId` under `rowId`: the same on every replica. */
function followedRowId(rowId: Id, sourceRowId: Id): Id {
  return deterministicId(`set-ref~${rowId}~${sourceRowId}`);
}

function reconcileRefsInTransaction(gd: GedeDoc, tableId: Id): number {
  const table = tableMap(gd, tableId);
  if (table === null) return 0;
  const record = tableRecord(table);
  const range = setRangeColumn(record);
  const metas = rowMetaMap(table);
  const cells = cellsMap(table);
  const editor = new RowEditor(rowsArray(table));
  const isFollowed = (id: Id): boolean => rowMeta(table, id).setRefOf !== null;
  let writes = 0;

  // The rows every referencing row should have, in source order.
  const wanted = new Map<Id, { id: Id; row: FollowedRow; source: Id }[]>();
  const wantedSet = new Set<Id>();
  if (range !== null) {
    for (const rowId of editor.ids) {
      if (isFollowed(rowId) || wanted.has(rowId)) continue;
      const source = setReferenceOf(gd, tableId, rowId);
      if (source === null) continue;
      const children = followedRows(gd, source).map((row) => ({
        id: followedRowId(rowId, row.sourceRowId),
        row,
        source,
      }));
      wanted.set(rowId, children);
      for (const child of children) wantedSet.add(child.id);
    }
  }

  // Minimal diff (see ref/rows.ts): dedupe, delete, insert, then reorder.
  editor.dedupe();
  const removed = editor.remove((id) => isFollowed(id) && !wantedSet.has(id));
  for (const id of removed) {
    metas.delete(id);
    const prefix = `${id}:`;
    for (const key of [...cells.keys()].filter((k) => k.startsWith(prefix))) cells.delete(key);
  }
  for (const [parentId, children] of wanted) {
    const ids = children.map((c) => c.id);
    ids.forEach((id, i) => {
      if (editor.has(id)) return;
      let anchor = editor.indexOf(parentId);
      for (let j = i - 1; j >= 0; j -= 1) {
        const sibling = editor.indexOf(ids[j] ?? '');
        if (sibling >= 0) {
          anchor = sibling;
          break;
        }
      }
      editor.insertAt(anchor + 1, id);
    });
    // Followed rows directly behind the referencing row, in source order.
    orderMembers(editor, [parentId, ...ids]);
    const parentAt = editor.indexOf(parentId);
    ids.forEach((id, i) => {
      if (editor.ids[parentAt + 1 + i] !== id) editor.move(id, parentAt + 1 + i);
    });
  }
  writes += removed.length + editor.writes;
  if (range === null || wanted.size === 0) return writes;

  // Depth, provenance and text, walking the rows in order so each referencing row's
  // effective depth (HIER-02) is read after everything above it is settled.
  const followers = new Map<Id, { parent: Id; row: FollowedRow; source: Id }>();
  for (const [parent, children] of wanted) {
    for (const child of children)
      followers.set(child.id, { parent, row: child.row, source: child.source });
  }
  const parentDepth = new Map<Id, number>();
  let previous = -1;
  for (const id of editor.ids) {
    const follower = followers.get(id);
    if (follower === undefined) {
      const stored = rowMeta(table, id).depth;
      previous = Math.min(stored, previous + 1);
      parentDepth.set(id, previous);
      continue;
    }
    const want = (parentDepth.get(follower.parent) ?? 0) + 1 + follower.row.depth;
    const meta = rowMetaFor(table, id);
    if (rowMeta(table, id).depth !== want) {
      meta.set('depth', want);
      writes += 1;
    }
    previous = want;
    const provenance = rowMeta(table, id).setRefOf;
    if (provenance?.rowId !== follower.parent || provenance.tableId !== follower.source) {
      meta.set('setRefOf', { rowId: follower.parent, tableId: follower.source });
      writes += 1;
    }
    const key = cellKey(id, range);
    const current = cells.get(key);
    const { content } = follower.row;
    if (content.kind === 'formula') {
      if (current !== content.source) {
        cells.set(key, content.source);
        writes += 1;
      }
    } else if (
      current === undefined ||
      isFormula(current) ||
      cellText(table, id, range) !== content.text
    ) {
      if (content.text === '') {
        if (current !== undefined) cells.delete(key);
      } else {
        cells.set(key, textFragment(content.text));
      }
      writes += 1;
    }
  }
  if (writes > 0) settleCollapsed(table);
  return writes;
}

/** Whether a table may need the `@` reconcile: a family, or a table holding followed rows. */
function mayFollow(table: TableMap): boolean {
  const record = tableRecord(table);
  if (record.kind === 'family') return true;
  return [...rowMetaMap(table).values()].some((meta) => meta.get('setRefOf') !== undefined);
}

/**
 * SET-06, REF-01: bring a family's followed rows in line with its `@` references — for each
 * row whose range cell is `=@E`, E's rows sit directly under it, one level deeper, in E's
 * order, read-only, their text following E's. Idempotent, deterministic (a followed row's
 * id derives from the referencing row and the source row) and a minimal diff (ref/rows.ts),
 * so two replicas reconciling at once converge and a settled one writes nothing. Under
 * `SET_REF_ORIGIN` by default, untracked by undo: undoing the `@` removes the rows on the
 * next reconcile. Returns the number of writes; transacts only when there is a table.
 */
export function reconcileSetRefs(
  gd: GedeDoc,
  tableId: Id,
  origin: unknown = SET_REF_ORIGIN,
): number {
  const table = tableMap(gd, tableId);
  if (table === null || !mayFollow(table)) return 0;
  let writes = 0;
  gd.doc.transact(() => {
    writes = reconcileRefsInTransaction(gd, tableId);
  }, origin);
  return writes;
}

/** Every family's `@` references, repeated while a pass moves something (bounded). */
export function reconcileAllSetRefs(gd: GedeDoc, origin: unknown = SET_REF_ORIGIN): number {
  let total = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    let writes = 0;
    for (const tableId of [...gd.tables.keys()].sort()) {
      writes += reconcileSetRefs(gd, tableId, origin);
    }
    total += writes;
    if (writes === 0) break;
  }
  return total;
}

/**
 * Keep every family's `@` references reconciled while a document is open for editing: once
 * on install, then after every transaction but its own (a source edit, a remote update, an
 * undo). Returns the unsubscribe.
 */
export function observeSetRefs(gd: GedeDoc): () => void {
  let active = false;
  const run = (): void => {
    if (active) return;
    active = true;
    try {
      reconcileAllSetRefs(gd);
    } finally {
      active = false;
    }
  };
  const handler = (_events: unknown, transaction: Y.Transaction): void => {
    if (transaction.origin === SET_REF_ORIGIN) return;
    run();
  };
  run();
  gd.tables.observeDeep(handler);
  return () => {
    gd.tables.unobserveDeep(handler);
  };
}
