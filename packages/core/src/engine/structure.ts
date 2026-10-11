/**
 * The tables a sheet's structure draws (SET-13..16; ADR-056, SPEC §3): U, the super set
 * array, each section's summary and the sheet's summary, as read-only tables on the lattice.
 *
 * They are projections: nothing is stored, typed or given a Yjs row. `structureTables` reads
 * the sheet's set tables and sections and answers plain table snapshots at lattice positions
 * under the sheet's own tables; the same snapshots feed the engine (`structureSync`, so an
 * A1 address, `@U` or a range reads them like any table) and the renderer, which is why the
 * two cannot disagree. A snapshot is `structure: true`: it takes the formula engine's
 * workbook but is never a document table. Cells hold plain text (numbers as ASCII digits)
 * so a formula can read them whatever the locale; the words come from `StructureLabels`.
 */
import type { UnitBounds } from '../doc/geometry.js';
import { sheetBounds } from '../doc/geometry.js';
import { listSections, pinStructureRow, structureRowOf } from '../doc/sections.js';
import { listSheets, TABLE_HEADER_ROWS, TABLE_TITLE_ROWS, type GedeDoc } from '../doc/schema.js';
import {
  sectionSummary,
  sheetSummary,
  summarySets,
  superSetArray,
  universalSet,
  type SummaryRow,
  type SummarySet,
} from '../doc/sheet-sets.js';
import type { SetCellValue } from '../doc/set-table.js';
import { cellKey, type CellKey, type Id } from '../ids.js';
import type { CellSnapshot, TableSnapshot, WorkbookChange } from './types.js';

export type StructureKind = 'section' | 'sheet' | 'universe' | 'super';

/** The section summary's columns, left to right (SET-15); the labels come from the catalogue. */
export const SUMMARY_COLUMNS = [
  'id',
  'name',
  'definition',
  'cardinality',
  'status',
  'equal',
  'improper',
  'proper',
  'elementOf',
  'intersection',
  'union',
  'difference',
] as const;
export type SummaryColumn = (typeof SUMMARY_COLUMNS)[number];

/** Lattice units each section-summary column spans. */
const SUMMARY_WIDTHS: Readonly<Record<SummaryColumn, number>> = {
  id: 1,
  name: 1,
  definition: 2,
  cardinality: 1,
  status: 1,
  equal: 2,
  improper: 2,
  proper: 2,
  elementOf: 2,
  intersection: 2,
  union: 2,
  difference: 2,
};

/** The words the tables are written in; the active locale's, from the app. */
export interface StructureLabels {
  /** The universal set's title: the name `@U` reads. */
  readonly universe: string;
  readonly superSet: string;
  readonly sheetSummary: string;
  /** A section summary's title: `1° Foundation`. */
  readonly sectionTitle: (ordinal: number, name: string) => string;
  readonly summaryColumns: Readonly<Record<SummaryColumn, string>>;
  readonly sheetColumns: {
    readonly section: string;
    readonly sets: string;
    readonly elements: string;
  };
  readonly superColumns: { readonly member: string; readonly kind: string };
  /** The super set array's kind words. */
  readonly element: string;
  readonly set: string;
  readonly specialNull: string;
  readonly specialSingleton: string;
  /** SET-15: “—”, checked and found none. */
  readonly none: string;
  readonly bag: (count: number) => string;
}

export interface StructureTable {
  readonly kind: StructureKind;
  readonly sectionId: Id | null;
  /** The section's place among the sheet's, from 1; null for the sheet's own tables. */
  readonly ordinal: number | null;
  /** Sets, distinct elements and sections the table counts, for its title bar. */
  readonly sets: number;
  readonly elements: number;
  readonly sections: number;
  /** SPEC §7 v1 default 3: the three pair columns read “—” above the limit. */
  readonly algebra: boolean;
  readonly bounds: UnitBounds;
  readonly table: TableSnapshot;
}

/**
 * Rows left clear under the sheet's tables when the structure rows are pinned, so tables added
 * below them later do not land on the pinned rows (the pin is a stored row, SET-13).
 */
const PIN_HEADROOM_ROWS = 24;

/**
 * SET-13..16, ADR-056: every structure table starts on the pinned row, each in its own fixed
 * block of lattice columns, so a top-left address never depends on content. U, the super set
 * array and the sheet summary come first (a column apart); section summaries follow to the right,
 * one block each, in the order their ids (ULIDs) were made.
 */
const GAP_COLS = 1;
const UNIVERSE_COL = 0;
const SUPER_COL = UNIVERSE_COL + 2 + GAP_COLS;
const SHEET_COL = SUPER_COL + 3 + GAP_COLS;
const SECTIONS_COL = SHEET_COL + 4 + GAP_COLS;
const SECTION_BLOCK = Object.values(SUMMARY_WIDTHS).reduce((a, b) => a + b, 0) + GAP_COLS;

