/**
 * Sync Client (ARCHITECTURE §1.3): y-websocket against
 * `wss://ws.gede.work/ws/:docId`, the access token offered as the
 * `bearer.<token>` subprotocol next to `gede.v1` (issue #32: a browser socket
 * cannot set headers, but a subprotocol list stays out of URLs, access logs
 * and history; the server selects `gede.v1` and never echoes the token).
 *
 * The provider is driven by hand rather than left to reconnect on its own:
 *   - every connect re-reads the access token from the session (AUTH-09 silent
 *     refresh) and offers it in a fresh subprotocol list;
 *   - reconnects back off exponentially with jitter (the provider's own backoff
 *     is deterministic and capped at 2.5 s);
 *   - the server's close codes are read: 4401 retries once with a token forced
 *     through Cognito's refresh; a second 4401 in the same sync-less window is
 *     terminal (the session is gone, not the token stale); 4403 / 4404 / 4400
 *     are terminal at once. Terminal closes surface as a failure the chrome
 *     shows (LOAD-05: only a failed sync surfaces anything);
 *   - the server's type-4 notice `{ code: 'read-only' }` (SHARE-03) flips
 *     `readOnly`, so a permission downgraded mid-session is shown, not
 *     discovered by edits that never echo;
 *   - the tab going hidden pauses the socket, coming back resumes it.
 *
 * Framework-free: the React hook (`use-document.ts`) subscribes to `snapshot`
 * with `useSyncExternalStore`. Nothing here imports the DOM beyond the
 * `WebSocket` constructor, which tests replace with a fake.
 */
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';

import { backoffDelay } from '../api/client.js';

export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'reconnecting';

/** A close the server chose deliberately; reconnecting will not help without a change. */
export interface SyncFailure {
  readonly code: number;
  readonly reason: string;
  /** Decided on this device (no token to send) rather than by the server. */
  readonly local?: boolean | undefined;
}

export interface SyncSnapshot {
  readonly status: SyncStatus;
  readonly failure: SyncFailure | null;
  /** Consecutive unsuccessful attempts since the last sync. */
  readonly attempts: number;
  /** Has this session ever completed a sync? Drives 'connecting' vs 'reconnecting'. */
  readonly everSynced: boolean;
  /** The server said this socket is view-only (type-4 notice): its updates are dropped. */
  readonly readOnly: boolean;
}

/** GeDe's one addition to the wire format: server → client notices. */
export const MESSAGE_NOTICE = 4;

export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHENTICATED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;

/** The subprotocol the server selects; `bearer.<token>` rides beside it. */
export const WS_SUBPROTOCOL = 'gede.v1';

/** `Sec-WebSocket-Protocol` entries for one connect attempt (issue #32). */
export function wsProtocols(token: string): string[] {
  return [WS_SUBPROTOCOL, `bearer.${token}`];
}

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
  /** Forced refresh, used for the one retry after a 4401. Defaults to `getToken`. */
  refreshToken?: (() => Promise<string | null>) | undefined;
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
    readOnly: false,
  };
  private readonly listeners = new Set<Listener>();
  private wanted = false;
  private paused = false;
  private destroyed = false;
  private unauthenticatedRetries = 0;
  /** The next attempt must fetch a forced-refresh token (after a 4401). */
  private forceRefresh = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectSeq = 0;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly getToken: () => Promise<string | null>;
  private readonly refreshToken: () => Promise<string | null>;

  constructor(options: SyncClientOptions) {
    this.getToken = options.getToken;
    this.refreshToken = options.refreshToken ?? options.getToken;
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
    // The stock provider only knows types 0–3; GeDe's type 4 carries notices.
    this.provider.messageHandlers[MESSAGE_NOTICE] = (_encoder, decoder) => {
      this.onNotice(decoder);
    };
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
      next.everSynced === this.snapshot.everSynced &&
      next.readOnly === this.snapshot.readOnly
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
    const fetchToken = this.forceRefresh ? this.refreshToken : this.getToken;
    this.forceRefresh = false;
    try {
      token = await fetchToken();
    } catch {
      token = null;
    }
    if (this.stale(seq)) return;
    if (token === null) {
      this.set({
        status: 'offline',
        failure: { code: CLOSE_UNAUTHENTICATED, reason: 'signed out', local: true },
      });
      return;
    }
    // y-websocket 3.x passes `protocols` to every `new WebSocket(url, protocols)`.
    this.provider.protocols = wsProtocols(token);
    this.provider.connect();
  }

  private readonly onSync = (synced: boolean): void => {
    if (!synced) return;
    // A sync closes the 4401 window: the refreshed token was accepted.
    this.unauthenticatedRetries = 0;
    this.set({ status: 'synced', failure: null, attempts: 0, everSynced: true });
  };

  private onNotice(decoder: decoding.Decoder): void {
    let notice: unknown;
    try {
      notice = JSON.parse(decoding.readVarString(decoder));
    } catch {
      return;
    }
    if (
      typeof notice === 'object' &&
      notice !== null &&
      (notice as { code?: unknown }).code === 'read-only'
    ) {
      this.set({ readOnly: true });
    }
  }

  private readonly onClose = (event: CloseEvent | null): void => {
    if (this.destroyed || !this.wanted || this.paused) return;
    // Whatever happens next is ours to decide; the provider must not reconnect.
    this.provider.shouldConnect = false;

    const code = event?.code ?? 0;
    if (
      code === CLOSE_UNAUTHENTICATED &&
      this.unauthenticatedRetries < MAX_UNAUTHENTICATED_RETRIES
    ) {
      // The token we offered was stale. Force a refresh and try immediately, once per window.
      this.unauthenticatedRetries += 1;
      this.forceRefresh = true;
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
