// The `/accept` Lambda's entry point (issue 080). Mirrors
// src/server/writeApi/albAdapter.ts's header and shape exactly: this is
// deliberately the ONLY file in src/server/acceptInvite/ that touches
// AWS-specific event shapes, cold-start credential fetching, and live
// network resources (Secrets Manager, Postgres, Cognito JWKS over the
// internet) — handler.ts/store.ts underneath it are pure/injectable and
// unit-tested. Reviewed code, wired for `cdk deploy` (see
// deploy/cdk/lib/api-stack.ts), but not exercised by any test in this repo —
// doing so would require a real VPC-reachable RDS instance and a real
// Cognito User Pool (HANDOFF: "no live AWS/Electric/Cognito reachable in
// tests").
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { createRemoteJWKSet } from 'jose'
import { Pool } from 'pg'
import type { ALBEvent, ALBHandler, ALBResult } from 'aws-lambda'
import { acceptInvite, type AcceptInviteDeps } from './handler'
import { PgAcceptStore } from './store'

interface DbSecret {
  readonly username: string
  readonly password: string
}

// Cold-start-cached across warm invocations (standard Lambda pattern,
// mirrors writeApi/albAdapter.ts) — one pool per execution environment, not
// per request.
let cachedDeps: AcceptInviteDeps | undefined

async function loadDeps(): Promise<AcceptInviteDeps> {
  if (cachedDeps) return cachedDeps

  const issuer = requireEnv('COGNITO_ISSUER')
  const secretArn = requireEnv('DATABASE_SECRET_ARN')
  const endpoint = requireEnv('DATABASE_ENDPOINT')
  const database = process.env.DATABASE_NAME ?? 'gede'

  const secretsClient = new SecretsManagerClient({})
  const secretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }))
  const secret = JSON.parse(secretResponse.SecretString ?? '{}') as Partial<DbSecret>
  if (!secret.username || !secret.password) {
    throw new Error('DATABASE_SECRET_ARN did not resolve to a { username, password } secret')
  }

  const pool = new Pool({
    host: endpoint,
    port: 5432,
    database,
    user: secret.username,
    password: secret.password,
    // Verify the RDS server cert against Amazon's RDS CA bundle, copied into
    // this Lambda's bundle at build time (api-stack.ts's afterBundling
    // hook). Without a pinned CA, node's default trust store rejects RDS's
    // AWS-managed CA as "self-signed certificate in certificate chain".
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
    store: new PgAcceptStore({ pool }),
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

export const handler: ALBHandler = async (event: ALBEvent): Promise<ALBResult> => {
  let parsedBody: unknown
  try {
    parsedBody = event.body ? (JSON.parse(event.body) as unknown) : {}
  } catch {
    return jsonResponse(400, { error: 'Request body was not valid JSON.' })
  }

  const body = parsedBody as { invitationId?: unknown; workspaceId?: unknown }
  if (typeof body.invitationId !== 'string' || typeof body.workspaceId !== 'string') {
    return jsonResponse(400, { error: 'Expected a { invitationId, workspaceId } request body.' })
  }

  const authorizationHeader = event.headers?.authorization ?? event.headers?.Authorization
  const deps = await loadDeps()

  // Mirrors writeApi/albAdapter.ts's own catch: acceptInvite can throw (e.g.
  // an unexpected Postgres error) — never let that become an opaque,
  // undiagnosable ALB 502; log it and return a typed JSON 500 instead.
  let result: Awaited<ReturnType<typeof acceptInvite>>
  try {
    result = await acceptInvite(
      { authorizationHeader, invitationId: body.invitationId, workspaceId: body.workspaceId },
      deps,
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('acceptInvite: request handling failed unexpectedly', err)
    return jsonResponse(500, { error: 'Something went wrong accepting this invitation. Please try again.' })
  }

  if (result.status !== 200) {
    return jsonResponse(result.status, { rejection: result.rejection })
  }
  return jsonResponse(200, { outcome: result.outcome })
}
