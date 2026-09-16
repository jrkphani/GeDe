/**
 * The one-time codes Cognito sends, and how many digits each has (AUTH-06). Pure — no
 * Amplify, no DOM — so the screen can read it under any test's mock of `cognito.ts`.
 *
 * Cognito does not make the length configurable and does not report it:
 * `CodeDeliveryDetailsType` carries `AttributeName`, `DeliveryMedium` and `Destination`
 * only, and the EMAIL_OTP challenge's `ChallengeParameters` carry the medium and the masked
 * destination only. The length is a property of the operation that sends the code:
 *
 * - `sign-up` — the verification code of `SignUp` / `ResendConfirmationCode`, answered by
 *   `ConfirmSignUp` (Amplify: `CONFIRM_SIGN_UP`). **Six digits.** The developer guide's
 *   verification examples carry `confirmation_code=123456` ("Configuring MFA,
 *   authentication, verification and invitation messages" › "Customizing email verification
 *   messages"); the code "is valid for 24 hours" ("Signing up and confirming user accounts"
 *   › "Verifying contact information at sign-up"). An email-change verification
 *   (`VerifyUserAttribute`) is the same kind of code.
 * - `sign-in` — the passwordless EMAIL_OTP first factor of `InitiateAuth(USER_AUTH)`,
 *   answered by `RespondToAuthChallenge` (Amplify: `CONFIRM_SIGN_IN_WITH_EMAIL_CODE`).
 *   **Eight digits.** The API reference's worked example answers it with
 *   `"EMAIL_OTP_CODE": "12345678"` (RespondToAuthChallenge › Examples), and that is what
 *   the production pool sends; it stays valid for the app client's authentication flow
 *   session duration (ten minutes here, `infra/lib/stacks/auth-stack.ts`).
 *
 * The screen's code step takes its label, its complete state and its Verify enablement from
 * this table; the field itself (`@gede/ui` `CodeField`) accepts up to the longest and never
 * drops a digit. This is the one place a digit count is written in the app.
 */
import type { CodeLength } from '@gede/ui';

export type CodeKind = 'sign-in' | 'sign-up';

export const CODE_LENGTH: Readonly<Record<CodeKind, CodeLength>> = {
  'sign-in': 8,
  'sign-up': 6,
};
