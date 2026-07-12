// DIAGNOSTIC HARNESS — NOT a permanent regression suite (yet). Built to
// reproduce, locally and deterministically, the live client-side
// materialization bug: after a fresh sign-in (empty local PGlite, post 063's
// clear-on-sign-out wipe), Electric's read-path delivers every row over the
// wire (confirmed live: 200s carrying dimensions/parameters/contexts/
// bindings/tier1_*/tier2_* rows) yet the UI renders nothing for the Design
// tier (deterministic, 3/3 sessions) and flaky/partial for tier1/tier2.
//
// Unlike every other *.test.ts in this codebase, this harness deliberately
// does NOT pre-seed `workspaces` via freshDb()'s `db.insert(workspaces)...`
// convenience (db/sync.test.ts, syncEngine.test.ts, store/sync.test.ts all do
// this). That pre-seed is exactly what every existing test's "fresh DB" means
// — it is NOT a fresh sign-in. A real post-063 fresh sign-in's local PGlite
// has NO workspaces row, no projects row, nothing — see openDatabase(
// 'memory://') used bare below. Driving `startSync`/`useSyncStore.start()`
// against a REAL PGlite (not the trivial single-delta fixtures elsewhere)
// with a fake `streamFactory` that races tables the way 11 independent
// concurrent ShapeStreams + a 401-cold-start-then-retry actually would in
// production is the one thing missing from the existing suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import * as schema from '../db/schema'
import { startSync, type ShapeStreamFactory, type ShapeStreamLike } from './syncEngine'
import type { ElectricMessage } from './electricProtocol'
import type { TableName } from '../domain/syncDelta'
import { setDatabase, resetDatabase } from '../store/database'
import { resetSyncStore, useSyncStore } from '../store/sync'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { resetTier1Store, useTier1Store } from '../store/tier1'

const T0 = '2026-07-12T00:00:00.000Z'
const T1 = '2026-07-12T00:00:01.000Z'

// ── Fixture plumbing — mirrors syncEngine.test.ts's fakeStreamFactory, but
// generalized to build a change message for ANY table (that file's `change()`
// helper hardcodes table-agnostic wire shape; this one adds a `table` arg so
// scenarios below can push arbitrary tables without one bespoke helper each).
function fakeStreamFactory() {
  const subscribers = new Map<TableName, ((messages: readonly ElectricMessage[]) => void)[]>()
  const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
    subscribe(callback) {
      const wrapper = (messages: readonly ElectricMessage[]) => void callback(messages)
      const list = subscribers.get(table) ?? []
      list.push(wrapper)
      subscribers.set(table, list)
      return () => subscribers.set(table, (subscribers.get(table) ?? []).filter((cb) => cb !== wrapper))
    },
  })
  function push(table: TableName, messages: readonly ElectricMessage[]): void {
    for (const cb of subscribers.get(table) ?? []) cb(messages)
  }
  return { factory, push }
}

function change(id: string, updatedAt: string, extra: Record<string, unknown>): ElectricMessage {
  return { key: `"public"."x"/"${id}"`, value: { id, created_at: updatedAt, updated_at: updatedAt, deleted_at: null, ...extra }, headers: { operation: 'insert' } }
}

// Real per-table wire rows (snake_case, matching electricProtocol.ts's
// SQL_TO_JS_COLUMNS) for a small but topologically REAL project: one
// workspace-parent race candidate per table, PLUS one child-canvas dimension
// (d2, contextId -> c1) — the exact shape the bug report's live sessions
// almost certainly contain (any project with a single drill-down/child
// canvas), which is what turns "a transient race" into "permanent, 3/3".
const WS = 'ws-fresh'
const P = 'p1'

