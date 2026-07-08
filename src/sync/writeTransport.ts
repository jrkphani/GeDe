// Issue 048 — drains 032's client mutation queue (src/domain/mutationQueue.ts)
// to the write-path API by batching pending QueuedMutations into 043's
// MutationEnvelope wire shape (src/domain/mutationProtocol.ts) and POSTing
// them. Reuses 043's protocol/rejection types verbatim — this file never
// modifies src/domain/mutationProtocol.ts or src/server/writeApi/** (owned
// by the write-path issue), it only imports their types.
//
// DI-testable like src/sync/syncEngine.ts's `streamFactory` seam: the HTTP
// client and auth-header provider are injected, so tests drive success/
// reject/offline with no live network. Deliberately pure and store-free
// (mirrors syncEngine.ts's own split) — src/store/sync.ts is what wires this
// to the real `fetch`, `getAuthHeaders()` (src/auth/wireIdentity.ts), and the
// currently-open workspace.
import type { MutationQueue, QueuedMutation } from '../domain/mutationQueue'
import type { MutationEnvelope, MutationOutcome, MutationTable } from '../domain/mutationProtocol'
import type { TableName } from '../domain/syncDelta'
import type { WriteRejection } from '../server/writeApi/rejection'

export interface WriteApiHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}

export type WriteApiHttpClient = (
  path: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<WriteApiHttpResponse>

// mutationQueue.ts's TableName is the read-path's snake_case SQL table name
// (src/domain/projectEnvelope.ts, matching src/db/schema.ts's pgTable()
// string); mutationProtocol.ts's MutationTable is the write-path's camelCase
// schema EXPORT name. Both enumerate the same nine tables under two
// different naming conventions — a seam mismatch between 032 (read-path
// queue) and 043 (write-path protocol) that predates this issue and belongs
// to neither. This bridges it rather than inventing a third vocabulary.
const TABLE_TO_MUTATION_TABLE: Readonly<Record<TableName, MutationTable>> = {
  projects: 'projects',
  tier1_purpose: 'tier1Purpose',
  tier1_props: 'tier1Props',
  tier2_tables: 'tier2Tables',
  tier2_entries: 'tier2Entries',
  dimensions: 'dimensions',
  parameters: 'parameters',
  contexts: 'contexts',
  bindings: 'bindings',
  // Issue 056 — invitations/workspace_members join the same snake_case
  // (queue) <-> camelCase (protocol) bridge as the original nine.
  invitations: 'invitations',
  workspace_members: 'workspaceMembers',
}

// QueuedMutation.op is only 'upsert' | 'delete' (032 never distinguishes a
// fresh insert from an edit of an existing row); MutationEnvelope.op is
// 'insert' | 'update' | 'delete' (043 needs the split — 'insert' is
// idempotent via `ON CONFLICT DO NOTHING`, 'update' is a bare
// `UPDATE ... WHERE id`, which silently no-ops if the row doesn't exist yet,
// see src/server/writeApi/store.ts's applyIfNew). This issue's only current
// producer (issue 037's adoptProject, src/store/projects.ts) always creates
// fresh rows in the destination workspace, so 'upsert' maps to 'insert'
// here. KNOWN LIMITATION: a future producer that enqueues an edit to an
// already-synced row will need mutationQueue.ts itself to carry the
// insert/update distinction (out of this issue's scope — src/db/mutations.ts
// and its callers are owned elsewhere) rather than silently mis-mapping to
// an insert that a conflicting row would then just ignore.
function toMutationOp(op: QueuedMutation['op']): MutationEnvelope['op'] {
  return op === 'delete' ? 'delete' : 'insert'
}

export function toMutationEnvelope(mutation: QueuedMutation, workspaceId: string): MutationEnvelope {
  return {
    id: mutation.id,
    workspaceId,
    table: TABLE_TO_MUTATION_TABLE[mutation.table],
    op: toMutationOp(mutation.op),
    entityId: mutation.rowId,
    payload: mutation.row,
    clientUpdatedAt: mutation.optimisticUpdatedAt,
  }
}

export type FlushRejection = Extract<MutationOutcome, { status: 'rejected' }>

export type FlushOutcome =
  // Nothing to send (no pending mutations) or no workspace is resolvable yet
  // — never reaches the network, so signed-out/sync-off/no-open-workspace
  // paths stay byte-for-byte unchanged (issue scope, test-first plan #5).
  | { readonly kind: 'skipped' }
  // fetch() itself threw (offline, DNS, CORS…) or returned an unparsable
  // body — retried with backoff by the caller, queue left untouched
  // (test-first plan #3).
  | { readonly kind: 'network-error' }
  // A wholesale 401/403 (the whole batch is unauthenticated/unauthorized,
  // src/server/writeApi/handler.ts's auth gate) — not a per-mutation
  // rejection; queue untouched, retried with backoff (a token refresh may
  // resolve it).
  | { readonly kind: 'auth-rejected'; readonly rejection: WriteRejection }
  | {
      readonly kind: 'applied'
      readonly acknowledgedIds: readonly string[]
      readonly rejections: readonly FlushRejection[]
    }

export interface FlushDeps {
  readonly httpClient: WriteApiHttpClient
  readonly getAuthHeaders: () => Promise<Record<string, string>>
  readonly path: string
}

interface WriteApiSuccessBody {
  readonly outcomes: readonly MutationOutcome[]
}

interface WriteApiRejectedBody {
  readonly rejection: WriteRejection
}

function isRejectedBody(body: unknown): body is WriteApiRejectedBody {
  return typeof body === 'object' && body !== null && 'rejection' in body
}

function isSuccessBody(body: unknown): body is WriteApiSuccessBody {
  return typeof body === 'object' && body !== null && Array.isArray((body as WriteApiSuccessBody).outcomes)
}

/**
 * Sends every PENDING entry in `queue`, in order, as one batch —
 * src/server/writeApi/handler.ts applies mutations "strictly in the order
 * the client queued them", so this never splits or reorders a flush.
 * Idempotent retry (test-first plan #2) falls out for free: a retried flush
 * re-reads the still-pending queue and resends the SAME UUIDv7 envelope
 * ids, which 043's `applied_mutations` ledger no-ops server-side — this
 * function does not track attempts itself.
 */
export async function flushMutations(
  queue: MutationQueue,
  workspaceId: string | null,
  deps: FlushDeps,
): Promise<FlushOutcome> {
  const pending = queue.entries.filter((entry) => entry.status === 'pending')
  if (pending.length === 0 || workspaceId === null) return { kind: 'skipped' }

  const envelopes = pending.map((mutation) => toMutationEnvelope(mutation, workspaceId))
  const authHeaders = await deps.getAuthHeaders()

  let response: WriteApiHttpResponse
  try {
    response = await deps.httpClient(deps.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ mutations: envelopes }),
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

  const acknowledgedIds: string[] = []
  const rejections: FlushRejection[] = []
  for (const outcome of body.outcomes) {
    if (outcome.status === 'rejected') rejections.push(outcome)
    else acknowledgedIds.push(outcome.mutationId)
  }
  return { kind: 'applied', acknowledgedIds, rejections }
}
