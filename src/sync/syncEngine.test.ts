import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client'
import { bindings, canvases, dimensions, parameters, projects, workspaces } from '../db/schema'
import { applyInboundDeltas } from '../db/sync'
import { FetchError, FetchBackoffAbortError } from '@electric-sql/client'
import { isIgnorableReadError, startSync, type ShapeStreamFactory, type ShapeStreamLike } from './syncEngine'
import { SYNCED_TABLES } from './config'
import { MalformedElectricMessageError } from './electricProtocol'
import type { ElectricMessage } from './electricProtocol'
import type { RowDelta, TableName } from '../domain/syncDelta'
import type { Database } from '../db/client'

// Issue 075 Part A (drain-race regression) — the reconcile-retry buffer lives
// inside syncEngine's startSync and calls db/sync's applyInboundDeltas. To
// deterministically force the concurrent-interleave race (a second table's
// failed batch buffering WHILE a drain's `await applyInboundDeltas` is still
// in flight), the drain race test below installs a GATED implementation over
// this real function for one specific call, delegating to the real DB write
// for every other call. The factory default just delegates to the real
// implementation, so every OTHER test in this file behaves byte-for-byte as
// if unmocked.
vi.mock('../db/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/sync')>()
  return { ...actual, applyInboundDeltas: vi.fn(actual.applyInboundDeltas) }
})

// A fake per-table shape stream: each table gets its own subscriber list so a
// test can push a message batch to exactly one table's stream, mirroring how
// Electric would deliver a change on one shape without touching the others.
// No live Electric server is reachable in this repo's tests (HANDOFF) — this
// is the fixture/mock the issue's implementation notes call for.
function fakeStreamFactory() {
  const subscribers = new Map<TableName, ((messages: readonly ElectricMessage[]) => void)[]>()
  const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
    subscribe(callback) {
      const wrapper = (messages: readonly ElectricMessage[]) => void callback(messages)
      const list = subscribers.get(table) ?? []
      list.push(wrapper)
      subscribers.set(table, list)
      return () => {
        subscribers.set(
          table,
          (subscribers.get(table) ?? []).filter((cb) => cb !== wrapper),
        )
      }
    },
  })
  function push(table: TableName, messages: readonly ElectricMessage[]): void {
    for (const cb of subscribers.get(table) ?? []) cb(messages)
  }
  return { factory, push }
}

function change(id: string, updatedAt: string, extra: Record<string, unknown>): ElectricMessage {
  return {
    key: `"public"."projects"/"${id}"`,
    value: { id, created_at: updatedAt, updated_at: updatedAt, deleted_at: null, ...extra },
    headers: { operation: 'insert' },
  }
}

async function freshDb() {
  const { db } = await openDatabase('memory://')
  // Issue 034: projects carries a NOT NULL workspace_id FK — seed the
  // workspace the fixture deltas below reference (bypassing RLS as the
  // table owner; this is test setup, not a tenancy assertion).
  await db.insert(workspaces).values({ id: 'ws1', name: 'Test Workspace' })
  return db
}

