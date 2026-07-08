// The Cognito PostConfirmation trigger's entry point (issue 050). Mirrors
// src/server/writeApi/albAdapter.ts's header exactly: this is deliberately
// the ONLY file in src/server/provisionWorkspace/ that touches AWS-specific
// event shapes, cold-start credential fetching, and live network resources
// (Secrets Manager, Postgres) — handler.ts underneath it is pure/injectable
// and unit-tested. Reviewed code, wired for `cdk deploy` (see
// deploy/cdk/lib/auth-stack.ts), but not exercised by any test in this repo —
// doing so would require a real VPC-reachable RDS instance and a real
// Cognito User Pool invocation (HANDOFF: "no live AWS/Electric/Cognito
// reachable in tests").
//
// Connects as the DB-secret OWNER role (the same `gede_admin` master
// credential deploy/cdk/lib/migration-runner/handler.ts uses), NOT the
// least-privileged `app_user` role the write-path Lambda uses — mirrors that
// runner's own owner-exemption from RLS (migration 0008's header comment):
// bootstrapping a user's very first workspace + membership row is exactly
// the kind of write RLS's own policies would otherwise block (there is no
// existing membership yet to authorize it against). See handler.ts's header
// for the fuller rationale.
//
// Cognito trigger contract: a PostConfirmation Lambda MUST return the event
// object unchanged (Cognito merges the `response` fields back into its own
// flow) — a modified or missing return, or a thrown error, is treated as
// confirmation FAILURE for the user. A provisioning failure here must not
// brick sign-in more than necessary (issue 050 design brief: "log +
// surface, don't corrupt") — so every provisioning failure is caught and
// logged, never rethrown; the event is always returned.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { Pool } from 'pg'
import type { PostConfirmationTriggerEvent, PostConfirmationTriggerHandler } from 'aws-lambda'
import { provisionWorkspace, type ProvisionExecutor } from './handler'

interface DbSecret {
  readonly username: string
  readonly password: string
}

// Cold-start-cached across warm invocations (standard Lambda pattern, mirrors
// writeApi/albAdapter.ts and debugApi/albAdapter.ts) — one pool per execution
// environment, not per request.
let cachedPool: Pool | undefined

async function loadPool(): Promise<Pool> {
  if (cachedPool) return cachedPool

  const secretArn = requireEnv('DATABASE_SECRET_ARN')
  const endpoint = requireEnv('DATABASE_ENDPOINT')
  const database = process.env.DATABASE_NAME ?? 'gede'

  const secretsClient = new SecretsManagerClient({})
  const secretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }))
  const secret = JSON.parse(secretResponse.SecretString ?? '{}') as Partial<DbSecret>
  if (!secret.username || !secret.password) {
    throw new Error('DATABASE_SECRET_ARN did not resolve to a { username, password } secret')
  }

  cachedPool = new Pool({
    host: endpoint,
    port: 5432,
    database,
    user: secret.username,
    password: secret.password,
    // Verify the RDS server cert against Amazon's RDS CA bundle, copied into
    // this Lambda's bundle at build time (auth-stack.ts's afterBundling
    // hook) — exactly mirrors writeApi/albAdapter.ts and the migration
    // runner. Never rejectUnauthorized:false.
    ssl: {
      ca: readFileSync(join(__dirname, 'rds-global-bundle.pem'), 'utf8'),
      rejectUnauthorized: true,
    },
    max: 3, // Lambda concurrency is per-invocation; keep the pool small per execution environment.
  })
  return cachedPool
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

/**
 * Every Cognito user-pool trigger event carries `request.userAttributes.sub`
 * — the same immutable `sub` claim that ends up in every issued token
 * (src/auth/jwt.ts decodes it client-side). Reading it here rather than
 * `event.userName` (which, under `signInAliases: { email: true }`, is
 * Cognito's own internal username, not necessarily the sub) keeps this
 * trigger and the client computing `workspaceIdForSub` from the exact same
 * value.
 */
function extractSub(event: PostConfirmationTriggerEvent): string | undefined {
  return event.request.userAttributes.sub
}

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const sub = extractSub(event)
  if (!sub) {
    // Defensive only — Cognito always sends `sub` for a confirmed user. Still
    // must not throw (see header): log and let confirmation proceed.
    // eslint-disable-next-line no-console
    console.error('provisionWorkspace: PostConfirmation event was missing userAttributes.sub')
    return event
  }

  try {
    const pool = await loadPool()
    const executor: ProvisionExecutor = {
      query: async (sql, params) => {
        const result = await pool.query(sql, params as unknown[] | undefined)
        return { rows: result.rows as Record<string, unknown>[] }
      },
    }
    const result = await provisionWorkspace(sub, executor)
    // eslint-disable-next-line no-console
    console.log(`provisionWorkspace: ensured workspace ${result.workspaceId} for sub ${sub}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('provisionWorkspace: failed to provision workspace — sign-in proceeds regardless', err)
  }

  // Cognito trigger contract: always return the event unchanged.
  return event
}