function projectsMsg() {
  return change(P, T0, { workspace_id: WS, name: 'Tavalo', description: null })
}
function tier1PurposeMsg() {
  return change('t1p1', T0, { project_id: P, workspace_id: WS, body: 'Because reasons' })
}
function tier1PropMsg() {
  return change('t1x1', T0, { project_id: P, workspace_id: WS, rank: 1, name: 'Prop', description: null, sort: 0 })
}
function tier2TableMsg() {
  return change('t2t1', T0, { project_id: P, workspace_id: WS, name: 'Value', sort: 0 })
}
function tier2EntryMsg() {
  return change('t2e1', T0, { table_id: 't2t1', parent_id: null, name: 'Entry', description: null, sort: 0 })
}
// d1 = root-canvas dimension (contextId null — the "safe" case).
function dimensionRootMsg() {
  return change('d1', T0, { project_id: P, workspace_id: WS, context_id: null, source_param_id: null, name: 'Value', color: '#111', sort: 0 })
}
// d2 = CHILD-canvas dimension bound to context c1 — a real, NOT-nulled
// forward FK (dimensions.contextId is NOT in DEFERRED_FK_COLUMN, unlike
// sourceParamId — src/db/sync.ts:34-39).
function dimensionChildMsg() {
  return change('d2', T0, { project_id: P, workspace_id: WS, context_id: 'c1', source_param_id: null, name: 'Comfort', color: '#222', sort: 1 })
}
function parameterMsg() {
  return change('pa1', T0, { dimension_id: 'd1', parent_param_id: null, source_entry_id: null, name: 'High', sort: 0 })
}
function contextMsg() {
  return change('c1', T0, { project_id: P, workspace_id: WS, parent_id: null, symbol: 'α', name: null, justification: null, sort: 0 })
}
function bindingMsg() {
  return change('b1', T0, { context_id: 'c1', dimension_id: 'd1', parameter_id: 'pa1', tuple_hash: 'h1' })
}

// Flushes one microtask/macrotask tick — the minimum needed for a single
// applyInboundDeltas().then(...) chain to resolve, mirroring syncEngine.
// test.ts's own `flush()`.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
// Multiple ticks — needed when a drain triggers ANOTHER drain synchronously
// chained off a `.then()` (mirrors the drain-race test's `settle()`).
function settle(times = 8): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  return p
}

async function freshSignInDb() {
  // Deliberately NOT pre-seeded — this is the actual post-063 fresh sign-in
  // state: PGlite has the schema (migrations ran) but zero rows anywhere.
  const { db } = await openDatabase('memory://')
  return db
}

