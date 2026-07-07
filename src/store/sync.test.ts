import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { projects } from '../db/schema'
import { useCommandLogStore } from './commandLog'
import { resetSyncStore, useSyncStore } from './sync'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import type { ElectricMessage } from '../sync/electricProtocol'
import type { QueuedMutation } from '../domain/mutationQueue'

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
})

afterEach(() => {
  resetSyncStore()
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
