/**
 * Room Manager: one `Room` per open document, created lazily, evicted after
 * `ROOM_IDLE_MS` without sockets (after a final compaction). The process is
 * treated as one of many — nothing here assumes it owns a document forever,
 * which is what lets growth step 1 (a second task + Redis fan-out) slot in.
 *
 * It also bounds what one task holds (#99, ADR-036): rooms, sockets, and
 * sockets per user — a join past a bound is refused with a close code and a
 * `GeDe/Sync WsRefusals` datapoint — and re-resolves every connection's
 * permission on a cadence (#104), so a share change that did not pass through
 * this process (another task, a rolling deploy, a change made by hand) still
 * ends the socket within `WS_PERMISSION_RECHECK_MS`.
 */
import type { WebSocket } from 'ws';

import type { Config } from '../config.js';
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import { count, type RefusalReason } from '../metrics.js';
import { resolvePermission } from '../permissions.js';
import type { ProjectionWorker } from '../projection/worker.js';
import type { Repo } from '../repo/types.js';
import { Room, type Conn, type Member } from './room.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  CLOSE_TOO_MANY_REQUESTS,
  CLOSE_TRY_AGAIN_LATER,
} from './route.js';

/** The reconnect close: the provider comes back and resolves the permission afresh. */
const CLOSE_RECONNECT = 1001;

export interface RoomManagerStats {
  /** Joins refused because the task already serves `WS_MAX_ROOMS` rooms. */
  refusedRooms: number;
  /** Joins refused because the task already serves `WS_MAX_SOCKETS` sockets. */
  refusedSockets: number;
  /** Joins refused because the user already holds `WS_MAX_SOCKETS_PER_USER` sockets. */
  refusedUserSockets: number;
  /** Connections the periodic re-check closed (#104). */
  revoked: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly evictions = new Map<string, NodeJS.Timeout>();
  /** Open sockets per verified user across every room on this task (#99). */
  private readonly socketsByUser = new Map<string, number>();
  private sockets = 0;
  private recheckTimer: NodeJS.Timeout | null = null;
  private recheckInFlight: Promise<void> | null = null;
  private shuttingDown = false;
  readonly stats: RoomManagerStats = {
    refusedRooms: 0,
    refusedSockets: 0,
    refusedUserSockets: 0,
    revoked: 0,
  };

  constructor(
    private readonly repo: Repo,
    private readonly s3: SnapshotStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly projection: Pick<ProjectionWorker, 'schedule'> | null = null,
  ) {
    // The sweep runs for the life of the process; it must not keep one alive.
    this.recheckTimer = setInterval(() => {
      void this.recheckPermissions();
    }, config.WS_PERMISSION_RECHECK_MS);
    this.recheckTimer.unref();
  }