// Issue 086 — the read-error classifier. The "Sync error" banner was over-
// sensitive: it flipped on any transient/boot-race read blip and self-cleared
// a second later. isIgnorableReadError draws the boundary the store uses to
// decide which read errors it hard-ignores (never debounces at all): the pre-
// signin boot-race (401 / missing_token, self-heals on sign-in) and transient
// transport Electric retries on its own (aborted long-poll / socket closed).
// A genuine apply/parse failure (MalformedElectricMessageError, a PGlite FK/
// constraint throw, the synthetic orphaned-row Error) is NOT ignorable — it
// gets debounced by the store and surfaces only if it stays unresolved.
describe('isIgnorableReadError — transient/boot-race vs genuine (issue 086)', () => {
  it('a boot-race 401 FetchError (missing_token before the auth token attaches) is ignorable', () => {
    const err = new FetchError(
      401,
      JSON.stringify({ error: 'missing_token' }),
      { error: 'missing_token' },
      {},
      'https://sync.example/v1/shape',
      'missing_token',
    )
    expect(isIgnorableReadError(err)).toBe(true)
  })

  it('a 403 FetchError (auth not yet resolved) is ignorable', () => {
    const err = new FetchError(403, undefined, undefined, {}, 'https://sync.example/v1/shape')
    expect(isIgnorableReadError(err)).toBe(true)
  })

  it('a transient long-poll abort (FetchBackoffAbortError, Electric retries it) is ignorable', () => {
    expect(isIgnorableReadError(new FetchBackoffAbortError())).toBe(true)
  })

  it('a bare AbortError / socket-closed transport blip is ignorable', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(isIgnorableReadError(abort)).toBe(true)
    expect(isIgnorableReadError(new Error('net::ERR_ABORTED'))).toBe(true)
  })

  it('a genuine parse failure (MalformedElectricMessageError) is NOT ignorable', () => {
    expect(isIgnorableReadError(new MalformedElectricMessageError('row x has no "id"'))).toBe(false)
  })

  it('a genuine local FK/constraint apply failure is NOT ignorable', () => {
    const fk = new Error('insert or update on table "parameters" violates foreign key constraint')
    expect(isIgnorableReadError(fk)).toBe(false)
  })

  it('the synthetic orphaned-row error (surfaced after every table is up-to-date) is NOT ignorable', () => {
    const orphan = new Error('2 buffered "parameters" row(s) never resolved their FK dependency')
    expect(isIgnorableReadError(orphan)).toBe(false)
  })

  it('a 5xx server FetchError is NOT ignorable (a sustained server outage should surface)', () => {
    const err = new FetchError(500, undefined, undefined, {}, 'https://sync.example/v1/shape')
    expect(isIgnorableReadError(err)).toBe(false)
  })
})

