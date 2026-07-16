// @vitest-environment jsdom
// Issue 036 needs `window` for online/offline browser events; the rest of
// this file's pre-existing 032 tests are jsdom-agnostic so this is a safe
// widening (HANDOFF gotcha: plain src/store/*.test.ts otherwise run in node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchError, FetchBackoffAbortError } from '@electric-sql/client'
import { uuidv7 } from 'uuidv7'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, addTier2Table, createContext, createProject } from '../db/mutations'
import { createWorkspace } from '../db/workspaces'
import { dimensions, parameters, projects } from '../db/schema'
import { useCommandLogStore } from './commandLog'
import { useStatusStore } from './status'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetSyncStore, useSyncStore } from './sync'
import { SYNCED_TABLES } from '../sync/config'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import type { TokenProvider } from '../sync/authToken'
import type { ElectricMessage } from '../sync/electricProtocol'
import type { QueuedMutation } from '../domain/mutationQueue'
import type { TableName } from '../domain/syncDelta'
import { SYNC_ERROR_GRACE_MS } from '../domain/syncStatus'

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
  // Issue 086 — capture the subscribe-level onError so a test can simulate a
  // transport/auth error Electric surfaces through that channel (a boot-race
  // 401, an aborted long-poll), distinct from the apply/parse errors a
  // delivered message triggers.
  const errorHandlers = new Map<TableName, (error: unknown) => void>()
  const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
    subscribe(callback, onError) {
      subscribers.set(table, (messages) => void callback(messages))
      if (onError) errorHandlers.set(table, onError)
      return () => {
        subscribers.delete(table)
        errorHandlers.delete(table)
      }
    },
  })
  function deliver(table: TableName, messages: readonly ElectricMessage[]): void {
    subscribers.get(table)?.(messages)
  }
  function deliverUpToDateAll(): void {
    for (const table of SYNCED_TABLES) deliver(table, [{ headers: { control: 'up-to-date' } }])
  }
  function deliverError(table: TableName, error: unknown): void {
    errorHandlers.get(table)?.(error)
  }
  return { factory, deliver, deliverUpToDateAll, deliverError }
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
  // Issue 086 — the debounce tests below opt into fake timers per-test; make
  // sure a failure mid-test never leaks them into an unrelated test.
  vi.useRealTimers()
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

