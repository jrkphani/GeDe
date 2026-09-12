/**
 * FAKES for tests: a token verifier backed by a Map, an S3 store backed by a
 * Map, a silent logger, and a `startServer` helper that boots `buildServer`
 * on an ephemeral port with all of them injected.
 */
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import pino from 'pino';

import { type Config, configSchema } from '../config.js';
import type { Deps, IdTokenIdentity, Mailer, SnapshotStore, TokenVerifier } from '../deps.js';
import { REDACTED_PATHS, requestSerializer } from '../logger.js';
import type { Mail } from '../mail/templates.js';
import type { TokenIdentity } from '../repo/types.js';
import { buildServer, type SyncServer } from '../server.js';
import { FakeRepo } from './fake-repo.js';

export const WEB_ORIGIN = 'https://gede.test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...configSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      COGNITO_USER_POOL_ID: 'ap-southeast-1_TEST',
      COGNITO_CLIENT_IDS: 'test-client',
      COGNITO_REGION: 'ap-southeast-1',
      DOCS_BUCKET: 'gede-docs-test',
      DOCS_PREFIX: 'docs',
      WEB_ORIGIN,
      SNAPSHOT_EVERY_UPDATES: '3',
      SNAPSHOT_IDLE_MS: '60000',
      ROOM_IDLE_MS: '60000',
      PERSIST_COALESCE_MS: '10',
    }),
    ...overrides,
  };
}

/**
 * FAKE verifier: `tokens` maps a bearer string to the identity it stands for,
 * `idTokens` an ID-token string to what it attests. The two are separate maps,
 * as the real verifier is two verifiers: an access token is never accepted as
 * an ID token or the other way round.
 */
export class FakeVerifier implements TokenVerifier {
  readonly tokens = new Map<string, TokenIdentity>();
  readonly idTokens = new Map<string, IdTokenIdentity>();

  issue(token: string, sub: string, email: string | null = null): string {
    this.tokens.set(token, { sub, email });
    return token;
  }

  /** An ID token for `sub` attesting `email` (verified), or none when `email` is null. */
  issueId(token: string, sub: string, email: string | null): string {
    this.idTokens.set(token, { sub, email });
    return token;
  }

  verify(token: string): Promise<TokenIdentity> {
    const identity = this.tokens.get(token);
    return identity ? Promise.resolve(identity) : Promise.reject(new Error('invalid token'));
  }

  verifyIdToken(token: string): Promise<IdTokenIdentity> {
    const identity = this.idTokens.get(token);
    return identity ? Promise.resolve(identity) : Promise.reject(new Error('invalid id token'));
  }
}

/** FAKE SES: records every message; `failNextSend` makes one send reject as the sandbox would for an unverified recipient. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  failNextSend = false;

  send(mail: Mail): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      return Promise.reject(new Error('MessageRejected: Email address is not verified'));
    }
    this.sent.push(mail);
    return Promise.resolve();
  }
}

/** FAKE S3: a Map of key → bytes. */
export class FakeSnapshotStore implements SnapshotStore {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  /** Set to make every `put` fail (an S3 outage during a compaction). */
  failPuts = false;

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.puts += 1;
    if (this.failPuts) return Promise.reject(new Error('simulated S3 put failure'));
    this.objects.set(key, new Uint8Array(bytes));
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(key));
  }

  /** Set to make the next `deletePrefix` fail (the purge must still have committed). */
  failNextDelete = false;

  deletePrefix(prefix: string): Promise<number> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      return Promise.reject(new Error('simulated S3 failure'));
    }
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

/** One parsed pino line, as the production logger would emit it. */
export type LogLine = Record<string, unknown> & { level: number; msg?: string };

export interface TestServer {
  app: SyncServer;
  repo: FakeRepo;
  verifier: FakeVerifier;
  s3: FakeSnapshotStore;
  mail: FakeMailer;
  config: Config;
  baseUrl: string;
  wsUrl: string;
  /** Every log line at `info` and above, when `startServer` was given `{ captureLogs: true }`. */
  logs: LogLine[];
  close(): Promise<void>;
}

export interface StartOptions {
  /** Record log lines (with the production serializers and redaction) instead of discarding them. */
  captureLogs?: boolean | undefined;
}

/** The production logger's shape — same serializers and redaction as `main.ts` — into an array. */
function capturingLogger(lines: LogLine[]) {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line) as LogLine);
      }
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

export async function startServer(
  overrides: Partial<Config> = {},
  options: StartOptions = {},
): Promise<TestServer> {
  const config = testConfig(overrides);
  const repo = new FakeRepo();
  const verifier = new FakeVerifier();
  const s3 = new FakeSnapshotStore();
  const mail = new FakeMailer();
  const logs: LogLine[] = [];
  const deps: Deps = {
    config,
    logger: options.captureLogs === true ? capturingLogger(logs) : pino({ level: 'silent' }),
    verifier,
    db: repo,
    s3,
    mail,
    version: 'test',
  };
  const app = await buildServer(deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    repo,
    verifier,
    s3,
    mail,
    config,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    wsUrl: `ws://127.0.0.1:${String(port)}`,
    logs,
    close: () => app.close(),
  };
}

// Test helper: the caller names the response shape it is about to assert on. The
// type parameter is a deliberate, explicit cast at the call site — the same thing
// `as T` after `response.json()` would do, without repeating it in every test.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function json<T = unknown>(
  server: TestServer,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const headers: Record<string, string> = { origin: WEB_ORIGIN };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const text = await response.text();
  const body = (text === '' ? null : JSON.parse(text)) as T;
  return { status: response.status, body, headers: response.headers };
}