describe('startSync — orchestration (test-first plan #1, driven by a fake stream)', () => {
  it('normalizes and applies an inbound message to PGlite, then calls onApplied', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied })

    push('projects', [change('p1', '2026-07-07T00:00:01.000Z', { workspace_id: 'ws1', name: 'Tavalo', description: null })])
    // applyInboundDeltas is awaited internally then onApplied fires — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tavalo')
    expect(onApplied).toHaveBeenCalledWith('projects', expect.arrayContaining([expect.objectContaining({ id: 'p1' })]))

    handle.stop()
  })

  it('a control message alone produces no deltas and never calls onApplied', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    startSync(db, { streamFactory: factory, onApplied })

    push('projects', [{ headers: { control: 'up-to-date' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onApplied).not.toHaveBeenCalled()
  })

  // Issue 036: the read-path orchestrator's documented seam for a future
  // sync-status UI ("syncEngine.ts owns reacting to those [control
  // messages]") — onControl is the hook that seam was left for. Additive:
  // must not change the assertion above (onApplied still never fires for a
  // control-only batch).
  it('calls onControl for a control message, without calling onApplied', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const onControl = vi.fn()
    startSync(db, { streamFactory: factory, onApplied, onControl })

    push('projects', [{ headers: { control: 'up-to-date' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onControl).toHaveBeenCalledWith('projects', 'up-to-date')
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('onControl fires per-table and ignores change messages', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onControl = vi.fn()
    startSync(db, { streamFactory: factory, onControl })

    push('projects', [change('p1', '2026-07-07T00:00:01.000Z', { name: 'Tavalo', description: null })])
    push('dimensions', [{ headers: { control: 'must-refetch' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onControl).toHaveBeenCalledTimes(1)
    expect(onControl).toHaveBeenCalledWith('dimensions', 'must-refetch')
  })

  it('a malformed message calls onError instead of throwing', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    startSync(db, { streamFactory: factory, onError })

    push('projects', [{ key: 'bad', value: { name: 'no id' }, headers: { operation: 'insert' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onError).toHaveBeenCalledWith('projects', expect.any(Error))
  })

  it('stop() unsubscribes every table stream', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied })
    handle.stop()

    push('projects', [change('p1', '2026-07-07T00:00:01.000Z', { workspace_id: 'ws1', name: 'Tavalo', description: null })])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onApplied).not.toHaveBeenCalled()
  })
})

// Issue 075 Part A — the CONFIRMED root cause (docs/issues/075): this module
// opens one INDEPENDENT ShapeStream per table (SYNCED_TABLES.map above), each
// applying its own batch the instant THAT table's network response resolves
// — no cross-table ordering. A forward FK to a SIBLING synced table
// (parameters.dimension_id, bindings.context_id/dimension_id/parameter_id)
// is NOT NULL and NOT deferred (unlike the self/cross-referential columns
// DEFERRED_FK_COLUMN already protects in src/db/sync.ts), so if e.g. the
// `parameters` shape resolves before `dimensions` has committed, the whole
// batch throws + rolls back and (before this fix) was just dropped —
// Electric never re-delivers an acked batch. These tests drive startSync
// with the SAME fake per-table stream fixture the rest of this file uses
// (no live Electric server reachable in this repo's tests), deliberately
// NOT pre-seeding the parent row (unlike freshDb(), which only seeds the
// workspace), to actually trigger the race rather than assume it.
describe('startSync — reconcile-retry for cross-table FK races (issue 075 Part A)', () => {
  const WS = 'ws1'
  const T0 = '2026-07-07T00:00:00.000Z'
  const T1 = '2026-07-07T00:00:01.000Z'
  const T2 = '2026-07-07T00:00:02.000Z'
  const T3 = '2026-07-07T00:00:03.000Z'

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  function dimensionChange(id: string, updatedAt: string, extra: Record<string, unknown> = {}): ElectricMessage {
    return change(id, updatedAt, {
      project_id: 'p1',
      workspace_id: WS,
      // Issue 090 — canvas_id is a NOT-NULL membership FK; the root canvas cv1
      // is seeded (via a canvas delta) before any dimension/context applies.
      canvas_id: 'cv1',
      context_id: null,
      source_param_id: null,
      name: 'Value',
      color: '#111',
      sort: 0,
      ...extra,
    })
  }

  // A root canvas delta for p1 — pushed right after the project lands so every
  // dimension/context's NOT-NULL canvas_id resolves (Electric streams canvases
  // too; canvases precedes dimensions/contexts in apply order).
  function canvasChange(id: string, updatedAt: string): ElectricMessage {
    return change(id, updatedAt, {
      project_id: 'p1',
      workspace_id: WS,
      parent_context_id: null,
      name: 'Canvas 1',
      sort: 0,
    })
  }

  function parameterChange(id: string, updatedAt: string, dimensionId: string): ElectricMessage {
    return change(id, updatedAt, {
      dimension_id: dimensionId,
      workspace_id: WS,
      parent_param_id: null,
      source_entry_id: null,
      name: 'Comfort',
      sort: 0,
    })
  }

  function contextChange(id: string, updatedAt: string): ElectricMessage {
    return change(id, updatedAt, {
      project_id: 'p1',
      workspace_id: WS,
      canvas_id: 'cv1',
      parent_id: null,
      symbol: 'α',
      name: null,
      justification: null,
      sort: 0,
    })
  }

  function bindingChange(
    id: string,
    updatedAt: string,
    contextId: string,
    dimensionId: string,
    parameterId: string,
  ): ElectricMessage {
    return change(id, updatedAt, {
      context_id: contextId,
      dimension_id: dimensionId,
      parameter_id: parameterId,
      workspace_id: WS,
      tuple_hash: 'h1',
    })
  }

  it('a parameters batch that races ahead of its not-yet-landed dimensions parent is buffered and retried once the parent applies', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied, onError })

    push('projects', [change('p1', T0, { workspace_id: WS, name: 'Tavalo', description: null })])
    await flush()
    // The project's root canvas lands (dimension/context deltas below FK it).
    push('canvases', [canvasChange('cv1', T0)])
    await flush()

    // parameters races ahead of its dimension parent — currently missing
    // locally, so this batch throws inside applyInboundDeltas and rolls back.
    push('parameters', [parameterChange('pa1', T1, 'd1')])
    await flush()

    expect(onError).toHaveBeenCalledWith('parameters', expect.any(Error))
    expect(await db.select().from(parameters)).toHaveLength(0)

    // The parent lands — a later, independent success on a DIFFERENT table.
    push('dimensions', [dimensionChange('d1', T2)])
    await flush()

    expect(await db.select().from(dimensions)).toHaveLength(1)
    // The retry drained the buffered parameters batch — both rows now present.
    expect(await db.select().from(parameters)).toHaveLength(1)
    expect(onApplied).toHaveBeenCalledWith('parameters', expect.arrayContaining([expect.objectContaining({ id: 'pa1' })]))

    handle.stop()
  })

  it('a deeper bindings chain (needs contexts + dimensions + parameters) converges once every parent has landed, regardless of arrival order', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied, onError })

    push('projects', [change('p1', T0, { workspace_id: WS, name: 'Tavalo', description: null })])
    await flush()
    push('canvases', [canvasChange('cv1', T0)])
    await flush()

    // bindings arrives before ANY of its three parents.
    push('bindings', [bindingChange('b1', T1, 'c1', 'd1', 'pa1')])
    await flush()
    expect(onError).toHaveBeenCalledWith('bindings', expect.any(Error))
    expect(await db.select().from(bindings)).toHaveLength(0)

    // One parent lands — still missing two more, retry still fails silently.
    push('dimensions', [dimensionChange('d1', T2)])
    await flush()
    expect(await db.select().from(bindings)).toHaveLength(0)

    // A second parent lands — still missing contexts.
    push('parameters', [parameterChange('pa1', T2, 'd1')])
    await flush()
    expect(await db.select().from(bindings)).toHaveLength(0)

    // The last parent lands — the buffered binding now applies.
    push('contexts', [contextChange('c1', T2)])
    await flush()
    expect(await db.select().from(bindings)).toHaveLength(1)
    expect(onApplied).toHaveBeenCalledWith('bindings', expect.arrayContaining([expect.objectContaining({ id: 'b1' })]))

    handle.stop()
  })

  it('a genuinely orphaned buffered delta (its parent never arrives) surfaces onError once every synced table reports up-to-date, without looping', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onApplied = vi.fn()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onApplied, onError })

    push('projects', [change('p1', T0, { workspace_id: WS, name: 'Tavalo', description: null })])
    await flush()
    onError.mockClear()

    // References a dimension that will NEVER arrive this session.
    push('parameters', [parameterChange('pa1', T3, 'd-never-arrives')])
    await flush()
    expect(onError).toHaveBeenCalledWith('parameters', expect.any(Error))
    const callsAfterFirstFailure = onError.mock.calls.length

    // Every synced table reports its shape has fully caught up — including
    // `parameters` itself — with no dimensions row ever having arrived.
    for (const table of SYNCED_TABLES) {
      push(table, [{ headers: { control: 'up-to-date' } }])
    }
    await flush()

    // Exactly one MORE onError call — the final orphan surfacing — not a
    // repeating/self-triggering loop (the buffer is drained/cleared by it).
    expect(onError.mock.calls.length).toBe(callsAfterFirstFailure + 1)
    const lastCall = onError.mock.calls[onError.mock.calls.length - 1] as [TableName, unknown]
    expect(lastCall[0]).toBe('parameters')
    expect(await db.select().from(parameters)).toHaveLength(0)

    // A further up-to-date delivery (e.g. a reconnect re-announcing catch-up)
    // must not re-surface the same, already-cleared buffer again.
    push('dimensions', [{ headers: { control: 'up-to-date' } }])
    await flush()
    expect(onError.mock.calls.length).toBe(callsAfterFirstFailure + 1)

    handle.stop()
  })
})

