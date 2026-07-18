import { create } from 'zustand'
import { uuidv7 } from 'uuidv7'
import type { Database } from '../db/client'
import {
  acknowledge,
  emptyQueue,
  enqueue,
  pending,
  pendingCount,
  prune,
  reconcileWithDeltas,
  rejectMutation,
  type MutationOp,
  type MutationQueue,
  type QueuedMutation,
} from '../domain/mutationQueue'
import {
  deriveSyncStatus,
  detectLostEdits,
  lostEditMessage,
  SYNC_ERROR_GRACE_MS,
  WRITE_STALL_GRACE_MS,
  type SyncStatus,
} from '../domain/syncStatus'
import type { TableName } from '../domain/syncDelta'
import { isIgnorableReadError, startSync, type SyncHandle, type SyncOptions } from '../sync/syncEngine'
import { isSyncEnabled, shouldSkipReadPath, SYNCED_TABLES, writeApiPath } from '../sync/config'
import { flushMutations, type WriteApiHttpClient } from '../sync/writeTransport'
import { getAuthHeaders } from '../auth/wireIdentity'
import { useAuthStore } from './auth'
import { useStatusStore } from './status'

// Issue 048 — the write-transport wiring: src/sync/writeTransport.ts is pure
// and store-free (mirrors syncEngine.ts's own split), so this store is what
// supplies the real `fetch`, the real Cognito JWT (wireIdentity.ts's
// getAuthHeaders(), 033/044), and the currently-open workspace. The HTTP
// client itself isn't injectable through the public store API (there's no
// test seam for swapping `fetch` at the store layer) — every flush test
// drives src/sync/writeTransport.ts directly instead, which IS fully
// DI-testable; this module only wires the real implementation once.
const defaultHttpClient: WriteApiHttpClient = async (path, init) => {
  const response = await fetch(path, init)
  return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> }
}

// Exponential backoff for a failed flush (network error or a wholesale
// auth rejection that a token refresh might resolve) — module-level, like
// onlineHandler/offlineHandler below, so it survives across store actions
// without bloating SyncState with timer plumbing tests don't need (every
// flush test calls `flush()` directly rather than waiting on real timers).
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
let flushTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = INITIAL_BACKOFF_MS

function clearFlushTimer(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
}

// Issue 086 — the debounce timer for a genuine, still-unresolved read error.
// Module-level (like flushTimer above) so it survives across store actions
// without bloating SyncState with timer plumbing. onError schedules exactly
// ONE recompute() SYNC_ERROR_GRACE_MS after a genuine error first begins, so
// the "Sync error" banner appears once the grace elapses if nothing has
// cleared it; any success (onApplied / onControl up-to-date / start) cancels
// it. Never reset while an error persists — the clock runs from when the
// error FIRST began, not from each repeat.
let errorGraceTimer: ReturnType<typeof setTimeout> | null = null

function clearErrorGraceTimer(): void {
  if (errorGraceTimer !== null) clearTimeout(errorGraceTimer)
  errorGraceTimer = null
}

// Issue 087 — the write-side twin of errorGraceTimer above: the debounce timer
// for a still-unresolved write-outbox failure. A failing flush schedules
// exactly ONE recompute() WRITE_STALL_GRACE_MS after the stall FIRST begins, so
// the "Changes not saving" footer surfaces once the grace elapses if no flush
// has landed to clear it; any successful flush (or a stop/restart) cancels it.
// Never reset while the stall persists — the clock runs from when it began, not
// from each repeated failure (mirrors errorGraceTimer's own rule).
let writeStallGraceTimer: ReturnType<typeof setTimeout> | null = null

function clearWriteStallGraceTimer(): void {
  if (writeStallGraceTimer !== null) clearTimeout(writeStallGraceTimer)
  writeStallGraceTimer = null
}

function resetBackoff(): void {
  backoffMs = INITIAL_BACKOFF_MS
}

