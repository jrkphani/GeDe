// The read-path orchestrator (issue 032): subscribes one ElectricSQL shape
// per synced table, normalizes each message batch (electricProtocol.ts) into
// RowDeltas, and applies them into local PGlite (src/db/sync.ts). This module
// is the seam that ties the pure/tested pieces to a live connection — it is
// itself DI-testable via `streamFactory` (syncEngine.test.ts drives it with a
// fake stream; no live Electric server is reachable in this repo's tests,
// HANDOFF/issue 032 constraints) and is never called unless
// `src/sync/config.ts`'s isSyncEnabled() is true.
import { ShapeStream } from '@electric-sql/client'
import type { Database } from '../db/client'
import { applyInboundDeltas } from '../db/sync'
import { toRowDeltas, type ElectricMessage } from './electricProtocol'
import { SYNCED_TABLES, syncBaseUrl } from './config'
import { noAuth, type TokenProvider } from './authToken'
import type { RowDelta, TableName } from '../domain/syncDelta'

// A minimal structural subset of @electric-sql/client's ShapeStream — the
// seam a fake stream implements in tests instead of a live connection.
export interface ShapeStreamLike {
  subscribe(callback: (messages: readonly ElectricMessage[]) => void | Promise<void>): () => void
}

export type ShapeStreamFactory = (table: TableName, options: SyncOptions) => ShapeStreamLike

export interface SyncOptions {
  // The Electric server's shape endpoint base (defaults to config.ts's
  // syncBaseUrl()). Overridable for tests/alternate environments.
  baseUrl?: string
  // The identity seam (ADR-0009/issue 033): supplies the Cognito JWT to
  // attach to every shape request. Defaults to `noAuth` so 032 never
  // hard-depends on 033 having landed — see src/sync/authToken.ts.
  getAuthToken?: TokenProvider
  // Dependency injection point for tests — defaults to a real ShapeStream
  // per table against `baseUrl`.
  streamFactory?: ShapeStreamFactory
  // Called after each batch of deltas is successfully applied to PGlite —
  // the hook a store layer (future: src/store/sync.ts) uses to reconcile its
  // optimistic-write queue (src/domain/mutationQueue.ts) and surface sync
  // status (issue 036 renders it; 032 only exposes it).
  onApplied?: (table: TableName, deltas: readonly RowDelta[]) => void
  // Called if applying a batch throws — sync is additive/best-effort; a
  // malformed message or a transient DB error must never crash the app
  // (local-first: the user's own edits keep working regardless).
  onError?: (table: TableName, error: unknown) => void
}

function defaultShapeStreamFactory(table: TableName, options: SyncOptions): ShapeStreamLike {
  const getAuthToken = options.getAuthToken ?? noAuth
  const base = options.baseUrl ?? syncBaseUrl()
  return new ShapeStream({
    url: `${base}/v1/shape`,
    params: { table },
    headers: {
      Authorization: async () => {
        const token = await getAuthToken()
        return token ? `Bearer ${token}` : ''
      },
    },
    // Real ShapeStream's callback type (Message<T>[]) is a strict superset of
    // ElectricMessage — every field this app reads is present — so the
    // instance satisfies ShapeStreamLike structurally. Asserted once, here,
    // at the one boundary that touches the live library; everything else in
    // this package is Electric-agnostic and typed against our own interfaces.
  }) as unknown as ShapeStreamLike
}

export interface SyncHandle {
  stop(): void
}

export function startSync(db: Database, options: SyncOptions = {}): SyncHandle {
  const factory = options.streamFactory ?? defaultShapeStreamFactory
  const unsubscribes = SYNCED_TABLES.map((table) => {
    const stream = factory(table, options)
    return stream.subscribe((messages) => {
      let deltas: RowDelta[]
      try {
        deltas = toRowDeltas(table, messages)
      } catch (error) {
        options.onError?.(table, error)
        return
      }
      if (deltas.length === 0) return
      applyInboundDeltas(db, deltas)
        .then(() => options.onApplied?.(table, deltas))
        .catch((error: unknown) => options.onError?.(table, error))
    })
  })
  return {
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe()
    },
  }
}
