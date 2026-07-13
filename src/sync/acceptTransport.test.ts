// Issue 080 — drives src/sync/acceptTransport.ts with an injected HTTP
// client, exactly like writeTransport.test.ts drives flushMutations(). No
// live network in any of these.
import { describe, expect, it } from 'vitest'
import { acceptInvitationOnServer, type AcceptApiHttpClient, type AcceptApiHttpResponse } from './acceptTransport'

function jsonResponse(status: number, body: unknown): AcceptApiHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

const noAuthHeaders = () => Promise.resolve({})
const request = { invitationId: 'inv-1', workspaceId: 'ws-1' }

describe('acceptInvitationOnServer — request shape', () => {
  it('POSTs { invitationId, workspaceId } as JSON to the given path, merging in the auth headers', async () => {
    let capturedPath: string | undefined
    let capturedInit: Parameters<AcceptApiHttpClient>[1] | undefined
    const httpClient: AcceptApiHttpClient = (path, init) => {
      capturedPath = path
      capturedInit = init
      return Promise.resolve(jsonResponse(200, { outcome: { status: 'applied', workspaceId: 'ws-1', role: 'editor' } }))
    }

    await acceptInvitationOnServer(request, {
      httpClient,
      getAuthHeaders: () => Promise.resolve({ Authorization: 'Bearer test-token' }),
      path: '/accept',
    })

    expect(capturedPath).toBe('/accept')
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.headers).toMatchObject({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(capturedInit?.body ?? '{}')).toEqual(request)
  })
})

describe('acceptInvitationOnServer — outcomes', () => {
  it('applied: resolves { kind: "applied", outcome }', async () => {
    const httpClient: AcceptApiHttpClient = () =>
      Promise.resolve(jsonResponse(200, { outcome: { status: 'applied', workspaceId: 'ws-1', role: 'editor' } }))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'applied', outcome: { status: 'applied', workspaceId: 'ws-1', role: 'editor' } })
  })

  it('rejected (200 + rejected outcome): resolves { kind: "rejected", outcome }', async () => {
    const rejectedOutcome = { status: 'rejected' as const, reason: 'invitation_not_found' as const, message: 'not valid' }
    const httpClient: AcceptApiHttpClient = () => Promise.resolve(jsonResponse(200, { outcome: rejectedOutcome }))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'rejected', outcome: rejectedOutcome })
  })

  it('auth-rejected (non-2xx with a rejection body): resolves { kind: "auth-rejected", rejection }', async () => {
    const rejection = { reason: 'expired_token' as const, message: 'session expired' }
    const httpClient: AcceptApiHttpClient = () => Promise.resolve(jsonResponse(401, { rejection }))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'auth-rejected', rejection })
  })

  it('network-error: the httpClient throws (offline, DNS, CORS...)', async () => {
    const httpClient: AcceptApiHttpClient = () => Promise.reject(new TypeError('Failed to fetch'))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'network-error' })
  })

  it('network-error: the response body is not parsable JSON', async () => {
    const httpClient: AcceptApiHttpClient = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) })

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'network-error' })
  })

  it('network-error: a non-2xx response with no recognizable rejection body', async () => {
    const httpClient: AcceptApiHttpClient = () => Promise.resolve(jsonResponse(500, { error: 'boom' }))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'network-error' })
  })

  it('network-error: a 2xx response with an unrecognizable body shape', async () => {
    const httpClient: AcceptApiHttpClient = () => Promise.resolve(jsonResponse(200, { unexpected: true }))

    const result = await acceptInvitationOnServer(request, { httpClient, getAuthHeaders: noAuthHeaders, path: '/accept' })

    expect(result).toEqual({ kind: 'network-error' })
  })
})
