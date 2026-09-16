/**
 * FAKE — Cognito's user-pool API, intercepted at the network edge so the real
 * sign-in screen and the real Amplify client run end to end without a pool.
 * Only the calls the passwordless code flows make are answered; anything else
 * returns 400 so a new dependency on Cognito shows up as a failed test.
 */
import type { Page } from '@playwright/test';
import { fakeTokens, type FakeSession } from './jwt.js';

/**
 * The codes the fake pool "sends", at the lengths the real one does (AUTH-06,
 * `apps/web/src/auth/codes.ts` `CODE_LENGTH`): the passwordless EMAIL_OTP sign-in code
 * answered in `RespondToAuthChallenge` is eight digits; the sign-up verification code
 * answered in `ConfirmSignUp` is six. The suite used to answer six for the sign-in step
 * too, which is why it never caught the screen truncating real codes.
 */
export const FAKE_SIGN_IN_CODE = '12345678';
export const FAKE_SIGN_UP_CODE = '123456';

/**
 * Unknown addresses, by the three shapes the pool was measured to answer under
 * `preventUserExistenceErrors` (final audit 2026-09-13, #46, ADR-040). The fake picks
 * the shape by the address's local part; any other unknown address gets SELECT_CHALLENGE.
 */
export const UNKNOWN = {
  /** 200 SELECT_CHALLENGE with the pool's generic factors and no EMAIL_OTP. */
  selectChallenge: 'audit-nobody@example.invalid',
  /** 400 PasswordResetRequiredException (the SDK turns it into a RESET_PASSWORD step). */
  passwordReset: 'nobody-reset@example.invalid',
  /** 200 with a simulated EMAIL_OTP challenge and a masked destination — identical to a real one. */
  simulatedCode: 'nobody-simulated@example.invalid',
} as const;

/** `m***@1cloudhub.com`, the way the pool masks a destination. */
function maskDestination(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.charAt(0)}***@${domain}`;
}

export async function installFakeCognito(page: Page, session: FakeSession): Promise<void> {
  /** The account the sign-up flow created, if any: `SignUp` fills it, its tokens name it. */
  let signedUp: FakeSession | null = null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const attributesOf = (s: FakeSession) => [
    { Name: 'sub', Value: s.sub },
    { Name: 'email', Value: s.email },
    { Name: 'name', Value: s.name },
  ];
  const tokensFor = (s: FakeSession) => ({
    AuthenticationResult: {
      ...fakeTokens(s),
      RefreshToken: 'fake-refresh',
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    },
  });

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
        // Auto sign-in after ConfirmSignUp: Amplify forwards the Session the confirmation
        // returned, and the pool answers with tokens — no second code (auth/README.md).
        if (typeof body?.Session === 'string' && signedUp !== null && username === signedUp.email) {
          return json(tokensFor(signedUp));
        }
        // The pool has `preventUserExistenceErrors` on: an unknown email is never a
        // UserNotFoundException. Production answers with one of three shapes (see UNKNOWN).
        if (username === UNKNOWN.passwordReset) {
          return json(
            { __type: 'PasswordResetRequiredException', message: 'Password reset required' },
            400,
          );
        }
        if (username === UNKNOWN.simulatedCode) {
          return json({
            ChallengeName: 'EMAIL_OTP',
            Session: 'fake-session',
            AvailableChallenges: ['PASSWORD_SRP', 'PASSWORD', 'EMAIL_OTP'],
            ChallengeParameters: {
              CODE_DELIVERY_DELIVERY_MEDIUM: 'EMAIL',
              CODE_DELIVERY_DESTINATION: 'n***@e***',
            },
          });
        }
        if (username !== session.email) {
          return json({
            ChallengeName: 'SELECT_CHALLENGE',
            Session: 'fake-session',
            AvailableChallenges: ['PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN'],
            ChallengeParameters: {},
          });
        }
        // The real challenge carries the medium and the masked destination — never the
        // code's length (nothing in Cognito's API does).
        return json({
          ChallengeName: 'EMAIL_OTP',
          Session: 'fake-session',
          ChallengeParameters: {
            CODE_DELIVERY_DELIVERY_MEDIUM: 'EMAIL',
            CODE_DELIVERY_DESTINATION: maskDestination(session.email),
          },
        });
      }
      case 'RespondToAuthChallenge': {
        const responses = (body?.ChallengeResponses ?? {}) as Record<string, string>;
        if (responses.EMAIL_OTP_CODE !== FAKE_SIGN_IN_CODE) {
          return json({ __type: 'CodeMismatchException', message: 'Invalid code' }, 400);
        }
        return json(tokensFor(session));
      }
      case 'SignUp': {
        const username = str(body?.Username);
        if (username === session.email) {
          return json({ __type: 'UsernameExistsException', message: 'User already exists' }, 400);
        }
        const attrs = (body?.UserAttributes ?? []) as { Name: string; Value: string }[];
        signedUp = {
          ...session,
          sub: 'e2e-signup-1',
          email: username,
          name: attrs.find((a) => a.Name === 'name')?.Value ?? '',
        };
        return json({
          UserConfirmed: false,
          UserSub: signedUp.sub,
          Session: 'fake-signup-session',
          CodeDeliveryDetails: {
            AttributeName: 'email',
            DeliveryMedium: 'EMAIL',
            Destination: maskDestination(username),
          },
        });
      }
      case 'ResendConfirmationCode': {
        const username = str(body?.Username);
        return json({
          CodeDeliveryDetails: {
            AttributeName: 'email',
            DeliveryMedium: 'EMAIL',
            Destination: maskDestination(username),
          },
        });
      }
      case 'ConfirmSignUp': {
        if (signedUp === null || body?.Username !== signedUp.email) {
          return json({ __type: 'UserNotFoundException', message: 'User does not exist' }, 400);
        }
        if (body.ConfirmationCode !== FAKE_SIGN_UP_CODE) {
          return json({ __type: 'CodeMismatchException', message: 'Invalid code' }, 400);
        }
        return json({ Session: 'fake-confirmed-session' });
      }
      case 'GetUser': {
        // The bearer token names the account (its `sub` claim); the fake JWT is unsigned.
        const [, payload = ''] = str(body?.AccessToken).split('.');
        const sub = (
          JSON.parse(Buffer.from(payload, 'base64url').toString() || '{}') as {
            sub?: string;
          }
        ).sub;
        const who = signedUp !== null && sub === signedUp.sub ? signedUp : session;
        return json({ Username: who.sub, UserAttributes: attributesOf(who) });
      }
      case 'RevokeToken':
      case 'GlobalSignOut':
        return json({});
      default:
        return json({ __type: 'NotImplemented', message: `fake cognito: ${operation}` }, 400);
    }
  });
}