interface Spec {
  readonly kind: StructureKind;
  readonly id: Id;
  readonly title: string;
  readonly widths: readonly number[];
  readonly labels: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function snapshot(
  sheetId: Id,
  spec: Spec,
  at: { col: number; row: number },
): { table: TableSnapshot; bounds: UnitBounds } {
  const colIds = spec.widths.map((_w, i) => `c${String(i)}`);
  const rowIds = spec.rows.map((_r, i) => `r${String(i)}`);
  const cells: Record<CellKey, CellSnapshot> = {};
  spec.rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (text !== '') cells[cellKey(rowIds[r] ?? '', colIds[c] ?? '')] = { kind: 'text', text };
    });
  });
  const first = colIds[0] ?? '';
  const table: TableSnapshot = {
    id: spec.id,
    sheetId,
    title: spec.title,
    gridCol: at.col,
    gridRow: at.row,
    columns: colIds.map((id, i) => ({
      id,
      label: spec.labels[i] ?? '',
      width: spec.widths[i] ?? 1,
    })),
    // The first column is the set `@Title` names (REF-01), so `@U` reads U's elements.
    setRange: first,
    structure: true,
    rows: rowIds,
    rowHeights: rowIds.map(() => 1),
    rowDepths: rowIds.map(() => 0),
    rowOutlineColumns: rowIds.map(() => first),
    cells,
  };
  return {
    table,
    bounds: {
      col: at.col,
      row: at.row,
      cols: spec.widths.reduce((a, b) => a + b, 0),
      rows: TABLE_TITLE_ROWS + TABLE_HEADER_ROWS + rowIds.length,
    },
  };
}

function names(list: readonly string[] | null, labels: StructureLabels): string {
  return list === null || list.length === 0 ? labels.none : list.join(', ');
}

function summaryCells(row: SummaryRow, labels: StructureLabels): string[] {
  const status =
    row.status === null
      ? labels.none
      : row.status === 'null'
        ? labels.specialNull
        : labels.specialSingleton;
  return [
    row.id.slice(0, 10),
    row.name,
    row.definition === '' ? labels.none : row.definition,
    row.bag === row.cardinality
      ? String(row.cardinality)
      : `${String(row.cardinality)} · ${labels.bag(row.bag)}`,
    status,
    names(row.equal, labels),
    names(row.improperSubsetOf, labels),
    names(row.properSubsetOf, labels),
    names(row.elementOf, labels),
    names(row.intersection, labels),
    names(row.union, labels),
    names(row.difference, labels),
  ];
}

/**
 * Every structure table of one sheet, side by side from the sheet's pinned structure row (a clear
 * band under its own tables until `structureSync` pins it), each in a fixed block of columns: a summary per section, the
 * sheet summary, U and the super set array. Empty for a sheet with neither a set nor a
 * section. `valueOf` answers a formula range cell with the value the engine evaluated
 * (SET-02), as `summarySets` takes it.
 */
export function structureTables(
  gd: GedeDoc,
  sheetId: Id,
  labels: StructureLabels,
  valueOf?: (tableId: Id) => SetCellValue | undefined,
): StructureTable[] {
  const sections = listSections(gd, sheetId);
  const sets: readonly SummarySet[] = summarySets(gd, sheetId, valueOf);
  if (sections.length === 0 && sets.length === 0) return [];
  const bounds = sheetBounds(gd, sheetId);
  const row =
    structureRowOf(gd, sheetId) ??
    (bounds === null ? 1 : bounds.row + bounds.rows + 1) + PIN_HEADROOM_ROWS;
  const universe = universalSet(sets);
  const out: StructureTable[] = [];
  const add = (
    col: number,
    spec: Spec,
    extra: Pick<StructureTable, 'sectionId' | 'ordinal' | 'sets' | 'elements' | 'sections'> & {
      algebra?: boolean;
    },
  ): void => {
    const { table, bounds: box } = snapshot(sheetId, spec, { col, row });
    out.push({ kind: spec.kind, algebra: true, ...extra, bounds: box, table });
  };
  const slots = sections.map((s) => s.id).sort();
  sections.forEach((section, i) => {
    const inSection = sets.filter((s) => s.sectionId === section.id);
    const summary = sectionSummary(inSection);
    add(
      SECTIONS_COL + slots.indexOf(section.id) * SECTION_BLOCK,
      {
        kind: 'section',
        id: `structure.${sheetId}.section.${section.id}`,
        title: labels.sectionTitle(i + 1, section.name),
        widths: SUMMARY_COLUMNS.map((c) => SUMMARY_WIDTHS[c]),
        labels: SUMMARY_COLUMNS.map((c) => labels.summaryColumns[c]),
        rows: summary.rows.map((r) => summaryCells(r, labels)),
      },
      {
        sectionId: section.id,
        ordinal: i + 1,
        sets: summary.setCount,
        elements: summary.elementCount,
        sections: 0,
        algebra: summary.algebra,
      },
    );
  });
  add(
    SHEET_COL,
    {
      kind: 'sheet',
      id: `structure.${sheetId}.sheet`,
      title: labels.sheetSummary,
      widths: [2, 1, 1],
      labels: [labels.sheetColumns.section, labels.sheetColumns.sets, labels.sheetColumns.elements],
      rows: sheetSummary(sections, sets).map((r, i) => [
        `${String(i + 1)}° ${r.name}`,
        String(r.setCount),
        String(r.elementCount),
      ]),
    },
    {
      sectionId: null,
      ordinal: null,
      sets: sets.length,
      elements: universe.length,
      sections: sections.length,
    },
  );
  add(
    UNIVERSE_COL,
    {
      kind: 'universe',
      id: `structure.${sheetId}.universe`,
      title: labels.universe,
      widths: [2],
      labels: [labels.universe],
      rows: universe.map((e) => [e]),
    },
    {
      sectionId: null,
      ordinal: null,
      sets: sets.length,
      elements: universe.length,
      sections: sections.length,
    },
  );
  const superSet = superSetArray(sets);
  add(
    SUPER_COL,
    {
      kind: 'super',
      id: `structure.${sheetId}.super`,
      title: labels.superSet,
      widths: [2, 1],
      labels: [labels.superColumns.member, labels.superColumns.kind],
      rows: [
        ...superSet.elements.map((e) => [e, labels.element]),
        ...superSet.sets.map((s) => [s, labels.set]),
      ],
    },
    {
      sectionId: null,
      ordinal: null,
      sets: sets.length,
      elements: universe.length,
      sections: sections.length,
    },
  );
  return out;
}

