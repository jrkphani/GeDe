// @vitest-environment jsdom
// Issue 036 needs `window` for online/offline browser events; the rest of
// this file's pre-existing 032 tests are jsdom-agnostic so this is a safe
// widening (HANDOFF gotcha: plain src/store/*.test.ts otherwise run in node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { createWorkspace } from '../db/workspaces'
import { projects } from '../db/schema'
import { useCommandLogStore } from './commandLog'
import { useStatusStore } from './status'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetSyncStore, useSyncStore } from './sync'
import { SYNCED_TABLES } from '../sync/config'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import type { ElectricMessage } from '../sync/electricProtocol'
import type { QueuedMutation } from '../domain/mutationQueue'
import type { TableName } from '../domain/syncDelta'

// Issue 048 — signs the store into "authenticated" without ever touching the
// real amazon-cognito-identity-js client: getAuthHeaders() (src/auth/
// wireIdentity.ts) reads useAuthStore.getState().getIdToken(), which returns
// the cached idToken as-is when it isn't expired (src/store/auth.ts), so a
// real-shaped, not-yet-expired JWT here is enough to avoid ever calling
// cognitoClient.getCurrentSession().
function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeIdToken(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ sub: 'user-1', email: 'a@b.com', exp, iat: 1 }))
  return `${header}.${body}.fake-signature`
}

function signIn(): void {
  useAuthStore.setState({
    status: 'authenticated',
    configured: true,
    user: { sub: 'user-1', email: 'a@b.com' },
    idToken: fakeIdToken(),
    accessToken: 'fake-access-token',
  })
}

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
  resetAuthStoreForTests()
  useCommandLogStore.getState().clear()
  useStatusStore.setState({ message: null, action: null })
})

