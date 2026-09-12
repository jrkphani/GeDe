/**
 * The per-account tour flag is written by two things that can happen within
 * a second of each other — Replay (`tourDone: false`) and Skip
 * (`tourDone: true`) — and `PATCH /api/me` answers with the stored profile,
 * which replaces `session.profile`. Two writes in flight at once can answer
 * out of order and leave the profile disagreeing with the server, and
 * `useTourAutoStart` would then act on the wrong flag. So every write goes
 * through one queue: in order, one at a time, and a write of the value the
 * tail already carries is coalesced into it.
 */
export type FlagWriter = (patch: { tourDone: boolean }) => Promise<unknown>;

export interface FlagQueue {
  /** Resolves when this value (or the coalesced write carrying it) has been answered — success or not. */
  persist(value: boolean, write: FlagWriter): Promise<void>;
  /** Test seam. */
  reset(): void;
}

export function createFlagQueue(): FlagQueue {
  let chain: Promise<void> = Promise.resolve();
  /** The value the last queued write will store, while any write is queued or in flight. */
  let tail: boolean | null = null;
  let queued = 0;
  return {
    persist(value, write) {
      if (queued > 0 && tail === value) return chain;
      tail = value;
      queued += 1;
      chain = chain
        .then(() => write({ tourDone: value }))
        .catch(() => undefined)
        .then(() => {
          queued -= 1;
          if (queued === 0) tail = null;
        });
      return chain;
    },
    reset() {
      chain = Promise.resolve();
      tail = null;
      queued = 0;
    },
  };
}

/** The app's one queue; the controller and Replay both write through it. */
export const tourFlag = createFlagQueue();
