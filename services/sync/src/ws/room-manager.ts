/**
 * Room Manager: one `Room` per open document, created lazily, evicted after
 * `ROOM_IDLE_MS` without sockets (after a final compaction). The process is
 * treated as one of many — nothing here assumes it owns a document forever,
 * which is what lets growth step 1 (a second task + Redis fan-out) slot in.
 */
import type { WebSocket } from 'ws';

import type { Config } from '../config.js';
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { ProjectionWorker } from '../projection/worker.js';
import type { Repo } from '../repo/types.js';
import { Room, type Conn, type Member } from './room.js';

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly evictions = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(
    private readonly repo: Repo,
    private readonly s3: SnapshotStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly projection: Pick<ProjectionWorker, 'schedule'> | null = null,
  ) {}

  get(documentId: string): Room | undefined {
    return this.rooms.get(documentId);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Attach a socket to a document's room, creating and loading the room on first use. */
  join(documentId: string, socket: WebSocket, member: Member): Conn {
    if (this.shuttingDown) {
      socket.close(1013, 'shutting down');
      throw new Error('room manager is shutting down');
    }
    const timer = this.evictions.get(documentId);
    if (timer) {
      clearTimeout(timer);
      this.evictions.delete(documentId);
    }
    let room = this.rooms.get(documentId);
    if (!room) {
      room = new Room(documentId, this.repo, this.s3, this.config, this.logger, this.projection);
      room.onEmpty = (r) => {
        this.scheduleEviction(r);
      };
      room.onSuperseded = (r) => {
        // Drop it without compacting (the commit was just refused); the next
        // join loads from storage. Sockets get 1001 and reconnect.
        if (this.rooms.get(r.documentId) === r) this.rooms.delete(r.documentId);
        this.logger.warn({ documentId: r.documentId }, 'room superseded; reloading on next join');
        void r.dispose({ compact: false });
      };
      this.rooms.set(documentId, room);
      this.logger.info({ documentId }, 'room opened');
      // A room that failed to load (S3 or database error) must not be reused:
      // drop it so the next join retries from storage. Its sockets are closed
      // with 1011 by the room itself.
      const opened = room;
      room.ready.catch(() => {
        if (this.rooms.get(documentId) === opened) this.rooms.delete(documentId);
        void opened.dispose({ compact: false, closeCode: 1011 });
      });
    }
    return room.join(socket, member);
  }

  private scheduleEviction(room: Room): void {
    if (room.size > 0 || this.shuttingDown) return;
    const timer = setTimeout(() => {
      this.evictions.delete(room.documentId);
      if (room.size > 0) return;
      void this.evict(room);
    }, this.config.ROOM_IDLE_MS);
    timer.unref();
    this.evictions.set(room.documentId, timer);
  }

  /**
   * The document was deleted or purged (LIB-08): close its room now rather
   * than at idle. `compact` saves the state first (soft delete — it can be
   * recovered); a purge passes `false` because the rows are already gone.
   * Sockets receive `closeCode` (4404 tells the provider not to reconnect
   * to a document that is no longer served).
   */
  async close(documentId: string, options: { compact: boolean; closeCode: number }): Promise<void> {
    const timer = this.evictions.get(documentId);
    if (timer) {
      clearTimeout(timer);
      this.evictions.delete(documentId);
    }
    const room = this.rooms.get(documentId);
    if (!room) return;
    this.rooms.delete(documentId);
    await room.dispose(options);
    this.logger.info({ documentId, closeCode: options.closeCode }, 'room closed');
  }

  /**
   * A participant's permission changed or ended (SHARE-01/03): close the
   * sockets they hold on the document so the next connection resolves the
   * new permission. Nothing to do when the room is not open.
   */
  closeUser(documentId: string, userId: string, code: number, reason: string): number {
    const room = this.rooms.get(documentId);
    if (!room) return 0;
    const closed = room.closeMember(userId, code, reason);
    if (closed > 0) {
      this.logger.info({ documentId, userId, closeCode: code, sockets: closed }, 'sockets closed');
    }
    return closed;
  }

  /** Remove the room from the map first so a new join creates a fresh room that loads from storage. */
  async evict(room: Room): Promise<void> {
    if (this.rooms.get(room.documentId) === room) this.rooms.delete(room.documentId);
    await room.dispose({ compact: true });
    this.logger.info({ documentId: room.documentId }, 'room evicted');
  }

  /**
   * Flush every room's pending updates, snapshot every dirty room, close every
   * socket. The flush comes first, so if the shutdown deadline cuts a snapshot
   * short the log is still complete and the next task replays it.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.evictions.values()) clearTimeout(timer);
    this.evictions.clear();
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(rooms.map((room) => room.dispose({ compact: true })));
    this.logger.info({ rooms: rooms.length }, 'rooms closed');
  }
}
