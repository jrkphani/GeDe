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
import { eq } from 'drizzle-orm'
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
  return change('t2e1', T0, { table_id: 't2t1', workspace_id: WS, parent_id: null, name: 'Entry', description: null, sort: 0 })
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
  return change('pa1', T0, { dimension_id: 'd1', workspace_id: WS, parent_param_id: null, source_entry_id: null, name: 'High', sort: 0 })
}
function contextMsg() {
  return change('c1', T0, { project_id: P, workspace_id: WS, parent_id: null, symbol: 'α', name: null, justification: null, sort: 0 })
}
function bindingMsg() {
  return change('b1', T0, { context_id: 'c1', dimension_id: 'd1', parameter_id: 'pa1', workspace_id: WS, tuple_hash: 'h1' })
}
// An Electric control message announcing a shape has fully caught up. Issue 088
// scenarios need these to drive `maybeSurfaceOrphaned`'s all-`up-to-date`
// trigger, which the earlier scenarios (data-only pushes) never exercise.
function upToDate(): ElectricMessage {
  return { headers: { control: 'up-to-date' } }
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

  it('SCENARIO B (issue 077, FIXED): a child-canvas dimension racing its own context converges within the same retry drain — Design tier AND tier1/tier2 bycatch all land', async () => {
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

    // DESIRED behavior (issue 077 fix): `dimensions.contextId` now joins
    // `dimensions.sourceParamId` in DEFERRED_FK_COLUMN (src/db/sync.ts), so
    // d2's real-but-not-yet-committed `context_id` FK is nulled on the first
    // pass and restored on the second pass of the SAME transaction — no FK
    // violation, no rollback, regardless of RETRY_APPLY_ORDER placing
    // `dimensions` before `contexts`. Every row in the drain batch lands,
    // including the tier1/tier2 bycatch that has nothing to do with
    // contexts/dimensions at all.
    expect(await db.select().from(schema.projects)).toHaveLength(1)
    expect(await db.select().from(schema.dimensions)).toHaveLength(2) // d1 + d2 (child-canvas)
    expect(await db.select().from(schema.contexts)).toHaveLength(1)
    expect(await db.select().from(schema.parameters)).toHaveLength(1)
    expect(await db.select().from(schema.bindings)).toHaveLength(1)
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(1)
    expect(await db.select().from(schema.tier1Props)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Tables)).toHaveLength(1)
    expect(await db.select().from(schema.tier2Entries)).toHaveLength(1)

    // d2's contextId must have been RESTORED (the second pass), not left
    // null forever — this is the whole point of the deferred-column
    // treatment, not just "insert succeeds with a dangling null FK".
    const d2Rows = await db.select().from(schema.dimensions).where(eq(schema.dimensions.id, 'd2'))
    expect(d2Rows[0]?.contextId).toBe('c1')

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
      workspace_id: WS,
      parent_param_id: null,
      source_entry_id: null,
      name: 'High',
      sort: 0,
    })
    const paSegmentConsumer = change('pa-segment-consumer', T0, {
      dimension_id: 'd-segment',
      workspace_id: WS,
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
      workspace_id: WS,
      tuple_hash: 'h1',
    })
    const bindingSegment = change('b-segment', T0, {
      context_id: 'c-tuple1',
      dimension_id: 'd-segment',
      parameter_id: 'pa-segment-consumer',
      workspace_id: WS,
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

  // ── Issue 088 — the residual genuine "Sync error" on a fresh load. The bug:
  // `parameters.dimension_id` and every `bindings` forward FK are NOT NULL
  // (schema.ts) and therefore NOT in DEFERRED_FK_COLUMN — deferring them would
  // leave a permanent NULL FK, which is why the fix is NOT to defer but to
  // harden the orphan decision. Those child rows rely entirely on the retry
  // drain to converge once their sibling parent lands. The failure is a pure
  // TIMING race: `maybeSurfaceOrphaned` fires SYNCHRONOUSLY from the last
  // table's `up-to-date` control handler — BEFORE that same callback's own
  // parent-carrying apply has committed — so it wrongly declares the buffered
  // child rows orphaned, clears them from the buffer (permanently — Electric
  // never re-delivers an acked batch), and surfaces the banner with no further
  // retry. This test stages that exact interleave for BOTH the
  // `parameters.dimension_id` and the `bindings.*` cases.
  it('SCENARIO E (issue 088): a parameters/bindings row buffered when the LAST table reaches up-to-date must NOT be declared orphaned while its parent apply is still pending — it converges with its REAL forward FKs', async () => {
    const db = await freshSignInDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const onApplied = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError, onApplied })

    // projects + workspace + context c1 land first, isolating the
    // parameters->dimensions and bindings->{contexts,dimensions,parameters}
    // SIBLING-table forward-FK race (issue 088) from the projects/workspace
    // parent race (Scenario A/075A).
    push('projects', [projectsMsg()])
    push('contexts', [contextMsg()])
    await settle()
    expect(await db.select().from(schema.contexts)).toHaveLength(1)

    // parameters (pa1 -> d1) and bindings (b1 -> c1/d1/pa1) stream BEFORE the
    // dimensions shape delivers d1: both FK-fail and buffer.
    push('parameters', [parameterMsg()])
    push('bindings', [bindingMsg()])
    await settle()
    expect(onError).toHaveBeenCalledWith('parameters', expect.any(Error))
    expect(onError).toHaveBeenCalledWith('bindings', expect.any(Error))
    expect(await db.select().from(schema.parameters)).toHaveLength(0)
    expect(await db.select().from(schema.bindings)).toHaveLength(0)
    onError.mockClear()

    // Every OTHER shape reports up-to-date first, so `dimensions` (whose d1 the
    // buffered rows wait on) is the LAST table to reach up-to-date. No orphan
    // may surface yet — the buffer is a live race, not a dead end.
    const others: TableName[] = [
      'projects',
      'tier1_purpose',
      'tier1_props',
      'tier2_tables',
      'tier2_entries',
      'parameters',
      'contexts',
      'bindings',
      'invitations',
      'workspace_members',
    ]
    for (const table of others) push(table, [upToDate()])
    await settle()
    expect(onError).not.toHaveBeenCalled()

    // dimensions delivers d1 AND announces up-to-date in the SAME batch — the
    // production race: the 11th (last) up-to-date fires synchronously, BEFORE
    // d1's own apply (kicked off later in the same callback) has committed. The
    // pre-088 maybeSurfaceOrphaned declared pa1/b1 orphaned right here and
    // cleared them from the buffer -> permanently lost, banner surfaced.
    push('dimensions', [dimensionRootMsg(), upToDate()])
    await settle()

    // GREEN (issue 088 fix): no orphan surfaced — the buffered rows converged
    // once d1 landed, because the orphan decision now waits for the pending
    // parent apply + a no-progress drain instead of firing on the raw
    // all-up-to-date edge.
    expect(onError).not.toHaveBeenCalled()
    expect(await db.select().from(schema.dimensions)).toHaveLength(1)
    expect(await db.select().from(schema.parameters)).toHaveLength(1)
    expect(await db.select().from(schema.bindings)).toHaveLength(1)

    // The child rows carry their REAL forward FK values (never nulled/dropped)
    // — the whole point: a NULL parameters.dimension_id / bindings.* would be a
    // materialization bug, not a fix.
    const pa = await db.select().from(schema.parameters).where(eq(schema.parameters.id, 'pa1'))
    expect(pa[0]?.dimensionId).toBe('d1')
    const b = await db.select().from(schema.bindings).where(eq(schema.bindings.id, 'b1'))
    expect(b[0]?.contextId).toBe('c1')
    expect(b[0]?.dimensionId).toBe('d1')
    expect(b[0]?.parameterId).toBe('pa1')

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

  it('when PGlite converges (Scenario B shape, issue 077 FIXED), useDimensionsStore/useTier1Store faithfully reflect the landed rows', async () => {
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

    // PGlite now genuinely has both rows (issue 077's fix: dimensions.
    // contextId joins DEFERRED_FK_COLUMN's null-then-restore treatment, so
    // d2's real-but-not-yet-committed context FK no longer poisons the whole
    // drain batch). useDimensionsStore.load(P) — with its default
    // contextId=null — scopes to the PROJECT'S ROOT canvas only (src/store/
    // dimensions.ts:65-67), so it correctly lists d1 (root, contextId null)
    // and correctly excludes d2 (a CHILD canvas, contextId='c1') — that's
    // the store's own canvas-scoping contract, not a materialization gap.
    // The fix is proven at the PGlite layer directly: both rows landed, and
    // d2's contextId was actually RESTORED to 'c1' (not left dangling null).
    expect(await db.select().from(schema.dimensions)).toHaveLength(2)
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual(['d1'])
    const d2Rows = await db.select().from(schema.dimensions).where(eq(schema.dimensions.id, 'd2'))
    expect(d2Rows[0]?.contextId).toBe('c1')
    expect(await db.select().from(schema.tier1Purpose)).toHaveLength(1)
    expect(useTier1Store.getState().purpose).toBe('Because reasons')

    useSyncStore.getState().stop()
  })
})
