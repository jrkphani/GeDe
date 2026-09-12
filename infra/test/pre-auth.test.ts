import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pool's pre-authentication trigger (`infra/assets/pre-auth/index.mjs`), run against a
 * mocked Cognito client. Loaded through a computed specifier so the `.mjs` stays out of
 * infra's TypeScript program; `vi.resetModules` gives every test a fresh lookup cache.
 */
const HANDLER = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/pre-auth/index.mjs'),
).href;

const send = vi.fn();
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  ListUserPoolClientsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

interface PreAuthEvent {
  userPoolId: string;
  userName?: string;
  callerContext?: { clientId?: string };
  request?: { userAttributes?: { email?: string } };
}
type Handler = (event: PreAuthEvent) => Promise<PreAuthEvent>;

const POOL = 'ap-southeast-1_TEST';
const E2E_CLIENT = 'e2e-client-id';
const SPA_CLIENT = 'spa-client-id';

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  process.env.E2E_USERNAME = 'e2e@gede.work';
  process.env.E2E_CLIENT_NAME = 'gede-e2e';
  const mod = (await import(HANDLER)) as { handler: Handler };
  return mod.handler;
}

const clientsPage = {
  UserPoolClients: [
    { ClientName: 'gede-spa', ClientId: SPA_CLIENT },
    { ClientName: 'gede-e2e', ClientId: E2E_CLIENT },
  ],
};
const signIn = (email: string, clientId: string): PreAuthEvent => ({
  userPoolId: POOL,
  userName: email,
  callerContext: { clientId },
  request: { userAttributes: { email } },
});

describe('pre-authentication trigger', () => {
  beforeEach(() => {
    send.mockReset();
    // The handler reports refusals and lookup failures to its log; keep them out of the test output.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('AUTH-04 lets the e2e account in through gede-e2e only, and nobody else through it', async () => {
    send.mockResolvedValue(clientsPage);
    const handler = await loadHandler();
    await expect(handler(signIn('e2e@gede.work', E2E_CLIENT))).resolves.toBeDefined();
    await expect(handler(signIn('e2e@gede.work', SPA_CLIENT))).rejects.toThrow(
      'This account signs in only through the pipeline.',
    );
    await expect(handler(signIn('someone@example.com', E2E_CLIENT))).rejects.toThrow(
      'This client is reserved for the pipeline.',
    );
    await expect(handler(signIn('someone@example.com', SPA_CLIENT))).resolves.toBeDefined();
    // One lookup per container, not per sign-in.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AUTH-04 a failed client lookup is not cached: the next sign-in looks again (#103)', async () => {
    send.mockRejectedValueOnce(new Error('TooManyRequestsException'));
    send.mockResolvedValue(clientsPage);
    const handler = await loadHandler();
    // The transient error passes an ordinary user through…
    await expect(handler(signIn('someone@example.com', SPA_CLIENT))).resolves.toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
    // …and the next invocation retries the lookup and enforces the binding again.
    await expect(handler(signIn('e2e@gede.work', SPA_CLIENT))).rejects.toThrow(
      'This account signs in only through the pipeline.',
    );
    expect(send).toHaveBeenCalledTimes(2);
    await expect(handler(signIn('someone@example.com', SPA_CLIENT))).resolves.toBeDefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('AUTH-04 while the lookup fails, only the e2e account is refused (fail closed for the binding, open for everyone else)', async () => {
    send.mockRejectedValue(new Error('InternalErrorException'));
    const handler = await loadHandler();
    await expect(handler(signIn('someone@example.com', SPA_CLIENT))).resolves.toBeDefined();
    await expect(handler(signIn('e2e@gede.work', E2E_CLIENT))).rejects.toThrow(
      'This account signs in only through the pipeline.',
    );
    await expect(handler(signIn('e2e@gede.work', SPA_CLIENT))).rejects.toThrow(
      'This account signs in only through the pipeline.',
    );
    expect(send).toHaveBeenCalledTimes(3);
  });
});