/** What the engine was last told about each structure table, to send only what moved. */
export interface StructureSync {
  /** The tables as last computed; read by the renderer. */
  tables(sheetId: Id): readonly StructureTable[];
  /** Recompute from the document and the engine's results; the changes since the last call. */
  next(valueOf: (tableId: Id) => SetCellValue | undefined): WorkbookChange[];
  /** Forget what the engine knows: the next `next` sends every table (after a reset). */
  reset(): void;
}

/** A table's identity for change detection: its structure and cells, serialised. */
const signature = (t: TableSnapshot): string => JSON.stringify(t);

/**
 * Keep the engine's copy of the structure tables current. `next` recomputes every sheet's
 * tables and answers the `table` / `cells` / `table-removed` changes that bring the engine
 * from what it was told last to what they are now; nothing when they did not move, which is
 * what ends the loop of a result changing a table changing a result.
 */
export function structureSync(gd: GedeDoc, labels: () => StructureLabels): StructureSync {
  let sent = new Map<Id, TableSnapshot>();
  let current = new Map<Id, StructureTable[]>();
  return {
    tables: (sheetId) => current.get(sheetId) ?? [],
    reset: () => {
      sent = new Map();
    },
    next: (valueOf) => {
      const words = labels();
      const now = new Map<Id, StructureTable[]>();
      for (const sheet of listSheets(gd)) {
        const tables = structureTables(gd, sheet.id, words, valueOf);
        const first = tables[0];
        if (first === undefined) continue;
        // shortcut: pinned by whichever replica sees the tables first, a viewer's write is
        // refused by the service; when that shows, pin on the sheet's creation instead.
        if (structureRowOf(gd, sheet.id) === null) pinStructureRow(gd, sheet.id, first.bounds.row);
        now.set(sheet.id, tables);
      }
      current = now;
      const changes: WorkbookChange[] = [];
      const live = new Set<Id>();
      for (const tables of now.values()) {
        for (const { table } of tables) {
          live.add(table.id);
          const before = sent.get(table.id);
          if (before !== undefined && signature(before) === signature(table)) continue;
          const { cells, ...structure } = table;
          changes.push({ type: 'table', table: structure });
          const moved: Record<CellKey, CellSnapshot | null> = {};
          for (const [key, cell] of Object.entries(cells) as [CellKey, CellSnapshot][]) {
            if (JSON.stringify(before?.cells[key]) !== JSON.stringify(cell)) moved[key] = cell;
          }
          // A cell the engine holds that the table no longer has is cleared, not left stale.
          for (const key of Object.keys(before?.cells ?? {}) as CellKey[]) {
            if (!(key in cells)) moved[key] = null;
          }
          if (Object.keys(moved).length > 0) {
            changes.push({ type: 'cells', tableId: table.id, cells: moved });
          }
          sent.set(table.id, table);
        }
      }
      for (const id of [...sent.keys()]) {
        if (live.has(id)) continue;
        changes.push({ type: 'table-removed', tableId: id });
        sent.delete(id);
      }
      return changes;
    },
  };
}
