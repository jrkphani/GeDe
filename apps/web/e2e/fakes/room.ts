/**
 * FAKE — an in-memory y-websocket room behind Playwright's WebSocket routing.
 * It speaks the real wire format (y-protocols), so the SPA's provider runs
 * unchanged; it is not the sync service (no auth, no persistence).
 */
import type { Page, WebSocketRoute } from '@playwright/test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** GeDe's server → client notice (`services/sync/src/ws/protocol.ts`). */
const MESSAGE_NOTICE = 4;

/** The token a connection carried, by either transport; the bearer subprotocol wins. */
export function tokenOf(url: string, protocols: readonly string[]): string | null {
  const bearer = protocols.find((p) => p.startsWith('bearer.'));
  if (bearer !== undefined) return bearer.slice('bearer.'.length);
  const query = url.indexOf('?');
  if (query < 0) return null;
  return new URLSearchParams(url.slice(query + 1)).get('token');
}

export interface FakeRoomOptions {
  /** Drop every write and send the read-only notice once, as the service does for `view` (SHARE-03). */
  viewOnly?: boolean | undefined;
}

export class FakeRoom {
  readonly options: FakeRoomOptions;
  private readonly notified = new Set<WebSocketRoute>();
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly sockets = new Set<WebSocketRoute>();
  readonly urls: string[] = [];
  /** The subprotocol list each socket offered (`['gede.v1', 'bearer.<token>']`), in order. */
  readonly protocols: string[][] = [];
  /**
   * The access token each connection carried — from the `bearer.` subprotocol
   * (what the SPA sends, issue #32) or, as the service still accepts for one
   * release, a `?token=` query parameter. `null` when neither was present.
   */
  readonly tokens: (string | null)[] = [];

  constructor(options: FakeRoomOptions = {}) {
    this.options = options;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const bytes = Buffer.from(encoding.toUint8Array(encoder));
      for (const ws of this.sockets) if (ws !== origin) ws.send(bytes);
    });
  }

  /** Route every `/ws/` socket of this page into the room. */
  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws\//, (ws) => {
      this.urls.push(ws.url());
      this.protocols.push(ws.protocols());
      this.tokens.push(tokenOf(ws.url(), ws.protocols()));
      this.sockets.add(ws);
      ws.onMessage((message) => {
        this.receive(ws, typeof message === 'string' ? Buffer.from(message) : message);
      });
      ws.onClose(() => {
        this.sockets.delete(ws);
      });
      // What the service does on connect: sync step 1, then any awareness.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(Buffer.from(encoding.toUint8Array(encoder)));
    });
  }

  private receive(ws: WebSocketRoute, bytes: Uint8Array): void {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const subtype = decoding.readVarUint(decoder);
      if (subtype !== syncProtocol.messageYjsSyncStep1 && this.options.viewOnly === true) {
        if (!this.notified.has(ws)) {
          this.notified.add(ws);
          const notice = encoding.createEncoder();
          encoding.writeVarUint(notice, MESSAGE_NOTICE);
          encoding.writeVarString(notice, JSON.stringify({ code: 'read-only' }));
          ws.send(Buffer.from(encoding.toUint8Array(notice)));
        }
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const replay = decoding.createDecoder(bytes);
      decoding.readVarUint(replay);
      syncProtocol.readSyncMessage(replay, encoder, this.doc, ws);
      if (encoding.length(encoder) > 1) ws.send(Buffer.from(encoding.toUint8Array(encoder)));
    } else if (type === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      const out = Buffer.from(encoding.toUint8Array(encoder));
      for (const other of this.sockets) if (other !== ws) other.send(out);
    }
  }
}
