/**
 * Sections and lock (SET-17, SET-18; ADR-056, SPEC §4).
 *
 * A section is a named lane on a sheet between two lattice column edges; lock is a flag on a
 * section or on the whole sheet. Both live on the sheet's map, so no table, row or address
 * is touched (SET-17: sections never change an A1 address): `locked` on the sheet, and one
 * `section:<id>` key per section holding its own `Y.Map` — created once by its author, so
 * two replicas adding sections at once never replace each other, and a rename and a lock
 * made apart both survive the merge.
 */
import * as Y from 'yjs';

import { newId, type Id } from '../ids.js';
import { readBoolean, readNumber, readString, type GedeDoc, type SheetMap } from './schema.js';

export const SECTION_PREFIX = 'section:';

/** One empty lattice column separates two sections (SET-17). */
export const SECTION_GUTTER = 1;
/** The last lattice column a section may reach (a range beyond it is refused, not stored). */
export const MAX_SECTION_COLUMN = 16383;
/** Lattice columns a new section spans when the caller names none. */
export const DEFAULT_SECTION_COLUMNS = 6;

export interface SectionRecord {
  readonly id: Id;
  readonly name: string;
  /** First and last lattice column the lane spans, inclusive. */
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly locked: boolean;
}

/** Why an edit is stopped (SET-18). The sheet's lock is named first: it covers every section. */
export type LockReason = 'sheet' | 'section';

function sheetMapOf(gd: GedeDoc, sheetId: Id): SheetMap | null {
  return gd.sheets.toArray().find((s) => readString(s, 'id') === sheetId) ?? null;
}

