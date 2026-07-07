// Issue 048 test-first plan — drives src/sync/writeTransport.ts with an
// injected HTTP client, exactly like syncEngine.test.ts drives startSync()
// with a fake ShapeStream. No live network in any of these.
import { describe, expect, it, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { MutationQueue, QueuedMutation } from '../domain/mutationQueue'
import type { WriteApiHttpClient, WriteApiHttpResponse } from './writeTransport'
import { flushMutations, toMutationEnvelope } from './writeTransport'

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

function queueOf(...entries: QueuedMutation[]): MutationQueue {
  return { entries }
}

function jsonResponse(status: number, body: unknown): WriteApiHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

const noAuthHeaders = () => Promise.resolve({})

describe('toMutationEnvelope', () => {
  it('bridges the queue snake_case table name to the protocol camelCase MutationTable', () => {
    const envelope = toMutationEnvelope(mutation({ table: 'tier1_purpose' }), 'ws-1')
    expect(envelope.table).toBe('tier1Purpose')
  })

  it('maps rowId/optimisticUpdatedAt/row onto entityId/clientUpdatedAt/payload, and attaches workspaceId', () => {
    const envelope = toMutationEnvelope(
      mutation({ rowId: 'row-9', row: { id: 'row-9', name: 'x' }, optimisticUpdatedAt: '2026-02-02T00:00:00.000Z' }),
      'ws-42',
    )
    expect(envelope).toMatchObject({
      workspaceId: 'ws-42',
      entityId: 'row-9',
      payload: { id: 'row-9', name: 'x' },
      clientUpdatedAt: '2026-02-02T00:00:00.000Z',
    })
  })

  it('maps a delete op straight through, and an upsert to insert', () => {
    expect(toMutationEnvelope(mutation({ op: 'delete' }), 'ws-1').op).toBe('delete')
    expect(toMutationEnvelope(mutation({ op: 'upsert' }), 'ws-1').op).toBe('insert')
  })
})

describe('flushMutations — skips without touching the network (test-first plan #5)', () => {
  it('is a no-op when the queue has no pending entries', async () => {
    const httpClient = vi.fn<WriteApiHttpClient>()
    const result = await flushMutations(queueOf(), 'ws-1', {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(result).toEqual({ kind: 'skipped' })
    expect(httpClient).not.toHaveBeenCalled()
  })

  it('is a no-op when no workspace is resolvable (e.g. signed out, no workspace open)', async () => {
    const httpClient = vi.fn<WriteApiHttpClient>()
    const result = await flushMutations(queueOf(mutation()), null, {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(result).toEqual({ kind: 'skipped' })
    expect(httpClient).not.toHaveBeenCalled()
  })
})

describe('flushMutations — happy path (test-first plan #1)', () => {
  it('POSTs pending mutations as MutationEnvelopes with the JWT header, and acknowledges applied/noop outcomes', async () => {
    const m1 = mutation({ rowId: 'c1' })
    const m2 = mutation({ rowId: 'c2', id: uuidv7() })
    const httpClient = vi.fn<WriteApiHttpClient>().mockResolvedValue(
      jsonResponse(200, {
        outcomes: [
          { mutationId: m1.id, status: 'applied' },
          { mutationId: m2.id, status: 'noop' },
        ],
      }),
    )
    const result = await flushMutations(queueOf(m1, m2), 'ws-1', {
      httpClient,
      getAuthHeaders: () => Promise.resolve({ Authorization: 'Bearer jwt-123' }),
      path: '/write',
    })

    expect(httpClient).toHaveBeenCalledTimes(1)
    const call = httpClient.mock.calls.at(0)
    if (!call) throw new Error('httpClient was not called')
    const [path, init] = call
    expect(path).toBe('/write')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-123', 'Content-Type': 'application/json' })
    const body = JSON.parse(init.body) as { mutations: { id: string }[] }
    expect(body.mutations.map((m) => m.id)).toEqual([m1.id, m2.id])

    expect(result).toEqual({ kind: 'applied', acknowledgedIds: [m1.id, m2.id], rejections: [] })
  })

  it('ignores acknowledged/non-pending entries already resolved', async () => {
    const pending = mutation({ rowId: 'c1' })
    const acknowledged = mutation({ rowId: 'c2', id: uuidv7(), status: 'acknowledged' })
    const httpClient = vi
      .fn<WriteApiHttpClient>()
      .mockResolvedValue(jsonResponse(200, { outcomes: [{ mutationId: pending.id, status: 'applied' }] }))
    await flushMutations(queueOf(pending, acknowledged), 'ws-1', {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    const call = httpClient.mock.calls.at(0)
    if (!call) throw new Error('httpClient was not called')
    const [, init] = call
    const body = JSON.parse(init.body) as { mutations: { id: string }[] }
    expect(body.mutations).toHaveLength(1)
    expect(body.mutations[0]?.id).toBe(pending.id)
  })
})

describe('flushMutations — idempotent retry (test-first plan #2)', () => {
  it('a retried flush of the same still-pending queue resends the identical UUIDv7 envelope ids', async () => {
    const m = mutation()
    const failingClient = vi.fn<WriteApiHttpClient>().mockRejectedValueOnce(new Error('network down'))
    const first = await flushMutations(queueOf(m), 'ws-1', {
      httpClient: failingClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(first).toEqual({ kind: 'network-error' })

    const succeedingClient = vi
      .fn<WriteApiHttpClient>()
      .mockResolvedValue(jsonResponse(200, { outcomes: [{ mutationId: m.id, status: 'applied' }] }))
    const retry = await flushMutations(queueOf(m), 'ws-1', {
      httpClient: succeedingClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })

    const call = succeedingClient.mock.calls.at(0)
    if (!call) throw new Error('succeedingClient was not called')
    const [, init] = call
    const body = JSON.parse(init.body) as { mutations: { id: string }[] }
    expect(body.mutations[0]?.id).toBe(m.id)
    expect(retry).toEqual({ kind: 'applied', acknowledgedIds: [m.id], rejections: [] })
  })
})

describe('flushMutations — offline / network error (test-first plan #3)', () => {
  it('resolves "network-error" and never throws when the HTTP client rejects', async () => {
    const httpClient = vi.fn<WriteApiHttpClient>().mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await flushMutations(queueOf(mutation()), 'ws-1', {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(result).toEqual({ kind: 'network-error' })
  })
})

describe('flushMutations — rejection (test-first plan #4)', () => {
  it('surfaces a per-mutation WriteRejection without acknowledging it', async () => {
    const m = mutation()
    const httpClient = vi.fn<WriteApiHttpClient>().mockResolvedValue(
      jsonResponse(200, {
        outcomes: [
          {
            mutationId: m.id,
            status: 'rejected',
            reason: 'stale_conflict',
            message: "Someone else's more recent change already landed — yours was not applied.",
          },
        ],
      }),
    )
    const result = await flushMutations(queueOf(m), 'ws-1', {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(result).toEqual({
      kind: 'applied',
      acknowledgedIds: [],
      rejections: [
        {
          mutationId: m.id,
          status: 'rejected',
          reason: 'stale_conflict',
          message: "Someone else's more recent change already landed — yours was not applied.",
        },
      ],
    })
  })

  it('surfaces a wholesale 401 as "auth-rejected", not a per-mutation rejection', async () => {
    const httpClient = vi.fn<WriteApiHttpClient>().mockResolvedValue(
      jsonResponse(401, {
        rejection: {
          mutationId: '*',
          reason: 'expired_token',
          message: 'Your session has expired or is invalid — sign in again to keep editing.',
        },
      }),
    )
    const result = await flushMutations(queueOf(mutation()), 'ws-1', {
      httpClient,
      getAuthHeaders: noAuthHeaders,
      path: '/write',
    })
    expect(result).toEqual({
      kind: 'auth-rejected',
      rejection: {
        mutationId: '*',
        reason: 'expired_token',
        message: 'Your session has expired or is invalid — sign in again to keep editing.',
      },
    })
  })
})