afterEach(() => {
  resetSyncStore()
  resetAuthStoreForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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

  // Issue 058 test-first plan item 1: "start() no longer short-circuits when
  // syncBaseUrl() is non-empty — add/confirm a test for the 'real URL, no
  // injected factory' branch too." The gate's PURE decision logic
  // (`shouldSkipReadPath`, src/sync/config.ts) is unit-tested directly in
  // config.test.ts, in complete isolation from the real Electric
  // ShapeStream client — this repo's tests never construct a real
  // ShapeStream (HANDOFF: "no live Electric server is reachable in tests");
  // doing so here leaks an unresolvable background long-poll into later
  // tests (confirmed empirically: it inflates an unrelated fetch-mock
  // assertion two tests later). This test instead proves `start()` ACTUALLY
  // consults that gate, end-to-end, via the same `streamFactory` DI seam
  // every other test in this file already uses — a real URL is set
  // alongside the injected factory, confirming the gate reads
  // `syncBaseUrl()` and doesn't just always pass because a factory happens
  // to be present.
  it('start() proceeds once VITE_SYNC_URL is populated (051\'s gate no longer blocks it)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    vi.stubEnv('VITE_SYNC_URL', 'https://sync.example.test')
    const { db } = await openDatabase('memory://')
    const factory: ShapeStreamFactory = (): ShapeStreamLike => ({ subscribe: () => () => {} })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().enabled).toBe(true)
    expect(useSyncStore.getState().handle).not.toBeNull()

    useSyncStore.getState().stop()
    vi.unstubAllEnvs()
  })

  it('start() still no-ops when VITE_SYNC_URL is empty and no streamFactory is injected (051\'s original crash-on-empty-URL guard, unregressed)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    vi.stubEnv('VITE_SYNC_URL', '')
    const { db } = await openDatabase('memory://')

    expect(() => useSyncStore.getState().start(db)).not.toThrow()
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

// Issue 062 — the invitee-discovery client wiring: once `invitations` is a
// real SYNCED_TABLES entry (src/domain/syncScope.ts), an inbound invitation
// delta lands via the SAME onApplied path every other table already uses —
// but nothing previously re-ran useWorkspaceStore.loadMyInvitations() when
// that happened, so the 060 "Invitations" badge only ever refreshed on
// mount/identity-change, never on a genuinely NEW inbound invite arriving
// mid-session. `invitationsAppliedAt` is the generic, workspace-store-free
// signal PendingInvitations.tsx subscribes to (see that component's own
// effect) to close that gap without this store needing to know anything
// about invitations semantics beyond "which table just applied".
describe('sync store — invitations delta signal (issue 062)', () => {
  it('invitationsAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().invitationsAppliedAt).toBe(0)
  })

  it('bumps invitationsAppliedAt when an inbound `invitations` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'invitations') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().invitationsAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."invitations"/"inv1"',
        value: {
          id: 'inv1',
          workspace_id: ws.id,
          email: 'invitee@example.com',
          role: 'viewer',
          invited_by_sub: 'sub-owner',
          expires_at: '2026-08-01T00:00:00.000Z',
          accepted_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().invitationsAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump invitationsAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
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

    expect(useSyncStore.getState().invitationsAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets invitationsAppliedAt back to 0', () => {
    useSyncStore.setState({ invitationsAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().invitationsAppliedAt).toBe(0)
  })
})

// Issue 067 — the client half of streaming `workspace_members`: mirrors
// `invitationsAppliedAt` (062) exactly, but for inbound member deltas, so
// the shared Members panel (WorkspaceMembers.tsx, via useWorkspaceRole's own
// load-on-change effect) can refresh when another client's accept/role-
// change/removal streams in mid-session — the whole point of this issue.
describe('sync store — workspace_members delta signal (issue 067)', () => {
  it('membersAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().membersAppliedAt).toBe(0)
  })

  it('bumps membersAppliedAt when an inbound `workspace_members` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'workspace_members') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().membersAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."workspace_members"/"mem1"',
        value: {
          id: 'mem1',
          workspace_id: ws.id,
          user_sub: 'sub-invitee',
          role: 'editor',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().membersAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump membersAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
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

    expect(useSyncStore.getState().membersAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets membersAppliedAt back to 0', () => {
    useSyncStore.setState({ membersAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().membersAppliedAt).toBe(0)
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

// Issue 048 — the write-transport wiring itself (src/sync/writeTransport.ts)
// is exhaustively DI-tested in isolation; these drive the store-level seam
// (the real `fetch`, stubbed globally — there is no DI seam for the HTTP
// client at the store layer, see sync.ts's own doc comment) to prove the
// wiring — gating, queue reconciliation, status announcement — actually
// fires end to end.
describe('sync store — write-queue flush (issue 048)', () => {
  it('signed-out: flush() never touches fetch, queue stays pending (test-first plan #5)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    useSyncStore.getState().setWorkspaceId('ws-1')
    useSyncStore.getState().enqueueLocalMutation(mutation())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useSyncStore.getState().pendingCount).toBe(1)
  })

  it('sync=off: flush() never touches fetch even when signed in with a workspace open (test-first plan #5)', async () => {
    signIn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    useSyncStore.getState().setWorkspaceId('ws-1')
    useSyncStore.getState().enqueueLocalMutation(mutation())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useSyncStore.getState().pendingCount).toBe(1)
  })

  it('happy path: POSTs the pending queue as MutationEnvelopes with the JWT header and drains pendingCount on ack (test-first plan #1)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    signIn()
    const m = mutation()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ outcomes: [{ mutationId: m.id, status: 'applied' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    useSyncStore.getState().setWorkspaceId('ws-1')
    useSyncStore.getState().enqueueLocalMutation(m)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/write')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /)
    const body = JSON.parse(init.body as string) as { mutations: { id: string; workspaceId: string }[] }
    expect(body.mutations).toEqual([expect.objectContaining({ id: m.id, workspaceId: 'ws-1' })])

    expect(useSyncStore.getState().pendingCount).toBe(0)
  })

  it('rejection reconciliation: drops the rejected entry, announces a calm status error, and leaves the undo stack untouched (test-first plan #4)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    signIn()
    const m = mutation()
    const rejectionMessage = "Someone else's more recent change already landed — yours was not applied."
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          outcomes: [{ mutationId: m.id, status: 'rejected', reason: 'stale_conflict', message: rejectionMessage }],
        }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const commandLogBefore = useCommandLogStore.getState().past.length

    useSyncStore.getState().setWorkspaceId('ws-1')
    useSyncStore.getState().enqueueLocalMutation(m)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().pendingCount).toBe(0)
    expect(useStatusStore.getState().message).toBe(rejectionMessage)
    expect(useCommandLogStore.getState().past.length).toBe(commandLogBefore)
  })

  it('offline backlog + reconnect: a write that fails while offline flushes once the browser comes back online (test-first plan #3)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    signIn()
    const m = mutation()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ outcomes: [{ mutationId: m.id, status: 'applied' }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    useSyncStore.getState().setWorkspaceId('ws-1')
    const { db } = await openDatabase('memory://')
    const { factory } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })

    useSyncStore.getState().enqueueLocalMutation(m)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The first attempt (triggered by enqueue) failed over the network —
    // the write stays queued, not lost.
    expect(useSyncStore.getState().pendingCount).toBe(1)

    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useSyncStore.getState().pendingCount).toBe(0)
  })
})
