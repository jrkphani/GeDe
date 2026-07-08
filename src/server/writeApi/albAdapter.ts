// The Lambda entry point (issue 043, ADR-0010: "Lambda behind the ALB").
// This is deliberately the ONLY file in src/server/writeApi/ that touches
// AWS-specific event shapes, cold-start credential fetching, and live
// network resources (Secrets Manager, Postgres, Cognito JWKS over the
// internet) — everything else in this directory is pure/injectable and unit
// -tested. This file is the "documented seam, not live" the write-path
// issue's own scope calls for: it is reviewed code, wired for `cdk deploy`
// (see deploy/cdk/lib/api-stack.ts), but not exercised by any test in this
// repo, because doing so would require a real VPC-reachable RDS instance
// and a real Cognito User Pool (033, not yet built) — exactly what HANDOFF's
// "no live AWS/Electric/Cognito reachable in tests" rules out.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { createRemoteJWKSet } from 'jose'
import { Pool } from 'pg'
import type { ALBEvent, ALBHandler, ALBResult } from 'aws-lambda'
import { handleWriteRequest, type WriteApiDeps } from './handler'
import { PgWriteStore } from './store'
import type { MutationEnvelope } from '../../domain/mutationProtocol'

interface DbSecret {
  readonly username: string
  readonly password: string
}

// Cold-start-cached across warm invocations (standard Lambda pattern) — one
// pool per execution environment, not per request.
let cachedDeps: WriteApiDeps | undefined

async function loadDeps(): Promise<WriteApiDeps> {
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
    // this Lambda's bundle at build time (api-stack.ts's afterBundling hook).
    // Without a pinned CA, node's default trust store rejects RDS's AWS-managed
    // CA as "self-signed certificate in certificate chain".
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
    store: new PgWriteStore({ pool }),
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

  const body = parsedBody as { mutations?: unknown }
  if (!Array.isArray(body.mutations)) {
    return jsonResponse(400, { error: 'Expected a { mutations: [...] } request body.' })
  }

  const authorizationHeader = event.headers?.authorization ?? event.headers?.Authorization
  const deps = await loadDeps()
  // ALB event bodies are untyped JSON on the wire — this cast is the trust
  // boundary; handleWriteRequest re-validates every envelope's shape
  // (isWellFormedEnvelope) before trusting any field of it.
  const mutations = body.mutations as MutationEnvelope[]
  const result = await handleWriteRequest({ authorizationHeader, mutations }, deps)

  if (result.status !== 200) {
    return jsonResponse(result.status, { rejection: result.rejection })
  }
  return jsonResponse(200, { outcomes: result.outcomes })
}
