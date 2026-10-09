/**
 * Minimal-diff edits over a table's `rows` array, for the reconcilers
 * (REF-02 pulls, HIER-07 `Split()` children).
 *
 * Why not delete-and-reinsert: a Yjs array insert is a fresh item, so two
 * replicas that each rebuild the same block concurrently end up with every
 * row twice after merge, see the block as wrong again, rebuild again, and
 * never settle. Editing the smallest difference converges instead:
 *
 *   - `dedupe` drops later occurrences of an id. After a merge both replicas
 *     hold the same order, so both delete the same items and insert nothing.
 *   - `remove` deletes only the rows that should not be there.
 *   - `insertAt` adds only a row that is missing.
 *   - `move` relocates one row (a delete and one insert). A concurrent move
 *     of the same row duplicates it once; the next `dedupe` settles it.
 *
 * A replica that sees the other's finished result makes no write at all.
 */
import type * as Y from 'yjs';

import type { Id } from '../ids.js';

export class RowEditor {
  /** A mirror of the array, kept in step with every edit. */
  readonly ids: Id[];
  writes = 0;
  /** Position by id, rebuilt lazily after an edit; `has`/`indexOf` stay O(1) between edits. */
  private index: Map<Id, number> | null = null;

  constructor(private readonly rows: Y.Array<Id>) {
    this.ids = rows.toArray();
  }

  /** Index of the first occurrence of `id`, or -1. */
  indexOf(id: Id): number {
    if (this.index === null) {
      this.index = new Map();
      this.ids.forEach((row, i) => {
        if (!this.index?.has(row)) this.index?.set(row, i);
      });
    }
    return this.index.get(id) ?? -1;
  }

  /** Delete later occurrences of every id that appears more than once. Returns how many went. */
  dedupe(): number {
    const seen = new Set<Id>();
    const doomed: number[] = [];
    this.ids.forEach((id, i) => {
      if (seen.has(id)) doomed.push(i);
      else seen.add(id);
    });
    for (let k = doomed.length - 1; k >= 0; k -= 1) this.deleteAt(doomed[k] ?? 0);
    return doomed.length;
  }

  /** Delete every row `predicate` names. Returns the ids removed. */
  remove(predicate: (id: Id) => boolean): Id[] {
    const removed: Id[] = [];
    for (let i = this.ids.length - 1; i >= 0; i -= 1) {
      const id = this.ids[i];
      if (id !== undefined && predicate(id)) {
        removed.push(id);
        this.deleteAt(i);
      }
    }
    return removed.reverse();
  }

  insertAt(index: number, id: Id): void {
    const at = Math.max(0, Math.min(index, this.ids.length));
    this.rows.insert(at, [id]);
    this.ids.splice(at, 0, id);
    this.index = null;
    this.writes += 1;
  }

  /** Relocate one row so that it sits at `index` (index counted after its removal). */
  move(id: Id, index: number): void {
    const from = this.indexOf(id);
    if (from < 0) return;
    this.deleteAt(from);
    this.insertAt(index, id);
  }

  /**
   * Make every id of `order` present and in that relative order, other rows
   * keeping their places, by few moves: the members already in order (a
   * longest increasing run of positions) stay, every other member is deleted
   * and re-inserted right after its predecessor in `order` (the leading ones
   * before the first member that stayed, or at the end when none did).
   * O(n log n); a contiguous run of deletes or inserts is one Yjs operation,
   * so a 10,000-row fill or reversal runs in well under 2 s (the test budget).
   */
  arrange(order: readonly Id[]): void {
    const present = order.filter((id) => this.has(id));
    const keep = new Set(
      longestIncreasing(
        present,
        present.map((id) => this.indexOf(id)),
      ),
    );
    const doomed = present
      .filter((id) => !keep.has(id))
      .map((id) => this.indexOf(id))
      .sort((a, b) => b - a);
    // Highest first, one Yjs delete per contiguous run.
    for (let k = 0; k < doomed.length;) {
      let start = doomed[k] ?? 0;
      let length = 1;
      while (doomed[k + length] === start - 1) {
        start -= 1;
        length += 1;
      }
      this.rows.delete(start, length);
      this.ids.splice(start, length);
      k += length;
    }
    this.writes += doomed.length;
    // Runs of members to insert, keyed by the kept member they follow (null: the leading run).
    const after = new Map<Id | null, Id[]>();
    let anchor: Id | null = null;
    for (const id of order) {
      if (keep.has(id)) {
        anchor = id;
        continue;
      }
      const run = after.get(anchor);
      if (run === undefined) after.set(anchor, [id]);
      else run.push(id);
    }
    if (after.size === 0) {
      this.index = null;
      return;
    }
    const out: Id[] = [];
    const inserts: { at: number; ids: Id[] }[] = [];
    const lead = after.get(null);
    const emit = (ids: Id[] | undefined): void => {
      if (ids === undefined) return;
      inserts.push({ at: out.length, ids });
      for (const id of ids) out.push(id);
    };
    let leadDone = false;
    for (const id of this.ids) {
      if (!leadDone && keep.has(id)) {
        emit(lead);
        leadDone = true;
      }
      out.push(id);
      if (keep.has(id)) emit(after.get(id));
    }
    if (!leadDone) emit(lead);
    // Ascending: each insert lands where the finished array has it.
    for (const { at, ids } of inserts) {
      this.rows.insert(at, ids);
      this.writes += ids.length;
    }
    this.ids.length = 0;
    for (const id of out) this.ids.push(id);
    this.index = null;
  }

  has(id: Id): boolean {
    return this.indexOf(id) >= 0;
  }

  private deleteAt(index: number): void {
    this.rows.delete(index, 1);
    this.ids.splice(index, 1);
    this.index = null;
    this.writes += 1;
  }
}

/**
 * Move rows one at a time until the members of `order` appear in that
 * relative order (other rows keep their places). Each move relocates one
 * row to just before the row that currently sits where it should be.
 * Bounded by the number of members.
 */
export function orderMembers(editor: RowEditor, order: readonly Id[]): void {
  const members = order.filter((id) => editor.has(id));
  let budget = members.length;
  while (budget > 0) {
    budget -= 1;
    const positions = members.map((id) => editor.indexOf(id));
    let first = -1;
    for (let i = 1; i < positions.length; i += 1) {
      if ((positions[i] ?? 0) < (positions[i - 1] ?? 0)) {
        first = i;
        break;
      }
    }
    if (first < 0) return;
    // The member at `first` sits too early: put it right after its predecessor.
    const id = members[first] ?? '';
    const predecessor = members[first - 1] ?? '';
    const predecessorAt = editor.indexOf(predecessor);
    editor.move(id, predecessorAt); // its own removal shifted the predecessor left by one
  }
}

/** The items whose `positions` form a longest strictly increasing run, in order (patience sort). */
function longestIncreasing<T>(items: readonly T[], positions: readonly number[]): T[] {
  const tails: number[] = [];
  const previous: number[] = [];
  positions.forEach((p, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((positions[tails[mid] ?? 0] ?? 0) < p) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? (tails[lo - 1] ?? -1) : -1;
    tails[lo] = i;
  });
  const out: T[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i] ?? -1) {
    const item = items[i];
    if (item !== undefined) out.push(item);
  }
  return out.reverse();
}
