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
import type { DocumentPermission, Repo } from '../repo/types.js';
import { PersistenceWriter } from './persistence.js';
import {
  decodeMessage,
  encodeAwareness,
  encodeNotice,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  SYNC_STEP1,
  SYNC_STEP2,
} from './protocol.js';

/** Transaction origin for updates replayed from storage; never persisted or echoed. */
const LOAD_ORIGIN = Symbol('load');

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

  constructor(
    readonly socket: WebSocket,
    readonly member: Member,
  ) {}

  get canEdit(): boolean {
    return canEdit(this.member.permission);
  }
}

export interface RoomStats {
  /** Sync-step-2/update messages dropped from view-only sockets (SHARE-03). */
  droppedUpdates: number;
  /** Awareness updates dropped for exceeding the size limit. */
  droppedAwareness: number;
  /** Messages that were not valid protocol. */
  malformed: number;
}

export type RoomConfig = Pick<
  Config,
  | 'SNAPSHOT_EVERY_UPDATES'
  | 'SNAPSHOT_IDLE_MS'
  | 'PERSIST_COALESCE_MS'
  | 'DOCS_PREFIX'
  | 'AWARENESS_MAX_BYTES'
>;

export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  readonly stats: RoomStats = { droppedUpdates: 0, droppedAwareness: 0, malformed: 0 };
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
    const state = await this.repo.updates.loadState(this.documentId);
    let lastSeq = state.snapshotSeq;
    if (state.snapshotKey !== null) {
      const bytes = await this.s3.get(state.snapshotKey);
      if (bytes === undefined) {
        // The pointer exists but the object does not: refuse to serve a
        // document with silently missing history.
        throw new Error(`snapshot ${state.snapshotKey} is missing from the bucket`);
      }
      Y.applyUpdate(this.doc, bytes, LOAD_ORIGIN);
    }
    for (const entry of state.updates) {
      Y.applyUpdate(this.doc, entry.update, LOAD_ORIGIN);
      lastSeq = Math.max(lastSeq, entry.seq);
    }
    this.writer = new PersistenceWriter(
      this.documentId,
      this.doc,
      this.repo.updates,
      this.s3,
      this.config,
      this.logger,
      { snapshotSeq: state.snapshotSeq, lastSeq },
    );
    this.logger.info(
      {
        documentId: this.documentId,
        snapshotSeq: state.snapshotSeq,
        replayed: state.updates.length,
      },
      'room loaded',
    );
  }

  /** Attach a socket. Sends the initial sync step 1 and current awareness once the room is loaded. */
  join(socket: WebSocket, member: Member): Conn {
    const conn = new Conn(socket, member);
    this.conns.add(conn);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.stats.malformed += 1;
        return;
      }
      const bytes = toUint8Array(data);
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

  private handle(conn: Conn, bytes: Uint8Array): void {
    const message = decodeMessage(bytes);
    switch (message.kind) {
      case 'sync': {
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
        awarenessProtocol.applyAwarenessUpdate(this.awareness, message.update, conn);
        return;
      }
      case 'queryAwareness': {
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
    socket.send(message, { binary: true }, (error) => {
      if (error) {
        this.logger.warn({ err: error, documentId: this.documentId }, 'send failed; closing');
        socket.close(1011, 'send failed');
      }
    });
  }

  /**
   * Flush persistence, optionally compact, close every socket and free the
   * document. `going away` (1001) tells the provider to reconnect with backoff.
   */
  async dispose(options: { compact: boolean; closeCode?: number }): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.onEmpty = null;
    for (const conn of this.conns) {
      conn.socket.close(options.closeCode ?? 1001, 'going away');
    }
    this.conns.clear();
    try {
      await this.ready;
      await this.writer?.close({ compact: options.compact });
    } catch (error) {
      this.logger.error({ err: error, documentId: this.documentId }, 'room dispose failed');
    } finally {
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