// Issue 075 Part A (drain-race regression) — the concurrency bug the initial
// 075A commit shipped: drainRetryBuffer snapshotted `batch`, awaited the real
// DB transaction, then on success cleared `retryBuffer` WHOLESALE. During
// that await another table's stream can hit its own `.catch` and concat its
// failed deltas onto `retryBuffer`; the wholesale clear then discarded them
// permanently (Electric never re-delivers an acked batch). Since multiple
// shape streams apply concurrently and `applyInboundDeltas` is a real awaited
// transaction, this interleave is exactly the burst condition the whole fix
// exists for. The fix removes ONLY the snapshotted batch (reference-identity
// filter), so anything buffered mid-drain survives to the next drain. This
// test forces the interleave deterministically by gating one specific drain's
// apply open while a second table's batch fails and buffers.
describe('startSync — no deltas dropped when a batch buffers mid-drain (issue 075 Part A drain race)', () => {
  const WS = 'ws1'
  const T0 = '2026-07-07T00:00:00.000Z'
  const T1 = '2026-07-07T00:00:01.000Z'
  const T2 = '2026-07-07T00:00:02.000Z'

  let realApply: (db: Database, deltas: readonly RowDelta[]) => Promise<void>

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../db/sync')>('../db/sync')
    realApply = actual.applyInboundDeltas
  })

  // Restore the plain delegating default after this describe's test so the
  // gated implementation never leaks into any other test.
  afterEach(() => {
    vi.mocked(applyInboundDeltas).mockImplementation((db, deltas) => realApply(db, deltas))
  })

  function settle(times = 6): Promise<void> {
    let p = Promise.resolve()
    for (let i = 0; i < times; i++) p = p.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return p
  }

  it('a batch that fails+buffers DURING an in-flight drain is still retried (not lost) once its parent lands', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError })

    // A gate that holds the pa1 DRAIN's apply open (AFTER it has written pa1)
    // so we can force a second table's failure to buffer mid-drain.
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    let drainReached!: () => void
    const drainReachedP = new Promise<void>((resolve) => {
      drainReached = resolve
    })

    vi.mocked(applyInboundDeltas).mockImplementation(async (db2, deltas) => {
      // Do the real write first (so a successful drain actually lands pa1;
      // a failing FK batch actually rejects here and gets buffered).
      await realApply(db2, deltas)
      // Only the pa1 DRAIN reaches here successfully (the initial pa1 apply
      // rejects above, before this point) — hold it open until released.
      if (deltas.some((d) => d.id === 'pa1')) {
        drainReached()
        await drainGate
      }
    })

    push('projects', [change('p1', T0, { workspace_id: WS, name: 'Tavalo', description: null })])
    await settle()
    // The root canvas lands (issue 090 — dimension/context NOT-NULL canvas_id FK).
    push('canvases', [change('cv1', T0, { project_id: 'p1', workspace_id: WS, parent_context_id: null, name: 'Canvas 1', sort: 0 })])
    await settle()

    // parameters races ahead of its dimension parent -> the batch throws in
    // applyInboundDeltas and pa1 is buffered.
    push('parameters', [
      change('pa1', T1, { dimension_id: 'd1', workspace_id: WS, parent_param_id: null, source_entry_id: null, name: 'Comfort', sort: 0 }),
    ])
    await settle()
    expect(await db.select().from(parameters)).toHaveLength(0)

    // The dimension parent lands -> its apply succeeds -> triggers the pa1
    // drain. The gated mock writes pa1 then holds the drain's promise open.
    push('dimensions', [
      change('d1', T2, { project_id: 'p1', workspace_id: WS, canvas_id: 'cv1', context_id: null, source_param_id: null, name: 'Value', color: '#111', sort: 0 }),
    ])
    await drainReachedP // deterministically: drain is now in flight (holding)

    // WHILE the drain is still awaiting, a bindings batch fails (its parents
    // aren't all present) and concats itself onto retryBuffer — the exact
    // mid-drain interleave. With the wholesale clear, the release below wipes
    // it; with the reference-identity filter, it survives.
    push('bindings', [
      change('b1', T1, { context_id: 'c1', dimension_id: 'd1', parameter_id: 'pa1', workspace_id: WS, tuple_hash: 'h1' }),
    ])
    await settle()
    expect(onError).toHaveBeenCalledWith('bindings', expect.any(Error))

    // Release the drain -> its success path prunes ONLY pa1 (fix) or clears
    // everything (bug).
    releaseDrain()
    await settle()
    expect(await db.select().from(parameters)).toHaveLength(1)

    // The binding's last missing parent (contexts c1) lands -> a fresh
    // successful apply drains the buffer again. If b1 was lost by the
    // wholesale clear, nothing is left to retry and it never applies (RED).
    // If it survived the mid-drain interleave, it applies now (GREEN).
    push('contexts', [
      change('c1', T2, { project_id: 'p1', workspace_id: WS, canvas_id: 'cv1', parent_id: null, symbol: 'α', name: null, justification: null, sort: 0 }),
    ])
    await settle()

    expect(await db.select().from(bindings)).toHaveLength(1)

    handle.stop()
  })
})

