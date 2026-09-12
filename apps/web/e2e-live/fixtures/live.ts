/**
 * Fixtures for the live suite (docs/TESTING.md "Live suite").
 *
 * How the suite signs in without a mailbox or a passkey. The pool is passwordless for people
 * and the SPA client has only the USER_AUTH flow; the SPA keeps its tokens in memory
 * (`sharedInMemoryStorage`, AUTH-09), so there is no storage to seed either. Instead:
 *
 *   1. Once per worker, the runner mints real tokens for `e2e@<domain>` with
 *      `AdminInitiateAuth` on the `gede-e2e` app client (`ADMIN_USER_PASSWORD_AUTH`; the
 *      password comes from Secrets Manager). This needs IAM: the pipeline's
 *      Playwright-Live role, or a developer profile locally.
 *   2. Each sign-in drives the real sign-in screen — email, "Email me a one-time code" — and
 *      answers the SPA's own `InitiateAuth` request at the network edge with those tokens as
 *      an `AuthenticationResult`. Amplify stores them and raises `signedIn` exactly as it
 *      would after a code; the SPA is untouched. Every later call (Cognito `GetUser`, `/api`,
 *      the WebSocket) is real and carries the `gede-e2e` client's token, which
 *      `services/sync` accepts beside the SPA's (`COGNITO_CLIENT_IDS`).
 *
 * The stub is the one exception to "never fake a session" in docs/TESTING.md and it is a stub
 * at the network boundary only: the tokens are Cognito's, minted seconds earlier.
 *
 * Cleanup: the worker's teardown deletes every document the account owns (soft-delete, then
 * `delete-all`), so a red run never leaves anything behind for the next one.
 */
import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { test as base, expect, type Page } from '@playwright/test';

export interface LiveTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  /** Seconds, as Cognito reports it (3600 for this client). */
  readonly expiresIn: number;
}

export interface LiveSession {
  readonly username: string;
  readonly region: string;
  readonly tokens: LiveTokens;
  /** `${E2E_BASE_URL}/api`, the SPA's own API origin (through CloudFront). */
  readonly apiUrl: string;
  /** Authenticated fetch against the API, for setup and cleanup outside the browser. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for the live suite (the pipeline sets it from stage outputs; locally see docs/TESTING.md)`,
    );
  }
  return value;
}

/** `ap-southeast-1_AbCdEf` → `ap-southeast-1`. */
function regionOfPool(userPoolId: string): string {
  const region = userPoolId.split('_')[0];
  if (region === undefined || region === '')
    throw new Error(`malformed user pool id ${userPoolId}`);
  return region;
}

async function mintTokens(): Promise<Omit<LiveSession, 'api' | 'apiUrl'>> {
  const userPoolId = required('E2E_USER_POOL_ID');
  const clientId = required('E2E_CLIENT_ID');
  const secretArn = required('E2E_SECRET_ARN');
  const region = regionOfPool(userPoolId);

  const secret = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const parsed = JSON.parse(secret.SecretString ?? '{}') as {
    username?: unknown;
    password?: unknown;
  };
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('the e2e user secret must carry "username" and "password"');
  }

  const auth = await new CognitoIdentityProviderClient({ region }).send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: parsed.username, PASSWORD: parsed.password },
    }),
  );
  const result = auth.AuthenticationResult;
  if (
    result?.AccessToken === undefined ||
    result.IdToken === undefined ||
    result.RefreshToken === undefined
  ) {
    throw new Error(
      `AdminInitiateAuth did not return tokens (challenge: ${auth.ChallengeName ?? 'none'}); is the e2e user's password permanent?`,
    );
  }
  return {
    username: parsed.username,
    region,
    tokens: {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      refreshToken: result.RefreshToken,
      expiresIn: result.ExpiresIn ?? 3600,
    },
  };
}

/** Soft-delete every document the account owns, then purge Recently Deleted. */
export async function deleteEverything(session: LiveSession): Promise<void> {
  const list = await session.api('/documents?view=browse');
  if (list.ok) {
    const { documents } = (await list.json()) as { documents: { id: string }[] };
    for (const { id } of documents) {
      // 409 `sample` / `shared` are the API refusing on purpose; nothing to do about them here.
      await session.api(`/documents/${id}`, { method: 'DELETE' });
    }
  }
  await session.api('/documents/delete-all', { method: 'POST' });
}

export interface LiveFixtures {
  /** Sign in through the real screen and land on `path` (or the library). */
  signIn: (page: Page, path?: string) => Promise<void>;
}
export interface LiveWorkerFixtures {
  session: LiveSession;
}

export const test = base.extend<LiveFixtures, LiveWorkerFixtures>({
  session: [
    // eslint-disable-next-line no-empty-pattern -- worker fixtures take no page-level options
    async ({}, use) => {
      // `baseURL` is a test-scoped option; the worker reads the same variable the config did.
      const apiUrl = `${required('E2E_BASE_URL').replace(/\/+$/, '')}/api`;
      const minted = await mintTokens();
      const session: LiveSession = {
        ...minted,
        apiUrl,
        api: (path, init = {}) => {
          const headers = new Headers(init.headers);
          headers.set('authorization', `Bearer ${minted.tokens.accessToken}`);
          headers.set('content-type', 'application/json');
          return fetch(`${apiUrl}${path}`, { ...init, headers });
        },
      };
      await use(session);
      await deleteEverything(session);
    },
    { scope: 'worker' },
  ],

  signIn: async ({ session }, use) => {
    await use(async (page, path = '/') => {
      await installSignIn(page, session);
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
      await page.getByLabel('Email').fill(session.username);
      await page.getByLabel('Email').press('Enter');
      await page.getByRole('button', { name: 'Email me a one-time code' }).click();
      // The stubbed InitiateAuth answers with tokens, so there is no code step. AUTH-07: the
      // passkey offer may follow a code sign-in; decline it whenever it appears.
      const notNow = page.getByRole('button', { name: 'Not now' });
      const target = new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      await Promise.race([
        notNow.waitFor({ state: 'visible', timeout: 10_000 }).then(() => notNow.click()),
        page.waitForURL(target, { timeout: 10_000 }),
      ]).catch(() => undefined);
      await expect(page).toHaveURL(target);
    });
  },
});

export { expect };

/**
 * Answer the SPA's `InitiateAuth` with the minted tokens; every other Cognito call
 * (`GetUser`, `RevokeToken`, …) goes through to the real endpoint.
 */
const installed = new WeakSet<Page>();
async function installSignIn(page: Page, session: LiveSession): Promise<void> {
  if (installed.has(page)) return; // one handler per page, however many sign-ins
  installed.add(page);
  const endpoint = `https://cognito-idp.${session.region}.amazonaws.com/`;
  await page.route(endpoint, async (route) => {
    const target = route.request().headers()['x-amz-target'];
    if (target !== 'AWSCognitoIdentityProviderService.InitiateAuth') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/x-amz-json-1.1',
      body: JSON.stringify({
        ChallengeParameters: {},
        AuthenticationResult: {
          AccessToken: session.tokens.accessToken,
          IdToken: session.tokens.idToken,
          RefreshToken: session.tokens.refreshToken,
          ExpiresIn: session.tokens.expiresIn,
          TokenType: 'Bearer',
        },
      }),
    });
  });
}