  get(documentId: string): Room | undefined {
    return this.rooms.get(documentId);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Open sockets on this task. */
  get socketCount(): number {
    return this.sockets;
  }

  socketsFor(userId: string): number {
    return this.socketsByUser.get(userId) ?? 0;
  }

  /**
   * Attach a socket to a document's room, creating and loading the room on
   * first use. `undefined` when the join was refused: the socket has been
   * closed with the code that says why (1013 task full or shutting down,
   * 4429 too many sockets for this user) and the refusal counted.
   */
  join(documentId: string, socket: WebSocket, member: Member): Conn | undefined {
    if (this.shuttingDown) {
      socket.close(CLOSE_TRY_AGAIN_LATER, 'shutting down');
      return undefined;
    }
    const held = this.socketsFor(member.userId);
    if (held >= this.config.WS_MAX_SOCKETS_PER_USER) {
      this.stats.refusedUserSockets += 1;
      this.refuse(
        'too_many_sockets_for_user',
        { documentId, userId: member.userId, sockets: held },
        'too many sockets for one user; join refused',
      );
      socket.close(CLOSE_TOO_MANY_REQUESTS, 'too many connections');
      return undefined;
    }
    if (this.sockets >= this.config.WS_MAX_SOCKETS) {
      this.stats.refusedSockets += 1;
      this.refuse(
        'too_many_sockets',
        { documentId, userId: member.userId, sockets: this.sockets },
        'task socket limit reached; join refused',
      );
      socket.close(CLOSE_TRY_AGAIN_LATER, 'too many connections');
      return undefined;
    }
    const timer = this.evictions.get(documentId);
    if (timer) {
      clearTimeout(timer);
      this.evictions.delete(documentId);
    }
    let room = this.rooms.get(documentId);
    if (!room) {
      if (this.rooms.size >= this.config.WS_MAX_ROOMS) {
        this.stats.refusedRooms += 1;
        this.refuse(
          'too_many_rooms',
          { documentId, userId: member.userId, rooms: this.rooms.size },
          'task room limit reached; join refused',
        );
        socket.close(CLOSE_TRY_AGAIN_LATER, 'too many open documents');
        return undefined;
      }
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
    this.sockets += 1;
    this.socketsByUser.set(member.userId, held + 1);
    socket.once('close', () => {
      this.sockets -= 1;
      const left = this.socketsFor(member.userId) - 1;
      if (left <= 0) this.socketsByUser.delete(member.userId);
      else this.socketsByUser.set(member.userId, left);
    });
    return room.join(socket, member);
  }

  private refuse(reason: RefusalReason, context: Record<string, unknown>, msg: string): void {
    count(this.logger, 'WsRefusals', reason, context, msg);
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

  /** Close every socket `userId` holds on this task, on every document (account erased, #111). */
  closeUserEverywhere(userId: string, code: number, reason: string): number {
    let closed = 0;
    for (const room of this.rooms.values()) closed += room.closeMember(userId, code, reason);
    if (closed > 0) {
      this.logger.info({ userId, closeCode: code, sockets: closed }, 'sockets closed everywhere');
    }
    return closed;
  }

  /**
   * Re-resolve every open connection's standing (#104). For each distinct
   * (document, user) the permission is read from the database once; a
   * connection whose permission ended closes 4403, one whose document is
   * gone 4404, one whose permission changed 1001 (reconnect and resolve
   * afresh), and one whose token has expired 1001 as well. `revoked` is set
   * before the close frame, so frames the peer sends meanwhile are refused.
   * One sweep at a time; a sweep that fails to read leaves sockets as they
   * are and tries again next interval (a database outage must not evict
   * every editor).
   */
  recheckPermissions(now: number = Date.now()): Promise<void> {
    if (this.recheckInFlight) return this.recheckInFlight;
    this.recheckInFlight = this.sweep(now).finally(() => {
      this.recheckInFlight = null;
    });
    return this.recheckInFlight;
  }

  private async sweep(now: number): Promise<void> {
    for (const room of this.rooms.values()) {
      const byUser = new Map<string, Conn[]>();
      for (const conn of room.conns) {
        if (conn.revoked) continue;
        const list = byUser.get(conn.member.userId) ?? [];
        list.push(conn);
        byUser.set(conn.member.userId, list);
      }
      for (const [userId, conns] of byUser) {
        let resolved;
        try {
          resolved = await resolvePermission(this.repo, userId, room.documentId);
        } catch (error) {
          this.logger.warn(
            { err: error, documentId: room.documentId, userId },
            'permission re-check failed; sockets kept until the next sweep',
          );
          continue;
        }
        for (const conn of conns) {
          if (!room.conns.has(conn) || conn.revoked) continue;
          const verdict = this.verdict(conn, resolved, now);
          if (verdict === null) continue;
          this.stats.revoked += 1;
          count(
            this.logger,
            'WsRevocations',
            verdict.reason,
            { documentId: room.documentId, userId, closeCode: verdict.code },
            'connection closed by the permission re-check',
          );
          room.closeConn(conn, verdict.code, verdict.text);
        }
      }
    }
  }

  private verdict(
    conn: Conn,
    resolved: Awaited<ReturnType<typeof resolvePermission>>,
    now: number,
  ): { code: number; reason: RefusalReason; text: string } | null {
    if (resolved?.document.deletedAt !== null) {
      return { code: CLOSE_NOT_FOUND, reason: 'document_gone', text: 'document deleted' };
    }
    if (resolved.permission === null) {
      return { code: CLOSE_FORBIDDEN, reason: 'permission_ended', text: 'access removed' };
    }
    if (resolved.permission !== conn.member.permission) {
      return { code: CLOSE_RECONNECT, reason: 'permission_changed', text: 'permission changed' };
    }
    if (conn.member.tokenExpiresAt !== null && conn.member.tokenExpiresAt <= now) {
      return { code: CLOSE_RECONNECT, reason: 'token_expired', text: 'token expired' };
    }
    return null;
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
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    for (const timer of this.evictions.values()) clearTimeout(timer);
    this.evictions.clear();
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(rooms.map((room) => room.dispose({ compact: true })));
    this.logger.info({ rooms: rooms.length }, 'rooms closed');
  }
}
