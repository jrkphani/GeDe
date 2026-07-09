import { useState, type SyntheticEvent } from 'react'
import { useAuthStore } from '../store/auth'
import { useStatusStore } from '../store/status'
import { Button } from './ui/button'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'

type Mode = 'sign-in' | 'sign-up' | 'verify'

// The product brief (issue 064 design brief) — truthful, GeDe-voiced value
// points, not marketing fluff (STYLE_GUIDE §9).
const VALUE_POINTS = [
  'Design generative systems as dimensions, parameters, and contexts — not one-off screens.',
  'Foundation and architecture tiers, plus a canvas, keep the whole method in view.',
  'Sign in to sync a project across devices and collaborators.',
] as const

/*
 * `/welcome` and `/login` — the v2 on-ramp (issue 064, evolving issue 033's
 * Hero.tsx + LoginScreen.tsx into one polished surface, shadcn `login-05`
 * as the auth card's structural base). It is the canonical signed-out
 * destination and the sign-out redirect target (issue 063). Auth is an
 * on-ramp, not a gate: "Use locally" always routes straight to the
 * account-free local app, and an unconfigured build degrades to a calm
 * notice rather than a broken form (issue 033 design brief) — nothing here
 * blocks or delays the local app's own boot.
 *
 * Reuses the existing Cognito wiring end to end (useAuthStore's signIn/
 * signUp/confirmSignUp/resendCode) — this component owns no auth logic of
 * its own, only the three-mode form UI that drives it.
 */
export function HeroLanding({
  onSignedIn,
  onUseLocally,
}: {
  onSignedIn: () => void
  onUseLocally: () => void
}) {
  const signIn = useAuthStore((s) => s.signIn)
  const signUp = useAuthStore((s) => s.signUp)
  const confirmSignUp = useAuthStore((s) => s.confirmSignUp)
  const resendCode = useAuthStore((s) => s.resendCode)
  const clearError = useAuthStore((s) => s.clearError)
  const error = useAuthStore((s) => s.error)
  const configured = useAuthStore((s) => s.configured)
  const announce = useStatusStore((s) => s.announce)

  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  function switchMode(next: Mode) {
    clearError()
    setMode(next)
  }

  async function handleSignIn(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    try {
      await signIn(email, password)
      onSignedIn()
    } catch {
      // The calm error is already in the store; nothing else to do here.
    } finally {
      setBusy(false)
    }
  }

  async function handleSignUp(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    try {
      await signUp(email, password)
      setMode('verify')
      announce(`Check ${email} for a verification code`)
    } catch {
      // handled via store error
    } finally {
      setBusy(false)
    }
  }

  async function handleVerify(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    try {
      await confirmSignUp(email, code)
      setMode('sign-in')
      setPassword('')
      setCode('')
      announce('Verified — sign in to continue')
    } catch {
      // handled via store error
    } finally {
      setBusy(false)
    }
  }

  async function handleResend() {
    try {
      await resendCode(email)
      announce(`Sent a new code to ${email}`)
    } catch {
      // handled via store error
    }
  }

  return (
    <main className="hero-landing">
      <section className="hero-landing__brief panel">
        <p className="hero-landing__eyebrow">GeDe</p>
        <h1 className="hero-landing__title">Design generative systems, together.</h1>
        <p className="hero-landing__body">
          GeDe is a local-first tool for designing generative systems. The full app works offline,
          on this device, with no account — signing in only adds sync across devices and
          collaborators.
        </p>
        <ul className="hero-landing__points">
          {VALUE_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <Button variant="bare" className="hero-landing__use-locally" onClick={onUseLocally}>
          Use locally
        </Button>
      </section>

      <section className="hero-landing__auth panel" aria-labelledby="hero-landing-auth-heading">
        <h2 id="hero-landing-auth-heading" className="hero-landing__auth-title">
          {mode === 'sign-in' && 'Sign in'}
          {mode === 'sign-up' && 'Create an account'}
          {mode === 'verify' && 'Verify your email'}
        </h2>

        {!configured && (
          <p className="hero-landing__notice" role="status">
            Sign-in isn't configured for this build — continue with the local app instead.
          </p>
        )}

        {error !== null && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}

        {mode === 'sign-in' && (
          <form
            className="hero-landing__form"
            onSubmit={(e) => {
              void handleSignIn(e)
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="hero-email">Email</FieldLabel>
                <Input
                  id="hero-email"
                  className="hero-landing__input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => {
                    clearError()
                    setEmail(e.target.value)
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="hero-password">Password</FieldLabel>
                <Input
                  id="hero-password"
                  className="hero-landing__input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => {
                    clearError()
                    setPassword(e.target.value)
                  }}
                />
              </Field>
              <Button type="submit" variant="command" disabled={busy || !configured}>
                Sign in
              </Button>
              <Button
                type="button"
                variant="bare"
                className="hero-landing__switch"
                onClick={() => switchMode('sign-up')}
              >
                Need an account? Sign up
              </Button>
            </FieldGroup>
          </form>
        )}

        {mode === 'sign-up' && (
          <form
            className="hero-landing__form"
            onSubmit={(e) => {
              void handleSignUp(e)
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="hero-signup-email">Email</FieldLabel>
                <Input
                  id="hero-signup-email"
                  className="hero-landing__input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => {
                    clearError()
                    setEmail(e.target.value)
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="hero-signup-password">Password</FieldLabel>
                <Input
                  id="hero-signup-password"
                  className="hero-landing__input"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={password}
                  onChange={(e) => {
                    clearError()
                    setPassword(e.target.value)
                  }}
                />
              </Field>
              <Button type="submit" variant="command" disabled={busy || !configured}>
                Sign up
              </Button>
              <Button
                type="button"
                variant="bare"
                className="hero-landing__switch"
                onClick={() => switchMode('sign-in')}
              >
                Already have an account? Sign in
              </Button>
            </FieldGroup>
          </form>
        )}

        {mode === 'verify' && (
          <form
            className="hero-landing__form"
            onSubmit={(e) => {
              void handleVerify(e)
            }}
          >
            <FieldGroup>
              <p className="hero-landing__body">We emailed a verification code to {email}.</p>
              <Field>
                <FieldLabel htmlFor="hero-verify-code">Verification code</FieldLabel>
                <Input
                  id="hero-verify-code"
                  className="hero-landing__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => {
                    clearError()
                    setCode(e.target.value)
                  }}
                />
              </Field>
              <Button type="submit" variant="command" disabled={busy}>
                Verify
              </Button>
              <Button
                type="button"
                variant="bare"
                className="hero-landing__switch"
                onClick={() => {
                  void handleResend()
                }}
              >
                Resend code
              </Button>
            </FieldGroup>
          </form>
        )}
      </section>
    </main>
  )
}
