/**
 * One in-memory Yjs document per open document (ARCHITECTURE §1.3 "Room
 * Manager" + "Permission Guard"). The room:
 *   - loads the latest snapshot from S3 and replays `doc_updates` after it;
 *   - speaks the y-websocket protocol to every socket;
 *   - fans out updates and awareness;
 *   - drops sync-step-2 and update messages from view-only sockets (SHARE-03)
 *     while still sending them the document stream;
 *   - decodes every client update itself before applying it (#105): a frame
 *     that does not decode is refused (1007) and never reaches the document,
 *     the log or the other sockets;
 *   - bounds what one connection and one document may cost (#99, ADR-037):
 *     bytes per second per connection, a hard ceiling on the document's
 *     size, a bounded send buffer that is cut immediately when exceeded;
 *   - hands every accepted update to the persistence writer.
 */
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Config } from '../config.js';
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import { count, type RefusalReason } from '../metrics.js';
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
} from './protocol.js';
import {
  CLOSE_MALFORMED,
  CLOSE_MESSAGE_TOO_BIG,
  CLOSE_TOO_LARGE,
  CLOSE_TOO_MANY_REQUESTS,
  CLOSE_TRY_AGAIN_LATER,
} from './route.js';
import { LOAD_ORIGIN, loadStoredState } from './state.js';
import { TokenBucket } from './throttle.js';

/** Bytes the type-1 envelope adds around an awareness payload (varUint type + varUint length). */
const AWARENESS_ENVELOPE_BYTES = 8;

/** `ws`'s error code for a frame over `maxPayload`; the socket is closed 1009 by `ws` itself. */
const WS_ERR_TOO_BIG = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

export interface Member {
  readonly userId: string;
  readonly permission: DocumentPermission;
  /**
   * When the access token the socket was admitted with expires (ms epoch),
   * or null when the verifier does not say. The periodic re-check (#104)
   * closes the socket 1001 past it so the provider reconnects with a fresh
   * token; the token itself is never held here.
   */
  readonly tokenExpiresAt: number | null;
}

export class Conn {
  /** Awareness client ids this socket has announced; cleared when it leaves. */
  readonly awarenessIds = new Set<number>();
  /** Set once the read-only notice (type 4) has been sent; it goes out at most once per connection. */
  readOnlyNotified = false;
  /** Serialises message handling per socket so order is preserved across the async load. */
  queue: Promise<void> = Promise.resolve();
  /** Per-connection limits (#37, #99): sync messages, sync bytes and awareness each have a bucket. */
  readonly updateBucket: TokenBucket;
  readonly bytesBucket: TokenBucket;
  readonly awarenessBucket: TokenBucket;
  /**
   * Bytes the socket may hold unread on top of `WS_MAX_BUFFERED_BYTES`: the
   * step 2 the room sent it on join, once (#99), for as long as that step 2
   * is still in the socket's buffer. Serving a document at all means sending
   * its whole state; that one send is not what makes a socket a slow consumer.
   */
  bufferAllowance = 0;
  /** Set once the room has answered this socket's first step 1; a repeat is priced (#99). */
  step2Sent = false;
  /** Set once the room closed this socket for exceeding a limit; later frames are ignored. */
  limited = false;
  /**
   * Set once the room closed this socket because the member's permission
   * changed or ended (`closeMember`, SHARE-03). The permission frozen on the
   * connection is stale from that moment, so every later frame is refused:
   * `ws` keeps delivering frames until the peer answers the close handshake
   * (up to 30 s), and a client that never answers must not keep writing.
   */
  revoked = false;

  constructor(
    readonly socket: WebSocket,
    readonly member: Member,
    limits: Pick<
      Config,
      | 'WS_UPDATES_PER_SEC'
      | 'WS_UPDATES_BURST'
      | 'WS_BYTES_PER_SEC'
      | 'WS_BYTES_BURST'
      | 'WS_AWARENESS_PER_SEC'
      | 'WS_AWARENESS_BURST'
    >,
  ) {
    this.updateBucket = new TokenBucket(limits.WS_UPDATES_PER_SEC, limits.WS_UPDATES_BURST);
    this.bytesBucket = new TokenBucket(limits.WS_BYTES_PER_SEC, limits.WS_BYTES_BURST);
    this.awarenessBucket = new TokenBucket(limits.WS_AWARENESS_PER_SEC, limits.WS_AWARENESS_BURST);
  }

  get canEdit(): boolean {
    return canEdit(this.member.permission);
  }

  /**
   * The first step 2 this socket receives is allowed on top of the buffer
   * budget. True when this was the first; a repeat changes nothing.
   */
  allowStep2(bytes: number): boolean {
    if (this.step2Sent) return false;
    this.step2Sent = true;
    this.bufferAllowance = bytes;
    return true;
  }

