/**
 * y-websocket wire format. Byte-compatible with `y-websocket`'s
 * `WebsocketProvider`, so the SPA uses that provider unchanged:
 *
 *   message      := varUint(type) payload
 *   type 0 sync  := payload is a y-protocols/sync message
 *                     sub 0 syncStep1(stateVector)   sub 1 syncStep2(update)   sub 2 update(update)
 *   type 1 awareness := varUint8Array(awareness update)
 *   type 2 auth  := (unused; the provider treats it as a permission-denied notice)
 *   type 3 queryAwareness := empty; reply with type 1 carrying every state
 *   type 4 notice := varString(JSON) — GeDe's one addition, server → client only
 *
 * On connect the server sends a syncStep1 and, when anyone is present, one
 * awareness message with all states — exactly what `y-websocket/bin/utils`
 * does.
 *
 * Type 4 (SHARE-03 / LOAD-05): when a socket whose permission is `view` sends
 * a sync step 2 or an update, the room drops it (as before) and, once per
 * connection, replies with `{ "code": "read-only" }` so the client can show
 * its read-only state instead of waiting for an echo that never comes. In
 * practice it arrives during the handshake: the provider answers the
 * server's step 1 with a step 2, which is the first write the room rejects.
 * The stock provider does not know type 4: the SPA registers
 * `provider.messageHandlers[4]` to read it (the array is public on
 * `WebsocketProvider`); an unregistered handler only logs. Types 0–3 are
 * byte-for-byte y-websocket. The server never accepts a type 4 from a client.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;
export const MESSAGE_NOTICE = 4;

/** Payload of a type 4 message. Only one code exists today. */
export interface Notice {
  readonly code: 'read-only';
}

export const SYNC_STEP1 = syncProtocol.messageYjsSyncStep1;
export const SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;
export const SYNC_UPDATE = syncProtocol.messageYjsUpdate;

export type SyncSubtype = typeof SYNC_STEP1 | typeof SYNC_STEP2 | typeof SYNC_UPDATE;

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

export function encodeNotice(notice: Notice): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_NOTICE);
  encoding.writeVarString(encoder, JSON.stringify(notice));
  return encoding.toUint8Array(encoder);
}

/** `undefined` when the bytes are not a well-formed type 4 message. */
export function decodeNotice(bytes: Uint8Array): Notice | undefined {
  const decoder = decoding.createDecoder(bytes);
  if (decoding.readVarUint(decoder) !== MESSAGE_NOTICE) return undefined;
  try {
    const parsed: unknown = JSON.parse(decoding.readVarString(decoder));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { code?: unknown }).code === 'read-only'
    ) {
      return { code: 'read-only' };
    }
  } catch {
    // fall through: not a notice
  }
  return undefined;
}

export type DecodedMessage =
  | { kind: 'sync'; subtype: SyncSubtype; decoder: decoding.Decoder }
  | { kind: 'awareness'; update: Uint8Array }
  | { kind: 'queryAwareness' }
  | { kind: 'auth' }
  | { kind: 'unknown'; type: number };

/** Read the envelope. The sync payload stays in the decoder for the room to apply or drop. */
export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const decoder = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(decoder);
  switch (type) {
    case MESSAGE_SYNC: {
      const subtype = decoding.readVarUint(decoder);
      if (subtype !== SYNC_STEP1 && subtype !== SYNC_STEP2 && subtype !== SYNC_UPDATE) {
        return { kind: 'unknown', type };
      }
      return { kind: 'sync', subtype, decoder };
    }
    case MESSAGE_AWARENESS:
      return { kind: 'awareness', update: decoding.readVarUint8Array(decoder) };
    case MESSAGE_QUERY_AWARENESS:
      return { kind: 'queryAwareness' };
    case MESSAGE_AUTH:
      return { kind: 'auth' };
    default:
      return { kind: 'unknown', type };
  }
}
