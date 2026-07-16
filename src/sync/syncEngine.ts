// The read-path orchestrator (issue 032): subscribes one ElectricSQL shape
// per synced table, normalizes each message batch (electricProtocol.ts) into
// RowDeltas, and applies them into local PGlite (src/db/sync.ts). This module
// is the seam that ties the pure/tested pieces to a live connection — it is
// itself DI-testable via `streamFactory` (syncEngine.test.ts drives it with a
// fake stream; no live Electric server is reachable in this repo's tests,
// HANDOFF/issue 032 constraints) and is never called unless
// `src/sync/config.ts`'s isSyncEnabled() is true.
import { FetchBackoffAbortError, FetchError, ShapeStream } from '@electric-sql/client'
import type { Database } from '../db/client'
import { applyInboundDeltas } from '../db/sync'
import {
  isElectricChangeMessage,
  toRowDeltas,
  type ElectricControlMessage,
  type ElectricMessage,
} from './electricProtocol'
import { SYNCED_TABLES, syncBaseUrl } from './config'
import { noAuth, type TokenProvider } from './authToken'
import type { RowDelta, TableName } from '../domain/syncDelta'
import { ENVELOPE_TABLE_NAMES } from '../domain/projectEnvelope'

// Issue 075 Part A — the FK-dependency apply order for the reconcile-retry
// buffer below (see startSync's own doc comment). Mirrors the parent-before-
// child order the docs/issues/075 fix prescribes: ENVELOPE_TABLE_NAMES'
// existing registry order (projects -> tier1_*/tier2_tables -> tier2_entries
// -> dimensions -> parameters -> contexts -> bindings), plus the two
// sync-only tables appended at the end — neither `invitations` nor
// `workspace_members` carries a forward FK to any OTHER synced table (both
// `workspace_id`s point outward at `workspaces`, which isn't itself synced),
// so their position relative to the nine envelope tables never matters for
// convergence.
const RETRY_APPLY_ORDER: readonly TableName[] = [...ENVELOPE_TABLE_NAMES, 'invitations', 'workspace_members']

// Sorts a set of buffered deltas into RETRY_APPLY_ORDER so a single retry
// batch applies parents before children — not a guarantee of success (a
// child-canvas dimension's nullable `context_id` isn't covered by this single
// linear order, since dimensions precedes contexts in it), just a good-faith
// ordering that resolves the common cases in one pass; anything left over
// simply stays buffered for the NEXT successful apply to retry again (see
// drainRetryBuffer below) — convergence never depends on getting the order
// perfect in one shot.
function byRetryApplyOrder(deltas: readonly RowDelta[]): RowDelta[] {
  const rank = new Map(RETRY_APPLY_ORDER.map((name, i) => [name, i]))
  return [...deltas].sort((a, b) => (rank.get(a.table) ?? RETRY_APPLY_ORDER.length) - (rank.get(b.table) ?? RETRY_APPLY_ORDER.length))
}

function groupByTable(deltas: readonly RowDelta[]): Map<TableName, RowDelta[]> {
  const out = new Map<TableName, RowDelta[]>()
  for (const delta of deltas) {
    const list = out.get(delta.table) ?? []
    list.push(delta)
    out.set(delta.table, list)
  }
  return out
}

// A minimal structural subset of @electric-sql/client's ShapeStream — the
// seam a fake stream implements in tests instead of a live connection. The
// optional second `onError` mirrors the real ShapeStream.subscribe(cb, onError)
// signature (issue 086): Electric surfaces TRANSPORT/AUTH errors (a boot-race
// 401, an aborted long-poll — a FetchError/FetchBackoffAbortError) through this
// callback, distinct from the apply/parse errors startSync raises itself. Both
// funnel into SyncOptions.onError; the store classifies them (isIgnorableRead-
// Error) so the transient ones never reach the "Sync error" banner.
export interface ShapeStreamLike {
  subscribe(
    callback: (messages: readonly ElectricMessage[]) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): () => void
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
  // Called for each Electric control message (`up-to-date`, `must-refetch`,
  // `snapshot-end`, `subset-end`) on a table's shape — the seam 032 left for
  // this ("syncEngine.ts owns reacting to those"). Issue 036 uses `up-to-date`
  // per-table to know when a shape has fully caught up (the "synced" vs
  // "syncing" distinction) — never fires for a change message, and never
  // implies onApplied (a control-only batch carries no RowDelta).
  onControl?: (table: TableName, control: ElectricControlMessage['headers']['control']) => void
}

