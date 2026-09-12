/**
 * Initial document state (DOC-03). One function builds it so the server
 * (`POST /api/documents` writes it as snapshot seq 1) and the client
 * (`ensureFirstSheet`, the pre-Wave-2 fallback) produce byte-for-byte the
 * same shape: `meta.title`, `meta.createdAt`, and one sheet labelled
 * `Sheet 1` tagged `seeded`.
 *
 * Seeding runs under `SEED_ORIGIN`, which the undo manager never tracks.
 */
import * as Y from 'yjs';

import { newId, type Id } from '../ids.js';
import { listSheets, openDocument, type GedeDoc, type SheetMap } from './schema.js';

/** Transaction origin for seeding; never tracked by undo. */
export const SEED_ORIGIN = 'seed';

/** Label of the sheet every new document starts with. */
export const FIRST_SHEET_LABEL = 'Sheet 1';

export interface SeedOptions {
  /** The document record's title; `meta.title` mirrors it. */
  readonly title: string;
  /** ISO timestamp for `meta.createdAt`; defaults to now. */
  readonly createdAt?: string | undefined;
}

export interface SeedResult {
  /** Id of the first sheet (created here, or already present). */
  readonly sheetId: Id;
  /** False when the document already had a sheet and nothing was written. */
  readonly seeded: boolean;
}

/** The first sheet as a prelim map; the id is returned because a prelim cannot be read back. */
export function firstSheetMap(): { id: Id; map: SheetMap } {
  const id = newId();
  const map: SheetMap = new Y.Map<unknown>();
  map.set('id', id);
  map.set('label', FIRST_SHEET_LABEL);
  map.set('parentContext', null);
  map.set('seeded', true);
  return { id, map };
}

/**
 * Give an empty document its meta and first sheet. Idempotent: a document
 * that already has a sheet is left alone (its meta is not touched either —
 * `seedMeta` reconciles the title on open). Returns the first sheet's id.
 */
export function seedNewDocument(doc: Y.Doc, options: SeedOptions): SeedResult {
  const gd: GedeDoc = openDocument(doc);
  const existing = listSheets(gd)[0];
  if (existing !== undefined) return { sheetId: existing.id, seeded: false };
  let sheetId: Id = '';
  doc.transact(() => {
    gd.meta.set('title', options.title);
    gd.meta.set('createdAt', options.createdAt ?? new Date().toISOString());
    const sheet = firstSheetMap();
    sheetId = sheet.id;
    gd.sheets.push([sheet.map]);
  }, SEED_ORIGIN);
  return { sheetId, seeded: true };
}

/** The seeded document as one Yjs update — what the server stores as snapshot seq 1. */
export function encodeSeededDocument(options: SeedOptions): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  try {
    seedNewDocument(doc, options);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
