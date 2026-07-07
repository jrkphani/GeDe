import { useState, type SyntheticEvent } from 'react'
import { useAuthStore } from '../store/auth'
import { useStatusStore } from '../store/status'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Mode = 'sign-in' | 'sign-up' | 'verify'

/*
 * `/login` — the custom Cognito login screen (issue 033, ADR-0009: not
 * Hosted UI). One screen, three modes (sign-in / sign-up / verify) so a
 * fresh visitor never leaves the page; the calm error surface (issue 015)
 * renders whatever the store's `error` holds, cleared on the next edit.
 * Composed entirely from `ui/` primitives (Button/Input) — no raw controls.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
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
    <main className="login">
      <section className="panel login__panel">
        <h1 className="login__title">
          {mode === 'sign-in' && 'Sign in'}
          {mode === 'sign-up' && 'Create an account'}
          {mode === 'verify' && 'Verify your email'}
        </h1>

        {!configured && (
          <p className="login__notice" role="status">
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
            className="login__form"
            onSubmit={(e) => {
              void handleSignIn(e)
            }}
          >
            <label className="login__field" htmlFor="login-email">
              Email
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  clearError()
                  setEmail(e.target.value)
                }}
              />
            </label>
            <label className="login__field" htmlFor="login-password">
              Password
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => {
                  clearError()
                  setPassword(e.target.value)
                }}
              />
            </label>
            <Button type="submit" variant="command" disabled={busy || !configured}>
              Sign in
            </Button>
            <Button
              type="button"
              variant="bare"
              className="login__switch"
              onClick={() => switchMode('sign-up')}
            >
              Need an account? Sign up
            </Button>
          </form>
        )}

        {mode === 'sign-up' && (
          <form
            className="login__form"
            onSubmit={(e) => {
              void handleSignUp(e)
            }}
          >
            <label className="login__field" htmlFor="signup-email">
              Email
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  clearError()
                  setEmail(e.target.value)
                }}
              />
            </label>
            <label className="login__field" htmlFor="signup-password">
              Password
              <Input
                id="signup-password"
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
            </label>
            <Button type="submit" variant="command" disabled={busy || !configured}>
              Sign up
            </Button>
            <Button
              type="button"
              variant="bare"
              className="login__switch"
              onClick={() => switchMode('sign-in')}
            >
              Already have an account? Sign in
            </Button>
          </form>
        )}

        {mode === 'verify' && (
          <form
            className="login__form"
            onSubmit={(e) => {
              void handleVerify(e)
            }}
          >
            <p className="login__body">We emailed a verification code to {email}.</p>
            <label className="login__field" htmlFor="verify-code">
              Verification code
              <Input
                id="verify-code"
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
            </label>
            <Button type="submit" variant="command" disabled={busy}>
              Verify
            </Button>
            <Button
              type="button"
              variant="bare"
              className="login__switch"
              onClick={() => {
                void handleResend()
              }}
            >
              Resend code
            </Button>
          </form>
        )}
      </section>
    </main>
  )
}
