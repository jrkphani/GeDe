// @vitest-environment jsdom
// Issue 036 needs `window` for online/offline browser events; the rest of
// this file's pre-existing 032 tests are jsdom-agnostic so this is a safe
// widening (HANDOFF gotcha: plain src/store/*.test.ts otherwise run in node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { projects } from '../db/schema'
import { useCommandLogStore } from './commandLog'
import { useStatusStore } from './status'
import { resetSyncStore, useSyncStore } from './sync'
import { SYNCED_TABLES } from '../sync/config'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import type { ElectricMessage } from '../sync/electricProtocol'
import type { QueuedMutation } from '../domain/mutationQueue'
import type { TableName } from '../domain/syncDelta'

// A per-table fake shape stream (issue 036): mirrors syncEngine.test.ts's
// fakeStreamFactory, but also exposes deliverUpToDateAll() so a store test
// can simulate every synced table's shape catching up without hand-writing 9
// individual control-message deliveries per test.
function fakeStreamFactory() {
  const subscribers = new Map<TableName, (messages: readonly ElectricMessage[]) => void>()
  const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
    subscribe(callback) {
      subscribers.set(table, (messages) => void callback(messages))
      return () => subscribers.delete(table)
    },
  })
  function deliver(table: TableName, messages: readonly ElectricMessage[]): void {
    subscribers.get(table)?.(messages)
  }
  function deliverUpToDateAll(): void {
    for (const table of SYNCED_TABLES) deliver(table, [{ headers: { control: 'up-to-date' } }])
  }
  return { factory, deliver, deliverUpToDateAll }
}

function mutation(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  return {
    id: uuidv7(),
    table: 'contexts',
    rowId: 'ctx-1',
    op: 'upsert',
    row: { id: 'ctx-1', symbol: 'α' },
    optimisticUpdatedAt: '2026-01-01T00:00:01.000Z',
    enqueuedAt: '2026-01-01T00:00:01.000Z',
    status: 'pending',
    ...overrides,
  }
}

beforeEach(() => {
  resetSyncStore()
  useCommandLogStore.getState().clear()
  useStatusStore.setState({ message: null, action: null })
})

afterEach(() => {
  resetSyncStore()
  vi.unstubAllEnvs()
})

describe('sync store — feature-flag gate (test-first plan #6)', () => {
  it('start() is a no-op when VITE_SYNC_ENABLED is unset (the default, tested v1 path)', async () => {
    const { db } = await openDatabase('memory://')
    useSyncStore.getState().start(db)
    expect(useSyncStore.getState().enabled).toBe(false)
    expect(useSyncStore.getState().handle).toBeNull()
  })
})

describe('sync store — mutation queue', () => {
  it('enqueueLocalMutation tracks pendingCount', () => {
    useSyncStore.getState().enqueueLocalMutation(mutation())
    expect(useSyncStore.getState().pendingCount).toBe(1)
  })
})

describe('sync store — undo/redo isolation (test-first plan #5)', () => {
  it('the sync store never touches the command log', () => {
    const before = useCommandLogStore.getState().past.length
    useSyncStore.getState().enqueueLocalMutation(mutation())
    useSyncStore.getState().stop()
    expect(useCommandLogStore.getState().past.length).toBe(before)
  })
})

describe('sync store — engine lifecycle (driven by a fake stream, no live Electric)', () => {
  it('start()/stop() manage the engine handle when sync is force-enabled', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const factory: ShapeStreamFactory = (): ShapeStreamLike => ({
      subscribe: () => () => {},
    })
    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().enabled).toBe(true)
    expect(useSyncStore.getState().handle).not.toBeNull()

    useSyncStore.getState().stop()
    expect(useSyncStore.getState().enabled).toBe(false)
    expect(useSyncStore.getState().handle).toBeNull()
    vi.unstubAllEnvs()
  })

  it('reconciles the queue when the engine applies an authoritative delta', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    // Seed the project the incoming context row's FK requires.
    await createProject(db, { name: 'Tavalo' })
    const [project] = await db.select().from(projects)
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'contexts') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().enqueueLocalMutation(
      mutation({ rowId: 'c1', optimisticUpdatedAt: '2026-01-01T00:00:01.000Z' }),
    )
    expect(useSyncStore.getState().pendingCount).toBe(1)

    useSyncStore.getState().start(db, { streamFactory: factory })
    box.deliver?.([
      {
        key: '"public"."contexts"/"c1"',
        value: {
          id: 'c1',
          project_id: project?.id,
          workspace_id: project?.workspaceId,
          parent_id: null,
          symbol: 'α',
          name: null,
          justification: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:02.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().pendingCount).toBe(0)
    vi.unstubAllEnvs()
  })
})

