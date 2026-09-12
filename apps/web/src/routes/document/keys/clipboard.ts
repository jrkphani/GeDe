/**
 * Cell clipboard (KEYS-03, MENU-04). The OS clipboard is the source of truth,
 * reached by two routes with one payload (ADR-028):
 *
 * - The keyboard (⌘X ⌘C ⌘V) is the browser's own copy / cut / paste command on
 *   the focused cell, which raises the native `copy` / `cut` / `paste` events
 *   handled here. No permission prompt, no paste popup, every engine. The
 *   shell binds none of those chords, so the default is never prevented.
 * - The menu commands (a click is a user gesture) use the async Clipboard API:
 *   `write` needs no prompt; `read` may prompt once, which a menu item can
 *   afford and a keystroke cannot.
 *
 * Both routes carry the cell's marks in a private flavour beside `text/plain`.
 * The two stores are not one: Chromium exposes the async route's custom web
 * format only through `navigator.clipboard.read`, never through a
 * `DataTransfer`, so marks copied by the menu and pasted by keyboard (or the
 * reverse) degrade to text. "Paste and match style" (⌥⇧⌘V) takes the text only.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  cellKey,
  cellRich,
  cellText,
  effectiveCellFormat,
  isFormula,
  isRichDoc,
  plainText,
  richFromText,
  tableMap,
  tableRecord,
  workbookCellId,
  type FormatLocale,
  type GedeDoc,
  type Id,
  type RichDoc,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { peekEngine } from '../../../doc/engine.js';
import { isEditableTarget } from '../../../doc/shortcuts.js';
import type { CellSelection } from '../../../doc/selection.js';
import { activeLocale } from '../../../locale.js';
import { layoutCell } from '../cell/index.js';
import { formatCellValue } from '../formula/index.js';
import type { ColumnValue, GridCommands } from '../grid/commands.js';

/** Private clipboard flavour carrying the rich document beside `text/plain`. */
export const RICH_MIME = 'application/x-gede-rich+json';
/** The same flavour as the async Clipboard API spells a custom format (Chromium's `web ` prefix). */
const RICH_WEB_MIME = `web ${RICH_MIME}`;

export interface ClipboardDeps {
  gd: GedeDoc;
  /** The selected cell, or null; nothing is handled without one. */
  cell: CellSelection | null;
  /** True while the cell editor is open — the editor owns the clipboard then. */
  editing: boolean;
  editable: boolean;
  locale: FormatLocale;
  commands: GridCommands;
  /** The cell's A1 address for announcements. */
  addressOf: (cell: CellSelection) => string;
}

export interface CellClipboard {
  /**
   * ⌥⇧⌘V (KEYS-03): the next native `paste` in this task pastes text only; when
   * the browser raises none for the chord, `readText` fills in.
   */
  armMatchStyle: () => void;
  /** Menu commands (MENU-04); each announces its outcome. */
  copy: () => Promise<void>;
  /** Copies the displayed text — the formatted value, marks dropped. */
  copySnapshot: () => Promise<void>;
  cut: () => Promise<void>;
  paste: () => Promise<void>;
  pasteMatchStyle: () => Promise<void>;
  /** Why a clipboard command is unavailable, or undefined when it can run. */
  reason: (command: 'copy' | 'cut' | 'paste') => string | undefined;
  /**
   * MENU-03: the column menu's clipboard group. Each acts on every cell of
   * the column it was opened on — never on the selected cell — and each write
   * is one transaction (one undo step). `reason` says why a write is refused:
   * a derived, linked or pulled column is read-only (REF-05).
   */
  column: ColumnClipboard;
}

export interface ColumnTarget {
  readonly tableId: Id;
  readonly colId: Id;
}

export interface ColumnClipboard {
  copy: (target: ColumnTarget) => Promise<void>;
  /** The displayed text of every cell, one line per row, marks dropped. */
  copySnapshot: (target: ColumnTarget) => Promise<void>;
  cut: (target: ColumnTarget) => Promise<void>;
  paste: (target: ColumnTarget) => Promise<void>;
  pasteMatchStyle: (target: ColumnTarget) => Promise<void>;
  clear: (target: ColumnTarget) => void;
  /** Why a write into the column is unavailable, or undefined when it can run. */
  reason: (target: ColumnTarget, command: 'copy' | 'cut' | 'paste') => string | undefined;
}

interface Payload {
  text: string;
  rich: RichDoc;
}

/**
 * The rich flavour of a column: one document per row, in row order. Shaped so
 * a single-cell paste can tell it from a `RichDoc` (an object with `cells`,
 * never a document), and a column paste can take a single cell's document.
 */