describe('Materialization repro — post-sign-in read-path race (real PGlite, real startSync)', () => {
  it('SCENARIO A (control): a pure workspace/project-parent race with NO child-canvas dimension converges via 075A retry', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError })

    // Every child table arrives and fails BEFORE `projects` (and therefore
    // before `workspaces`) has ever been seen locally — the 11-independent-
    // concurrent-ShapeStreams race the bug report describes.
    push('tier1_purpose', [tier1PurposeMsg()])
    push('tier1_props', [tier1PropMsg()])
    push('tier2_tables', [tier2TableMsg()])
    push('tier2_entries', [tier2EntryMsg()])
    push('dimensions', [dimensionRootMsg()])
    push('parameters', [parameterMsg()])
    push('contexts', [contextMsg()])
    push('bindings', [bindingMsg()])
    await settle()

    // Every one of them must have failed at this point — proves the race is
    // real, not a fixture mistake.
    expect(onError).toHaveBeenCalledWith('tier1_purpose', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('dimensions', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('contexts', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('bindings', expect.any(Error))
    expect(await db.select().from(schema.dimensions)).toHaveLength(0)

    // `projects` finally lands — ensures `workspaces` (072) then inserts the
    // project, triggering drainRetryBuffer().
    push('projects', [projectsMsg()])
    await settle()

    // With no context/dimension ordering conflict, the retry buffer's single
    // parent-before-child sorted pass (RETRY_APPLY_ORDER) converges cleanly.
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(1)
    expect(await db.select().from(schema.tier1Props)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Entries)).toHaveLength(1)
    expect(await db.select().from(schema.dimensions)).toHaveLength(1)
    expect(await db.select().from(schema.parameters)).toHaveLength(1)
    expect(await db.select().from(schema.contexts)).toHaveLength(1)
    expect(await db.select().from(schema.bindings)).toHaveLength(1)

    handle.stop()
  })

  it('SCENARIO B (ROOT CAUSE, proven): a child-canvas dimension racing its own context permanently poisons the ENTIRE retry batch — Design tier AND tier1/tier2 bycatch never converge', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const onApplied = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError, onApplied })

    // Same race as Scenario A, but this project has ONE child-canvas
    // dimension (d2, contextId='c1') — utterly ordinary content (any project
    // with a single drill-down). d1/d2 both race ahead of `projects`.
    push('tier1_purpose', [tier1PurposeMsg()])
    push('tier1_props', [tier1PropMsg()])
    push('tier2_tables', [tier2TableMsg()])
    push('tier2_entries', [tier2EntryMsg()])
    push('dimensions', [dimensionRootMsg(), dimensionChildMsg()])
    push('parameters', [parameterMsg()])
    push('contexts', [contextMsg()])
    push('bindings', [bindingMsg()])
    await settle()
    expect(await db.select().from(schema.dimensions)).toHaveLength(0)

    // `projects` lands — ensures workspaces, inserts the project, triggers
    // the ONE retry drain that should land everything (as Scenario A proved
    // it can, absent the child dimension).
    push('projects', [projectsMsg()])
    await settle()

    // THE FAILING ASSERTION (this is the bug): the retry buffer sorts the
    // WHOLE buffered batch by the static RETRY_APPLY_ORDER, which places
    // `dimensions` BEFORE `contexts` (src/sync/syncEngine.ts's
    // RETRY_APPLY_ORDER = [...ENVELOPE_TABLE_NAMES, ...] — dimensions is
    // index 5, contexts is index 7). d2's `context_id` FK is real and NOT
    // covered by DEFERRED_FK_COLUMN (src/db/sync.ts:34-39 only nulls
    // dimensions.sourceParamId), so within the SAME transaction, d2's insert
    // throws a genuine FK violation against a not-yet-inserted `contexts`
    // row — which rolls back the ENTIRE transaction per applyInboundDeltas'
    // atomicity (src/db/sync.ts:50, "ONE transaction"). Every OTHER row in
    // that same drain batch — tier1_purpose, tier1_props, tier2_tables,
    // tier2_entries, d1, pa1 — is bycatch: individually FK-resolvable, but
    // rolled back anyway because they share one transaction with d2.
    expect(await db.select().from(schema.projects)).toHaveLength(1) // the parent itself DID land
    expect(await db.select().from(schema.dimensions)).toHaveLength(0) // d1 (safe!) + d2 both gone
    expect(await db.select().from(schema.contexts)).toHaveLength(0)
    expect(await db.select().from(schema.parameters)).toHaveLength(0)
    expect(await db.select().from(schema.bindings)).toHaveLength(0)
    // The bycatch — tier1/tier2 have NOTHING to do with contexts/dimensions,
    // yet they are poisoned too, purely because they rode in the same
    // buffered batch. This is the flakiness mechanism: whether tier1/tier2
    // survive is pure luck of whether they got bundled into THIS batch.
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(0)
    expect(await db.select().from(schema.tier1Props)).toHaveLength(0)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(0)
    expect(await db.select().from(schema.tier2Entries)).toHaveLength(0)

    // PERMANENCE: RETRY_APPLY_ORDER is a static module-level constant — it
    // never reorders itself, so every SUBSEQUENT drain attempt fails
    // IDENTICALLY. Prove this isn't "just needs one more retry" by forcing
    // several more successful applies (each of which calls drainRetryBuffer)
    // via unrelated tables, and confirming nothing ever lands.
    push('invitations', [
      change('inv1', T1, { workspace_id: WS, email: 'x@example.com', role: 'viewer', invited_by_sub: 'sub-1', expires_at: '2026-08-01T00:00:00.000Z', accepted_at: null }),
    ])
    await settle()
    push('workspace_members', [change('mem1', T1, { workspace_id: WS, user_sub: 'sub-1', role: 'owner' })])
    await settle()
    push('invitations', [change('inv2', T1, { workspace_id: WS, email: 'y@example.com', role: 'viewer', invited_by_sub: 'sub-1', expires_at: '2026-08-01T00:00:00.000Z', accepted_at: null })])
    await settle()

    expect(await db.select().from(schema.dimensions)).toHaveLength(0)
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(0)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(0)
    // The orphan-surfacing safety net never fires either — every synced
    // table has NOT reported up-to-date, so onError for these tables was
    // called only once each (the FIRST failure), never re-surfaced as
    // "orphaned" — this is a SILENT, permanent stall for the rest of the
    // session, not even a visible repeated error.
    const dimensionsErrorCalls = onError.mock.calls.filter((c) => c[0] === 'dimensions').length
    expect(dimensionsErrorCalls).toBe(1)

    handle.stop()
  })

  it('SMOKE-SHAPE GATE (issue 077 step 1): the live 3-session smoke\'s EXACT data shape — two ROOT dimensions (Region/Segment, contextId null), their parameters, ONE context-register entry (one contexts row + bindings), plus Foundation and Architecture rows — delivered raced/out-of-order, must be checked BEFORE any fix is written', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError })

    // Region + Segment: BOTH root-canvas dimensions (contextId null) — no
    // child-canvas dimension anywhere in this shape, unlike Scenario B. This
    // is the actual live smoke's Design tier: registering a tuple (a
    // "context") over root dimensions never itself creates a child-canvas
    // dimension — createContext (src/db/mutations.ts:505) only inserts a
    // `contexts` row; canvasScope's contextId FK on `dimensions` is set only
    // for a dimension the user explicitly drills into, which the smoke's
    // reported repro steps don't describe.
    const dRegion = change('d-region', T0, {
      project_id: P,
      workspace_id: WS,
      context_id: null,
      source_param_id: null,
      name: 'Region',
      color: '#111',
      sort: 0,
    })
    const dSegment = change('d-segment', T0, {
      project_id: P,
      workspace_id: WS,
      context_id: null,
      source_param_id: null,
      name: 'Segment',
      color: '#222',
      sort: 1,
    })
    const paRegionHigh = change('pa-region-high', T0, {
      dimension_id: 'd-region',
      parent_param_id: null,
      source_entry_id: null,
      name: 'High',
      sort: 0,
    })
    const paSegmentConsumer = change('pa-segment-consumer', T0, {
      dimension_id: 'd-segment',
      parent_param_id: null,
      source_entry_id: null,
      name: 'Consumer',
      sort: 0,
    })
    // ONE context-register entry: one `contexts` row (the registered tuple's
    // scenario point) plus the bindings tying it to the two root-dimension
    // parameter picks above.
    const contextRegister = change('c-tuple1', T0, {
      project_id: P,
      workspace_id: WS,
      parent_id: null,
      symbol: 'α',
      name: null,
      justification: null,
      sort: 0,
    })
    const bindingRegion = change('b-region', T0, {
      context_id: 'c-tuple1',
      dimension_id: 'd-region',
      parameter_id: 'pa-region-high',
      tuple_hash: 'h1',
    })
    const bindingSegment = change('b-segment', T0, {
      context_id: 'c-tuple1',
      dimension_id: 'd-segment',
      parameter_id: 'pa-segment-consumer',
      tuple_hash: 'h1',
    })

    // Raced/out-of-order, per-table independent streams — every child table
    // arrives before `projects` (and therefore before `workspaces`) has ever
    // been seen locally, exactly like the 11-independent-concurrent-
    // ShapeStreams race the other scenarios in this file drive.
    push('tier1_purpose', [tier1PurposeMsg()])
    push('tier1_props', [tier1PropMsg()])
    push('tier2_tables', [tier2TableMsg()])
    push('tier2_entries', [tier2EntryMsg()])
    push('dimensions', [dRegion, dSegment])
    push('parameters', [paRegionHigh, paSegmentConsumer])
    push('contexts', [contextRegister])
    push('bindings', [bindingRegion, bindingSegment])
    await settle()

    // Every one of them must have failed at this point — proves the race is
    // real, not a fixture mistake (mirrors Scenario A/B's own proof step).
    expect(onError).toHaveBeenCalledWith('tier1_purpose', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('dimensions', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('contexts', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('bindings', expect.any(Error))
    expect(await db.select().from(schema.dimensions)).toHaveLength(0)

    // `projects` finally lands — ensures `workspaces` (072), inserts the
    // project, and triggers the ONE retry drain that must land everything.
    push('projects', [projectsMsg()])
    await settle()

    // DESIRED behavior (what a real fresh sign-in must show): every table's
    // rows materialize. This is the GATE assertion issue 077 step 1 calls
    // for — whichever way it lands (pass or fail) IS the answer, checked
    // BEFORE any fix in syncEngine.ts/db/sync.ts is written.
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(1)
    expect(await db.select().from(schema.tier1Props)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Entries)).toHaveLength(1)
    expect(await db.select().from(schema.dimensions)).toHaveLength(2)
    expect(await db.select().from(schema.parameters)).toHaveLength(2)
    expect(await db.select().from(schema.contexts)).toHaveLength(1)
    expect(await db.select().from(schema.bindings)).toHaveLength(2)

    handle.stop()
  })

  it('SCENARIO C (explains the FLAKINESS): tier1/tier2 land fine when their own delivery happens to arrive AFTER `projects` has already committed', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const handle = startSync(db, { streamFactory: factory })

    // This time `projects` wins the race outright (no buffering at all for
    // it), and tier1/tier2 arrive strictly AFTER — the "lucky" ordering.
    push('projects', [projectsMsg()])
    await settle()
    push('tier1_purpose', [tier1PurposeMsg()])
    push('tier1_props', [tier1PropMsg()])
    push('tier2_tables', [tier2TableMsg()])
    push('tier2_entries', [tier2EntryMsg()])
    await settle()

    // No buffering needed — workspace+project already committed, so these
    // apply on the FIRST attempt, independent of any Design-tier chaos.
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(1)
    expect(await db.select().from(schema.tier1Props)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Entries)).toHaveLength(1)

    handle.stop()
  })

  it('SCENARIO D: the 401-cold-start-then-retry pattern (empty/no-op delivery, then the real batch) applies correctly once auth attaches', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied })

    // A 401 never reaches toRowDeltas as a change message in this app's
    // model (ShapeStream's own retry keeps the subscribe callback from firing
    // at all until it has a real response) — the closest faithful simulation
    // is an empty message batch (no-op) followed by the real delivery once
    // the token attaches.
    push('projects', [])
    await flush()
    push('projects', [projectsMsg()])
    await settle()

    expect(await db.select().from(schema.projects)).toHaveLength(1)
    expect(onApplied).toHaveBeenCalledWith('projects', expect.arrayContaining([expect.objectContaining({ id: P })]))

    handle.stop()
  })
})

