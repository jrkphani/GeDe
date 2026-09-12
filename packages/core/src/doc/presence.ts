/**
 * Awareness payload (ARCHITECTURE §1.5.3, SHARE-04): user id, name, colour,
 * sheet and selected cell. The colour is an index into the six presence
 * tokens (`--presence-1` … `--presence-6`), assigned on join and never the
 * brand colour — the pixel value lives in `packages/tokens`, not here.
 */
import type { Id } from '../ids.js';

export const PRESENCE_COLOURS = 6;
export type PresenceColour = 1 | 2 | 3 | 4 | 5 | 6;

export interface PresenceCell {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

export interface PresenceState {
  readonly userId: string;
  readonly name: string;
  readonly colour: PresenceColour;
  readonly sheetId: Id | null;
  readonly cell?: PresenceCell | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isPresenceColour(v: unknown): v is PresenceColour {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PRESENCE_COLOURS;
}

/** Tolerant reader for a remote awareness state; null when it is not ours. */
export function toPresenceState(v: unknown): PresenceState | null {
  if (!isRecord(v)) return null;
  if (typeof v.userId !== 'string' || typeof v.name !== 'string') return null;
  if (!isPresenceColour(v.colour)) return null;
  const cell = v.cell;
  let presenceCell: PresenceCell | undefined;
  if (isRecord(cell)) {
    if (
      typeof cell.tableId === 'string' &&
      typeof cell.rowId === 'string' &&
      typeof cell.colId === 'string'
    ) {
      presenceCell = { tableId: cell.tableId, rowId: cell.rowId, colId: cell.colId };
    }
  }
  return {
    userId: v.userId,
    name: v.name,
    colour: v.colour,
    sheetId: typeof v.sheetId === 'string' ? v.sheetId : null,
    cell: presenceCell,
  };
}

/**
 * Pick a colour for a joining client: the least-used index among those already
 * present, ties broken by the lowest index. Deterministic given the same room
 * state, so two clients joining in sequence differ.
 */
export function assignPresenceColour(taken: readonly PresenceColour[]): PresenceColour {
  const counts = new Array<number>(PRESENCE_COLOURS).fill(0);
  for (const c of taken) counts[c - 1] = (counts[c - 1] ?? 0) + 1;
  let best: PresenceColour = 1;
  for (let i = 1; i < PRESENCE_COLOURS; i += 1) {
    if ((counts[i] ?? 0) < (counts[best - 1] ?? 0)) best = (i + 1) as PresenceColour;
  }
  return best;
}

/** Initials for the avatar fallback: up to two letters, never a generated face. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}