  /** The step 2 has left the buffer: the socket is back on the plain budget. */
  endStep2Allowance(): void {
    this.bufferAllowance = 0;
  }
}

export interface RoomStats {
  /** Sync-step-2/update messages dropped from view-only sockets (SHARE-03). */
  droppedUpdates: number;
  /** Messages refused because the room had already sealed its writer (dispose in progress). */
  refusedClosing: number;
  /** Messages refused after the member's permission changed or ended (`closeMember`, SHARE-03). */
  refusedRevoked: number;
  /** Awareness updates dropped for exceeding the size limit. */
  droppedAwareness: number;
  /** Frames that were not valid protocol or did not decode as a Yjs update; the socket is closed 1007 (#105). */
  malformed: number;
  /** Frames `ws` refused for exceeding `WS_MAX_UPDATE_BYTES`; the socket is closed 1009 (#99). */
  oversized: number;
  /** Updates refused because the document would exceed `DOC_MAX_BYTES`; the socket is closed 4413 (#99). */
  tooLarge: number;
  /** Sockets closed for not reading (buffered bytes over the limit, #37). */
  slowConsumers: number;
  /** Connections closed for sending updates faster than the limit (#37). */
  rateLimited: number;
  /** Connections closed for sending more sync bytes than the limit (#99). */
  bytesRateLimited: number;
  /** Awareness updates dropped for exceeding the per-connection rate (#37). */
  throttledAwareness: number;
}

