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
 *
 * On connect the server sends a syncStep1 and, when anyone is present, one
 * awareness message with all states — exactly what `y-websocket/bin/utils`
 * does.
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
