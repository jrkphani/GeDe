// The shape-proxy's AWS-specific adapter (issue 058). Mirrors src/server/
// writeApi/albAdapter.ts's split exactly (ADR-0010: "thin AWS adapter, pure
// core") — this is deliberately the ONLY file in src/server/shapeProxy/ that
// touches AWS event shapes, cold-start credential fetching, and live network
// resources (Secrets Manager, Postgres, Cognito JWKS, and — new here —
// Electric's own VPC-private HTTP endpoint). Reviewed code, wired for `cdk
// deploy` (see deploy/cdk/lib/api-stack.ts), but not exercised by any test in
// this repo, exactly like its writeApi/debugApi siblings — doing so would
// require a real VPC-reachable RDS instance, a real Cognito User Pool, and a
// real Electric service (HANDOFF: "no live AWS/Electric/Cognito reachable in
// tests"). handler.ts (the pure decision core this file calls into) IS fully
// unit-tested.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { createRemoteJWKSet } from 'jose'
import { Pool } from 'pg'
import type { ALBEvent, ALBHandler, ALBResult } from 'aws-lambda'
import { resolveShapeRequest, type ShapeProxyDeps } from './handler'

interface DbSecret {
  readonly username: string
  readonly password: string
}

// Cold-start-cached across warm invocations (standard Lambda pattern, mirrors
// every sibling adapter in this repo) — one pool + one set of resolved
// secrets per execution environment, not per request.
let cachedDeps: ShapeProxyDeps | undefined

async function loadDeps(): Promise<ShapeProxyDeps> {
  if (cachedDeps) return cachedDeps

  const issuer = requireEnv('COGNITO_ISSUER')
  const dbSecretArn = requireEnv('DATABASE_SECRET_ARN')
  const endpoint = requireEnv('DATABASE_ENDPOINT')
  const database = process.env.DATABASE_NAME ?? 'gede'
  const electricBaseUrl = requireEnv('ELECTRIC_INTERNAL_URL')
  const electricSecretArn = requireEnv('ELECTRIC_SECRET_ARN')

  const secretsClient = new SecretsManagerClient({})

  const dbSecretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: dbSecretArn }))
  const dbSecret = JSON.parse(dbSecretResponse.SecretString ?? '{}') as Partial<DbSecret>
  if (!dbSecret.username || !dbSecret.password) {
    throw new Error('DATABASE_SECRET_ARN did not resolve to a { username, password } secret')
  }

  const electricSecretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: electricSecretArn }))
  const electricSecret = electricSecretResponse.SecretString
  if (!electricSecret) throw new Error('ELECTRIC_SECRET_ARN did not resolve to a secret string')

  const pool = new Pool({
    host: endpoint,
    port: 5432,
    database,
    user: dbSecret.username,
    password: dbSecret.password,
    // Verify the RDS server cert against Amazon's RDS CA bundle, copied into
    // this Lambda's bundle at build time (api-stack.ts's afterBundling hook)
    // — mirrors src/server/writeApi/albAdapter.ts exactly.
    ssl: {
      ca: readFileSync(join(__dirname, 'rds-global-bundle.pem'), 'utf8'),
      rejectUnauthorized: true,
    },
    max: 3, // Lambda concurrency is per-invocation; keep the pool small per execution environment.
  })

  cachedDeps = {
    jwt: {
      issuer,
      getKey: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
    },
    electricBaseUrl,
    electricSecret,
    // 057's own membership model: every live (non-tombstoned) workspace_members
    // row for this sub — own personal workspace (seeded by 050's provisioning
    // trigger) plus any shared workspace the sub has accepted an invitation
    // into (057's acceptInvitation seat mutation). This is the read-path's
    // counterpart to src/server/writeApi/store.ts's PgWriteStore.isMember.
    async listWorkspaceIdsForSub(sub: string): Promise<string[]> {
      const result = await pool.query<{ workspace_id: string }>(
        'SELECT DISTINCT workspace_id FROM workspace_members WHERE user_sub = $1 AND deleted_at IS NULL',
        [sub],
      )
      return result.rows.map((row) => row.workspace_id)
    },
  }
  return cachedDeps
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

// Electric's own response headers (electric-offset/electric-handle/
// electric-schema/electric-cursor) must survive untouched for the client
// ShapeStream's retry/resume logic to work at all — content-encoding/
// content-length are the two that must NOT survive (fetch() below already
// decompressed the body, so relaying Electric's original compressed-length
// headers would corrupt the response the browser sees — the exact CRITICAL
// mistake node_modules/@electric-sql/client/skills/electric-proxy-auth
// documents under "Not deleting content-encoding and content-length
// headers"). Same-origin via CloudFront (issue 047's routing model) means no
// CORS/Access-Control-Expose-Headers dance is needed here, unlike that
// skill's cross-origin Next.js example.
const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length'])

export const handler: ALBHandler = async (event: ALBEvent): Promise<ALBResult> => {
  const deps = await loadDeps()
  const authorizationHeader = event.headers?.authorization ?? event.headers?.Authorization
  const query = (event.queryStringParameters ?? {}) as Record<string, string | undefined>
  const table = query.table

  const resolution = await resolveShapeRequest({ authorizationHeader, table, query }, deps)
  if (!resolution.ok) {
    return {
      statusCode: resolution.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: resolution.error }),
      isBase64Encoded: false,
    }
  }

  // Forward to Electric's real (VPC-private) endpoint and relay the response
  // — Electric never sees a request that didn't pass through the auth +
  // workspace-scoping above, and the browser never learns Electric's
  // address, its secret, or its raw (unscoped) shape shape.
  const isPost = event.httpMethod === 'POST'
  const response = await fetch(
    resolution.url,
    isPost && event.body ? { method: 'POST', body: event.body } : { method: isPost ? 'POST' : 'GET' },
  )
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value
  })
  const bodyText = await response.text()
  return {
    statusCode: response.status,
    headers,
    body: bodyText,
    isBase64Encoded: false,
  }
}
