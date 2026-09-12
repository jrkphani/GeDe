/**
 * One in-memory Yjs document per open document (ARCHITECTURE §1.3 "Room
 * Manager" + "Permission Guard"). The room:
 *   - loads the latest snapshot from S3 and replays `doc_updates` after it;
 *   - speaks the y-websocket protocol to every socket;
 *   - fans out updates and awareness;
 *   - drops sync-step-2 and update messages from view-only sockets (SHARE-03)
 *     while still sending them the document stream;
 *   - hands every accepted update to the persistence writer.
 */
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import type { Config } from '../config.js';
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import { canEdit } from '../permissions.js';
import type { ProjectionWorker } from '../projection/worker.js';
import type { DocumentPermission, Repo } from '../repo/types.js';
import { PersistenceWriter } from './persistence.js';
import {
  decodeMessage,
  encodeAwareness,
  encodeNotice,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  MESSAGE_AWARENESS,
  SYNC_STEP1,
  SYNC_STEP2,
} from './protocol.js';
import { CLOSE_TOO_MANY_REQUESTS, CLOSE_TRY_AGAIN_LATER } from './route.js';
import { LOAD_ORIGIN, loadStoredState } from './state.js';
import { TokenBucket } from './throttle.js';

/** Bytes the type-1 envelope adds around an awareness payload (varUint type + varUint length). */
const AWARENESS_ENVELOPE_BYTES = 8;

export interface Member {
  readonly userId: string;
  readonly permission: DocumentPermission;
}

export class Conn {
  /** Awareness client ids this socket has announced; cleared when it leaves. */
  readonly awarenessIds = new Set<number>();
  /** Set once the read-only notice (type 4) has been sent; it goes out at most once per connection. */
  readOnlyNotified = false;
  /** Serialises message handling per socket so order is preserved across the async load. */
  queue: Promise<void> = Promise.resolve();
  /** Per-connection limits (#37): sync updates and awareness each have a bucket. */
  readonly updateBucket: TokenBucket;
  readonly awarenessBucket: TokenBucket;
  /** Set once the room closed this socket for exceeding a limit; later frames are ignored. */
  limited = false;

  constructor(
    readonly socket: WebSocket,
    readonly member: Member,
    limits: Pick<
      Config,
      'WS_UPDATES_PER_SEC' | 'WS_UPDATES_BURST' | 'WS_AWARENESS_PER_SEC' | 'WS_AWARENESS_BURST'
    >,
  ) {
    this.updateBucket = new TokenBucket(limits.WS_UPDATES_PER_SEC, limits.WS_UPDATES_BURST);
    this.awarenessBucket = new TokenBucket(limits.WS_AWARENESS_PER_SEC, limits.WS_AWARENESS_BURST);
  }

  get canEdit(): boolean {
    return canEdit(this.member.permission);
  }
}

export interface RoomStats {
  /** Sync-step-2/update messages dropped from view-only sockets (SHARE-03). */
  droppedUpdates: number;
  /** Messages refused because the room had already sealed its writer (dispose in progress). */
  refusedClosing: number;
  /** Awareness updates dropped for exceeding the size limit. */
  droppedAwareness: number;
  /** Messages that were not valid protocol. */
  malformed: number;
  /** Sockets closed for not reading (buffered bytes over the limit, #37). */
  slowConsumers: number;
  /** Connections closed for sending updates faster than the limit (#37). */
  rateLimited: number;
  /** Awareness updates dropped for exceeding the per-connection rate (#37). */
  throttledAwareness: number;
}

export type RoomConfig = Pick<
  Config,
  | 'SNAPSHOT_EVERY_UPDATES'
  | 'SNAPSHOT_IDLE_MS'
  | 'PERSIST_COALESCE_MS'
  | 'DOCS_PREFIX'
  | 'AWARENESS_MAX_BYTES'
  | 'WS_MAX_BUFFERED_BYTES'
  | 'WS_UPDATES_PER_SEC'
  | 'WS_UPDATES_BURST'
  | 'WS_AWARENESS_PER_SEC'
  | 'WS_AWARENESS_BURST'
>;