function sectionMapOf(sheet: SheetMap, sectionId: Id): Y.Map<unknown> | null {
  const value = sheet.get(`${SECTION_PREFIX}${sectionId}`);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

function readSection(id: Id, map: Y.Map<unknown>): SectionRecord | null {
  const firstColumn = readNumber(map, 'firstColumn', Number.NaN);
  const lastColumn = readNumber(map, 'lastColumn', Number.NaN);
  if (!Number.isInteger(firstColumn) || !Number.isInteger(lastColumn) || lastColumn < firstColumn) {
    return null;
  }
  return {
    id,
    name: readString(map, 'name'),
    firstColumn,
    lastColumn,
    locked: readBoolean(map, 'locked', false),
  };
}

/** The sheet's sections left to right (a malformed one reads as absent). */
export function listSections(gd: GedeDoc, sheetId: Id): SectionRecord[] {
  const sheet = sheetMapOf(gd, sheetId);
  if (sheet === null) return [];
  const out: SectionRecord[] = [];
  sheet.forEach((value, key) => {
    if (!key.startsWith(SECTION_PREFIX) || !(value instanceof Y.Map)) return;
    const record = readSection(key.slice(SECTION_PREFIX.length), value as Y.Map<unknown>);
    if (record !== null) out.push(record);
  });
  return out.sort((a, b) => a.firstColumn - b.firstColumn || (a.id < b.id ? -1 : 1));
}

export function sectionAtColumn(
  sections: readonly SectionRecord[],
  col: number,
): SectionRecord | null {
  return sections.find((s) => col >= s.firstColumn && col <= s.lastColumn) ?? null;
}

export function isSheetLocked(gd: GedeDoc, sheetId: Id): boolean {
  const sheet = sheetMapOf(gd, sheetId);
  return sheet !== null && readBoolean(sheet, 'locked', false);
}

/**
 * SET-18: what stops an edit at lattice column `col` of the sheet, or null. Read on every cell
 * write and every Find index entry, so it reads the sheet's keys once and builds nothing.
 */
export function lockReasonAt(gd: GedeDoc, sheetId: Id, col: number): LockReason | null {
  const sheet = sheetMapOf(gd, sheetId);
  if (sheet === null) return null;
  if (readBoolean(sheet, 'locked', false)) return 'sheet';
  for (const [key, value] of sheet.entries()) {
    if (!key.startsWith(SECTION_PREFIX) || !(value instanceof Y.Map)) continue;
    const map = value as Y.Map<unknown>;
    if (
      readBoolean(map, 'locked', false) &&
      col >= readNumber(map, 'firstColumn', Number.NaN) &&
      col <= readNumber(map, 'lastColumn', Number.NaN)
    ) {
      return 'section';
    }
  }
  return null;
}

/** SET-17: a table belongs to the section holding its anchor column. */
export function sectionOfTable(gd: GedeDoc, tableId: Id): SectionRecord | null {
  const table = gd.tables.get(tableId);
  if (table === undefined) return null;
  return sectionAtColumn(
    listSections(gd, readString(table, 'sheetId')),
    readNumber(table, 'gridCol', 0),
  );
}

/** SET-18: what stops an edit of the table, or null. */
export function lockReasonOfTable(gd: GedeDoc, tableId: Id): LockReason | null {
  const table = gd.tables.get(tableId);
  if (table === undefined) return null;
  return lockReasonAt(gd, readString(table, 'sheetId'), readNumber(table, 'gridCol', 0));
}

/** Whether any sheet or section is locked: the sync service checks nothing else on a document without one. */
export function anyLock(gd: GedeDoc): boolean {
  return gd.sheets.toArray().some(sheetHasLock);
}

/** Whether the sheet, or any of its sections, is locked. */
export function sheetHasLock(sheet: SheetMap): boolean {
  if (readBoolean(sheet, 'locked', false)) return true;
  let found = false;
  sheet.forEach((value, key) => {
    if (key.startsWith(SECTION_PREFIX) && value instanceof Y.Map) {
      found ||= readBoolean(value as Y.Map<unknown>, 'locked', false);
    }
  });
  return found;
}

/** SET-18: why the section cannot change, or null: its own lock, else the sheet's. */
export function sectionLockReason(gd: GedeDoc, sheetId: Id, sectionId: Id): LockReason | null {
  if (isSheetLocked(gd, sheetId)) return 'sheet';
  return listSections(gd, sheetId).find((s) => s.id === sectionId)?.locked === true
    ? 'section'
    : null;
}

/** Whether `[first, last]` fits among `sections` with the gutter on both sides. */
function fits(
  sections: readonly SectionRecord[],
  first: number,
  last: number,
  except: Id | null,
): boolean {
  return sections.every(
    (s) =>
      s.id === except ||
      first >= s.lastColumn + 1 + SECTION_GUTTER ||
      last <= s.firstColumn - 1 - SECTION_GUTTER,
  );
}

/** The range for a new section: after the last one, a gutter away (the sheet's column 0 when none). */
export function nextSectionRange(
  gd: GedeDoc,
  sheetId: Id,
  columns: number = DEFAULT_SECTION_COLUMNS,
): { firstColumn: number; lastColumn: number } {
  const last = listSections(gd, sheetId).at(-1);
  const firstColumn = last === undefined ? 0 : last.lastColumn + 1 + SECTION_GUTTER;
  return { firstColumn, lastColumn: firstColumn + Math.max(1, columns) - 1 };
}

/**
 * SET-17: add a section, as one undo step. Null — nothing written — for an empty name, a range
 * that is not whole non-negative columns within the lattice, one that overlaps another section or leaves less
 * than the gutter between them, or a locked sheet.
 */
export function addSection(
  gd: GedeDoc,
  sheetId: Id,
  input: { name: string; firstColumn: number; lastColumn: number },
): Id | null {
  const name = input.name.trim();
  const { firstColumn, lastColumn } = input;
  if (name === '' || !Number.isInteger(firstColumn) || !Number.isInteger(lastColumn)) return null;
  if (firstColumn < 0 || lastColumn < firstColumn || lastColumn > MAX_SECTION_COLUMN) return null;
  if (
    isSheetLocked(gd, sheetId) ||
    !fits(listSections(gd, sheetId), firstColumn, lastColumn, null)
  ) {
    return null;
  }
  let id: Id | null = null;
  gd.doc.transact(() => {
    const sheet = sheetMapOf(gd, sheetId);
    if (sheet === null) return;
    const map = new Y.Map<unknown>();
    map.set('name', name);
    map.set('firstColumn', firstColumn);
    map.set('lastColumn', lastColumn);
    map.set('locked', false);
    id = newId();
    sheet.set(`${SECTION_PREFIX}${id}`, map);
  }, gd.origin);
  return id;
}

/** SET-17: Rename section…, as one undo step. False when the name is empty or the section is locked. */
export function renameSection(gd: GedeDoc, sheetId: Id, sectionId: Id, name: string): boolean {
  const trimmed = name.trim();
  const sheet = sheetMapOf(gd, sheetId);
  const map = sheet === null ? null : sectionMapOf(sheet, sectionId);
  if (map === null || trimmed === '' || sectionLockReason(gd, sheetId, sectionId) !== null) {
    return false;
  }
  if (readString(map, 'name') !== trimmed)
    gd.doc.transact(() => map.set('name', trimmed), gd.origin);
  return true;
}

/** SET-18: Lock section / Unlock section, as one undo step. False for a section that is not there. */
export function setSectionLocked(
  gd: GedeDoc,
  sheetId: Id,
  sectionId: Id,
  locked: boolean,
): boolean {
  const sheet = sheetMapOf(gd, sheetId);
  const map = sheet === null ? null : sectionMapOf(sheet, sectionId);
  if (map === null) return false;
  if (readBoolean(map, 'locked', false) !== locked) {
    gd.doc.transact(() => map.set('locked', locked), gd.origin);
  }
  return true;
}

/** SET-18: Lock sheet / Unlock sheet, as one undo step. False for a sheet that is not there. */
export function setSheetLocked(gd: GedeDoc, sheetId: Id, locked: boolean): boolean {
  const sheet = sheetMapOf(gd, sheetId);
  if (sheet === null) return false;
  if (readBoolean(sheet, 'locked', false) !== locked) {
    gd.doc.transact(() => sheet.set('locked', locked), gd.origin);
  }
  return true;
}

/**
 * SET-17: tables snap within their section. A table anchored in a section is moved left, as
 * far as it takes, until its right edge is inside it; one wider than the section keeps the
 * section's first column. Anything outside every section is where it was put.
 */
export function clampToSection(gd: GedeDoc, sheetId: Id, col: number, width: number): number {
  const section = sectionAtColumn(listSections(gd, sheetId), col);
  if (section === null) return col;
  return Math.max(section.firstColumn, Math.min(col, section.lastColumn + 1 - width));
}