// Issue 088 Finding A — the surfacing drain loop must terminate on ACTUAL drain
// PROGRESS, not on raw buffer-length equality. The failure it guards: while a
// full-success drain (inside maybeSurfaceOrphaned's loop, after every table is
// up-to-date) removes K rows, exactly K new FK-failing-BUT-RESOLVABLE rows are
// concatenated from a concurrent stream's `.catch` during that drain's await —
// the buffer length is unchanged, so a length-based `while` exits and the K
// newly-arrived (resolvable) rows are surfaced-as-orphaned and dropped
// permanently. This is the exact false-orphan-drop class 088 exists to kill.
// The test stages that equal-count interleave deterministically with the same
// gated-apply harness the 075A drain-race test uses: it gates a surfacing-loop
// drain of one buffered row (d1) open, then — during the hold — buffers one new
// row (pa9) whose parent (d9) it makes present via a direct insert (standing in
// for a parent committed by a concurrent path during the await). Net buffer
// length is unchanged across the drain (d1 out, pa9 in). With a length-based
// exit pa9 would be surfaced-orphaned; with the progress-based terminator the
// loop keeps going and pa9 converges.
describe('startSync — surfacing drain loop terminates on progress, not length (issue 088 Finding A)', () => {
  const WS = 'ws1'
  const T0 = '2026-07-07T00:00:00.000Z'
  const T1 = '2026-07-07T00:00:01.000Z'

  let realApply: (db: Database, deltas: readonly RowDelta[]) => Promise<void>
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../db/sync')>('../db/sync')
    realApply = actual.applyInboundDeltas
  })
  afterEach(() => {
    vi.mocked(applyInboundDeltas).mockImplementation((db, deltas) => realApply(db, deltas))
  })

  function settle(times = 8): Promise<void> {
    let p = Promise.resolve()
    for (let i = 0; i < times; i++) p = p.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return p
  }
  function dimChange(id: string, updatedAt: string): ElectricMessage {
    // Issue 090 — canvas_id is a NOT-NULL membership FK; the root canvas cv1 is
    // made present (direct insert below) before this dimension is drained.
    return change(id, updatedAt, { project_id: 'p1', workspace_id: WS, canvas_id: 'cv1', context_id: null, source_param_id: null, name: 'Value', color: '#111', sort: 0 })
  }
  function paramChange(id: string, updatedAt: string, dimensionId: string): ElectricMessage {
    return change(id, updatedAt, { dimension_id: dimensionId, workspace_id: WS, parent_param_id: null, source_entry_id: null, name: 'High', sort: 0 })
  }

  it('an equal-count mid-drain concat of a RESOLVABLE row is not surfaced-orphaned — the loop keeps draining until a drain applies nothing', async () => {
    const db = await freshDb()
    const { factory, push } = fakeStreamFactory()
    const onError = vi.fn()
    const handle = startSync(db, { streamFactory: factory, onError })

    // Gate the surfacing-loop drain of d1 open (after it has committed d1) so a
    // second buffered row can be staged during the hold.
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    let drainReached!: () => void
    const drainReachedP = new Promise<void>((resolve) => {
      drainReached = resolve
    })
    vi.mocked(applyInboundDeltas).mockImplementation(async (db2, deltas) => {
      await realApply(db2, deltas) // the initial d1 apply rejects here (p1 absent); the drain succeeds (p1 present)
      if (deltas.length === 1 && deltas[0]?.id === 'd1') {
        drainReached()
        await drainGate
      }
    })

    // d1 races ahead of its project parent -> FK-fails and buffers.
    push('dimensions', [dimChange('d1', T0)])
    await settle()
    expect(await db.select().from(dimensions)).toHaveLength(0)
    onError.mockClear()

    // p1 becomes present WITHOUT a sync apply (direct insert) — so no normal
    // drain fires; d1 stays buffered but is now RESOLVABLE, and the ONLY thing
    // that will drain it is maybeSurfaceOrphaned's own loop below.
    await db.insert(projects).values({ id: 'p1', workspaceId: WS, name: 'Tavalo' })
    // Issue 090 — d1/d9's NOT-NULL canvas_id FK also needs the root canvas
    // present for the drain to resolve (both parents committed out-of-band).
    await db.insert(canvases).values({ id: 'cv1', projectId: 'p1', workspaceId: WS, parentContextId: null, name: 'Canvas 1', sort: 0 })

    // Every shape reports up-to-date -> the last one triggers the surfacing
    // loop, whose drain of [d1] commits d1 then holds (gated).
    for (const table of SYNCED_TABLES) push(table, [{ headers: { control: 'up-to-date' } }])
    await drainReachedP

    // DURING the hold: pa9 (-> d9) streams and FK-fails (d9 absent) -> concats
    // onto the buffer (this initial FK failure legitimately calls onError —
    // it's the normal "buffered, will retry" signal, NOT an orphan verdict).
    // Then d9 is made present (direct insert = a parent committed by a
    // concurrent path). Buffer goes [d1] -> (drain removes d1, pa9 added) ->
    // [pa9]: SAME length across the drain — the equal-count trap.
    push('parameters', [paramChange('pa9', T1, 'd9')])
    await settle()
    await db.insert(dimensions).values({ id: 'd9', projectId: 'p1', workspaceId: WS, canvasId: 'cv1', name: 'D9', color: '#222', sort: 0 })

    releaseDrain()
    await settle()

    // GREEN (progress-based terminator): the loop did NOT stop on the unchanged
    // length — it kept draining and pa9 converged with its REAL dimension_id.
    // A length-based exit would have surfaced pa9 as a false orphan and dropped
    // it permanently (RED): pa9 absent from PGlite + an "orphaned" error.
    const pa = await db.select().from(parameters).where(eq(parameters.id, 'pa9'))
    expect(pa).toHaveLength(1)
    expect(pa[0]?.dimensionId).toBe('d9')
    const orphanErrors = onError.mock.calls.filter(([, err]) => err instanceof Error && err.message.includes('orphaned'))
    expect(orphanErrors).toHaveLength(0)

    handle.stop()
  })
})
