// The debug/db inspection Lambda's entry point (issue 049, mirroring issue
// 043/046's ADR-0010 split: "Lambda behind the ALB"). This is deliberately
// the ONLY file in src/server/debugApi/ that touches AWS-specific event
// shapes, cold-start credential fetching, and live network resources
// (Secrets Manager, Postgres) — everything else in this directory is
// pure/injectable and unit-tested (handler.ts/operations.ts/sqlGuard.ts).
// Reviewed code, wired for `cdk deploy` (see deploy/cdk/lib/api-stack.ts),
// but not exercised by any test in this repo — doing so would require a
// real VPC-reachable RDS instance (HANDOFF: "no live AWS/Electric/Cognito
// reachable in tests").
//
// Read-only guard #2 (Design brief, in depth with sqlGuard as #1 and the row
// cap as #3): every query this Lambda runs happens inside a transaction that
// (a) issues `SET TRANSACTION READ ONLY` before the caller's SQL, so even a
// guard #1 bypass still can't mutate a row, and (b) sets a `statement_timeout`
// so a slow/heavy query can't hang or exhaust the connection pool. Deferred
// hardening (issue 049 scope, noted explicitly per the issue): a dedicated
// `app_readonly` Postgres role (GRANT SELECT only) would add a THIRD,
// database-enforced layer beneath this transaction-level guard — that needs
// a new migration + a migration-runner redeploy + WAL-slot coordination with
// any concurrent migration work, so it is out of scope for this cut. The
// transaction-level READ ONLY guard below still makes any write physically
// rejected by Postgres itself, not merely policy.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { Pool, type PoolClient } from 'pg'
import type { ALBEvent, ALBHandler, ALBResult } from 'aws-lambda'
import { handleDebugRequest, type DebugApiDeps, type DebugOperation } from './handler'
import { MAX_ROW_LIMIT, type QueryExecutor } from './operations'

interface DbSecret {
  readonly username: string
  readonly password: string
}

/** Never allow a query to run open-ended — a slow/heavy statement is killed server-side after this many ms. */
const STATEMENT_TIMEOUT_MS = 5_000

/**
 * Read-only guard #2: wraps every query in its own short transaction that
 * sets `TRANSACTION READ ONLY` + `statement_timeout` BEFORE running the
 * caller's SQL, then rolls back (never commits — there is nothing to commit
 * from a read, and rollback is the safe default if anything above this
 * layer is ever wrong). Mirrors src/server/writeApi/store.ts's
 * `withTenantContext` connect/begin/finally-release shape.
 */
class ReadOnlyPgExecutor implements QueryExecutor {
  constructor(private readonly pool: Pool) {}

  query = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> => {
    const client: PoolClient = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET TRANSACTION READ ONLY')
      // A literal, server-controlled integer (never caller-supplied) — safe
      // to interpolate; `SET LOCAL` does not accept bind parameters.
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      const result = await client.query(sql, params as unknown[] | undefined)
      await client.query('ROLLBACK') // nothing to commit from a read-only transaction
      return { rows: result.rows as Record<string, unknown>[] }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // best-effort — the connection may already be unusable after the error above
      })
      throw err
    } finally {
      client.release()
    }
  }
}

// Cold-start-cached across warm invocations (standard Lambda pattern) — one
// pool + one expected token per execution environment, not per request.
let cachedDeps: DebugApiDeps | undefined

async function loadDeps(): Promise<DebugApiDeps> {
  if (cachedDeps) return cachedDeps

  const dbSecretArn = requireEnv('DATABASE_SECRET_ARN')
  const debugTokenSecretArn = requireEnv('DEBUG_TOKEN_SECRET_ARN')
  const endpoint = requireEnv('DATABASE_ENDPOINT')
  const database = process.env.DATABASE_NAME ?? 'gede'

  const secretsClient = new SecretsManagerClient({})

  const dbSecretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: dbSecretArn }))
  const dbSecret = JSON.parse(dbSecretResponse.SecretString ?? '{}') as Partial<DbSecret>
  if (!dbSecret.username || !dbSecret.password) {
    throw new Error('DATABASE_SECRET_ARN did not resolve to a { username, password } secret')
  }

  const debugTokenResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: debugTokenSecretArn }))
  const expectedToken = debugTokenResponse.SecretString
  if (!expectedToken) {
    throw new Error('DEBUG_TOKEN_SECRET_ARN did not resolve to a secret string')
  }

  const pool = new Pool({
    host: endpoint,
    port: 5432,
    database,
    user: dbSecret.username,
    password: dbSecret.password,
    // Verify the RDS server cert against Amazon's RDS CA bundle, copied into
    // this Lambda's bundle at build time (api-stack.ts's afterBundling hook)
    // — exactly mirrors src/server/writeApi/albAdapter.ts. Never
    // `rejectUnauthorized: false` — the pinned CA stays on (issue 049 hard
    // constraint: "do NOT weaken TLS").
    ssl: {
      ca: readFileSync(join(__dirname, 'rds-global-bundle.pem'), 'utf8'),
      rejectUnauthorized: true,
    },
    max: 3, // Lambda concurrency is per-invocation; keep the pool small per execution environment.
  })

  cachedDeps = {
    expectedToken,
    executor: new ReadOnlyPgExecutor(pool),
  }
  return cachedDeps
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function jsonResponse(statusCode: number, body: unknown): ALBResult {
  return {
    statusCode,
    statusDescription: undefined,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }
}

function extractToken(event: ALBEvent): string | undefined {
  const headerToken = event.headers?.['x-debug-token']
  if (headerToken) return headerToken

  const authorizationHeader = event.headers?.authorization ?? event.headers?.Authorization
  if (!authorizationHeader) return undefined
  const [scheme, token] = authorizationHeader.split(' ')
  return scheme === 'Bearer' && token ? token : undefined
}

/**
 * Routes an ALB path (`/debug/db/counts`, `/debug/db/rows`, `/debug/db/query`)
 * to a `DebugOperation`. Returns `undefined` for an unrecognized path/method
 * combination (a 404, not a 400 — the caller never reached a real operation).
 */
function parseOperation(event: ALBEvent): DebugOperation | undefined {
  const { path } = event

  if (path === '/debug/db/counts' && event.httpMethod === 'GET') {
    return { kind: 'counts' }
  }

  if (path === '/debug/db/rows' && event.httpMethod === 'GET') {
    const table = event.queryStringParameters?.table
    if (!table) return undefined
    const rawLimit = event.queryStringParameters?.limit
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : MAX_ROW_LIMIT
    return { kind: 'rows', table, limit: Number.isFinite(limit) ? limit : MAX_ROW_LIMIT }
  }

  if (path === '/debug/db/query' && event.httpMethod === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = event.body ? (JSON.parse(event.body) as unknown) : {}
    } catch {
      return undefined
    }
    const sql = (parsedBody as { sql?: unknown }).sql
    if (typeof sql !== 'string') return undefined
    return { kind: 'query', sql }
  }

  return undefined
}

export const handler: ALBHandler = async (event: ALBEvent): Promise<ALBResult> => {
  const operation = parseOperation(event)
  if (!operation) {
    return jsonResponse(404, { error: 'No debug/db route matched this path/method.' })
  }

  const providedToken = extractToken(event)
  const deps = await loadDeps()
  const result = await handleDebugRequest({ providedToken, operation }, deps)

  if (result.status !== 200) {
    return jsonResponse(result.status, { error: result.error })
  }
  return jsonResponse(200, { data: result.data })
}
