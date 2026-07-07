import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import { projects, workspaces } from '../db/schema'
import { startSync, type ShapeStreamFactory, type ShapeStreamLike } from './syncEngine'
import type { ElectricMessage } from './electricProtocol'
import type { TableName } from '../domain/syncDelta'

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
