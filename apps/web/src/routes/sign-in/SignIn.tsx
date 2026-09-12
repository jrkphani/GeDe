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
import {
  classifyError,
  confirmCode,
  confirmSignUpCode,
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
import { canContinue, flowReducer, initialFlow, type Mode } from './flow.js';
import { RingMotif } from './RingMotif.js';

const MODES: { value: Mode; label: string }[] = [
  { value: 'sign-in', label: 'Sign in' },
  { value: 'sign-up', label: 'Create account' },
];

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
      return mode === 'sign-up'
        ? `Could not create the account: ${f.message}`
        : `Could not sign in: ${f.message}`;
  }
}

export function SignIn() {
  const session = useSession();
  const navigate = useNavigate();
  const config = getConfig();
  const passkeys = isPasskeySupported();
  const [state, dispatch] = useReducer(flowReducer, undefined, () =>
    initialFlow({ email: readLastEmail() }),
  );
  const [offerPasskey, setOfferPasskey] = useState(false);
  const [registering, setRegistering] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // The one place that leaves this screen: once the session is signed in and
  // no passkey offer is pending, go where the visitor was headed (AUTH-01).
  useEffect(() => {
    if (session.state.status === 'signed-in' && !offerPasskey) {
      void navigate(takeReturnTo() ?? '/', { replace: true });
    }
  }, [session.state.status, offerPasskey, navigate]);

  const finish = useCallback(async () => {
    await session.refresh();
    announce('Signed in');
  }, [session]);

  useEffect(() => {
    if (state.step === 'email') emailRef.current?.focus();
  }, [state.step, state.mode]);

  const fail = (err: unknown) => {
    const message = failureMessage(classifyError(err), state.mode);
    if (message === null) dispatch({ type: 'idle' });
    else dispatch({ type: 'error', message });
  };

  const handleStep = async (step: SignInStep, purpose: 'sign-in' | 'sign-up', viaCode: boolean) => {
    switch (step.kind) {
      case 'done':
        rememberLastEmail(state.email.trim());
        // AUTH-07: after a code sign-in, offer a passkey unless declined within 30 days.
        // Set the offer before the session flips: Amplify's `signedIn` Hub event has
        // already started a refresh, and the signed-in effect leaves this screen the
        // moment it lands unless an offer is pending.
        if (viaCode && passkeys && !passkeyOfferDeclinedRecently()) {
          setOfferPasskey(true);
          await session.refresh();
        } else {
          await finish();
        }
        return;
      case 'code':
        dispatch({ type: 'go-code', purpose, destination: step.destination });
        announce('We sent a six-digit code to your email');
        return;
      case 'unsupported':
        dispatch({
          type: 'error',
          message: `This account needs a sign-in method GeDe does not offer (${step.step}).`,
        });
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
    startSignUp(state.email.trim(), state.name.trim())
      .then(({ destination }) => {
        dispatch({ type: 'go-code', purpose: 'sign-up', destination });
        announce('We sent a six-digit code to confirm your email');
      })
      .catch(fail);
  };

  const usePasskey = () => {
    dispatch({ type: 'busy', busy: 'passkey' });
    startPasskeySignIn(state.email.trim())
      .then((step) => handleStep(step, 'sign-in', false))
      .catch(fail);
  };

  const emailCode = () => {
    dispatch({ type: 'busy', busy: 'code' });
    startCodeSignIn(state.email.trim())
      .then((step) => handleStep(step, 'sign-in', true))
      .catch(fail);
  };

  const verify = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state.code.length !== 6 || state.busy !== null) return;
    dispatch({ type: 'busy', busy: 'verify' });
    const call =
      state.codePurpose === 'sign-up'
        ? confirmSignUpCode(state.email.trim(), state.code)
        : confirmCode(state.code);
    call.then((step) => handleStep(step, state.codePurpose, true)).catch(fail);
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
        setOfferPasskey(false); // the signed-in effect navigates from here
      });
  };

  const declinePasskey = () => {
    recordPasskeyOfferDeclined();
    setOfferPasskey(false);
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
            <Button
              variant={passkeys ? 'secondary' : 'primary'}
              size="lg"
              onClick={emailCode}
              loading={busy === 'code'}
              loadingLabel="Sending code…"
              disabled={busy !== null}
            >
              Email me a code
            </Button>
            {/* Passkey above Apple, Apple never subordinate: black, Apple's glyph, 44 pt. */}
            {apple !== null && (
              <>
                <span className="gd-signin__or" aria-hidden="true">
                  or
                </span>
                <AppleSignInButton
                  onClick={apple}
                  loading={busy === 'apple'}
                  disabled={busy !== null}
                />
              </>
            )}
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
              value={state.code}
              onChange={(code) => {
                dispatch({ type: 'set-code', code });
              }}
              error={state.error ?? undefined}
              hint="Codes expire in 10 minutes"
              autoFocus
              disabled={busy === 'verify'}
            />
            {state.notice !== null && (
              <p className="gd-signin__notice" role="status">
                {state.notice}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={state.code.length !== 6 || busy !== null}
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
        open={offerPasskey}
        onOpenChange={(open) => {
          if (!open) declinePasskey();
        }}
        title="Add a passkey to this device?"
        description="Next time, sign in with Face ID, Touch ID or your device PIN instead of a code."
        actions={
          <>
            <Button onClick={declinePasskey} disabled={registering}>
              Not now
            </Button>
            <Button
              variant="primary"
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