interface ColumnRich {
  readonly kind: 'column';
  readonly cells: readonly RichDoc[];
}

function isColumnRich(value: unknown): value is ColumnRich {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'column' &&
    Array.isArray((value as { cells?: unknown }).cells) &&
    (value as { cells: unknown[] }).cells.every(isRichDoc)
  );
}

/** Lines of a pasted text: one per row. A Windows line end is a line end. */
function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * What the column menu copies: every cell of the column, in row order. An
 * entered cell gives its stored text (a formula keeps its tokens, so it
 * re-binds when pasted back — ADR-023) and its marks; a derived, pulled or
 * linked cell has no text of its own and gives what it shows.
 */
function columnPayload(
  deps: ClipboardDeps,
  target: ColumnTarget,
  snapshot: boolean,
): { text: string; rich: ColumnRich; label: string } | null {
  const table = tableMap(deps.gd, target.tableId);
  if (table === null) return null;
  const record = tableRecord(table);
  const column = record.columns.find((c) => c.id === target.colId);
  if (column === undefined) return null;
  const engine = peekEngine(deps.gd.doc);
  const cells = record.rows.map((rowId): Payload => {
    const rich = cellRich(table, rowId, target.colId);
    const stored = cellText(table, rowId, target.colId);
    const evaluated = column.source !== 'entered' || isFormula(stored);
    if (evaluated) {
      const value = engine?.result(workbookCellId(record.id, cellKey(rowId, target.colId)))?.value;
      const shown =
        value === undefined || value === null
          ? column.source === 'linked'
            ? stored
            : ''
          : formatCellValue(activeLocale(), value);
      // Copy keeps a formula's stored text; a snapshot and every engine-owned cell give the value.
      const text = snapshot || column.source !== 'entered' ? shown : stored;
      return { text, rich: richFromText(text) };
    }
    if (!snapshot) return { text: stored, rich };
    const format = effectiveCellFormat(table, rowId, target.colId);
    const text = layoutCell(rich, format, deps.locale).text;
    return { text, rich: richFromText(text) };
  });
  return {
    text: cells.map((c) => c.text).join('\n'),
    rich: { kind: 'column', cells: cells.map((c) => c.rich) },
    label: column.label,
  };
}

/** The values a column paste writes, from the clipboard's rich flavour or its text. */
function columnValues(read: { text: string; rich: RichDoc | ColumnRich | null }): ColumnValue[] {
  if (read.rich !== null && isColumnRich(read.rich)) {
    return read.rich.cells.map((rich) => ({ text: plainText(rich), rich }));
  }
  if (read.rich !== null) return [{ text: read.text, rich: read.rich }];
  const lines = linesOf(read.text);
  // A trailing line end (a copied column ends with none, a text editor's often does) is not a row.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((text) => ({ text, rich: null }));
}

function payloadOf(deps: ClipboardDeps, cell: CellSelection): Payload | null {
  const table = tableMap(deps.gd, cell.tableId);
  if (table === null) return null;
  return {
    text: cellText(table, cell.rowId, cell.colId),
    rich: cellRich(table, cell.rowId, cell.colId),
  };
}

function snapshotOf(deps: ClipboardDeps, cell: CellSelection): string | null {
  const table = tableMap(deps.gd, cell.tableId);
  if (table === null) return null;
  const rich = cellRich(table, cell.rowId, cell.colId);
  const format = effectiveCellFormat(table, cell.rowId, cell.colId);
  return layoutCell(rich, format, deps.locale).text;
}

/** The private flavour: one cell's document, or a column's (`ColumnRich`); null for anything else. */
function parseRich(json: string): RichDoc | ColumnRich | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRichDoc(value) || isColumnRich(value) ? value : null;
  } catch {
    return null;
  }
}

/** A single cell takes a document; a column's flavour degrades to its text. */
function cellRichOf(rich: RichDoc | ColumnRich | null): RichDoc | null {
  return rich !== null && isRichDoc(rich) ? rich : null;
}

/** Write the payload into the cell; false when the command refused (a read-only cell says why itself). */
function writeInto(
  deps: ClipboardDeps,
  cell: CellSelection,
  text: string,
  rich: RichDoc | null,
): boolean {
  if (rich !== null && plainText(rich) === text) {
    return deps.commands.commitRichCell(cell, rich);
  }
  return deps.commands.commitCell(cell, text);
}

/**
 * Match style: the text and nothing else. A cell that already holds the same
 * text with marks must lose them, so the rich path writes an unmarked document;
 * a formula still commits as text so its references bind (PRD §20).
 */
