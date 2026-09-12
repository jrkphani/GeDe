import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, test } from 'vitest';

import { REDACTED_PATHS, redactTokenParam, requestSerializer } from './logger.js';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig-nature_x';

/** A pino instance configured exactly as `main.ts` configures the production logger. */
function productionShapedLogger(lines: string[]) {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return pino(
    {
      level: 'info',
      serializers: { req: requestSerializer },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    sink,
  );
}

describe('logger redaction (issue #34)', () => {
  test('AUTH-01 redactTokenParam strips only the token value, wherever it sits in the query', () => {
    expect(redactTokenParam(`/ws/abc?token=${TOKEN}`)).toBe('/ws/abc?token=[redacted]');
    expect(redactTokenParam(`/ws/abc?x=1&token=${TOKEN}&y=2`)).toBe(
      '/ws/abc?x=1&token=[redacted]&y=2',
    );
    expect(redactTokenParam(`/ws/abc?TOKEN=${TOKEN}#frag`)).toBe('/ws/abc?TOKEN=[redacted]#frag');
    expect(redactTokenParam('/ws/abc?tokens=1')).toBe('/ws/abc?tokens=1');
    expect(redactTokenParam('/api/documents')).toBe('/api/documents');
  });

  test('AUTH-01 a logged request never carries a token from the query string (unread since #63) or from the headers', () => {
    const lines: string[] = [];
    const logger = productionShapedLogger(lines);
    const request = {
      method: 'GET',
      url: `/ws/6f1b2c3d-0000-4000-8000-00000000e2e0?token=${TOKEN}`,
      host: 'ws.gede.work',
      ip: '203.0.113.7',
      socket: { remotePort: 51234 },
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'sec-websocket-protocol': `gede.v1, bearer.${TOKEN}`,
        origin: 'https://gede.work',
      },
    };

    // What Fastify logs for every request: the `req` serializer, which drops the headers.
    logger.info({ req: request }, 'incoming request');
    // What a careless call site might log: the raw headers, alone or under `req`.
    logger.info({ headers: request.headers }, 'raw headers');
    logger.info({ req: { headers: request.headers } }, 'raw request');

    expect(lines).toHaveLength(3);
    const [incoming, rawHeaders, rawRequest] = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(incoming?.req).toEqual({
      method: 'GET',
      url: '/ws/6f1b2c3d-0000-4000-8000-00000000e2e0?token=[redacted]',
      host: 'ws.gede.work',
      remoteAddress: '203.0.113.7',
      remotePort: 51234,
    });
    expect(rawHeaders?.headers).toEqual({
      authorization: '[redacted]',
      'sec-websocket-protocol': '[redacted]',
      origin: 'https://gede.work',
    });
    // A partial object under `req` still goes through the serializer, which
    // keeps only the five request fields and must not throw on what is missing.
    expect(rawRequest?.req).toEqual({ url: '' });
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });
});
