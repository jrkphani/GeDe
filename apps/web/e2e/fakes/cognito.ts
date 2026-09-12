/**
 * FAKE — Cognito's user-pool API, intercepted at the network edge so the real
 * sign-in screen and the real Amplify client run end to end without a pool.
 * Only the calls the passwordless code flow makes are answered; anything else
 * returns 400 so a new dependency on Cognito shows up as a failed test.
 */
import type { Page } from '@playwright/test';
import { fakeTokens, type FakeSession } from './jwt.js';

export const FAKE_CODE = '123456';

export async function installFakeCognito(page: Page, session: FakeSession): Promise<void> {
  await page.route(`https://cognito-idp.${session.region}.amazonaws.com/**`, (route) => {
    const request = route.request();
    const target = request.headers()['x-amz-target'] ?? '';
    const operation = target.replace('AWSCognitoIdentityProviderService.', '');
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/x-amz-json-1.1',
        body: JSON.stringify(data),
      });
    switch (operation) {
      case 'InitiateAuth': {
        const username = (body?.AuthParameters as Record<string, string> | undefined)?.USERNAME;
        // The pool has `preventUserExistenceErrors` on: an unknown email is never an error.
        // It answers SELECT_CHALLENGE with the pool's generic factors and no EMAIL_OTP —
        // exactly what production returned in the Wave 1 audit (#46).
        if (username !== session.email) {
          return json({
            ChallengeName: 'SELECT_CHALLENGE',
            Session: 'fake-session',
            AvailableChallenges: ['PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN'],
            ChallengeParameters: {},
          });
        }
        return json({
          ChallengeName: 'EMAIL_OTP',
          Session: 'fake-session',
          ChallengeParameters: {
            CODE_DELIVERY_DELIVERY_MEDIUM: 'EMAIL',
            CODE_DELIVERY_DESTINATION: 'm***@1cloudhub.com',
          },
        });
      }
      case 'RespondToAuthChallenge': {
        const responses = (body?.ChallengeResponses ?? {}) as Record<string, string>;
        if (responses.EMAIL_OTP_CODE !== FAKE_CODE) {
          return json({ __type: 'CodeMismatchException', message: 'Invalid code' }, 400);
        }
        return json({
          AuthenticationResult: {
            ...fakeTokens(session),
            RefreshToken: 'fake-refresh',
            ExpiresIn: 3600,
            TokenType: 'Bearer',
          },
        });
      }
      case 'GetUser':
        return json({
          Username: session.sub,
          UserAttributes: [
            { Name: 'sub', Value: session.sub },
            { Name: 'email', Value: session.email },
            { Name: 'name', Value: session.name },
          ],
        });
      case 'RevokeToken':
      case 'GlobalSignOut':
        return json({});
      default:
        return json({ __type: 'NotImplemented', message: `fake cognito: ${operation}` }, 400);
    }
  });
}