function writePlain(deps: ClipboardDeps, cell: CellSelection, text: string): boolean {
  if (text.startsWith('=') || text === '') return deps.commands.commitCell(cell, text);
  return deps.commands.commitRichCell(cell, richFromText(text));
}

function systemClipboard(): Clipboard | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard;
}

/**
 * Writes to the OS clipboard through the async API. With `rich` the marks
 * ride along as a custom web format where the browser supports one
 * (Chromium); elsewhere, and for snapshots, plain text alone.
 */
async function writeSystem(
  text: string,
  rich: RichDoc | ColumnRich | null = null,
): Promise<boolean> {
  const clipboard = systemClipboard();
  if (clipboard === undefined) return false;
  if (rich !== null && typeof ClipboardItem === 'function') {
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          [RICH_WEB_MIME]: new Blob([JSON.stringify(rich)], { type: RICH_WEB_MIME }),
        }),
      ]);
      return true;
    } catch {
      // Custom formats refused (another engine, or no permission): plain text below.
    }
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Reads the OS clipboard: the rich flavour when present, else the text. */
async function readSystem(): Promise<{ text: string; rich: RichDoc | ColumnRich | null } | null> {
  const clipboard = systemClipboard();
  if (clipboard === undefined) return null;
  try {
    const items = await clipboard.read();
    for (const item of items) {
      if (!item.types.includes(RICH_WEB_MIME)) continue;
      const rich = parseRich(await (await item.getType(RICH_WEB_MIME)).text());
      const text = item.types.includes('text/plain')
        ? await (await item.getType('text/plain')).text()
        : rich === null
          ? ''
          : isColumnRich(rich)
            ? rich.cells.map(plainText).join('\n')
            : plainText(rich);
      return { text, rich };
    }
  } catch {
    // `read()` unsupported or refused: fall through to text.
  }
  try {
    return { text: await clipboard.readText(), rich: null };
  } catch {
    return null;
  }
}

const NO_CLIPBOARD = 'The clipboard is not available here';

/**
 * Bind the native clipboard events for the selected cell and return the menu
 * commands. One set of document listeners for the life of the document; the
 * deps are read through a ref so the listeners never go stale.
 */
