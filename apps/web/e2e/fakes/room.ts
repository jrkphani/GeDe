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

export class FakeRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly sockets = new Set<WebSocketRoute>();
  readonly urls: string[] = [];

  constructor() {
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
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
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