function scheduleFlushRetry(flush: () => Promise<void>): void {
  clearFlushTimer()
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

// The store-layer seam for issue 032's read-path + optimistic-write queue:
// owns the queue's runtime state and the sync engine's lifecycle, gated by
// isSyncEnabled() (default OFF — v1's single-user path is the tested
// default, test-first plan #6). Issue 036 extends this same store with the
// derived SyncStatus (online/offline/syncing/reconnecting/error/synced) a
// status-bar indicator (src/shell/SyncIndicator.tsx) renders, plus the quiet
// lost-edit note (useStatusStore.announce — the one feedback channel, no
// toasts) — 032 exposes the raw signals, 036 renders them.
//
// Session-scoped, not persisted — mirrors useCommandLogStore (issue 006):
// the queue and the command log are independent structures (test-first plan
// #5 — a remote delta reconciling mid-session must never touch undo/redo),
// so this store never imports or calls useCommandLogStore.

let onlineHandler: (() => void) | null = null
let offlineHandler: (() => void) | null = null

function initialOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

interface SyncState {
  enabled: boolean
  handle: SyncHandle | null
  queue: MutationQueue
  pendingCount: number
  // Issue 036 — the raw signals deriveSyncStatus() folds into `status`.
  online: boolean
  // Issue 086 — the timestamp (ms) a genuine, still-unresolved read error
  // began, or `null` when there is none. Replaces 036's `hasError: boolean`:
  // transient/boot-race read blips (isIgnorableReadError) never set it, and a
  // genuine error only surfaces the banner once it has stayed set for
  // SYNC_ERROR_GRACE_MS (the debounce that kills the observed flicker).
  errorSince: number | null
  // Issue 087 — the timestamp (ms) the current sustained WRITE-outbox failure
  // began, or `null` when the outbox is healthy. The write twin of `errorSince`
  // above: set the first time a flush() fails to reach the server (a
  // network-error or auth-rejected outcome) and cleared the moment a flush
  // lands. deriveSyncStatus debounces it into the 'write-stalled' status (only
  // past WRITE_STALL_GRACE_MS with a real backlog) so a genuinely stuck outbox
  // stops retrying silently and surfaces in the footer.
  writeStalledSince: number | null
  reconnecting: boolean
  upToDateTables: ReadonlySet<TableName>
  status: SyncStatus
  // Issue 048 — the workspace a flush's MutationEnvelopes are scoped to.
  // KNOWN GAP: nothing calls setWorkspaceId() yet — wiring it to "whichever
  // workspace the open project belongs to" touches src/store/projects.ts,
  // out of this issue's ownership (see docs/issues/048 implementation
  // notes). Until a caller sets it, flush() finds no workspace and stays a
  // no-op (never a crash, mirrors the rest of this store's "sync is
  // additive, never load-bearing" design).
  workspaceId: string | null
  flushing: boolean
  // Issue 062 — a generic "an `invitations` delta just applied" signal, a
  // plain `Date.now()` timestamp bumped by onApplied below. Deliberately
  // table-name-only: this store has no notion of invitations/workspace
  // semantics (mirrors its own "never touches the command log" isolation
  // principle) — src/components/PendingInvitations.tsx is the one consumer,
  // subscribing to this value so useWorkspaceStore.loadMyInvitations() reruns
  // whenever a NEW inbound invite streams in mid-session, closing the gap
  // where the 060 badge only ever refreshed on mount/identity-change.
  invitationsAppliedAt: number
  // Issue 067 — the `workspace_members` analogue of invitationsAppliedAt
  // directly above: a plain "an inbound `workspace_members` delta just
  // applied" timestamp, bumped by onApplied below the same way. This store
  // stays workspace-semantics-free either way — src/store/workspace.ts's
  // useWorkspaceRole is the one consumer, subscribing to this value so its
  // own load-on-workspaceId-change effect ALSO reruns whenever a member is
  // added/changed/removed on another client mid-session, closing the gap
  // where the owner's Members panel (WorkspaceMembers.tsx) only ever
  // reflected whatever this device's own local PGlite happened to already
  // contain.
  membersAppliedAt: number
  // Issue 072 (Defect 2) — the `projects` analogue of invitationsAppliedAt/
  // membersAppliedAt directly above: a plain "an inbound `projects` delta
  // just applied" timestamp, bumped by onApplied below the same way.
  // src/store/projects.ts subscribes to this to re-list itself off its own
  // ground-truth signal, closing the gap where refreshProjects()'s one-shot
  // dbList snapshot (taken before the read-path engine streams anything,
  // 068's restart-safety design) never saw a late-arriving projects delta.
  projectsAppliedAt: number
  // Issue 075 Part B — the Design-tier analogues of invitationsAppliedAt/
  // membersAppliedAt/projectsAppliedAt directly above: every remaining
  // synced table gets its own plain "an inbound delta for THIS table just
  // applied" timestamp, bumped by onApplied below the same way. Per-field
  // (not a generic map) to match the existing three exactly — a caller that
  // only cares about one table subscribes to one primitive number, same as
  // 062/067/072's own consumers. tier1_purpose/tier1_props share one signal
  // (tier1AppliedAt) and tier2_tables/tier2_entries share one (tier2AppliedAt):
  // both store pairs are always read/reloaded together (tier1.ts's load()
  // fetches purpose+props in one Promise.all; tier2.ts's load() fetches
  // tables+entries+links together), so a single combined signal per store is
  // enough — splitting them would just be two listeners doing the same
  // reload. dimensions.ts/contexts.ts/parameters.ts each got a dedicated
  // signal since those ARE three independently-loaded stores.
  dimensionsAppliedAt: number
  parametersAppliedAt: number
  contextsAppliedAt: number
  bindingsAppliedAt: number
  tier1AppliedAt: number
  tier2AppliedAt: number
  // Issue 090 Phase 4b — the `canvases` analogue of dimensionsAppliedAt/
  // contextsAppliedAt above: a plain "an inbound `canvases` delta just applied"
  // timestamp, bumped by onApplied below. src/store/canvases.ts subscribes to
  // it to re-list its root canvases off this ground-truth signal.
  canvasesAppliedAt: number
  setWorkspaceId: (workspaceId: string | null) => void
  // Starts the read-path engine if isSyncEnabled() is true; a no-op
  // otherwise (leaves `enabled: false`, `handle: null`) — safe to call
  // unconditionally from app bootstrap (src/store/projects.ts's init()).
  start: (db: Database, options?: SyncOptions) => void
  stop: () => void
  enqueueLocalMutation: (mutation: QueuedMutation) => void
  // Issue 048 — drains the pending queue to the write-path API. A no-op
  // (never touches the network) unless sync is enabled, the caller is
  // signed in, a workspace is resolvable, and there is something pending —
  // signed-out and sync=off stay byte-for-byte unchanged and network-free
  // (test-first plan #5). Safe to call repeatedly/concurrently: an
  // in-flight flush is skipped rather than doubled.
  flush: () => Promise<void>
  // Issue 089 D2 — the LOCAL twin of onApplied's `*AppliedAt` bumps, for a
  // cross-store write that has no server round-trip to echo it back. See the
  // implementation's doc comment.
  notifyLocalApply: (tables: readonly TableName[]) => void
}

export const useSyncStore = create<SyncState>()((set, get) => {
  // Recomputes the derived `status` (and clears a completed `reconnecting`
  // transition) from the store's current raw signals. Called after every
  // action that can move the needle — the pure decision itself lives in
  // src/domain/syncStatus.ts, this just feeds it live state.
  function recompute(): void {
    const s = get()
    const upToDate = s.upToDateTables.size >= SYNCED_TABLES.length
    // A reconnect completes only once BOTH the read-path has fully caught up
    // again AND the queue that accumulated while offline has drained — issue
    // 036 test-first plan #2 ("goes offline (queues N) → reconnecting →
    // synced, with the count draining to 0"). Clearing on `upToDate` alone
    // would report "synced" while pending writes are still in flight.
    const reconnecting = s.reconnecting && !(upToDate && s.pendingCount === 0)
    const status = deriveSyncStatus({
      enabled: s.enabled,
      online: s.online,
      // Issue 086 — plumb the error timestamp + the live clock; the pure
      // deriveSyncStatus does the grace-window comparison (never reads a clock
      // itself). A scheduled recompute() after the grace re-evaluates this
      // once the window has elapsed.
      errorSince: s.errorSince,
      // Issue 087 — plumb the write-stall timestamp alongside 086's read one;
      // the pure deriveSyncStatus does the grace-window + backlog comparison.
      writeStalledSince: s.writeStalledSince,
      now: Date.now(),
      reconnecting,
      upToDate,
      pendingCount: s.pendingCount,
    })
    set({ reconnecting, status })
  }

  // Issue 087 — the write-outbox analogue of onError's read-error debounce
  // (start() below): a failing flush() marks the stall from when it FIRST
  // began (never resets on a repeat), recomputes (still calm — within the grace
  // deriveSyncStatus reports 'syncing', not 'write-stalled'), and schedules ONE
  // recompute() after the grace so "Changes not saving" surfaces if nothing has
  // cleared it. A successful flush clears writeStalledSince and cancels this.
  function markWriteStalled(): void {
    if (get().writeStalledSince !== null) return
    set({ writeStalledSince: Date.now() })
    recompute()
    clearWriteStallGraceTimer()
    writeStallGraceTimer = setTimeout(() => {
      writeStallGraceTimer = null
      recompute()
    }, WRITE_STALL_GRACE_MS)
  }

  return {
    enabled: false,
    handle: null,
    queue: emptyQueue(),
    pendingCount: 0,
    online: true,
    errorSince: null,
    writeStalledSince: null,
    reconnecting: false,
    upToDateTables: new Set<TableName>(),
    status: 'disabled',
    workspaceId: null,
    flushing: false,
    invitationsAppliedAt: 0,
    membersAppliedAt: 0,
    projectsAppliedAt: 0,
    dimensionsAppliedAt: 0,
    parametersAppliedAt: 0,
    contextsAppliedAt: 0,
    bindingsAppliedAt: 0,
    tier1AppliedAt: 0,
    tier2AppliedAt: 0,
    canvasesAppliedAt: 0,

    setWorkspaceId(workspaceId) {
      set({ workspaceId })
      void get().flush()
    },

    start(db, callerOptions = {}) {
      if (!isSyncEnabled()) return
      // Issue 068 (Defect B) — the read-path was never authenticated: a
      // caller that doesn't inject its own getAuthToken (the one production
      // entry point, src/store/projects.ts, never has) fell through to
      // authToken.ts's `noAuth` deep inside syncEngine.ts, so every shape
      // request's Authorization header was empty and the shape proxy 401s
      // (src/server/shapeProxy/handler.ts). Mirror flush() below: default to
      // the real Cognito JWT via useAuthStore. A caller (or a test) that
      // injects its own getAuthToken keeps it as-is.
      const options: SyncOptions = {
        ...callerOptions,
        getAuthToken: callerOptions.getAuthToken ?? (() => useAuthStore.getState().getIdToken()),
      }
      // The read-path (Electric) needs a configured shape endpoint. Without
      // VITE_SYNC_URL — and no injected test streamFactory — the default
      // factory would build a shape URL from an empty base and throw
      // "Failed to construct 'URL': Invalid URL". Skip the read-path in that
      // case; the write flush (048) is independent and stays enabled via
      // isSyncEnabled() alone — see flush() below. As of issue 058, a real
      // Electric service is deployed behind VITE_SYNC_URL (the CloudFront
      // `/sync*` path, fronting the shape-proxy Lambda — never Electric
      // directly, see src/server/shapeProxy/), so this naturally starts
      // passing once that URL is populated in the deployed build — the
      // predicate itself (shouldSkipReadPath, src/sync/config.ts) is
      // unchanged from 051, still defensive rather than deleted.
      if (shouldSkipReadPath(Boolean(options.streamFactory))) return
      get().handle?.stop()
      // Issue 086/087 — a (re)start is a clean slate for both debounces.
      clearErrorGraceTimer()
      clearWriteStallGraceTimer()
      set({
        enabled: true,
        online: initialOnline(),
        errorSince: null,
        writeStalledSince: null,
        reconnecting: false,
        upToDateTables: new Set<TableName>(),
      })

      const handle = startSync(db, {
        ...options,
        onApplied: (table, deltas) => {
          options.onApplied?.(table, deltas)
          // Detect a lost local edit BEFORE reconciling — reconcileWithDeltas
          // acknowledges+prunes the matching queue entries (mutationQueue.ts
          // deliberately never compares row values; this is 036's own,
          // additional read of the same batch for UI purposes only).
          const lostEdits = detectLostEdits(get().queue, deltas)
          const queue = reconcileWithDeltas(get().queue, deltas)
          // Issue 086 — a successful apply resolves any pending read error:
          // clear the timestamp and cancel a debounce that hasn't fired yet.
          clearErrorGraceTimer()
          set({ queue, pendingCount: pendingCount(queue), errorSince: null })
          // Issue 062 — a plain timestamp bump, not a counter: any store
          // subscribing to this only cares "did this change since I last
          // looked", which a monotonically-updated Date.now() answers just
          // as well as a counter, with no extra state to reset in lockstep.
          if (table === 'invitations') set({ invitationsAppliedAt: Date.now() })
          // Issue 067 — same bump, same rationale, for `workspace_members`.
          if (table === 'workspace_members') set({ membersAppliedAt: Date.now() })
          // Issue 072 (Defect 2) — same bump, same rationale, for `projects`.
          if (table === 'projects') set({ projectsAppliedAt: Date.now() })
          // Issue 075 Part B — same bump, same rationale, for every
          // remaining Design-tier table (see the field doc comments above
          // for why tier1/tier2 share one combined signal each).
          if (table === 'dimensions') set({ dimensionsAppliedAt: Date.now() })
          if (table === 'parameters') set({ parametersAppliedAt: Date.now() })
          if (table === 'contexts') set({ contextsAppliedAt: Date.now() })
          if (table === 'bindings') set({ bindingsAppliedAt: Date.now() })
          if (table === 'tier1_purpose' || table === 'tier1_props') set({ tier1AppliedAt: Date.now() })
          if (table === 'tier2_tables' || table === 'tier2_entries') set({ tier2AppliedAt: Date.now() })
          // Issue 090 Phase 4b — same bump, same rationale, for `canvases`.
          if (table === 'canvases') set({ canvasesAppliedAt: Date.now() })
          recompute()
          if (lostEdits.length > 0) {
            useStatusStore.getState().announce(lostEditMessage(lostEdits.length))
          }
        },
        onControl: (table, control) => {
          options.onControl?.(table, control)
          if (control === 'up-to-date') {
            const next = new Set(get().upToDateTables)
            next.add(table)
            // Issue 086 — a shape reporting caught-up is a success: resolve
            // any pending read error and cancel a not-yet-fired debounce.
            clearErrorGraceTimer()
            set({ upToDateTables: next, errorSince: null })
            recompute()
          }
        },
        onError: (table, error) => {
          options.onError?.(table, error)
          // Issue 086 — classify before reacting. Transient/boot-race read
          // blips (a pre-signin 401 missing_token, an aborted long-poll
          // Electric retries) are HARD-IGNORED: they never set errorSince, so
          // they can never surface the "Sync error" banner. This is what kills
          // the observed flicker (docs/issues/086).
          if (isIgnorableReadError(error)) return
          // A genuine error. Start the clock from when it FIRST began (don't
          // keep resetting it on repeats), recompute (still calm — within the
          // grace window deriveSyncStatus reports 'syncing', not 'error'), and
          // schedule ONE recompute() after the grace so the banner surfaces if
          // nothing has cleared it by then.
          if (get().errorSince === null) {
            set({ errorSince: Date.now() })
            recompute()
            clearErrorGraceTimer()
            errorGraceTimer = setTimeout(() => {
              errorGraceTimer = null
              recompute()
            }, SYNC_ERROR_GRACE_MS)
          }
        },
      })

      if (typeof window !== 'undefined') {
        onlineHandler = () => {
          const wasOffline = !get().online
          set({
            online: true,
            reconnecting: wasOffline ? true : get().reconnecting,
            // Force a fresh catch-up check on reconnect — an up-to-date
            // reported before the drop doesn't prove the shape is still
            // caught up after it (test-first plan #2).
            upToDateTables: wasOffline ? new Set<TableName>() : get().upToDateTables,
          })
          recompute()
          // Issue 048 test-first plan #3 — flush-on-reconnect: drain
          // whatever backed up in the queue while offline. flush() itself
          // is the no-op gate (sync off / signed out / no workspace), so
          // this is always safe to call.
          resetBackoff()
          void get().flush()
        }
        offlineHandler = () => {
          set({ online: false })
          recompute()
        }
        window.addEventListener('online', onlineHandler)
        window.addEventListener('offline', offlineHandler)
      }

      set({ handle })
      recompute()
    },

    stop() {
      get().handle?.stop()
      if (typeof window !== 'undefined') {
        if (onlineHandler) window.removeEventListener('online', onlineHandler)
        if (offlineHandler) window.removeEventListener('offline', offlineHandler)
      }
      onlineHandler = null
      offlineHandler = null
      clearFlushTimer()
      clearErrorGraceTimer()
      clearWriteStallGraceTimer()
      resetBackoff()
      set({ enabled: false, handle: null })
      recompute()
    },

    enqueueLocalMutation(mutation) {
      const queue = enqueue(get().queue, mutation)
      set({ queue, pendingCount: pendingCount(queue) })
      recompute()
      // Issue 048 — flush promptly after a local write is queued; flush()
      // is a no-op unless sync is on, the caller is signed in, and a
      // workspace is resolvable (test-first plan #5).
      void get().flush()
    },

    async flush() {
      if (!isSyncEnabled()) return
      if (useAuthStore.getState().status !== 'authenticated') return
      if (get().flushing) return
      const { queue, workspaceId } = get()
      if (workspaceId === null || pending(queue).length === 0) return

      set({ flushing: true })
      clearFlushTimer()
      let result
      try {
        result = await flushMutations(queue, workspaceId, {
          httpClient: defaultHttpClient,
          getAuthHeaders,
          path: writeApiPath(),
        })
      } finally {
        set({ flushing: false })
      }

      if (result.kind === 'skipped') return

      if (result.kind === 'network-error') {
        // Issue 087 — a genuine write-outbox failure (server 5xx / write API
        // down / offline). Mark the stall (debounced) so a SUSTAINED failure
        // surfaces "Changes not saving" instead of only ever retrying quietly.
        markWriteStalled()
        scheduleFlushRetry(() => get().flush())
        return
      }

      if (result.kind === 'auth-rejected') {
        useStatusStore.getState().announce(result.rejection.message)
        // Issue 087 — an expired/invalid token is the other genuine sustained
        // failure: the quiet announce above is a one-shot, so also mark the
        // stall so the footer reflects it if a token refresh never resolves it.
        markWriteStalled()
        scheduleFlushRetry(() => get().flush())
        return
      }

      // result.kind === 'applied' — the round trip itself succeeded, so
      // reset backoff even if some individual mutations were rejected.
      resetBackoff()
      // Issue 087 — a flush that reached the server clears the write stall the
      // moment it lands (mirrors 086 clearing errorSince on a successful apply);
      // cancel a debounce that hasn't fired yet.
      clearWriteStallGraceTimer()
      if (get().writeStalledSince !== null) set({ writeStalledSince: null })
      let nextQueue = get().queue
      // Issue 091 — snapshot which rejected mutations came from a BACKGROUND
      // heal write (richTextConvert.ts tags them `origin: 'heal'`) BEFORE the
      // reject loop below drops them from the queue. A heal write is repeatable
      // and self-corrects on the next load, so its `unknown_entity` rejection (a
      // locally-created row whose INSERT hasn't flushed server-side yet) is
      // cosmetic — the entry is still dropped exactly as before, but its note is
      // suppressed. User-initiated writes carry no tag and keep surfacing.
      const healOriginIds = new Set(
        nextQueue.entries.filter((e) => e.origin === 'heal').map((e) => e.id),
      )
      for (const id of result.acknowledgedIds) nextQueue = acknowledge(nextQueue, id)
      nextQueue = prune(nextQueue)
      // Rejection reconciliation (test-first plan #4): drop the rejected
      // entry from the local queue (mutationQueue.ts's own documented
      // rollback-on-reject seam) and surface a calm status-bar error (015
      // style) — never a toast. The command log (006) is untouched here,
      // exactly like every other sync-store action (test-first plan #5 in
      // issue 036: "the sync store never touches the command log").
      for (const rejection of result.rejections) {
        nextQueue = rejectMutation(nextQueue, rejection.mutationId)
      }
      set({ queue: nextQueue, pendingCount: pendingCount(nextQueue) })
      recompute()
      // Issue 091 — announce only the last rejection that did NOT originate from
      // a background heal write. Heal-originated rejections are dropped above
      // (rejectMutation) just like any other, but their cosmetic note is
      // suppressed here.
      const surfacedRejections = result.rejections.filter((r) => !healOriginIds.has(r.mutationId))
      if (surfacedRejections.length > 0) {
        const last = surfacedRejections[surfacedRejections.length - 1]
        if (last) useStatusStore.getState().announce(last.message)
      }

      // More work may remain (the queue grew mid-flush, or this batch only
      // partially drained) — keep draining until a flush finds nothing left.
      if (pending(get().queue).length > 0) void get().flush()
    },

    // Issue 089 D2 — the LOCAL twin of onApplied's `*AppliedAt` bumps. A
    // mutation in one store that writes rows a DIFFERENT co-mounted store owns
    // (tier2.promote / rename-propagate / delete-resolution create or edit the
    // root-canvas dimensions + parameters the Design lane owns) has no server
    // round-trip to bump the matching signal — so the 075B refresh
    // subscriptions in dimensions.ts / parameters.ts never wake, and in the D2
    // co-mount model the already-mounted, projectId-keyed sibling lane stays
    // stale until a reload. Bumping the SAME signals here wakes those existing
    // subscriptions to re-read for their CURRENT canvas / tracked dimensions
    // (canvas-scoped per 090) — no new cross-store coupling, no schema change.
    // Does NOT recompute() (sync status is unaffected by a local re-read).
    notifyLocalApply(tables) {
      const at = Date.now()
      const patch: Partial<SyncState> = {}
      for (const table of tables) {
        if (table === 'dimensions') patch.dimensionsAppliedAt = at
        else if (table === 'parameters') patch.parametersAppliedAt = at
        else if (table === 'contexts') patch.contextsAppliedAt = at
        else if (table === 'bindings') patch.bindingsAppliedAt = at
        else if (table === 'tier1_purpose' || table === 'tier1_props') patch.tier1AppliedAt = at
        else if (table === 'tier2_tables' || table === 'tier2_entries') patch.tier2AppliedAt = at
        else if (table === 'canvases') patch.canvasesAppliedAt = at
      }
      set(patch)
    },
  }
})

// Issue 073 — the shared choke point every domain-content store action calls
// after its own local DB write: encapsulates the exact 8-line boilerplate
// createProject (src/store/projects.ts:189) and every workspace.ts action
// already hand-roll at each call site (guard on a resolvable sync workspace,
// build the QueuedMutation envelope, enqueue it). Written/reviewed ONCE here
// rather than re-derived per store — 073's root cause was that no such choke
// point existed below the store layer (db/mutations.ts is deliberately
// store-free), so each of the ~36 mutating call sites across
// tier1/tier2/dimensions/parameters/contexts/projects.ts calls this instead
// of reaching into useSyncStore directly. Deliberately does NOT decide the op
// (upsert/update/delete) — that's the call site's job (see docs/issues/073's
// op-selection rule); this only owns the guard + envelope shape.
export function enqueueIfSyncing(
  table: TableName,
  rowId: string,
  op: MutationOp,
  row: { readonly updatedAt: string } & Readonly<Record<string, unknown>>,
  // Issue 091 — an optional provenance tag threaded onto the queued mutation.
  // Only the D1 heal-on-load passes 'heal'; every other call site omits it and
  // gets an untagged (user-initiated) mutation, unchanged from before.
  origin?: QueuedMutation['origin'],
): void {
  const workspaceId = useSyncStore.getState().workspaceId
  if (!workspaceId) return
  useSyncStore.getState().enqueueLocalMutation({
    id: uuidv7(),
    table,
    rowId,
    op,
    row,
    optimisticUpdatedAt: row.updatedAt,
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
    // exactOptionalPropertyTypes: only set the key when there's a real tag
    // (never `origin: undefined`).
    ...(origin ? { origin } : {}),
  })
}

export function resetSyncStore(): void {
  useSyncStore.getState().handle?.stop()
  if (typeof window !== 'undefined') {
    if (onlineHandler) window.removeEventListener('online', onlineHandler)
    if (offlineHandler) window.removeEventListener('offline', offlineHandler)
  }
  onlineHandler = null
  offlineHandler = null
  clearFlushTimer()
  clearErrorGraceTimer()
  clearWriteStallGraceTimer()
  resetBackoff()
  useSyncStore.setState({
    enabled: false,
    handle: null,
    queue: emptyQueue(),
    pendingCount: 0,
    online: true,
    errorSince: null,
    writeStalledSince: null,
    reconnecting: false,
    upToDateTables: new Set<TableName>(),
    status: 'disabled',
    workspaceId: null,
    flushing: false,
    invitationsAppliedAt: 0,
    membersAppliedAt: 0,
    projectsAppliedAt: 0,
    dimensionsAppliedAt: 0,
    parametersAppliedAt: 0,
    contextsAppliedAt: 0,
    bindingsAppliedAt: 0,
    tier1AppliedAt: 0,
    tier2AppliedAt: 0,
    canvasesAppliedAt: 0,
  })
}