// Issue 068 (Defect B) — the read-path was never authenticated: start() was
// always called with no `getAuthToken`, so SyncOptions.getAuthToken fell
// back to authToken.ts's `noAuth` (always resolves null), and the shape
// proxy's server-side auth gate (401s with no bearer token, src/server/
// shapeProxy/handler.ts) rejected every real client. The fix mirrors how
// flush() (above) already wires the real Cognito JWT via useAuthStore —
// start() must default `getAuthToken` the same way whenever the caller (the
// one production entry point, src/store/projects.ts) doesn't inject its own.
describe('sync store — read-path authentication default (issue 068)', () => {
  it('start() with no caller-supplied getAuthToken defaults to the signed-in id token, not noAuth/null', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    signIn()
    const { db } = await openDatabase('memory://')
    let capturedGetAuthToken: TokenProvider | undefined
    const factory: ShapeStreamFactory = (_table, options) => {
      capturedGetAuthToken = options.getAuthToken
      return { subscribe: () => () => {} }
    }

    useSyncStore.getState().start(db, { streamFactory: factory })

    expect(capturedGetAuthToken).toBeDefined()
    const token = await capturedGetAuthToken?.()
    expect(token).not.toBeNull()
    expect(token).toBe(useAuthStore.getState().idToken)
  })

  it('a caller-supplied getAuthToken is used as-is (not overridden by the default)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const callerToken: TokenProvider = () => Promise.resolve('caller-supplied-token')
    let capturedGetAuthToken: TokenProvider | undefined
    const factory: ShapeStreamFactory = (_table, options) => {
      capturedGetAuthToken = options.getAuthToken
      return { subscribe: () => () => {} }
    }

    useSyncStore.getState().start(db, { streamFactory: factory, getAuthToken: callerToken })

    expect(await capturedGetAuthToken?.()).toBe('caller-supplied-token')
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

// Issue 072 — the `projects` analogue of `invitationsAppliedAt`/
// `membersAppliedAt` directly above: a plain "an inbound `projects` delta
// just applied" timestamp, bumped by onApplied the same way. Closes the read
// side of 072's second (independent) defect — src/store/projects.ts's own
// re-list subscriber is the one consumer (see projects.test.ts).
describe('sync store — projects delta signal (issue 072)', () => {
  it('projectsAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().projectsAppliedAt).toBe(0)
  })

  it('bumps projectsAppliedAt when an inbound `projects` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().projectsAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."projects"/"p1"',
        value: {
          id: 'p1',
          workspace_id: ws.id,
          name: 'Tavalo',
          description: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().projectsAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump projectsAppliedAt for a delta on a different table', async () => {
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

    expect(useSyncStore.getState().projectsAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets projectsAppliedAt back to 0', () => {
    useSyncStore.setState({ projectsAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().projectsAppliedAt).toBe(0)
  })
})

// Issue 075 Part B — the Design-tier analogues of invitationsAppliedAt/
// membersAppliedAt/projectsAppliedAt above: every remaining synced table gets
// its own re-load signal so src/store/{dimensions,contexts,parameters,tier1,
// tier2}.ts can each re-`load()` off their own ground truth instead of only
// ever loading once on mount (the root cause the Design tier never rendered a
// late-arriving delta — docs/issues/075). A delta on an unrelated table (a
// `projects` insert, used uniformly below) never bumps any of these.
function unrelatedTableDelta(ws: { id: string }): ElectricMessage {
  return {
    key: '"public"."projects"/"p-other"',
    value: {
      id: 'p-other',
      workspace_id: ws.id,
      name: 'Unrelated',
      description: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:02.000Z',
      deleted_at: null,
    },
    headers: { operation: 'insert' },
  }
}

describe('sync store — dimensions delta signal (issue 075 Part B)', () => {
  it('dimensionsAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().dimensionsAppliedAt).toBe(0)
  })

  it('bumps dimensionsAppliedAt when an inbound `dimensions` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'dimensions') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().dimensionsAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."dimensions"/"d1"',
        value: {
          id: 'd1',
          project_id: project.id,
          workspace_id: project.workspaceId,
          context_id: null,
          source_param_id: null,
          name: 'Value',
          color: '#111',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().dimensionsAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump dimensionsAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().dimensionsAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets dimensionsAppliedAt back to 0', () => {
    useSyncStore.setState({ dimensionsAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().dimensionsAppliedAt).toBe(0)
  })
})

describe('sync store — contexts delta signal (issue 075 Part B)', () => {
  it('contextsAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().contextsAppliedAt).toBe(0)
  })

  it('bumps contextsAppliedAt when an inbound `contexts` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
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
    expect(useSyncStore.getState().contextsAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."contexts"/"c1"',
        value: {
          id: 'c1',
          project_id: project.id,
          workspace_id: project.workspaceId,
          parent_id: null,
          symbol: 'α',
          name: null,
          justification: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().contextsAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump contextsAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().contextsAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets contextsAppliedAt back to 0', () => {
    useSyncStore.setState({ contextsAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().contextsAppliedAt).toBe(0)
  })
})

describe('sync store — parameters delta signal (issue 075 Part B)', () => {
  it('parametersAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().parametersAppliedAt).toBe(0)
  })

  it('bumps parametersAppliedAt when an inbound `parameters` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const dim = await addDimension(db, project.id)
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'parameters') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().parametersAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."parameters"/"pa1"',
        value: {
          id: 'pa1',
          dimension_id: dim.id,
          workspace_id: dim.workspaceId,
          parent_param_id: null,
          source_entry_id: null,
          name: 'Comfort',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().parametersAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump parametersAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().parametersAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets parametersAppliedAt back to 0', () => {
    useSyncStore.setState({ parametersAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().parametersAppliedAt).toBe(0)
  })
})

describe('sync store — bindings delta signal (issue 075 Part B)', () => {
  it('bindingsAppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().bindingsAppliedAt).toBe(0)
  })

  it('bumps bindingsAppliedAt when an inbound `bindings` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'bindings') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })
    expect(useSyncStore.getState().bindingsAppliedAt).toBe(0)

    box.deliver?.([
      {
        key: '"public"."bindings"/"b1"',
        value: {
          id: 'b1',
          context_id: ctx.id,
          dimension_id: dim.id,
          parameter_id: param.id,
          workspace_id: ctx.workspaceId,
          tuple_hash: 'x',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().bindingsAppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump bindingsAppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().bindingsAppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets bindingsAppliedAt back to 0', () => {
    useSyncStore.setState({ bindingsAppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().bindingsAppliedAt).toBe(0)
  })
})

// tier1_purpose and tier1_props deliberately share ONE signal (sync.ts's own
// field doc comment: tier1.ts's load() always reads both together) — proven
// below by bumping it from EITHER half of the pair, independently.
describe('sync store — tier1 delta signal (issue 075 Part B)', () => {
  it('tier1AppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().tier1AppliedAt).toBe(0)
  })

  it('bumps tier1AppliedAt when an inbound `tier1_purpose` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'tier1_purpose') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([
      {
        key: '"public"."tier1_purpose"/"tp1"',
        value: {
          id: 'tp1',
          project_id: project.id,
          workspace_id: project.workspaceId,
          body: 'Our purpose',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier1AppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('bumps tier1AppliedAt when an inbound `tier1_props` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'tier1_props') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([
      {
        key: '"public"."tier1_props"/"tpr1"',
        value: {
          id: 'tpr1',
          project_id: project.id,
          workspace_id: project.workspaceId,
          rank: 1,
          name: 'Comfort',
          description: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier1AppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump tier1AppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier1AppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets tier1AppliedAt back to 0', () => {
    useSyncStore.setState({ tier1AppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().tier1AppliedAt).toBe(0)
  })
})

// tier2_tables and tier2_entries deliberately share ONE signal, same
// rationale as tier1 above (tier2.ts's load() always reads both together) —
// proven below by bumping it from EITHER half of the pair, independently.
describe('sync store — tier2 delta signal (issue 075 Part B)', () => {
  it('tier2AppliedAt starts at 0 — no delta has applied yet', () => {
    expect(useSyncStore.getState().tier2AppliedAt).toBe(0)
  })

  it('bumps tier2AppliedAt when an inbound `tier2_tables` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'tier2_tables') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([
      {
        key: '"public"."tier2_tables"/"t1"',
        value: {
          id: 't1',
          project_id: project.id,
          workspace_id: project.workspaceId,
          name: 'Value',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier2AppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('bumps tier2AppliedAt when an inbound `tier2_entries` delta applies', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const table = await addTier2Table(db, project.id, 'Value')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (t): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (t === 'tier2_entries') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })

    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([
      {
        key: '"public"."tier2_entries"/"e1"',
        value: {
          id: 'e1',
          table_id: table.id,
          workspace_id: table.workspaceId,
          parent_id: null,
          name: 'Comfort',
          description: null,
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier2AppliedAt).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('does NOT bump tier2AppliedAt for a delta on a different table', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([unrelatedTableDelta(ws)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().tier2AppliedAt).toBe(0)
    vi.unstubAllEnvs()
  })

  it('resetSyncStore() resets tier2AppliedAt back to 0', () => {
    useSyncStore.setState({ tier2AppliedAt: 12345 })
    resetSyncStore()
    expect(useSyncStore.getState().tier2AppliedAt).toBe(0)
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

  // Issue 086 — a genuine read error is now DEBOUNCED: it must not flash
  // "Sync error" instantly, only after it stays unresolved past the grace
  // window. A malformed message (toRowDeltas parse throw) is a genuine,
  // non-ignorable error (isIgnorableReadError === false), so it exercises the
  // debounce end-to-end. Fake timers keep the grace deterministic — no
  // wall-clock waits.
  it('a genuine onError debounces: NOT "error" within the grace window, "error" only after it elapses (issue 086)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')

    vi.useFakeTimers()
    // A malformed message triggers syncEngine's onError synchronously
    // (toRowDeltas throws before any async apply).
    deliver('contexts', [{ key: 'bad', value: { name: 'no id' }, headers: { operation: 'insert' } }])
    // Within the grace window the banner stays calm — not "error".
    expect(useSyncStore.getState().errorSince).not.toBeNull()
    expect(useSyncStore.getState().status).not.toBe('error')
    expect(useSyncStore.getState().status).toBe('syncing')

    // The grace elapses with no success to clear it -> the banner surfaces.
    vi.advanceTimersByTime(SYNC_ERROR_GRACE_MS)
    expect(useSyncStore.getState().status).toBe('error')
    vi.useRealTimers()
  })

  it('a success within the grace window clears the debounced error and the banner never appears (issue 086, plan #5)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')

    vi.useFakeTimers()
    deliver('contexts', [{ key: 'bad', value: { name: 'no id' }, headers: { operation: 'insert' } }])
    expect(useSyncStore.getState().errorSince).not.toBeNull()
    expect(useSyncStore.getState().status).not.toBe('error')

    // A success arrives before the grace elapses: errorSince clears and the
    // pending grace timer is cancelled.
    deliverUpToDateAll()
    expect(useSyncStore.getState().errorSince).toBeNull()
    expect(useSyncStore.getState().status).toBe('synced')

    // Advancing past the grace must NOT resurrect the (already cleared) error.
    vi.advanceTimersByTime(SYNC_ERROR_GRACE_MS * 2)
    expect(useSyncStore.getState().status).toBe('synced')
    vi.useRealTimers()
  })

  // Issue 086 plan #2 — the pre-signin boot-race (a 401 missing_token before
  // the Cognito token attaches) is hard-ignored: it never sets errorSince, so
  // it can never surface the banner, even after the grace window elapses.
  it('a boot-race missing_token/401 onError never sets errorSince and never shows "error" (issue 086, plan #2)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliverError, deliverUpToDateAll } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })

    vi.useFakeTimers()
    deliverError(
      'contexts',
      new FetchError(
        401,
        JSON.stringify({ error: 'missing_token' }),
        { error: 'missing_token' },
        {},
        'https://sync.example/v1/shape',
        'missing_token',
      ),
    )
    expect(useSyncStore.getState().errorSince).toBeNull()
    expect(useSyncStore.getState().status).not.toBe('error')

    // Even after well past the grace window, the boot-race never surfaces.
    vi.advanceTimersByTime(SYNC_ERROR_GRACE_MS * 2)
    expect(useSyncStore.getState().status).not.toBe('error')
    vi.useRealTimers()

    // And a normal catch-up afterwards settles cleanly to synced.
    deliverUpToDateAll()
    expect(useSyncStore.getState().status).toBe('synced')
  })

  // Issue 086 plan #3 — normal long-poll churn Electric retries on its own
  // (an aborted long-poll / closed socket) is hard-ignored too.
  it('a transient transport abort onError never sets errorSince (issue 086, plan #3)', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliverError } = fakeStreamFactory()
    useSyncStore.getState().start(db, { streamFactory: factory })

    vi.useFakeTimers()
    deliverError('dimensions', new FetchBackoffAbortError())
    expect(useSyncStore.getState().errorSince).toBeNull()

    vi.advanceTimersByTime(SYNC_ERROR_GRACE_MS * 2)
    expect(useSyncStore.getState().status).not.toBe('error')
    vi.useRealTimers()
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

// Issue 075 Part A — the cross-table FK race, driven end-to-end through the
// store (this is the one place the read-error STATE lives — syncEngine.ts
// itself has no error state, only the onError callback). Deliberately does NOT
// pre-seed the `dimensions`/`parameters` parent rows (unlike this file's other
// tests, which only ever exercise a single already-satisfiable delta) — the
// whole point is to trigger the real race: a `parameters` shape resolving
// before its `dimensions` parent has committed locally. Issue 086 renamed the
// raw signal `hasError: boolean` -> `errorSince: number | null` (a genuine
// apply error is a real, non-ignorable failure, so it DOES set errorSince —
// asserted here on the raw signal, independent of the debounced banner).
describe('sync store — reconcile-retry convergence for cross-table FK races (issue 075 Part A)', () => {
  it('a parameters delta that races ahead of dimensions is buffered, then lands (no lingering error) once the parent applies and all tables report up-to-date', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    await createProject(db, { name: 'Tavalo' })
    const [project] = await db.select().from(projects)
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()

    useSyncStore.getState().start(db, { streamFactory: factory })

    // parameters arrives first, referencing a dimension not yet local.
    deliver('parameters', [
      {
        key: '"public"."parameters"/"pa1"',
        value: {
          id: 'pa1',
          dimension_id: 'd1',
          workspace_id: project?.workspaceId,
          parent_param_id: null,
          source_entry_id: null,
          name: 'Comfort',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().errorSince).not.toBeNull()
    expect(await db.select().from(parameters)).toHaveLength(0)

    // Its dimension parent lands next, on an independent table stream.
    deliver('dimensions', [
      {
        key: '"public"."dimensions"/"d1"',
        value: {
          id: 'd1',
          project_id: project?.id,
          workspace_id: project?.workspaceId,
          context_id: null,
          source_param_id: null,
          name: 'Value',
          color: '#111',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:02.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The retry drained: both rows now durably present in local PGlite.
    expect(await db.select().from(dimensions)).toHaveLength(1)
    expect(await db.select().from(parameters)).toHaveLength(1)
    // The successful retry's onApplied cleared errorSince, same as any other
    // successful apply — no lingering error from the earlier race.
    expect(useSyncStore.getState().errorSince).toBeNull()

    // Every table settling up-to-date must not resurrect the (already
    // resolved) error.
    deliverUpToDateAll()
    expect(useSyncStore.getState().errorSince).toBeNull()
    vi.unstubAllEnvs()
  })

  it('a genuinely orphaned parameters delta (its dimension never arrives) surfaces a real error once every table reports up-to-date, not before', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    const { db } = await openDatabase('memory://')
    const { factory, deliver, deliverUpToDateAll } = fakeStreamFactory()

    useSyncStore.getState().start(db, { streamFactory: factory })

    deliver('parameters', [
      {
        key: '"public"."parameters"/"pa1"',
        value: {
          id: 'pa1',
          dimension_id: 'd-never-arrives',
          workspace_id: 'ws-whatever',
          parent_param_id: null,
          source_entry_id: null,
          name: 'Comfort',
          sort: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSyncStore.getState().errorSince).not.toBeNull()

    // Every OTHER synced table catches up first — the dimension this row
    // needs is simply never coming this session. Still buffered/racing until
    // the LAST table reports up-to-date.
    const otherTables = SYNCED_TABLES.filter((t) => t !== 'dimensions')
    for (const table of otherTables) deliver(table, [{ headers: { control: 'up-to-date' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The final table (dimensions) reports up-to-date too — convergence
    // reached with the buffer still non-empty: a real, surfaced error.
    deliver('dimensions', [{ headers: { control: 'up-to-date' } }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSyncStore.getState().errorSince).not.toBeNull()
    expect(await db.select().from(parameters)).toHaveLength(0)

    // deliverUpToDateAll() re-delivering up-to-date again must not loop or
    // throw — the buffer is already drained/cleared.
    expect(() => deliverUpToDateAll()).not.toThrow()
    vi.unstubAllEnvs()
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
