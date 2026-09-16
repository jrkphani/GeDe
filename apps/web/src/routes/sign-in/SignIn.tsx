import { useCallback, useEffect, useReducer, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  AppleSignInButton,
  Button,
  CodeField,
  Dialog,
  Icon,
  SegmentedControl,
  TextField,
  Wordmark,
} from '@gede/ui';
import { announce } from '../../announce.js';
import { CODE_LENGTH, type CodeKind } from '../../auth/codes.js';
import {
  classifyError,
  confirmCode,
  confirmSignUpCode,
  currentUser,
  isPasskeySupported,
  registerPasskey,
  resendSignUp,
  startAppleSignIn,
  startCodeSignIn,
  startPasskeySignIn,
  startSignUp,
  type AuthFailure,
  type SignInStep,
} from '../../auth/cognito.js';
import {
  passkeyOfferDeclinedRecently,
  recordPasskeyOfferDeclined,
} from '../../auth/passkey-offer.js';
import { readLastEmail, rememberLastEmail, takeReturnTo, useSession } from '../../auth/session.js';
import { getConfig } from '../../config.js';
import { useMessages, type MessageKey } from '../../i18n/index.js';
import { activeLocale } from '../../locale.js';
import { canContinue, flowReducer, initialFlow, type Mode } from './flow.js';
import { RingMotif } from './RingMotif.js';

const MODES: { value: Mode; label: string }[] = [
  { value: 'sign-in', label: 'Sign in' },
  { value: 'sign-up', label: 'Create account' },
];

/**
 * AUTH-06: everything the code step says about the code follows the code the auth step
 * expects (`CODE_LENGTH`): the field's label and the announcement by its length, the
 * expiry by its kind (a sign-in code lives for the auth session, a sign-up code 24 hours).
 */
const CODE_COPY: Readonly<Record<6 | 8, { label: MessageKey; sent: MessageKey }>> = {
  6: { label: 'auth.code.label.six', sent: 'auth.code.sent.six' },
  8: { label: 'auth.code.label.eight', sent: 'auth.code.sent.eight' },
};
const CODE_EXPIRY: Readonly<Record<CodeKind, MessageKey>> = {
  'sign-in': 'auth.code.expires.signIn',
  'sign-up': 'auth.code.expires.signUp',
};

function failureMessage(f: AuthFailure, mode: Mode): string | null {
  switch (f.kind) {
    case 'cancelled':
      return null; // AUTH-05: stay put, say nothing.
    case 'unknown-email':
      return 'No account uses this email. Switch to Create account to start one.';
    case 'exists':
      return 'An account already uses this email. Switch to Sign in.';
    case 'wrong-code':
      return 'That code does not match. Check the latest email or resend.';
    case 'expired-code':
      return 'That code has expired. Resend to get a fresh one.';
    case 'other':
      // `message` is already plain copy (cognito.ts describeOtherFailure), never SDK text.
      return mode === 'sign-up' ? `Could not create the account. ${f.message}` : f.message;
  }
}

