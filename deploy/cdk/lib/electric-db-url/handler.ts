// The Electric-database-URL composer (issue 058) — a one-shot CloudFormation
// custom-resource Lambda that reads the Data stack's generated RDS secret
// (username/password, populated by CDK's DatabaseInstance/Credentials.
// fromGeneratedSecret) and composes a single `postgresql://...` connection
// string, written into a DEDICATED secret (`ElectricDatabaseUrlSecret`,
// api-stack.ts) that the real Electric container then reads as its
// `DATABASE_URL` env var via ECS's native `secrets:` (valueFrom) resolution.
//
// Why this exists instead of a simpler wiring: ECS's
// `ecs.Secret.fromSecretsManagerVersion(secret, {jsonField})` can only
// extract ONE field from a JSON secret into ONE env var — there is no native
// way to compose several fields (username + password + host + dbname) into a
// single templated env var value without EITHER (a) baking the resolved
// plaintext into the CloudFormation template via a
// `{{resolve:secretsmanager:...}}` dynamic reference embedded in a plain
// `environment` string (which would then be readable via
// `ecs:DescribeTaskDefinition` — a real secret-exposure regression, not
// acceptable per this repo's no-standing-secrets stance, see
// api-stack.ts/data-stack.ts's own doc comments), or (b) a shell-wrapper
// `command` override composing it at container start (rejected: this repo
// cannot verify the `electricsql/electric` image's internal shell/entrypoint
// without a live Docker pull, which this sandboxed environment does not
// have — guessing wrong would only surface as a live deploy failure, not a
// synth-time one). This Lambda is the safe third option: it never touches
// the CFN template, and ECS's native `secrets:` resolution (the same
// mechanism every other Lambda/task in this repo already uses) keeps the
// composed URL out of any describable resource.
//
// Mirrors migration-runner/handler.ts's CustomResource event shape exactly.
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

interface CustomResourceEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
}

interface CustomResourceResponse {
  readonly PhysicalResourceId: string;
}

interface DbSecret {
  readonly username: string;
  readonly password: string;
}

// Stable across every Create/Update — this is one logical resource (the
// composed connection string), never replaced.
const PHYSICAL_RESOURCE_ID = 'gede-electric-database-url';

export async function handler(event: CustomResourceEvent): Promise<CustomResourceResponse> {
  if (event.RequestType === 'Delete') {
    // Nothing to clean up: the target secret is a CDK-owned resource whose
    // own lifecycle/removal policy governs teardown; this custom resource
    // only ever writes a VALUE into it, never creates/deletes the secret
    // itself.
    return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
  }

  const dbSecretArn = requireEnv('DATABASE_SECRET_ARN');
  const endpoint = requireEnv('DATABASE_ENDPOINT');
  const database = process.env.DATABASE_NAME ?? 'gede';
  const targetSecretArn = requireEnv('TARGET_SECRET_ARN');

  const client = new SecretsManagerClient({});
  const dbSecretResponse = await client.send(new GetSecretValueCommand({ SecretId: dbSecretArn }));
  const dbSecret = JSON.parse(dbSecretResponse.SecretString ?? '{}') as Partial<DbSecret>;
  if (!dbSecret.username || !dbSecret.password) {
    throw new Error('DATABASE_SECRET_ARN did not resolve to a { username, password } secret');
  }

  // sslmode=require encrypts the connection (matches this repo's "no
  // plaintext DB traffic" bar) without pinning the RDS CA bundle the way
  // every OWN Lambda in this repo does (rds-global-bundle.pem,
  // rejectUnauthorized:true) — the electricsql/electric image is a
  // third-party container this repo doesn't control the trust-store
  // contents of, so full CA verification (sslmode=verify-full) is deferred.
  // Flagged as a known follow-up in docs/issues/058, not silently treated as
  // equivalent to the Lambdas' stricter posture.
  const databaseUrl = `postgresql://${encodeURIComponent(dbSecret.username)}:${encodeURIComponent(
    dbSecret.password,
  )}@${endpoint}:5432/${database}?sslmode=require`;

  await client.send(new PutSecretValueCommand({ SecretId: targetSecretArn, SecretString: databaseUrl }));

  return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
