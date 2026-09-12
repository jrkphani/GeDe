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
  cellRich,
  cellText,
  effectiveCellFormat,
  isRichDoc,
  plainText,
  richFromText,
  tableMap,
  type FormatLocale,
  type GedeDoc,
  type RichDoc,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { isEditableTarget } from '../../../doc/shortcuts.js';
import type { CellSelection } from '../../../doc/selection.js';
import { layoutCell } from '../cell/index.js';
import type { GridCommands } from '../grid/commands.js';

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
}

interface Payload {
  text: string;
  rich: RichDoc;
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

function parseRich(json: string): RichDoc | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRichDoc(value) ? value : null;
  } catch {
    return null;
  }
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
async function writeSystem(text: string, rich: RichDoc | null = null): Promise<boolean> {
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
async function readSystem(): Promise<{ text: string; rich: RichDoc | null } | null> {
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
        : writeInto(d, cell, text, richJson === '' ? null : parseRich(richJson));
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
        if (writeInto(d, d.cell, read.text, read.rich)) {
          announce(`Pasted into ${d.addressOf(d.cell)}`);
        }
      },
      pasteMatchStyle: pastePlain,
    };
  }, []);
}