export function SignIn() {
  const session = useSession();
  const navigate = useNavigate();
  const t = useMessages();
  const config = getConfig();
  const passkeys = isPasskeySupported();
  const [state, dispatch] = useReducer(flowReducer, undefined, () =>
    initialFlow({ email: readLastEmail() }),
  );
  /**
   * AUTH-07 passkey offer. `pending` holds the screen while the signed-in
   * user's `sub` is read (the decline memory is per user); `open` shows it.
   */
  const [offer, setOffer] = useState<
    { status: 'none' } | { status: 'pending' } | { status: 'open'; sub: string }
  >({ status: 'none' });
  const [registering, setRegistering] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // The one place that leaves this screen: once the session is signed in and
  // no passkey offer is pending, go where the visitor was headed (AUTH-01).
  useEffect(() => {
    if (session.state.status === 'signed-in' && offer.status === 'none') {
      void navigate(takeReturnTo() ?? '/', { replace: true });
    }
  }, [session.state.status, offer.status, navigate]);

  const finish = useCallback(async () => {
    await session.refresh();
    announce('Signed in');
  }, [session]);

  // Arriving at the email step from Change or Back places the caret in the field. A mode
  // switch also lands on the email step (AUTH-02) but focus stays on the segmented control
  // the user is operating — the arrow keys must keep working there (#144).
  const previousStep = useRef<typeof state.step | null>(null); // null: first render, focus once
  useEffect(() => {
    const arrived = state.step === 'email' && previousStep.current !== 'email';
    previousStep.current = state.step;
    if (arrived) emailRef.current?.focus();
  }, [state.step]);

  const fail = (err: unknown) => {
    const message = failureMessage(classifyError(err), state.mode);
    if (message === null) dispatch({ type: 'idle' });
    else dispatch({ type: 'error', message });
  };

  const handleStep = async (step: SignInStep, viaCode: boolean) => {
    switch (step.kind) {
      case 'done':
        rememberLastEmail(state.email.trim());
        // AUTH-07: after a code sign-in, offer a passkey unless this user declined
        // within 30 days. Hold the screen before the session flips: Amplify's
        // `signedIn` Hub event has already started a refresh, and the signed-in
        // effect leaves the moment it lands unless an offer is pending.
        if (viaCode && passkeys) {
          setOffer({ status: 'pending' });
          const user = await currentUser();
          if (user !== null && !passkeyOfferDeclinedRecently(user.sub)) {
            setOffer({ status: 'open', sub: user.sub });
            await session.refresh();
          } else {
            setOffer({ status: 'none' });
            await finish();
          }
        } else {
          await finish();
        }
        return;
      case 'code':
        // The step says which code it sent; the purpose and the length follow from it.
        dispatch({ type: 'go-code', purpose: step.code, destination: step.destination });
        announce(t(CODE_COPY[CODE_LENGTH[step.code]].sent));
        return;
      case 'unsupported':
        dispatch({ type: 'error', message: step.reason });
    }
  };

  // AUTH-03: Enter submits the email step.
  const submitEmail = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canContinue(state)) return;
    if (state.mode === 'sign-in') {
      dispatch({ type: 'go-method' });
      return;
    }
    dispatch({ type: 'busy', busy: 'continue' });
    startSignUp(state.email.trim(), state.name.trim(), activeLocale())
      .then((step) => handleStep(step, true))
      .catch(fail);
  };

  const usePasskey = () => {
    dispatch({ type: 'busy', busy: 'passkey' });
    startPasskeySignIn(state.email.trim())
      .then((step) => handleStep(step, false))
      .catch(fail);
  };

  const emailCode = () => {
    dispatch({ type: 'busy', busy: 'code' });
    startCodeSignIn(state.email.trim())
      .then((step) => handleStep(step, true))
      .catch(fail);
  };

  const codeLength = CODE_LENGTH[state.codePurpose];
  const codeComplete = state.code.length === codeLength;

  const verify = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!codeComplete || state.busy !== null) return;
    dispatch({ type: 'busy', busy: 'verify' });
    const call =
      state.codePurpose === 'sign-up'
        ? confirmSignUpCode(state.email.trim(), state.code)
        : confirmCode(state.code);
    call.then((step) => handleStep(step, true)).catch(fail);
  };

  const resend = () => {
    dispatch({ type: 'busy', busy: 'resend' });
    const call =
      state.codePurpose === 'sign-up'
        ? resendSignUp(state.email.trim()).then(() => undefined)
        : startCodeSignIn(state.email.trim()).then(() => undefined);
    call
      .then(() => {
        dispatch({ type: 'notice', message: 'A new code is on its way.' });
        announce('A new code is on its way');
      })
      .catch(fail);
  };

  // AUTH-08: rendered only when the pool has Apple configured (`config.appleSignIn`).
  const apple =
    config.appleSignIn === false
      ? null
      : () => {
          dispatch({ type: 'busy', busy: 'apple' });
          startAppleSignIn().catch(fail);
        };

  const addPasskey = () => {
    setRegistering(true);
    registerPasskey()
      .then(() => {
        announce('Passkey added');
      })
      .catch(() => {
        /* declined or failed: the session is still valid */
      })
      .finally(() => {
        setRegistering(false);
        setOffer({ status: 'none' }); // the signed-in effect navigates from here
      });
  };

  const declinePasskey = () => {
    if (offer.status === 'open') recordPasskeyOfferDeclined(offer.sub);
    setOffer({ status: 'none' });
  };

  const busy = state.busy;
  const emailDisabled = busy !== null;

  return (
    <main className="gd-signin">
      <RingMotif className="gd-signin__motif" />
      <header className="gd-signin__brand">
        <Wordmark size={32} />
      </header>
      <section className="gd-signin__copy">
        <p className="gd-signin__headline">
          Text is the data.
          <br />
          The canvas is the grid.
        </p>
        <p className="gd-signin__sub">Tables, formulas and context graphs on one shared sheet.</p>
      </section>

      <div className="gd-signin__card">
        <h1 className="gd-signin__title">
          {state.mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </h1>
        <SegmentedControl<Mode>
          label="Sign in or create account"
          options={MODES}
          value={state.mode}
          onChange={(mode) => {
            dispatch({ type: 'set-mode', mode });
          }}
          className="gd-signin__mode"
        />

        {state.step === 'email' && (
          <form className="gd-signin__form" onSubmit={submitEmail} noValidate>
            <TextField
              ref={emailRef}
              label="Email"
              type="email"
              inputMode="email"
              autoComplete={state.mode === 'sign-up' ? 'email' : 'username webauthn'}
              value={state.email}
              onChange={(e) => {
                dispatch({ type: 'set-email', email: e.target.value });
              }}
              disabled={emailDisabled}
              placeholder="you@company.com"
            />
            {state.mode === 'sign-up' && (
              <TextField
                label="Display name"
                autoComplete="name"
                value={state.name}
                onChange={(e) => {
                  dispatch({ type: 'set-name', name: e.target.value });
                }}
                disabled={emailDisabled}
                hint="Shown to people you share with"
              />
            )}
            {state.error !== null && (
              <p className="gd-signin__error" role="alert">
                {state.error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canContinue(state)}
              loading={busy === 'continue'}
              loadingLabel={state.mode === 'sign-up' ? 'Creating account…' : 'Continuing…'}
            >
              Continue
            </Button>
            <p className="gd-signin__note">
              No password. A passkey on this device, or a code by email.
            </p>
            {/* AUTH-08: Apple is offered at the sign-in and the sign-up step alike. No passkey
                exists before the address is known, so nothing sits above it here. */}
            {apple !== null && (
              <>
                <span className="gd-signin__or" aria-hidden="true">
                  or
                </span>
                <AppleSignInButton
                  wording={state.mode === 'sign-up' ? 'Continue with Apple' : 'Sign in with Apple'}
                  onClick={apple}
                  loading={busy === 'apple'}
                  disabled={busy !== null}
                />
              </>
            )}
          </form>
        )}

        {state.step === 'method' && (
          <div className="gd-signin__form">
            <p className="gd-signin__who">
              <span className="gd-signin__email">{state.email.trim()}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  dispatch({ type: 'go-email' });
                }}
              >
                Change
              </Button>
            </p>
            {passkeys && (
              <Button
                variant="primary"
                size="lg"
                icon={<Icon name="passkey" size={18} />}
                onClick={usePasskey}
                loading={busy === 'passkey'}
                loadingLabel="Waiting for your passkey…"
                disabled={busy !== null}
              >
                Passkey
              </Button>
            )}
            {/* Option 1c order, verbatim: passkey above Apple above email code. Apple is
                never subordinate to another provider; the code is a fallback, not one. */}
            {apple !== null && (
              <AppleSignInButton
                onClick={apple}
                loading={busy === 'apple'}
                disabled={busy !== null}
              />
            )}
            <Button
              variant={passkeys ? 'secondary' : 'primary'}
              size="lg"
              onClick={emailCode}
              loading={busy === 'code'}
              loadingLabel="Sending code…"
              disabled={busy !== null}
            >
              Email me a one-time code
            </Button>
            {state.error !== null && (
              <p className="gd-signin__error" role="alert">
                {state.error}
              </p>
            )}
          </div>
        )}

        {state.step === 'code' && (
          <form className="gd-signin__form" onSubmit={verify} noValidate>
            <p className="gd-signin__who">
              Code sent to{' '}
              <span className="gd-signin__email">{state.destination ?? state.email.trim()}</span>
            </p>
            <CodeField
              length={codeLength}
              label={t(CODE_COPY[codeLength].label)}
              value={state.code}
              onChange={(code) => {
                dispatch({ type: 'set-code', code });
              }}
              error={state.error ?? undefined}
              hint={t(CODE_EXPIRY[state.codePurpose])}
              autoFocus
              disabled={busy === 'verify'}
            />
            {state.notice !== null && (
              <p className="gd-signin__notice" role="status">
                {state.notice}
              </p>
            )}
            {state.mode === 'sign-in' && (
              // ADR-040 (#46): the pool answers an unknown address with a simulated code
              // challenge the app cannot tell from a real one, so the way out is said here.
              // Keyed on the mode, not the code's kind: the sign-in code step that follows a
              // confirmed sign-up (the auto-sign-in fallback) belongs to an account that exists.
              <p className="gd-signin__note">
                If no code arrives, this email may not have an account yet: switch to Create account
                to start one.
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!codeComplete || busy !== null}
              loading={busy === 'verify'}
              loadingLabel={state.codePurpose === 'sign-up' ? 'Creating account…' : 'Verifying…'}
            >
              {state.codePurpose === 'sign-up' ? 'Verify and create account' : 'Verify and sign in'}
            </Button>
            <div className="gd-signin__row">
              <Button
                variant="ghost"
                size="sm"
                onClick={resend}
                loading={busy === 'resend'}
                loadingLabel="Resending…"
                disabled={busy !== null}
              >
                Resend code
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  dispatch(
                    state.codePurpose === 'sign-up' ? { type: 'go-email' } : { type: 'go-method' },
                  );
                }}
                disabled={busy !== null}
              >
                Back
              </Button>
            </div>
          </form>
        )}
      </div>

      <Dialog
        open={offer.status === 'open'}
        onOpenChange={(open) => {
          if (!open) declinePasskey();
        }}
        title="Add a passkey to this device?"
        description="Next time, sign in with Face ID, Touch ID or your device PIN instead of a code."
        actions={
          // RESP-05 / ARCHITECTURE §2 "44 px targets": the lg size, as the rest of the
          // sign-in stack (#129).
          <>
            <Button size="lg" onClick={declinePasskey} disabled={registering}>
              Not now
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={addPasskey}
              loading={registering}
              loadingLabel="Adding…"
            >
              Add passkey
            </Button>
          </>
        }
      />
    </main>
  );
}
