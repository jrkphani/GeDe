/**
 * The values around a sheet's set tables (SET-13..16; ADR-056, SPEC §3): the universal set U,
 * the super set array, a section's summary and the sheet's. Pure functions of the sets'
 * facts, recomputed when the sets change; nothing here is stored or typed, so none of it has
 * a row id to converge (SPEC §3: rendered tables with no Yjs content).
 */
import type { Id } from '../ids.js';
import { isSetKind } from './set-range.js';
import { listSections, sectionAtColumn, type SectionRecord } from './sections.js';
import { tableMap, tablesOnSheet, type GedeDoc, type TableKind } from './schema.js';
import {
  setTableFacts,
  type SetCellValue,
  type SetTableFacts,
  type SpecialStatus,
} from './set-table.js';

/** SPEC §7 v1 default 3: the intersection, union and difference columns need n³ work, so they stop here. */
export const SUMMARY_ALGEBRA_LIMIT = 30;

/** One set table as the summaries read it. */
export interface SummarySet {
  readonly id: Id;
  /** The table's title, the set's name. */
  readonly name: string;
  /** The table's caption, the set's definition (SET-04). */
  readonly definition: string;
  readonly kind: TableKind;
  readonly facts: SetTableFacts;
  /** The section holding the table's anchor column, or null. */
  readonly sectionId: Id | null;
}

/**
 * The sheet's set tables in sheet order (the order `@E` and U read them), each with its facts
 * — a formula range cell counting the value `valueOf(tableId)` answers for it.
 */
export function summarySets(
  gd: GedeDoc,
  sheetId: Id,
  valueOf?: (tableId: Id) => SetCellValue | undefined,
): SummarySet[] {
  const sections = listSections(gd, sheetId);
  const out: SummarySet[] = [];
  for (const record of tablesOnSheet(gd, sheetId)) {
    const table = tableMap(gd, record.id);
    if (table === null || !isSetKind(record.kind)) continue;
    const facts = setTableFacts(table, record, valueOf?.(record.id));
    if (facts === null) continue;
    out.push({
      id: record.id,
      name: record.title,
      definition: record.look.caption,
      kind: record.kind,
      facts,
      sectionId: sectionAtColumn(sections, record.gridCol)?.id ?? null,
    });
  }
  return out;
}

/**
 * SET-13: every distinct element of every set, once, in first-seen order — sets in sheet
 * order, then row order. An element is a row that holds no children; a set or family row is
 * a set, not an element.
 */
export function universalSet(sets: readonly SummarySet[]): string[] {
  const seen = new Set<string>();
  for (const set of sets) {
    for (const row of set.facts.rows.values()) {
      if (row.kind === 'element') for (const e of row.elements) seen.add(e);
    }
  }
  return [...seen];
}

/** SET-14: the elements of U and the set names, which the array draws apart in words. */
export function superSetArray(sets: readonly SummarySet[]): {
  readonly elements: readonly string[];
  readonly sets: readonly string[];
} {
  return { elements: universalSet(sets), sets: sets.map((s) => s.name) };
}

export interface SummaryRow {
  readonly id: Id;
  readonly name: string;
  readonly definition: string;
  readonly cardinality: number;
  readonly bag: number;
  readonly status: SpecialStatus | null;
  /** Names of the section's other sets; empty means GeDe checked and found none (“—”). */
  readonly equal: readonly string[];
  readonly improperSubsetOf: readonly string[];
  readonly properSubsetOf: readonly string[];
  readonly elementOf: readonly string[];
  /** Pairs `B ∩ C`, `B ∪ C`, `B − C` equal to the set; null when the section is over the limit. */
  readonly intersection: readonly string[] | null;
  readonly union: readonly string[] | null;
  readonly difference: readonly string[] | null;
}

export interface SectionSummary {
  readonly setCount: number;
  readonly elementCount: number;
  /** False when the section has more sets than `SUMMARY_ALGEBRA_LIMIT`: the three pair columns are null. */
  readonly algebra: boolean;
  readonly rows: readonly SummaryRow[];
}

/** A set as another set's member: `{…}` over its own members, the form `memberKeys` gives a set row. */
function setKey(members: readonly string[]): string {
  return `{${[...members].sort().join('\u0001')}}`;
}

const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].every((m) => b.has(m));

/**
 * SET-15: the summary of the sets of one section — equality, ⊆ and ⊂ pairwise, ∈ against the
 * section's families, and the pairs whose intersection, union or difference equals each set.
 * A pair never includes the set it is compared to (`E ∩ C = E` says nothing about E).
 */
