/**
 * FAKE — a browser `WebSocket` stand-in plus an in-memory y-websocket room,
 * for tests only. The room speaks the real wire protocol (`y-protocols`) the
 * sync service speaks, so what the provider sends and receives here is
 * byte-for-byte what it would send to `services/sync`. It is not the service:
 * no auth, no persistence, no permissions beyond the `viewOnly` switch.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** GeDe's server → client notice (`services/sync/src/ws/protocol.ts`). */
const MESSAGE_NOTICE = 4;

export interface FakeRoomOptions {
  /** Drop sync-step-2 and update messages from every socket (SHARE-03 view-only). */
  viewOnly?: boolean | undefined;
  /** Refuse every connection with this close code (4401 / 4403 / 4404). */
  refuseWith?: { code: number; reason: string } | undefined;
  /** Refuse only the first N connections, then accept. */
  refuseCount?: number | undefined;
  /**
   * Behave as a task from before #32: only `?token=` is read, a connection
   * carrying the token as a subprotocol is closed 4401 (rolling-deploy window).
   */
  legacyOnly?: boolean | undefined;
}

export class FakeRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly sockets = new Set<FakeWebSocket>();
  private readonly notified = new Set<FakeWebSocket>();
  /** Every URL a socket connected with, in order. */
  readonly urls: string[] = [];
  /** The subprotocol list each socket offered, in order (`['gede.v1', 'bearer.<token>']`). */
  readonly protocols: string[][] = [];
  /**
   * The access token each connection carried, in order — read from the
   * `bearer.` subprotocol (what the SPA sends) or, as the service still
   * accepts for one release, a `?token=` query parameter. `null` when neither.
   */
  readonly tokens: (string | null)[] = [];
  droppedUpdates = 0;
  refusals = 0;
  options: FakeRoomOptions;

  constructor(options: FakeRoomOptions = {}) {
    this.options = options;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const bytes = encoding.toUint8Array(encoder);
      for (const socket of this.sockets) if (socket !== origin) socket.deliver(bytes);
    });
  }

  /** The WebSocket class to hand to the provider. */
  get WebSocket(): typeof WebSocket {
    return socketClassFor(this);
  }

  /** Called by the socket after construction; runs the open/refuse handshake asynchronously. */
  admit(socket: FakeWebSocket): void {
    this.urls.push(socket.url);
    this.protocols.push(socket.protocols);
    this.tokens.push(tokenOf(socket.url, socket.protocols));
    queueMicrotask(() => {
      if (socket.readyState !== FakeWebSocket.CONNECTING) return;
      const refuse =
        this.options.refuseWith !== undefined &&
        (this.options.refuseCount === undefined || this.refusals < this.options.refuseCount);
      if (refuse && this.options.refuseWith !== undefined) {
        this.refusals += 1;
        socket.serverClose(this.options.refuseWith.code, this.options.refuseWith.reason);
        return;
      }
      if (this.options.legacyOnly === true && !socket.url.includes('token=')) {
        this.refusals += 1;
        socket.serverClose(4401, 'missing token');
        return;
      }
      this.sockets.add(socket);
      socket.serverOpen();
      // What y-websocket's server does on connect: sync step 1, then awareness.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.deliver(encoding.toUint8Array(encoder));
      const states = this.awareness.getStates();
      if (states.size > 0) {
        const aw = encoding.createEncoder();
        encoding.writeVarUint(aw, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          aw,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
        );
        socket.deliver(encoding.toUint8Array(aw));
      }
    });
  }

  receive(socket: FakeWebSocket, bytes: Uint8Array): void {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const subtype = decoding.readVarUint(decoder);
      if (subtype !== syncProtocol.messageYjsSyncStep1 && this.options.viewOnly === true) {
        this.droppedUpdates += 1;
        // As the service does: one read-only notice per connection, on the first drop.
        if (!this.notified.has(socket)) {
          this.notified.add(socket);
          const notice = encoding.createEncoder();
          encoding.writeVarUint(notice, MESSAGE_NOTICE);
          encoding.writeVarString(notice, JSON.stringify({ code: 'read-only' }));
          socket.deliver(encoding.toUint8Array(notice));
        }
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const replay = decoding.createDecoder(bytes);
      decoding.readVarUint(replay);
      syncProtocol.readSyncMessage(replay, encoder, this.doc, socket);
      if (encoding.length(encoder) > 1) socket.deliver(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, socket);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      const out = encoding.toUint8Array(encoder);
      for (const other of this.sockets) if (other !== socket) other.deliver(out);
    }
  }

  leave(socket: FakeWebSocket): void {
    this.sockets.delete(socket);
  }

  /** Drop every open socket as a network failure would (code 1006). */
  dropAll(): void {
    for (const socket of Array.from(this.sockets)) socket.serverClose(1006, 'dropped');
  }

  /** A second client edits the room directly, as another participant would. */
  edit(fn: (doc: Y.Doc) => void): void {
    this.doc.transact(() => {
      fn(this.doc);
    }, 'other-participant');
  }
}

/** The token a connection carried, by either transport; the bearer subprotocol wins. */
export function tokenOf(url: string, protocols: readonly string[]): string | null {
  const bearer = protocols.find((p) => p.startsWith('bearer.'));
  if (bearer !== undefined) return bearer.slice('bearer.'.length);
  const query = url.indexOf('?');
  if (query < 0) return null;
  return new URLSearchParams(url.slice(query + 1)).get('token');
}

function socketClassFor(room: FakeRoom): typeof WebSocket {
  const Klass = class extends FakeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, room, protocols);
    }
  };
  return Klass as unknown as typeof WebSocket;
}

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent<ArrayBuffer>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  /** The subprotocols offered, normalised to a list. */
  readonly protocols: string[];
  /** As a browser reports it once open: the first offered protocol (Playwright's mock does the same). */
  protocol = '';

  constructor(
    readonly url: string,
    private readonly room: FakeRoom,
    protocols?: string | string[],
  ) {
    this.protocols =
      protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    room.admit(this);
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('fake socket is not open');
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sent.push(bytes);
    this.room.receive(this, bytes);
  }

  /** Client-initiated close (the provider calls this). */
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.room.leave(this);
    queueMicrotask(() => {
      this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'client', wasClean: true }));
    });
  }

  serverOpen(): void {
    this.protocol = this.protocols[0] ?? '';
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.room.leave(this);
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }

  deliver(bytes: Uint8Array): void {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    const copy = new Uint8Array(bytes).buffer;
    this.onmessage?.(new MessageEvent('message', { data: copy }));
  }
}

/** Await until `predicate` holds, polling microtasks and timers. */
export async function until(
  predicate: () => boolean,
  { timeoutMs = 2000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('until() timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
