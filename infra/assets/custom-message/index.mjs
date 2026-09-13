/**
 * Cognito custom-message trigger: every one-time code the pool sends goes out branded
 * and in the user's language (AUTH-03, AUTH-04, I18N-05).
 *
 * Cognito invokes this before it sends a message and takes `emailSubject` and
 * `emailMessage` (HTML, ≤ 20,000 characters) from the response; the code itself is never
 * in the event — `request.codeParameter` is a placeholder (`{####}`) that Cognito
 * substitutes after the trigger returns, and the templates carry it exactly once.
 *
 * Which event renders which kind:
 *   CustomMessage_SignUp, CustomMessage_ResendCode        → signUpCode (AUTH-03)
 *   CustomMessage_Authentication                          → signInCode (EMAIL_OTP first factor, AUTH-04)
 *   CustomMessage_UpdateUserAttribute, _VerifyUserAttribute → emailChangeCode (the client may
 *                                                           write `email`, ADR-019 / #107)
 * Anything else (AdminCreateUser, ForgotPassword — neither can happen in this pool:
 * recovery is off, the one admin-created account is created with its message suppressed)
 * is returned untouched, so Cognito uses the pool's templates.
 *
 * The locale is the user's `locale` attribute, which the web app writes at sign-up and
 * whenever the account's choice changes (apps/web/src/auth/cognito.ts); an absent or
 * unknown tag renders en-US. The trigger has no dependency but @gede/mail (bundled in by
 * `NodejsFunction` at synth time) and makes no call.
 *
 * What "fails open" means here, exactly: for the handler's OWN faults — a render error, a
 * malformed event — the event is returned as received and the pool's branded en-US
 * template goes out, because a trigger that throws refuses the sign-up or sign-in itself.
 * It does NOT cover a response Cognito refuses: with the built-in sender
 * (`EmailSendingAccount: COGNITO_DEFAULT`) Cognito answers a well-formed response that
 * sets `emailMessage`/`emailSubject` with `InvalidLambdaResponseException` to the caller —
 * no mail, every sign-in refused, and nothing here can see it. That is why the pool
 * attaches this function only under the `customMessageTrigger` context flag, flipped in
 * the same merge as `withSES` (ADR-044, runbook §5). The te-IN strings are stripped of
 * format characters (ZWNJ) before they leave, for MessageTemplateType's pattern.
 */
/* eslint-disable no-console -- a Lambda's stdout is its CloudWatch log; nothing secret is written */
import { renderCodeMail, resolveMailLocale } from '@gede/mail';

/** triggerSource → the kind of mail it renders. */
const KIND_BY_SOURCE = {
  CustomMessage_SignUp: 'signUpCode',
  CustomMessage_ResendCode: 'signUpCode',
  CustomMessage_Authentication: 'signInCode',
  CustomMessage_UpdateUserAttribute: 'emailChangeCode',
  CustomMessage_VerifyUserAttribute: 'emailChangeCode',
};

export const HANDLED_TRIGGER_SOURCES = Object.keys(KIND_BY_SOURCE);

export async function handler(event) {
  try {
    const kind = KIND_BY_SOURCE[event?.triggerSource];
    const placeholder = event?.request?.codeParameter;
    if (kind === undefined || typeof placeholder !== 'string' || placeholder === '') {
      return event;
    }
    const attributes = event.request.userAttributes ?? {};
    const locale = resolveMailLocale(attributes.locale);
    const email = typeof attributes.email === 'string' ? attributes.email : null;
    const mail = renderCodeMail(kind, locale, { code: placeholder, email });
    event.response.emailSubject = mail.subject;
    event.response.emailMessage = mail.html;
    return event;
  } catch (error) {
    // Fail open to the pool's template: a refused message is a refused sign-in.
    console.error('custom-message render failed; pool template used', error);
    return event;
  }
}
