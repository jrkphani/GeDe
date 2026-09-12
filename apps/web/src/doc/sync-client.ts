/**
 * Sync Client (ARCHITECTURE §1.3): y-websocket against
 * `wss://ws.gede.work/ws/:docId?token=<access JWT>`.
 *
 * The provider is driven by hand rather than left to reconnect on its own:
 *   - every connect re-reads the access token from the session (AUTH-09 silent
 *     refresh; the query string is the only place a browser socket can carry it);
 *   - reconnects back off exponentially with jitter (the provider's own backoff
 *     is deterministic and capped at 2.5 s);
 *   - the server's close codes are read: 4401 retries once with a fresh token,
 *     4403 / 4404 / 4400 are terminal and surface as a failure the chrome can
 *     show with a Retry (LOAD-05: only a failed sync surfaces anything);
 *   - the tab going hidden pauses the socket, coming back resumes it.
 *
 * Framework-free: the React hook (`use-document.ts`) subscribes to `snapshot`
 * with `useSyncExternalStore`. Nothing here imports the DOM beyond the
 * `WebSocket` constructor, which tests replace with a fake.
 */
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';

import { backoffDelay } from '../api/client.js';

export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'reconnecting';

/** A close the server chose deliberately; reconnecting will not help without a change. */
export interface SyncFailure {
  readonly code: number;
  readonly reason: string;
}

export interface SyncSnapshot {
  readonly status: SyncStatus;
  readonly failure: SyncFailure | null;
  /** Consecutive unsuccessful attempts since the last sync. */
  readonly attempts: number;
  /** Has this session ever completed a sync? Drives 'connecting' vs 'reconnecting'. */
  readonly everSynced: boolean;
}

export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHENTICATED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;

/** After this many consecutive failures the status reads 'offline' (the banner appears). */
export const OFFLINE_AFTER_ATTEMPTS = 3;
export const MAX_BACKOFF_MS = 30_000;
/** A second 4401 in a row means the session is gone, not the token stale. */
const MAX_UNAUTHENTICATED_RETRIES = 1;

export interface SyncClientOptions {
  docId: string;
  doc: Y.Doc;
  /** `config.wsUrl`, e.g. `wss://ws.gede.work/ws`. */
  wsUrl: string;
  /** Re-read on every connect. `null` means signed out. */
  getToken: () => Promise<string | null>;
  /** Test seams. */
  WebSocketImpl?: typeof WebSocket | undefined;
  random?: (() => number) | undefined;
  isOnline?: (() => boolean) | undefined;
}

type Listener = () => void;

export class SyncClient {
  readonly awareness: Awareness;
  readonly provider: WebsocketProvider;

  private snapshot: SyncSnapshot = {
    status: 'connecting',
    failure: null,
    attempts: 0,
    everSynced: false,
  };
  private readonly listeners = new Set<Listener>();
  private wanted = false;
  private paused = false;
  private destroyed = false;
  private unauthenticatedRetries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectSeq = 0;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly getToken: () => Promise<string | null>;

  constructor(options: SyncClientOptions) {
    this.getToken = options.getToken;
    this.random = options.random ?? Math.random;
    this.isOnline =
      options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.awareness = new Awareness(options.doc);
    this.provider = new WebsocketProvider(options.wsUrl, options.docId, options.doc, {
      connect: false,
      awareness: this.awareness,
      params: {},
      disableBc: true,
      // Never let the provider decide; every close goes through `onClose` below.
      shouldReconnect: () => false,
      ...(options.WebSocketImpl === undefined ? {} : { WebSocketPolyfill: options.WebSocketImpl }),
    });
    this.provider.on('sync', this.onSync);
    this.provider.on('connection-close', this.onClose);
  }

  // -- external store -------------------------------------------------------

