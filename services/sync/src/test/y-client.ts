/**
 * A minimal y-websocket client for tests. It mirrors what
 * `y-websocket`'s `WebsocketProvider` puts on the wire — sync step 1 on open,
 * `readSyncMessage` on every sync message, updates and awareness relayed —
 * so a server that satisfies this client satisfies the real provider.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { MESSAGE_AWARENESS, MESSAGE_SYNC } from '../ws/protocol.js';

export interface CloseEvent {
  code: number;
  reason: string;
}

export class YClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly ws: WebSocket;
  /** Every raw message received, for assertions about what the server sent. */
  readonly received: Uint8Array[] = [];
  readonly closed: Promise<CloseEvent>;
  private syncedResolve: (() => void) | null = null;
  readonly synced: Promise<void>;
  private isSynced = false;

  constructor(url: string, origin: string | undefined) {
    this.ws = new WebSocket(url, origin === undefined ? {} : { headers: { origin } });
    this.ws.binaryType = 'nodebuffer';
    this.synced = new Promise<void>((resolve) => {
      this.syncedResolve = resolve;
    });
    this.closed = new Promise<CloseEvent>((resolve) => {
      this.ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    this.ws.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
    });
    this.ws.on('message', (data) => {
      const bytes = new Uint8Array(data as Buffer);
      this.received.push(bytes);
      this.handle(bytes);
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.send(encoding.toUint8Array(encoder));
      },
    );
  }

  static async connect(url: string, origin: string | undefined): Promise<YClient> {
    const client = new YClient(url, origin);
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    return client;
  }

  /** Send raw bytes, bypassing the local doc — used to forge messages. */
  send(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes, { binary: true });
  }

  private handle(bytes: Uint8Array): void {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const subtype = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (subtype === syncProtocol.messageYjsSyncStep2 && !this.isSynced) {
        this.isSynced = true;
        this.syncedResolve?.();
      }
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    }
  }

  /** Text of the shared `cells` map entry, for assertions. */
  cell(key: string): string | undefined {
    return this.doc.getMap<string>('cells').get(key);
  }

  setCell(key: string, text: string): void {
    this.doc.getMap<string>('cells').set(key, text);
  }

  close(code?: number): void {
    this.awareness.destroy();
    this.ws.close(code);
  }
}

/** Poll until `predicate` is true or `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
