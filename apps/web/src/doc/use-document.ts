/**
 * `useDocument(docId)`: one Y.Doc per open document, persisted to IndexedDB
 * first (offline-first, LOAD-06) and synced through the WebSocket provider
 * behind it. The Yjs document is the document state; this hook only hands
 * out the handle and the sync status.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  createUndoManager,
  ensureFirstSheet,
  openDocument,
  seedMeta,
  type GedeDoc,
} from '@gede/core';

import { announce } from '../announce.js';
import { accessToken } from '../auth/cognito.js';
import { getConfig } from '../config.js';
import { createSyncClient, type SyncClient, type SyncSnapshot } from './sync-client.js';

export interface DocumentSession {
  readonly docId: string;
  readonly gd: GedeDoc;
  readonly sync: SyncClient;
  readonly undo: Y.UndoManager;
  /** The local replica; null where IndexedDB is unavailable (some private windows). */
  readonly persistence: IndexeddbPersistence | null;
}

export interface UseDocumentOptions {
  /** Server-side record the document is seeded from on its very first sync. */
  seed: { title: string; createdAt?: string | undefined } | null;
  /** Test seams; production wiring reads config and the session. */
  wsUrl?: string | undefined;
  getToken?: (() => Promise<string | null>) | undefined;
  WebSocketImpl?: typeof WebSocket | undefined;
  /** Name the IndexedDB store; tests keep it unique per case. */
  storeName?: ((docId: string) => string) | undefined;
}

export type ReplicaState = 'loading' | 'ready' | 'unavailable';

export interface UseDocumentResult {
  session: DocumentSession | null;
  sync: SyncSnapshot;
  /** True once the local replica or the server has delivered the document (skeleton off). */
  ready: boolean;
  /** Whether the IndexedDB replica has opened; edits before that are not yet on disk. */
  replica: ReplicaState;
}

const IDLE: SyncSnapshot = { status: 'connecting', failure: null, attempts: 0, everSynced: false };
const noSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE;

export const STATUS_ANNOUNCEMENTS: Record<SyncSnapshot['status'], string> = {
  connecting: 'Connecting',
  synced: 'Synced',
  reconnecting: 'Reconnecting',
  offline: 'Offline. Work is saved on this device',
};

export function storeNameFor(docId: string): string {
  return `gede-doc-${docId}`;
}

type Seams = Pick<UseDocumentOptions, 'wsUrl' | 'getToken' | 'WebSocketImpl' | 'storeName'>;
let testSeams: Seams | null = null;

/** Test seam: route every document opened by the shell through fakes (labelled as such in tests). */
export function setDocumentSeamsForTests(seams: Seams | null): void {
  testSeams = seams;
}

export function useDocument(docId: string, options: UseDocumentOptions): UseDocumentResult {
  const [session, setSession] = useState<DocumentSession | null>(null);
  const [ready, setReady] = useState(false);
  const [replica, setReplica] = useState<ReplicaState>('loading');
  const seedTitle = options.seed?.title ?? null;
  const seedCreatedAt = options.seed?.createdAt ?? null;
  // The seams are read when the session opens; changing them later does not reopen it.
  const seams = useRef(options);
  seams.current = options;

  useEffect(() => {
    if (docId === '' || seedTitle === null) return undefined;
    const opts = seams.current;
    const wsUrl = opts.wsUrl ?? testSeams?.wsUrl;
    const getToken = opts.getToken ?? testSeams?.getToken;
    const WebSocketImpl = opts.WebSocketImpl ?? testSeams?.WebSocketImpl;
    const storeName = opts.storeName ?? testSeams?.storeName;
    const doc = new Y.Doc({ gc: true });
    const gd = openDocument(doc);
    const undo = createUndoManager(gd);
    const persistence =
      typeof indexedDB === 'undefined'
        ? null
        : new IndexeddbPersistence((storeName ?? storeNameFor)(docId), doc);
    const sync = createSyncClient({
      docId,
      doc,
      wsUrl: wsUrl ?? getConfig().wsUrl,
      getToken: getToken ?? accessToken,
      WebSocketImpl,
    });
    const next: DocumentSession = { docId, gd, sync, undo, persistence };
    let disposed = false;
    let seeded = false;

    const seedOnce = () => {
      if (seeded || disposed) return;
      seeded = true;
      seedMeta(gd, {
        title: seedTitle,
        ...(seedCreatedAt === null ? {} : { createdAt: seedCreatedAt }),
      });
      ensureFirstSheet(gd);
    };
    const onLocalLoaded = () => {
      if (disposed) return;
      setReplica('ready');
      // A replica that already carries a sheet was opened online before: render it now,
      // offline or not. An empty store says nothing yet; the skeleton waits for the server.
      if (gd.sheets.length > 0) {
        seeded = true;
        setReady(true);
      }
    };
    const onSync = (synced: boolean) => {
      if (!synced || disposed) return;
      seedOnce();
      setReady(true);
    };
    persistence?.on('synced', onLocalLoaded);
    sync.provider.on('sync', onSync);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sync.pause();
      else sync.resume();
    };
    const onOnline = () => {
      sync.setOnline(true);
    };
    const onOffline = () => {
      sync.setOnline(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    setSession(next);
    setReady(false);
    setReplica(persistence === null ? 'unavailable' : 'loading');
    sync.connect();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      persistence?.off('synced', onLocalLoaded);
      sync.provider.off('sync', onSync);
      sync.destroy();
      void persistence?.destroy();
      undo.destroy();
      doc.destroy();
      setSession((current) => (current === next ? null : current));
    };
  }, [docId, seedTitle, seedCreatedAt]);

  const snapshot = useSyncExternalStore(
    session?.sync.subscribe ?? noSubscribe,
    session?.sync.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );

  // A11Y-05: sync status announces through the polite live region.
  useEffect(() => {
    if (session === null) return;
    announce(STATUS_ANNOUNCEMENTS[snapshot.status]);
  }, [session, snapshot.status]);

  return { session, sync: snapshot, ready, replica };
}