export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  readonly stats: RoomStats = {
    droppedUpdates: 0,
    refusedClosing: 0,
    droppedAwareness: 0,
    malformed: 0,
    slowConsumers: 0,
    rateLimited: 0,
    throttledAwareness: 0,
  };
  /** Resolves once the snapshot and log have been applied; rejects if loading failed. */
  readonly ready: Promise<void>;
  private writer: PersistenceWriter | null = null;
  private closing = false;

  constructor(
    readonly documentId: string,
    private readonly repo: Repo,
    private readonly s3: SnapshotStore,
    private readonly config: RoomConfig,
    private readonly logger: Logger,
    /** Receives every snapshot this room writes (debounced projection, ARCHITECTURE §1.3). */
    private readonly projection: Pick<ProjectionWorker, 'schedule'> | null = null,
  ) {
    // The server has no presence of its own.
    this.awareness.setLocalState(null);
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.ready = this.load();
  }

  get persistence(): PersistenceWriter {
    if (!this.writer) throw new Error('room is not loaded');
    return this.writer;
  }

  get size(): number {
    return this.conns.size;
  }

  private async load(): Promise<void> {
    const state = await loadStoredState(this.doc, this.documentId, this.repo.updates, this.s3);
    this.writer = new PersistenceWriter(
      this.documentId,
      this.doc,
      this.repo.updates,
      this.s3,
      this.config,
      this.logger,
      { snapshotSeq: state.snapshotSeq, lastSeq: state.lastSeq },
      this.projection === null
        ? undefined
        : (bytes) => {
            this.projection?.schedule(this.documentId, bytes);
          },
      () => {
        // Another task wrote to this document behind this room (#39): its
        // in-memory state is no longer the whole truth. The manager drops the
        // room; sockets get 1001, reconnect with backoff, and the fresh room
        // loads snapshot + log — the clients' replicas re-send what it lacks.
        this.onSuperseded?.(this);
      },
    );
    this.logger.info(
      { documentId: this.documentId, snapshotSeq: state.snapshotSeq, replayed: state.replayed },
      'room loaded',
    );
  }

  /** Attach a socket. Sends the initial sync step 1 and current awareness once the room is loaded. */
  join(socket: WebSocket, member: Member): Conn {
    const conn = new Conn(socket, member, this.config);
    this.conns.add(conn);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.stats.malformed += 1;
        return;
      }
      const bytes = toUint8Array(data);
      // An oversized awareness frame is refused on its length alone, before
      // anything is decoded or queued (#37). The envelope is one varUint byte.
      if (
        bytes[0] === MESSAGE_AWARENESS &&
        bytes.byteLength > this.config.AWARENESS_MAX_BYTES + AWARENESS_ENVELOPE_BYTES
      ) {
        this.stats.droppedAwareness += 1;
        return;
      }
      conn.queue = conn.queue
        .then(() => this.ready)
        .then(() => {
          this.handle(conn, bytes);
        })
        .catch((error: unknown) => {
          this.logger.warn({ err: error, documentId: this.documentId }, 'message handling failed');
        });
    });
    socket.once('close', () => {
      this.leave(conn);
    });
    socket.on('error', (error) => {
      this.logger.warn({ err: error, documentId: this.documentId }, 'socket error');
    });

    conn.queue = conn.queue
      .then(() => this.ready)
      .then(() => {
        this.send(conn, encodeSyncStep1(this.doc));
        const states = this.awareness.getStates();
        if (states.size > 0) this.send(conn, encodeAwareness(this.awareness, [...states.keys()]));
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error, documentId: this.documentId }, 'room failed to load');
        socket.close(1011, 'document unavailable');
      });
    return conn;
  }

  private leave(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    if (conn.awarenessIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    }
    this.onEmpty?.(this);
  }

  /** Set by the RoomManager to schedule eviction. */
  onEmpty: ((room: Room) => void) | null = null;
  /** Set by the RoomManager: this room's state was superseded by another task's write (#39). */
  onSuperseded: ((room: Room) => void) | null = null;

  private handle(conn: Conn, bytes: Uint8Array): void {
    // Frames still queued after the room closed this socket for a limit are ignored;
    // a frame received before an orderly close (shutdown, 1001) is still applied
    // and persisted (LOAD-05: nothing accepted is lost).
    if (conn.limited) return;
    if (this.writer?.sealed === true) {
      // The writer has drained and sealed: anything applied now could never
      // be persisted, so it is refused outright rather than accepted in
      // memory and lost. The socket is about to receive its close code.
      this.stats.refusedClosing += 1;
      return;
    }
    const message = decodeMessage(bytes);
    switch (message.kind) {
      case 'sync': {
        // Every sync message costs a token, reads included (#37, review of #66): a
        // step 1 makes the server encode and send whatever the client is missing —
        // the whole document for an empty state vector — from view-only sockets
        // too, so it is the cheapest amplifier a connection has.
        if (!this.takeUpdateToken(conn, 'too many sync messages')) return;
        if (message.subtype === SYNC_STEP1) {
          // A read: reply with what the client is missing.
          const stateVector = decoding.readVarUint8Array(message.decoder);
          this.send(conn, encodeSyncStep2(this.doc, stateVector));
          return;
        }
        if (!conn.canEdit) {
          // SHARE-03: a view-only participant receives the stream; their edits are rejected here.
          this.stats.droppedUpdates += 1;
          this.logger.debug(
            { documentId: this.documentId, userId: conn.member.userId },
            'update from view-only socket dropped',
          );
          if (!conn.readOnlyNotified) {
            // LOAD-05: tell the client once so it can show its read-only state
            // rather than wait for an echo that will never arrive.
            conn.readOnlyNotified = true;
            this.send(conn, encodeNotice({ code: 'read-only' }));
          }
          return;
        }
        if (message.subtype === SYNC_STEP2) {
          syncProtocol.readSyncStep2(message.decoder, this.doc, conn);
        } else {
          syncProtocol.readUpdate(message.decoder, this.doc, conn);
        }
        return;
      }
      case 'awareness': {
        if (message.update.byteLength > this.config.AWARENESS_MAX_BYTES) {
          this.stats.droppedAwareness += 1;
          return;
        }
        if (!conn.awarenessBucket.take()) {
          // Presence is best-effort: over the rate, drop rather than fan out (#37).
          this.stats.throttledAwareness += 1;
          return;
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, message.update, conn);
        return;
      }
      case 'queryAwareness': {
        // A read that fans every presence state back to one socket: same bucket as sync.
        if (!this.takeUpdateToken(conn, 'too many awareness queries')) return;
        const states = this.awareness.getStates();
        this.send(conn, encodeAwareness(this.awareness, [...states.keys()]));
        return;
      }
      case 'auth':
        return;
      case 'unknown':
        this.stats.malformed += 1;
    }
  }

  /**
   * Take one token from the connection's sync bucket. Over the burst — more
   * messages per second than any editor or provider produces (#37) — the
   * connection is closed with a code the client treats as terminal.
   */
  private takeUpdateToken(conn: Conn, reason: string): boolean {
    if (conn.updateBucket.take()) return true;
    this.stats.rateLimited += 1;
    conn.limited = true;
    this.logger.warn(
      { documentId: this.documentId, userId: conn.member.userId, reason },
      'sync rate limit exceeded; closing',
    );
    conn.socket.close(CLOSE_TOO_MANY_REQUESTS, reason);
    return false;
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOAD_ORIGIN) return;
    const message = encodeUpdate(update);
    for (const other of this.conns) {
      if (other !== origin) this.send(other, message);
    }
    const author = origin instanceof Conn ? origin.member.userId : null;
    this.writer?.enqueue(update, author);
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin instanceof Conn) {
      for (const id of added) origin.awarenessIds.add(id);
      for (const id of updated) origin.awarenessIds.add(id);
      for (const id of removed) origin.awarenessIds.delete(id);
    }
    const changed = added.concat(updated, removed);
    const message = encodeAwareness(this.awareness, changed);
    for (const conn of this.conns) this.send(conn, message);
  };

  private send(conn: Conn, message: Uint8Array): void {
    const { socket } = conn;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.config.WS_MAX_BUFFERED_BYTES) {
      // Back-pressure (#37): a socket that has stopped reading would otherwise
      // hold every further update in this process's memory. It is closed with
      // 1013 so the provider reconnects with backoff and resyncs from scratch.
      this.stats.slowConsumers += 1;
      conn.limited = true;
      this.logger.warn(
        {
          documentId: this.documentId,
          userId: conn.member.userId,
          buffered: socket.bufferedAmount,
        },
        'slow consumer; closing',
      );
      socket.close(CLOSE_TRY_AGAIN_LATER, 'slow consumer');
      return;
    }
    socket.send(message, { binary: true }, (error) => {
      if (error) {
        this.logger.warn({ err: error, documentId: this.documentId }, 'send failed; closing');
        socket.close(1011, 'send failed');
      }
    });
  }

  /**
   * Drain and seal persistence, close every socket, optionally compact, free
   * the document. Sockets stay open until the writer has sealed, so an update
   * that lands while the last append is in flight is still persisted (LOAD-05:
   * nothing accepted is lost); once sealed, `handle` refuses anything further
   * and the sockets are closed. `going away` (1001) tells the provider to
   * reconnect with backoff; 4404 tells it the document is gone.
   */
  async dispose(options: { compact: boolean; closeCode?: number }): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.onEmpty = null;
    const closeSockets = (): void => {
      for (const conn of this.conns) {
        conn.socket.close(options.closeCode ?? 1001, 'going away');
      }
      this.conns.clear();
    };
    try {
      try {
        await this.ready;
      } catch (error) {
        closeSockets();
        throw error;
      }
      await this.persistence.close({ compact: options.compact, beforeCompact: closeSockets });
    } catch (error) {
      this.logger.error({ err: error, documentId: this.documentId }, 'room dispose failed');
    } finally {
      closeSockets();
      this.awareness.destroy();
      this.doc.off('update', this.onDocUpdate);
      this.doc.destroy();
    }
  }
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