// Issue 086 — the read-error classification boundary the store (src/store/
// sync.ts) uses to keep the "Sync error" banner calm. Returns true for errors
// that must be HARD-IGNORED (never even debounced), because they are expected/
// transient and self-heal on their own:
//   - the pre-signin BOOT-RACE: a shape request fires before the Cognito token
//     is attached, so the shape proxy 401/403s (`missing_token`); it clears the
//     instant the user is signed in (src/store/sync.ts wires the real JWT).
//   - TRANSIENT TRANSPORT Electric retries itself: an aborted long-poll or a
//     closed socket on a live stream (FetchBackoffAbortError / AbortError /
//     net::ERR_ABORTED) — normal churn, not a failure.
// Everything else — a MalformedElectricMessageError parse throw, a genuine
// PGlite FK/constraint apply failure, the synthetic orphaned-row Error
// (maybeSurfaceOrphaned below), a 5xx server outage — is NOT ignorable: the
// store debounces it and surfaces the banner only if it stays unresolved past
// SYNC_ERROR_GRACE_MS. The transient boot-time cross-table FK race (075) throws
// the SAME PGlite shape as a genuine orphan and so is deliberately NOT
// classified apart here — the store's grace window separates them by time (the
// race self-heals within it; a true orphan does not), which is exactly the
// "debounce everything, hard-ignore only the boot-race/transport" resolution
// docs/issues/086's Open tension prescribes.
export function isIgnorableReadError(error: unknown): boolean {
  // Boot-race / auth-not-yet-resolved: Electric retries these with backoff and
  // they clear once the token attaches (401/403), or carry the proxy's
  // explicit `missing_token` reason.
  if (error instanceof FetchError && (error.status === 401 || error.status === 403)) return true
  // Transient transport Electric self-retries.
  if (error instanceof FetchBackoffAbortError) return true
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    const message = error.message
    if (/missing_token/i.test(message)) return true
    if (/\baborted\b/i.test(message) || /ERR_ABORTED/i.test(message)) return true
  }
  return false
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

  // Issue 075 Part A — the confirmed root cause: this function opens one
  // INDEPENDENT ShapeStream per table (the loop below), each applying its own
  // batch in its own db.transaction (src/db/sync.ts) the instant THAT
  // table's network response resolves — no cross-table ordering. A forward
  // FK to a sibling synced table (parameters.dimension_id, bindings.*, the
  // real, NOT-NULL, NOT-deferred FKs docs/issues/075 names) can therefore
  // resolve before its parent has committed, and applyInboundDeltas
  // correctly throws + rolls the whole batch back (db/sync.test.ts's
  // "cross-table forward-FK race" test pins that this is intentional and
  // must stay true). Previously the batch was then just dropped — Electric
  // never re-delivers an acked message, so those rows were permanently
  // missing for the rest of the session.
  //
  // The fix: buffer a failed batch's deltas here (scoped to this startSync
  // call — a fresh buffer every time sync (re)starts, cleared on stop()) and
  // retry them, sorted parent-before-child (byRetryApplyOrder above), after
  // every SUBSEQUENT successful apply of ANY table. This is orchestration ON
  // TOP of applyInboundDeltas — that function's own per-call transaction/
  // atomicity is completely unchanged; drainRetryBuffer below just calls it
  // again with the buffered deltas.
  //
  // Termination: a retry is only ever triggered by a NEW successful apply
  // (drainRetryBuffer is called from the .then() of a successful
  // applyInboundDeltas, never from a timer or from itself) — a batch that
  // still fails just stays buffered for the NEXT success to try again. Once
  // every SYNCED_TABLES table has reported its shape caught up
  // ('up-to-date') and the buffer is STILL non-empty, maybeSurfaceOrphaned
  // below concludes those rows are genuinely orphaned (not racing a
  // still-arriving parent) and surfaces the real error via onError exactly
  // once per table, then clears them from the buffer — no infinite retry,
  // no silent permanent drop either.
  let retryBuffer: RowDelta[] = []
  const upToDateTables = new Set<TableName>()

  function maybeSurfaceOrphaned(): void {
    if (retryBuffer.length === 0) return
    if (upToDateTables.size < SYNCED_TABLES.length) return
    const orphaned = retryBuffer
    retryBuffer = []
    for (const [table, deltas] of groupByTable(orphaned)) {
      options.onError?.(
        table,
        new Error(
          `${deltas.length} buffered "${table}" row(s) never resolved their FK dependency after every synced table reported up-to-date — treating as orphaned, not a transient race`,
        ),
      )
    }
  }

  async function drainRetryBuffer(): Promise<void> {
    if (retryBuffer.length === 0) return
    const batch = byRetryApplyOrder(retryBuffer)
    try {
      await applyInboundDeltas(db, batch)
      // Remove ONLY the deltas we just snapshotted+applied — never clear the
      // buffer wholesale. Multiple shape streams apply concurrently and this
      // `await` is a real DB transaction, so ANOTHER table's failed batch can
      // hit its `.catch` and concat itself onto `retryBuffer` DURING this
      // await (exactly the burst race this whole fix targets). A wholesale
      // `retryBuffer = []` here would silently drop those just-buffered
      // deltas — permanently, since Electric never re-delivers an acked
      // batch. `batch` holds the SAME delta object references that were in
      // `retryBuffer`, so reference-identity removal keeps anything that
      // arrived mid-drain buffered for the next drain.
      const applied = new Set(batch)
      retryBuffer = retryBuffer.filter((delta) => !applied.has(delta))
      for (const [table, deltas] of groupByTable(batch)) options.onApplied?.(table, deltas)
    } catch {
      // Still missing a parent (or genuinely orphaned) — stays buffered for
      // the next successful apply to retry. If every table already reports
      // up-to-date (this failed drain was itself the "next successful
      // apply" that triggered the retry), surface it now rather than
      // waiting for an up-to-date control message that may never come.
      maybeSurfaceOrphaned()
    }
  }

  const unsubscribes = SYNCED_TABLES.map((table) => {
    const stream = factory(table, options)
    return stream.subscribe((messages) => {
      for (const message of messages) {
        if (!isElectricChangeMessage(message)) {
          const control = message.headers.control
          options.onControl?.(table, control)
          if (control === 'up-to-date') {
            upToDateTables.add(table)
            maybeSurfaceOrphaned()
          }
        }
      }
      let deltas: RowDelta[]
      try {
        deltas = toRowDeltas(table, messages)
      } catch (error) {
        options.onError?.(table, error)
        return
      }
      if (deltas.length === 0) return
      applyInboundDeltas(db, deltas)
        .then(() => {
          options.onApplied?.(table, deltas)
          // A successful apply of ANY table may have just landed the parent
          // a buffered batch was waiting on.
          return drainRetryBuffer()
        })
        .catch((error: unknown) => {
          retryBuffer = retryBuffer.concat(deltas)
          options.onError?.(table, error)
        })
    },
    // Issue 086 — Electric surfaces TRANSPORT/AUTH errors (boot-race 401,
    // aborted long-poll) through subscribe's own error channel, separate from
    // the apply/parse errors above. Forward them to the same onError seam; the
    // store hard-ignores the transient/boot-race ones (isIgnorableReadError).
    (error) => options.onError?.(table, error))
  })
  return {
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe()
    },
  }
}