// Issue 036 — sync-state derivation wired to the live engine + browser
// network events. All fake-stream driven (no live Electric server reachable
// in this repo's tests, HANDOFF/032's own constraint) — same DI pattern 032
// established.
describe('sync store — status derivation (issue 036)', () => {
  it('is "disabled" before start() (sync not enabled, v1 default)', () => {
    expect(useSyncStore.getState().status).toBe('disabled')
  })

  it('goes "offline" on a browser offline event, and back "online" reflects in state', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })

    window.dispatchEvent(new Event('offline'))
    expect(useSyncStore.getState().status).toBe('offline')
    expect(useSyncStore.getState().online).toBe(false)

    window.dispatchEvent(new Event('online'))
    expect(useSyncStore.getState().online).toBe(true)
  })

  it('offline (queued) -> reconnecting -> synced, count draining to 0 (test-first plan #2)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    await createProject(db, { name: 'Tavalo' })
    const [project] = await db.select().from(projects)
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()

    useSyncStore.getState().start(db, { streamFactory: factory })
    // Catch up fully once while "online" so the baseline state is settled.
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')

    // Queue a local write, then drop the connection.
    useSyncStore.getState().enqueueLocalMutation({
      id: uuidv7(),
      table: 'contexts',
      rowId: 'c1',
      op: 'upsert',
      row: { id: 'c1', symbol: 'α' },
      optimisticUpdatedAt: '2026-01-01T00:00:01.000Z',
      enqueuedAt: '2026-01-01T00:00:01.000Z',
      status: 'pending',
    })
    window.dispatchEvent(new Event('offline'))
    expect(useSyncStore.getState().status).toBe('offline')
    expect(useSyncStore.getState().pendingCount).toBe(1)

    // Reconnect: still catching up (fresh up-to-date not yet re-received).
    window.dispatchEvent(new Event('online'))
    expect(useSyncStore.getState().status).toBe('reconnecting')

    // Every synced table reports caught-up again, but the queued write hasn't
    // been acknowledged yet — still reconnecting, not falsely "synced".
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('reconnecting')
    expect(useSyncStore.getState().pendingCount).toBe(1)

    // The authoritative echo for the queued write arrives -> drains to 0,
    // settles to synced.
    deliver('contexts', [
      {
        key: '"public"."contexts"/"c1"',
        value: {
          id: 'c1',
          project_id: project?.id,
          workspace_id: project?.workspaceId,
          parent_id: null,
          symbol: 'α',
          name: null,
          justification: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:02.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().pendingCount).toBe(0)
    expect(useSyncStore.getState().status).toBe('synced')
  })

  it('onError -> "error", self-heals to "synced" on the next successful apply', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')

    // A malformed message triggers syncEngine's onError.
    deliver('contexts', [{ key: 'bad', value: { name: 'no id' }, headers: { operation: 'insert' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSyncStore.getState().status).toBe('error')

    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')
  })
})

describe('sync store — lost-edit note (issue 036, test-first plan #3)', () => {
  it('a newer authoritative delta that overwrites a pending local write announces a quiet note (no modal)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    await createProject(db, { name: 'Tavalo' })
    const [project] = await db.select().from(projects)
    const { factory, deliver } = fakeStreamFactory()

    useSyncStore.getState().enqueueLocalMutation({
      id: uuidv7(),
      table: 'contexts',
      rowId: 'c1',
      op: 'upsert',
      row: { id: 'c1', symbol: 'α', name: 'My local name' },
      optimisticUpdatedAt: '2026-01-01T00:00:01.000Z',
      enqueuedAt: '2026-01-01T00:00:01.000Z',
      status: 'pending',
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    deliver('contexts', [
      {
        key: '"public"."contexts"/"c1"',
        value: {
          id: 'c1',
          project_id: project?.id,
          workspace_id: project?.workspaceId,
          parent_id: null,
          symbol: 'α',
          name: 'Someone else renamed it',
          justification: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:02.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useStatusStore.getState().message).toBe('A local change was replaced by a newer update.')
    expect(useStatusStore.getState().action).toBeNull()
  })
})
