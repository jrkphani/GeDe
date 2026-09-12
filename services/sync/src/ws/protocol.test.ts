import * as encoding from 'lib0/encoding';
import { describe, expect, test } from 'vitest';

import { decodeMessage, decodeNotice, encodeNotice, MESSAGE_NOTICE } from './protocol.js';

describe('type 4 notice', () => {
  test('SHARE-03 encodes as varUint(4) + varString(JSON) and round-trips', () => {
    const bytes = encodeNotice({ code: 'read-only' });
    expect(bytes[0]).toBe(MESSAGE_NOTICE);
    expect(Buffer.from(bytes.subarray(2)).toString('utf8')).toBe('{"code":"read-only"}');
    expect(decodeNotice(bytes)).toEqual({ code: 'read-only' });
  });

  test('SHARE-03 anything that is not a well-formed notice decodes to undefined', () => {
    const tagged = (type: number, body: string) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, type);
      encoding.writeVarString(e, body);
      return encoding.toUint8Array(e);
    };
    expect(decodeNotice(tagged(0, '{"code":"read-only"}'))).toBeUndefined();
    expect(decodeNotice(tagged(MESSAGE_NOTICE, 'not json'))).toBeUndefined();
    expect(decodeNotice(tagged(MESSAGE_NOTICE, '{"code":"other"}'))).toBeUndefined();
    expect(decodeNotice(tagged(MESSAGE_NOTICE, '[]'))).toBeUndefined();
  });

  test('SHARE-03 the server never accepts a type 4 from a client: it decodes as unknown', () => {
    expect(decodeMessage(encodeNotice({ code: 'read-only' }))).toEqual({
      kind: 'unknown',
      type: MESSAGE_NOTICE,
    });
  });
});