describe('Materialization repro — store layer (075B) mirrors PGlite faithfully either way', () => {
  beforeEach(() => {
    // Production has VITE_SYNC_ENABLED=true (the bug is confirmed live) —
    // useSyncStore.start() is a documented no-op otherwise (test-first plan
    // #6), so the store-level scenarios below must force it on to be a
    // faithful simulation of the production gate, not a false negative.
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    resetSyncStore()
    resetDimensionsStore()
    resetTier1Store()
  })
  afterEach(() => {
    resetSyncStore()
    resetDimensionsStore()
    resetTier1Store()
    resetDatabase()
    vi.unstubAllEnvs()
  })

  it('when PGlite converges (Scenario A shape), useDimensionsStore reflects the rows after its load() + the dimensionsAppliedAt refresh', async () => {
    const db = await freshSignInDb()
    setDatabase(db)
    const { factory, push } = fakeStreamFactory()

    useSyncStore.getState().start(db, { streamFactory: factory, getAuthToken: () => Promise.resolve('fake-token') })
    // load() BEFORE the project even exists locally — mirrors the real
    // mount-order race (the UI opens the project as soon as the project LIST
    // shows it, which can be before Design tier has landed).
    const loadPromise = useDimensionsStore.getState().load(P)

    push('dimensions', [dimensionRootMsg()])
    await settle()
    push('projects', [projectsMsg()])
    await settle()
    await loadPromise

    // The store's 075B subscription re-lists off dimensionsAppliedAt — since
    // PGlite genuinely has the row now (no child-canvas dimension in this
    // scenario), the store must reflect it.
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toContain('d1')
  })

  it('when PGlite is poisoned (Scenario B shape), useDimensionsStore/useTier1Store faithfully show EMPTY — proving the gap is upstream of the store layer, not in 075B', async () => {
    const db = await freshSignInDb()
    setDatabase(db)
    const { factory, push } = fakeStreamFactory()

    useSyncStore.getState().start(db, { streamFactory: factory, getAuthToken: () => Promise.resolve('fake-token') })
    const dimLoad = useDimensionsStore.getState().load(P)
    const tier1Load = useTier1Store.getState().load(P)

    push('tier1_purpose', [tier1PurposeMsg()])
    push('dimensions', [dimensionRootMsg(), dimensionChildMsg()])
    push('contexts', [contextMsg()])
    await settle()
    push('projects', [projectsMsg()])
    await settle()
    await dimLoad
    await tier1Load

    // PGlite itself has nothing for either (Scenario B's proven poisoning) —
    // the stores correctly show empty, matching the DB exactly. This is the
    // "table shell with no entry row" the bug report describes: the
    // component mounts and calls load() successfully (no crash, no stale
    // data), it's just reading a PGlite that never received the rows.
    expect(await db.select().from(schema.dimensions)).toHaveLength(0)
    expect(useDimensionsStore.getState().dimensions).toEqual([])
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(0)
    expect(useTier1Store.getState().purpose).toBe('')

    useSyncStore.getState().stop()
  })
})