export function sectionSummary(sets: readonly SummarySet[]): SectionSummary {
  const members = sets.map((s) => new Set(s.facts.members));
  const keys = sets.map((s) => `s\u0000${setKey(s.facts.members)}`);
  const algebra = sets.length <= SUMMARY_ALGEBRA_LIMIT;
  const names = (indexes: readonly number[]): string[] => indexes.map((j) => sets[j]?.name ?? '');
  const others = (i: number, test: (j: number) => boolean): string[] =>
    names(sets.map((_s, j) => j).filter((j) => j !== i && test(j)));
  const equals = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && subset(a, b);
  const pairs = (
    i: number,
    join: (b: ReadonlySet<string>, c: ReadonlySet<string>) => Set<string>,
    sign: string,
    ordered: boolean,
  ) => {
    const found: string[] = [];
    for (let b = 0; b < sets.length; b += 1) {
      for (let c = ordered ? 0 : b + 1; c < sets.length; c += 1) {
        if (b === c || b === i || c === i) continue;
        const mb = members[b];
        const mc = members[c];
        const target = members[i];
        if (mb && mc && target && equals(join(mb, mc), target)) {
          found.push(`${sets[b]?.name ?? ''} ${sign} ${sets[c]?.name ?? ''}`);
        }
      }
    }
    return found;
  };
  const rows = sets.map((set, i): SummaryRow => {
    const mine = members[i] ?? new Set<string>();
    return {
      id: set.id,
      name: set.name,
      definition: set.definition,
      cardinality: set.facts.cardinality,
      bag: set.facts.bag,
      status: set.facts.status,
      equal: others(i, (j) => equals(mine, members[j] ?? new Set())),
      improperSubsetOf: others(i, (j) => subset(mine, members[j] ?? new Set())),
      properSubsetOf: others(i, (j) => {
        const other = members[j] ?? new Set<string>();
        return subset(mine, other) && other.size > mine.size;
      }),
      elementOf: others(i, (j) => members[j]?.has(keys[i] ?? '') === true),
      intersection: algebra
        ? pairs(i, (b, c) => new Set([...b].filter((m) => c.has(m))), '∩', false)
        : null,
      union: algebra ? pairs(i, (b, c) => new Set([...b, ...c]), '∪', false) : null,
      difference: algebra
        ? pairs(i, (b, c) => new Set([...b].filter((m) => !c.has(m))), '−', true)
        : null,
    };
  });
  return {
    setCount: sets.length,
    elementCount: universalSet(sets).length,
    algebra,
    rows,
  };
}

export interface SheetSummaryRow {
  readonly sectionId: Id;
  readonly name: string;
  readonly setCount: number;
  readonly elementCount: number;
}

/** SET-16: each section with its set count and distinct element count. */
export function sheetSummary(
  sections: readonly SectionRecord[],
  sets: readonly SummarySet[],
): SheetSummaryRow[] {
  return sections.map((section) => {
    const inSection = sets.filter((s) => s.sectionId === section.id);
    return {
      sectionId: section.id,
      name: section.name,
      setCount: inSection.length,
      elementCount: universalSet(inSection).length,
    };
  });
}

/** A rectangle of the lattice, in units. */
export interface BandBlock {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

export interface StructureLayout {
  /** Each section's summary, under the section's lane. */
  readonly sections: readonly { readonly sectionId: Id; readonly block: BandBlock }[];
  readonly sheetSummary: BandBlock;
  readonly universe: BandBlock;
  readonly superSet: BandBlock;
  /** The first row below everything the structure draws. */
  readonly end: number;
}

/** Title row, counts row and header row of a summary table; a list block has the first two. */
export const SUMMARY_HEAD_ROWS = 3;
const LIST_HEAD_ROWS = 2;
const MIN_BAND_COLUMNS = 6;
const DEFAULT_BAND_COLUMNS = 12;

/**
 * Where the summaries, U and the super set array sit (SPEC §3): in a band below `top`, the
 * first row under the sheet's tables. A section's summary sits under its lane, as wide as the
 * lane; the sheet's three blocks follow, as wide as the lanes together, each a row apart. All
 * sizes follow from counts, so the shell can reserve the band before it is drawn. Null when
 * the sheet has neither a section nor a set.
 */
export function structureLayout(
  top: number,
  sections: readonly SectionRecord[],
  sets: readonly SummarySet[],
): StructureLayout | null {
  if (sections.length === 0 && sets.length === 0) return null;
  const left = sections[0]?.firstColumn ?? 0;
  const right = sections.at(-1)?.lastColumn ?? left + DEFAULT_BAND_COLUMNS - 1;
  const width = Math.max(MIN_BAND_COLUMNS, right - left + 1);
  const sectionBlocks = sections.map((section) => {
    const inSection = sets.filter((s) => s.sectionId === section.id).length;
    const algebraNote = inSection > SUMMARY_ALGEBRA_LIMIT ? 1 : 0;
    return {
      sectionId: section.id,
      block: {
        col: section.firstColumn,
        row: top,
        cols: section.lastColumn - section.firstColumn + 1,
        // Title, counts, header, one row per set, then the note on “—” (and on the limit).
        rows: SUMMARY_HEAD_ROWS + inSection + 1 + algebraNote,
      },
    };
  });
  const sectionRows = Math.max(0, ...sectionBlocks.map((b) => b.block.rows));
  const sheetTop = top + (sectionRows === 0 ? 0 : sectionRows + 1);
  const sheetSummary = {
    col: left,
    row: sheetTop,
    cols: width,
    rows: SUMMARY_HEAD_ROWS + sections.length,
  };
  const elements = universalSet(sets).length;
  const universe = {
    col: left,
    row: sheetSummary.row + sheetSummary.rows + 1,
    cols: width,
    // Title, counts, one row of chips per `width` elements, then the line saying how to use U.
    rows: LIST_HEAD_ROWS + Math.max(1, Math.ceil(elements / width)) + 1,
  };
  const superSet = {
    col: left,
    row: universe.row + universe.rows + 1,
    cols: width,
    rows: LIST_HEAD_ROWS + Math.max(1, Math.ceil((elements + sets.length) / width)),
  };
  return {
    sections: sectionBlocks,
    sheetSummary,
    universe,
    superSet,
    end: superSet.row + superSet.rows,
  };
}