export type RoomConfig = Pick<
  Config,
  | 'SNAPSHOT_EVERY_UPDATES'
  | 'SNAPSHOT_IDLE_MS'
  | 'PERSIST_COALESCE_MS'
  | 'DOCS_PREFIX'
  | 'DOC_LOG_MAX_BYTES'
  | 'DOC_MAX_BYTES'
  | 'AWARENESS_MAX_BYTES'
  | 'WS_MAX_UPDATE_BYTES'
  | 'WS_MAX_BUFFERED_BYTES'
  | 'WS_UPDATES_PER_SEC'
  | 'WS_UPDATES_BURST'
  | 'WS_BYTES_PER_SEC'
  | 'WS_BYTES_BURST'
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
    refusedRevoked: 0,
    droppedAwareness: 0,
    malformed: 0,
    oversized: 0,
    tooLarge: 0,
    slowConsumers: 0,
    rateLimited: 0,
    bytesRateLimited: 0,
    throttledAwareness: 0,
  };
  /** Resolves once the snapshot and log have been applied; rejects if loading failed. */
  readonly ready: Promise<void>;
  /**
   * The document's size as the room estimates it (#99): what was loaded,
   * plus every update accepted since, corrected to the encoded size at each
   * snapshot. An upper bound between snapshots (a deletion adds bytes here
   * and removes them from the state), which is the safe side for a ceiling.
   */
  stateBytes = 0;
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
    this.stateBytes = state.bytes;
    this.writer = new PersistenceWriter(
      this.documentId,
      this.doc,
      this.repo.updates,
      this.s3,
      this.config,
      this.logger,
      { snapshotSeq: state.snapshotSeq, lastSeq: state.lastSeq },
      (bytes) => {
        // The encoded state is the truth; the running estimate starts over from it.
        this.stateBytes = bytes.byteLength;
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
      {
        documentId: this.documentId,
        snapshotSeq: state.snapshotSeq,
        replayed: state.replayed,
        bytes: state.bytes,
      },
      'room loaded',
    );
  }

  /** Attach a socket. Sends the initial sync step 1 and current awareness once the room is loaded. */
  join(socket: WebSocket, member: Member): Conn {
    const conn = new Conn(socket, member, this.config);
    this.conns.add(conn);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        // The protocol is binary; a text frame is not a client we know.
        this.refuseMalformed(conn, 'text frame');
        return;
      }
      const bytes = toUint8Array(data);
      if (conn.limited) return;
      // Every frame costs its length from the bytes bucket (#99), whatever
      // its type and before it is queued: an awareness frame up to
      // `maxPayload` would otherwise be assembled by `ws` and dropped below
      // for free, at any rate — ingress the sync bucket was added to bound.
      if (!conn.bytesBucket.take(bytes.byteLength)) {
        this.stats.bytesRateLimited += 1;
        conn.limited = true;
        this.refuse(
          conn,
          'bytes_rate_limited',
          { bytes: bytes.byteLength },
          'byte rate limit exceeded; closing',
        );
        socket.close(CLOSE_TOO_MANY_REQUESTS, 'too many bytes');
        return;
      }
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
    socket.on('error', (error: Error & { code?: string }) => {
      if (error.code === WS_ERR_TOO_BIG) {
        // `ws` refused the frame on its declared length and closes 1009 itself;
        // nothing of it was assembled. Counted here so it is visible (#99).
        this.stats.oversized += 1;
        conn.limited = true;
        this.refuse(conn, 'message_too_big', {}, 'frame over WS_MAX_UPDATE_BYTES refused by ws');
        return;
      }
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
    if (conn.revoked) {
      // SHARE-03: the permission this socket was admitted with no longer
      // holds. Reads and writes alike are refused; the socket is closing.
      this.stats.refusedRevoked += 1;
      return;
    }
    if (this.writer?.sealed === true) {
      // The writer has drained and sealed: anything applied now could never
      // be persisted, so it is refused outright rather than accepted in
      // memory and lost. The socket is about to receive its close code.
      this.stats.refusedClosing += 1;
      return;
    }
    if (bytes.byteLength > this.config.WS_MAX_UPDATE_BYTES) {
      // `ws` enforces this on the frame length; kept as the room's own bound
      // in case the server is ever configured with a larger `maxPayload`.
      this.stats.oversized += 1;
      conn.limited = true;
      this.refuse(conn, 'message_too_big', { bytes: bytes.byteLength }, 'frame too big; closing');
      conn.socket.close(CLOSE_MESSAGE_TOO_BIG, 'message too big');
      return;
    }
    let message;
    try {
      message = decodeMessage(bytes);
    } catch {
      // lib0 threw on the envelope: not a frame any provider sends.
      this.refuseMalformed(conn, 'undecodable envelope');
      return;
    }
    switch (message.kind) {
      case 'sync': {
        // Every sync message costs a token, reads included (#37, review of #66): a
        // step 1 makes the server encode and send whatever the client is missing —
        // the whole document for an empty state vector — from view-only sockets
        // too, so it is the cheapest amplifier a connection has.
        if (!this.takeUpdateToken(conn, 'too many sync messages')) return;
        if (message.subtype === SYNC_STEP1) {
          // A read: reply with what the client is missing.
          let stateVector: Uint8Array;
          try {
            stateVector = decoding.readVarUint8Array(message.decoder);
          } catch {
            this.refuseMalformed(conn, 'undecodable state vector');
            return;
          }
          // The provider sends one step 1 per connection. A second one is
          // a request to encode and send the document again — a message
          // token buys a document-sized encode and reply — so it is priced
          // at the room's size estimate from the bytes bucket, before the
          // encode: a repeat on a document larger than the burst closes
          // 4429, a repeat on a small one is paid for like any other bytes.
          if (conn.step2Sent && !conn.bytesBucket.take(this.stateBytes)) {
            this.stats.bytesRateLimited += 1;
            conn.limited = true;
            this.refuse(
              conn,
              'bytes_rate_limited',
              { bytes: this.stateBytes, repeatedStep1: true },
              'repeated sync step 1 over the byte budget; closing',
            );
            conn.socket.close(CLOSE_TOO_MANY_REQUESTS, 'too many bytes');
            return;
          }
          const step2 = encodeSyncStep2(this.doc, stateVector);
          const first = conn.allowStep2(step2.byteLength);
          // The allowance is for that one send: it ends when `ws` has
          // handed the step 2 to the socket, so it never adds a document's
          // worth of slack to every later broadcast (#99).
          this.send(
            conn,
            step2,
            first
              ? () => {
                  conn.endStep2Allowance();
                }
              : undefined,
          );
          return;
        }
        // Step 2 and update carry the same payload: one Yjs update. It is read
        // here, never by y-protocols, so every failure is ours to count and
        // refuse (#105): y-protocols would catch it, print a stack trace to
        // stderr and keep the socket open.
        let update: Uint8Array;
        try {
          update = decoding.readVarUint8Array(message.decoder);
        } catch {
          this.refuseMalformed(conn, 'undecodable update payload');
          return;
        }
        // The frame's bytes were charged on arrival (the bytes bucket covers
        // every frame, #99): a connection that sends 200 frames per second at
        // the frame limit is within the message budget while pushing
        // hundreds of megabytes a second, and the byte bucket is what stops it.
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
        this.applyClientUpdate(conn, update);
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
        try {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, message.update, conn);
        } catch {
          this.refuseMalformed(conn, 'undecodable awareness update');
        }
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
        // Client → server auth frames mean nothing here; they cost a token so
        // they cannot be sent for free (#99).
        this.takeUpdateToken(conn, 'too many sync messages');
        return;
      case 'unknown':
        this.refuseMalformed(conn, `unknown message type ${String(message.type)}`);
    }
  }

  /**
   * One client update (a step 2 or an update frame) from an edit socket:
   * checked against the document ceiling, decoded on its own, then applied.
   * Nothing that fails here touches the document, the log or another socket.
   */
  private applyClientUpdate(conn: Conn, update: Uint8Array): void {
    if (this.stateBytes + update.byteLength > this.config.DOC_MAX_BYTES) {
      // ADR-037: the document would pass its ceiling. The socket is closed
      // with a code the provider treats as terminal (4413); the client keeps
      // its edits locally and shows the LOAD-05 banner.
      this.stats.tooLarge += 1;
      conn.limited = true;
      this.refuse(
        conn,
        'document_too_large',
        { bytes: update.byteLength, stateBytes: this.stateBytes },
        'update would exceed DOC_MAX_BYTES; closing',
      );
      conn.socket.close(CLOSE_TOO_LARGE, 'document too large');
      return;
    }
    // Decode before apply (#105): a truncated update fails here, whole, rather
    // than half-integrating inside a failed Yjs transaction whose `update`
    // event would still fire and persist the fragment.
    try {
      Y.decodeUpdate(update);
    } catch {
      this.refuseMalformed(conn, 'update does not decode');
      return;
    }
    try {
      Y.applyUpdate(this.doc, update, conn);
    } catch (error) {
      // Decoded but not integrable: refused the same way, and noted at warn
      // because it is a case decoding should have caught.
      this.logger.warn(
        { err: error, documentId: this.documentId, userId: conn.member.userId },
        'decoded update failed to apply',
      );
      this.refuseMalformed(conn, 'update failed to apply');
      return;
    }
    this.stateBytes += update.byteLength;
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
    this.refuse(conn, 'rate_limited', { reason }, 'sync rate limit exceeded; closing');
    conn.socket.close(CLOSE_TOO_MANY_REQUESTS, reason);
    return false;
  }

  /** A frame that is not the protocol (#105): counted, reported, and the socket closed 1007. */
  private refuseMalformed(conn: Conn, what: string): void {
    this.stats.malformed += 1;
    if (conn.limited) return;
    conn.limited = true;
    this.refuse(conn, 'malformed', { what }, 'malformed frame; closing');
    conn.socket.close(CLOSE_MALFORMED, 'malformed message');
  }

  /** One structured line per refusal, which is also the `GeDe/Sync WsRefusals` datapoint (#99). */
  private refuse(
    conn: Conn,
    reason: RefusalReason,
    context: Record<string, unknown>,
    msg: string,
  ): void {
    count(
      this.logger,
      'WsRefusals',
      reason,
      { documentId: this.documentId, userId: conn.member.userId, ...context },
      msg,
    );
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

  /** `onFlushed` runs once `ws` has written the message out of its buffer (not on failure). */
  private send(conn: Conn, message: Uint8Array, onFlushed?: () => void): void {
    const { socket } = conn;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.config.WS_MAX_BUFFERED_BYTES + conn.bufferAllowance) {
      // Back-pressure (#37, #99): a socket that has stopped reading would
      // otherwise hold every further update in this process's memory. It is
      // closed with 1013 so the provider reconnects with backoff and resyncs
      // from scratch — and terminated at once: waiting for a peer that is not
      // reading to answer the close handshake kept the buffer allocated for
      // `ws`'s 30 s close timeout.
      this.stats.slowConsumers += 1;
      conn.limited = true;
      this.refuse(
        conn,
        'slow_consumer',
        { buffered: socket.bufferedAmount },
        'slow consumer; closing',
      );
      socket.close(CLOSE_TRY_AGAIN_LATER, 'slow consumer');
      socket.terminate();
      return;
    }
    socket.send(message, { binary: true }, (error) => {
      if (error) {
        this.logger.warn({ err: error, documentId: this.documentId }, 'send failed; closing');
        socket.close(1011, 'send failed');
        return;
      }
      onFlushed?.();
    });
  }

  /**
   * Close every socket `userId` holds in this room (SHARE-03: a permission
   * resolved at upgrade is frozen on the connection, so a share change must
   * end the connection). 4403 tells the provider it is no longer a
   * participant; 1001 tells it to reconnect, which re-resolves the permission
   * (a downgrade to view then arrives as the read-only notice). Resolves the
   * number of sockets closed. The sockets leave through the usual close
   * handler, so awareness and eviction follow as for any departure.
   *
   * The connection is marked revoked before the close frame goes out: frames
   * already queued behind the room load, and any the peer sends before it
   * answers the handshake (or never does), are refused rather than applied
   * under the stale permission.
   */
  closeMember(userId: string, code: number, reason: string): number {
    let closed = 0;
    for (const conn of this.conns) {
      if (conn.member.userId !== userId) continue;
      conn.revoked = true;
      conn.socket.close(code, reason);
      closed += 1;
    }
    return closed;
  }

  /**
   * Close one connection the same way `closeMember` does (revoked first, then
   * the close frame): used by the periodic re-check (#104) when a token has
   * expired or a member's standing changed.
   */
  closeConn(conn: Conn, code: number, reason: string): void {
    if (!this.conns.has(conn)) return;
    conn.revoked = true;
    conn.socket.close(code, reason);
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