export function useCellClipboard(deps: ClipboardDeps): CellClipboard {
  const ref = useRef(deps);
  ref.current = deps;
  /** Armed by ⌥⇧⌘V; cleared by the paste that consumes it or the fallback timer. */
  const matchStyle = useRef<{ timer: number } | null>(null);

  useEffect(() => {
    /** The cell the native event applies to, or null when the event is someone else's. */
    const target = (event: ClipboardEvent): CellSelection | null => {
      const d = ref.current;
      if (d.cell === null || d.editing) return null;
      if (isEditableTarget(event.target)) return null;
      return d.cell;
    };
    const onCopy = (event: ClipboardEvent) => {
      const cell = target(event);
      const data = event.clipboardData;
      if (cell === null || data === null) return;
      const payload = payloadOf(ref.current, cell);
      if (payload === null) return;
      event.preventDefault();
      data.setData('text/plain', payload.text);
      data.setData(RICH_MIME, JSON.stringify(payload.rich));
      announce(`Copied ${ref.current.addressOf(cell)}`);
    };
    const onCut = (event: ClipboardEvent) => {
      const cell = target(event);
      const data = event.clipboardData;
      if (cell === null || data === null) return;
      const d = ref.current;
      if (!d.editable) return;
      const payload = payloadOf(d, cell);
      if (payload === null) return;
      event.preventDefault();
      data.setData('text/plain', payload.text);
      data.setData(RICH_MIME, JSON.stringify(payload.rich));
      if (d.commands.clearCell(cell)) announce(`Cut ${d.addressOf(cell)}`);
    };
    const onPaste = (event: ClipboardEvent) => {
      const cell = target(event);
      const data = event.clipboardData;
      if (cell === null || data === null) return;
      const d = ref.current;
      if (!d.editable) return;
      event.preventDefault();
      const text = data.getData('text/plain');
      const plainOnly = matchStyle.current !== null;
      if (matchStyle.current !== null) {
        window.clearTimeout(matchStyle.current.timer);
        matchStyle.current = null;
      }
      const richJson = data.getData(RICH_MIME);
      const written = plainOnly
        ? writePlain(d, cell, text)
        : writeInto(d, cell, text, richJson === '' ? null : cellRichOf(parseRich(richJson)));
      if (written) announce(`Pasted${plainOnly ? ' plain text' : ''} into ${d.addressOf(cell)}`);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  // Every command reads the deps through the ref, so the object is stable for the document's life.
  return useMemo<CellClipboard>(() => {
    const copyText = async (text: string | null, rich: RichDoc | null, what: string) => {
      const d = ref.current;
      if (d.cell === null || text === null) return;
      announce((await writeSystem(text, rich)) ? `${what} ${d.addressOf(d.cell)}` : NO_CLIPBOARD);
    };
    const pastePlain = async () => {
      const d = ref.current;
      if (d.cell === null || !d.editable) return;
      const read = await readSystem();
      if (read === null) {
        announce(NO_CLIPBOARD);
        return;
      }
      if (writePlain(d, d.cell, read.text)) {
        announce(`Pasted plain text into ${d.addressOf(d.cell)}`);
      }
    };
    return {
      armMatchStyle: () => {
        if (matchStyle.current !== null) window.clearTimeout(matchStyle.current.timer);
        matchStyle.current = {
          // The browser's paste event for the chord arrives in this task; none by the
          // next means the engine has no such command, and the async read stands in.
          timer: window.setTimeout(() => {
            matchStyle.current = null;
            void pastePlain();
          }, 0),
        };
      },
      reason: (command) => {
        const d = ref.current;
        if (d.cell === null) return 'select a cell first';
        if (command !== 'copy' && !d.editable) return 'you have view-only access';
        return undefined;
      },
      copy: async () => {
        const d = ref.current;
        if (d.cell === null) return;
        const payload = payloadOf(d, d.cell);
        await copyText(payload?.text ?? null, payload?.rich ?? null, 'Copied');
      },
      copySnapshot: async () => {
        const d = ref.current;
        if (d.cell === null) return;
        await copyText(snapshotOf(d, d.cell), null, 'Copied a snapshot of');
      },
      cut: async () => {
        const d = ref.current;
        if (d.cell === null || !d.editable) return;
        const payload = payloadOf(d, d.cell);
        if (payload === null) return;
        if (!(await writeSystem(payload.text, payload.rich))) {
          announce(NO_CLIPBOARD);
          return;
        }
        if (d.commands.clearCell(d.cell)) announce(`Cut ${d.addressOf(d.cell)}`);
      },
      paste: async () => {
        const d = ref.current;
        if (d.cell === null || !d.editable) return;
        const read = await readSystem();
        if (read === null) {
          announce(NO_CLIPBOARD);
          return;
        }
        if (writeInto(d, d.cell, read.text, cellRichOf(read.rich))) {
          announce(`Pasted into ${d.addressOf(d.cell)}`);
        }
      },
      pasteMatchStyle: pastePlain,
      column: {
        reason: (target, command) => {
          const d = ref.current;
          const table = tableMap(d.gd, target.tableId);
          if (table === null) return 'the column is gone';
          if (command === 'copy') return undefined;
          if (!d.editable) return 'you have view-only access';
          const source = tableRecord(table).columns.find((c) => c.id === target.colId)?.source;
          if (source === undefined) return 'the column is gone';
          return source === 'entered' ? undefined : `${source} columns are read-only`;
        },
        copy: async (target) => {
          const payload = columnPayload(ref.current, target, false);
          if (payload === null) return;
          announce(
            (await writeSystem(payload.text, payload.rich))
              ? `Copied column ${payload.label}`
              : NO_CLIPBOARD,
          );
        },
        copySnapshot: async (target) => {
          const payload = columnPayload(ref.current, target, true);
          if (payload === null) return;
          announce(
            (await writeSystem(payload.text))
              ? `Copied a snapshot of column ${payload.label}`
              : NO_CLIPBOARD,
          );
        },
        cut: async (target) => {
          const d = ref.current;
          if (!d.editable) return;
          const payload = columnPayload(d, target, false);
          if (payload === null) return;
          if (!(await writeSystem(payload.text, payload.rich))) {
            announce(NO_CLIPBOARD);
            return;
          }
          d.commands.clearColumn(target.tableId, target.colId);
        },
        paste: async (target) => {
          const d = ref.current;
          if (!d.editable) return;
          const read = await readSystem();
          if (read === null) {
            announce(NO_CLIPBOARD);
            return;
          }
          d.commands.fillColumn(target.tableId, target.colId, columnValues(read));
        },
        pasteMatchStyle: async (target) => {
          const d = ref.current;
          if (!d.editable) return;
          const read = await readSystem();
          if (read === null) {
            announce(NO_CLIPBOARD);
            return;
          }
          d.commands.fillColumn(target.tableId, target.colId, columnValues(read), {
            plain: true,
          });
        },
        clear: (target) => {
          const d = ref.current;
          if (!d.editable) return;
          d.commands.clearColumn(target.tableId, target.colId);
        },
      },
    };
  }, []);
}
