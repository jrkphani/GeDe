// Issue 080 — the client half of the dedicated `/accept` endpoint. Mirrors
// src/sync/writeTransport.ts's DI-testable shape exactly (the HTTP client
// and auth-header provider are injected, so tests drive success/reject/
// offline with no live network) but is deliberately much smaller: a single-
// shot authenticated POST, not a batch/queue drain — accepting an invitation
// is a one-off user action, not a stream of optimistic mutations.
//
// WHY NOT src/sync/writeTransport.ts: the generic write-path's tenancy guard
// cannot authorize a first-time accept (see src/server/acceptInvite/
// handler.ts's header for the full rationale) — this hits the SEPARATE
// `/accept` endpoint instead, whose response shape
// (`{ outcome: AcceptOutcome }` / `{ rejection: AcceptRejection }`) is its
// own, not `writeApi/rejection.ts`'s `WriteRejection` shape.
import type { AcceptOutcome, AcceptRejection } from '../server/acceptInvite/handler'

export interface AcceptApiHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}

export type AcceptApiHttpClient = (
  path: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<AcceptApiHttpResponse>

export interface AcceptTransportDeps {
  readonly httpClient: AcceptApiHttpClient
  readonly getAuthHeaders: () => Promise<Record<string, string>>
  readonly path: string
}

export interface AcceptInvitationRequest {
  readonly invitationId: string
  readonly workspaceId: string
}

export type AcceptTransportOutcome =
  // fetch() itself threw (offline, DNS, CORS…) or the body wasn't parsable
  // JSON — mirrors writeTransport.ts's own 'network-error' kind.
  | { readonly kind: 'network-error' }
  // A wholesale 401/403 (the caller's session itself is invalid/expired) —
  // mirrors writeTransport.ts's own 'auth-rejected' kind.
  | { readonly kind: 'auth-rejected'; readonly rejection: AcceptRejection }
  | { readonly kind: 'applied'; readonly outcome: Extract<AcceptOutcome, { status: 'applied' }> }
  | { readonly kind: 'rejected'; readonly outcome: Extract<AcceptOutcome, { status: 'rejected' }> }

interface AcceptApiSuccessBody {
  readonly outcome: AcceptOutcome
}

interface AcceptApiRejectedBody {
  readonly rejection: AcceptRejection
}

function isRejectedBody(body: unknown): body is AcceptApiRejectedBody {
  return typeof body === 'object' && body !== null && 'rejection' in body
}

function isSuccessBody(body: unknown): body is AcceptApiSuccessBody {
  return typeof body === 'object' && body !== null && 'outcome' in body
}

/**
 * Single-shot authenticated POST to the dedicated `/accept` endpoint —
 * mirrors writeTransport.ts's `flushMutations` request/response handling
 * shape (same network-error / auth-rejected / applied|rejected split), but
 * for exactly one accept, not a batch.
 */
export async function acceptInvitationOnServer(
  request: AcceptInvitationRequest,
  deps: AcceptTransportDeps,
): Promise<AcceptTransportOutcome> {
  const authHeaders = await deps.getAuthHeaders()

  let response: AcceptApiHttpResponse
  try {
    response = await deps.httpClient(deps.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(request),
    })
  } catch {
    return { kind: 'network-error' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'network-error' }
  }

  if (!response.ok) {
    if (isRejectedBody(body)) return { kind: 'auth-rejected', rejection: body.rejection }
    return { kind: 'network-error' }
  }

  if (!isSuccessBody(body)) return { kind: 'network-error' }

  if (body.outcome.status === 'applied') return { kind: 'applied', outcome: body.outcome }
  return { kind: 'rejected', outcome: body.outcome }
}