  getSnapshot = (): SyncSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<SyncSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (
      next.status === this.snapshot.status &&
      next.failure === this.snapshot.failure &&
      next.attempts === this.snapshot.attempts &&
      next.everSynced === this.snapshot.everSynced
    ) {
      return;
    }
    this.snapshot = next;
    this.listeners.forEach((l) => {
      l();
    });
  }

  // -- lifecycle ------------------------------------------------------------

  /** Start (or resume) connecting. Idempotent. */
  connect(): void {
    if (this.destroyed) return;
    this.wanted = true;
    this.paused = false;
    if (this.provider.wsconnected || this.provider.wsconnecting) return;
    this.schedule(0);
  }

  /** Stop and stay stopped until `connect()`. */
  disconnect(): void {
    this.wanted = false;
    this.clearTimer();
    this.closeSocket();
  }

  /** The tab went to the background: drop the socket, keep the intent. */
  pause(): void {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    this.clearTimer();
    this.closeSocket();
  }

  /** The tab is visible again: reconnect at once with a fresh token. */
  resume(): void {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    if (this.snapshot.status === 'synced') this.set({ status: 'reconnecting' });
    this.schedule(0);
  }

  /** The user pressed Retry: forget the failure and the backoff, connect now. */
  retry(): void {
    if (this.destroyed) return;
    this.unauthenticatedRetries = 0;
    this.set({
      failure: null,
      attempts: 0,
      status: this.snapshot.everSynced ? 'reconnecting' : 'connecting',
    });
    this.wanted = true;
    this.paused = false;
    this.clearTimer();
    this.closeSocket();
    this.schedule(0);
  }

  /** The browser reported a change in connectivity. */
  setOnline(online: boolean): void {
    if (!this.wanted || this.paused) return;
    if (online) {
      if (this.snapshot.failure !== null) return;
      if (this.provider.synced) {
        // The socket survived the blip; nothing to reconnect.
        this.set({ status: 'synced' });
        return;
      }
      this.clearTimer();
      this.schedule(0);
    } else {
      this.set({ status: 'offline' });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.wanted = false;
    this.clearTimer();
    this.provider.off('sync', this.onSync);
    this.provider.off('connection-close', this.onClose);
    this.provider.destroy();
    this.awareness.destroy();
    this.listeners.clear();
  }

  // -- internals ------------------------------------------------------------

  private closeSocket(): void {
    // `disconnect()` closes the socket and emits `connection-close` synchronously;
    // `paused`/`wanted` are already set so `onClose` ignores that echo.
    const wasPaused = this.paused;
    this.paused = true;
    this.provider.disconnect();
    this.paused = wasPaused;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    const seq = ++this.connectSeq;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt(seq);
    }, delayMs);
  }

  /** True when this attempt no longer matters: destroyed, paused, stopped, or superseded. */
  private stale(seq: number): boolean {
    return this.destroyed || !this.wanted || this.paused || seq !== this.connectSeq;
  }

  private async attempt(seq: number): Promise<void> {
    if (this.stale(seq)) return;
    if (!this.isOnline()) {
      this.set({ status: 'offline' });
      return;
    }
    let token: string | null;
    try {
      token = await this.getToken();
    } catch {
      token = null;
    }
    if (this.stale(seq)) return;
    if (token === null) {
      this.set({
        status: 'offline',
        failure: { code: CLOSE_UNAUTHENTICATED, reason: 'signed out' },
      });
      return;
    }
    this.provider.params = { token };
    this.provider.connect();
  }

  private readonly onSync = (synced: boolean): void => {
    if (!synced) return;
    this.unauthenticatedRetries = 0;
    this.set({ status: 'synced', failure: null, attempts: 0, everSynced: true });
  };

  private readonly onClose = (event: CloseEvent | null): void => {
    if (this.destroyed || !this.wanted || this.paused) return;
    // Whatever happens next is ours to decide; the provider must not reconnect.
    this.provider.shouldConnect = false;

    const code = event?.code ?? 0;
    if (
      code === CLOSE_UNAUTHENTICATED &&
      this.unauthenticatedRetries < MAX_UNAUTHENTICATED_RETRIES
    ) {
      // The token in the URL was stale. Fetch a fresh one and try immediately, once.
      this.unauthenticatedRetries += 1;
      this.set({ status: this.snapshot.everSynced ? 'reconnecting' : 'connecting' });
      this.schedule(0);
      return;
    }
    if (code >= 4400 && code < 4500) {
      this.set({
        status: 'offline',
        failure: { code, reason: event?.reason ?? '' },
      });
      return;
    }

    const attempts = this.snapshot.attempts + 1;
    const status: SyncStatus =
      !this.isOnline() || attempts >= OFFLINE_AFTER_ATTEMPTS
        ? 'offline'
        : this.snapshot.everSynced
          ? 'reconnecting'
          : 'connecting';
    this.set({ status, attempts });
    this.schedule(Math.min(MAX_BACKOFF_MS, backoffDelay(attempts, this.random)));
  };
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClient(options);
}
