// @vitest-environment jsdom
//
// Issue 064: the hero/landing page replaces Hero.tsx (product framing +
// "Sign in"/"Use locally" CTAs) and LoginScreen.tsx (the 3-mode Cognito
// form) with a single polished on-ramp — product brief beside a login-05-
// shaped auth card, driven by the real useAuthStore wiring. Migrates the
// assertions from both predecessors' test suites; network is mocked at
// `amazon-cognito-identity-js`'s boundary (src/auth/cognitoClient.ts), same
// as LoginScreen.test.tsx — no live AWS call.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { isAuthConfiguredMock, getCurrentSessionMock, signUpMock, confirmSignUpMock, resendConfirmationCodeMock, signInMock } =
  vi.hoisted(() => ({
    isAuthConfiguredMock: vi.fn(() => true),
    getCurrentSessionMock: vi.fn(),
    signUpMock: vi.fn(),
    confirmSignUpMock: vi.fn(),
    resendConfirmationCodeMock: vi.fn(),
    signInMock: vi.fn(),
  }))

vi.mock('../auth/cognitoClient', () => ({
  isAuthConfigured: () => isAuthConfiguredMock(),
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args) as unknown,
  signUp: (...args: unknown[]) => signUpMock(...args) as unknown,
  confirmSignUp: (...args: unknown[]) => confirmSignUpMock(...args) as unknown,
  resendConfirmationCode: (...args: unknown[]) => resendConfirmationCodeMock(...args) as unknown,
  signIn: (...args: unknown[]) => signInMock(...args) as unknown,
  signOut: vi.fn(),
}))

import { HeroLanding } from './HeroLanding'
import { resetAuthStoreForTests } from '../store/auth'

beforeEach(() => {
  vi.clearAllMocks()
  isAuthConfiguredMock.mockReturnValue(true)
  resetAuthStoreForTests()
})

describe('HeroLanding — product brief + a11y (issue 064 test-first plan)', () => {
  it('renders the product brief and both Sign in / Sign up entry points, with a single h1', () => {
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/design generative systems/i)
    expect(screen.getByText(/local-first/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Need an account? Sign up' })).toBeInTheDocument()
  })

  it('the mode heading is an h2, not a second h1', () => {
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in' })).toBeInTheDocument()
  })

  it('every input has an accessible label', () => {
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('"Use locally" is present and calls its handler (no-account path stays intact)', async () => {
    const user = userEvent.setup()
    const onUseLocally = vi.fn()
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={onUseLocally} />)
    await user.click(screen.getByRole('button', { name: 'Use locally' }))
    expect(onUseLocally).toHaveBeenCalledTimes(1)
  })
})

describe('HeroLanding — configured build (migrated from issue 044 test-first plan #2)', () => {
  it('renders an enabled sign-in form with no "not configured" banner once the build has real Cognito ids', () => {
    isAuthConfiguredMock.mockReturnValue(true)
    resetAuthStoreForTests()
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})

describe('HeroLanding — sign-in (migrated from issue 033)', () => {
  it('is keyboard-operable, DOM/reading order: Use locally -> email -> password -> submit -> switch link', async () => {
    const user = userEvent.setup()
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Use locally' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Email')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Password')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Need an account? Sign up' })).toHaveFocus()
  })

  it('signs in and calls onSignedIn on success', async () => {
    const user = userEvent.setup()
    signInMock.mockResolvedValue({
      idToken: 'a.b.c',
      accessToken: 'x',
      refreshToken: 'y',
      sub: 'user-1',
      email: 'me@example.com',
    })
    const onSignedIn = vi.fn()
    render(<HeroLanding onSignedIn={onSignedIn} onUseLocally={vi.fn()} />)

    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(signInMock).toHaveBeenCalledWith('me@example.com', 'Passw0rd!')
  })

  it('renders the calm error surface on a failed sign-in and never calls onSignedIn', async () => {
    const user = userEvent.setup()
    signInMock.mockRejectedValue(new Error('Incorrect username or password.'))
    const onSignedIn = vi.fn()
    render(<HeroLanding onSignedIn={onSignedIn} onUseLocally={vi.fn()} />)

    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.')
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})

describe('HeroLanding — sign-up -> verify (migrated from issue 033)', () => {
  it('switches to sign-up, submits, and lands on the verify step', async () => {
    const user = userEvent.setup()
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Need an account? Sign up' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Create an account' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Verify your email' })).toBeInTheDocument(),
    )
    expect(screen.getByText(/new@example\.com/)).toBeInTheDocument()
    expect(signUpMock).toHaveBeenCalledWith('new@example.com', 'Passw0rd!')
  })

  it('confirms the verification code and returns to sign-in', async () => {
    const user = userEvent.setup()
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    confirmSignUpMock.mockResolvedValue(undefined)
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Need an account? Sign up' }))
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    await screen.findByRole('heading', { level: 2, name: 'Verify your email' })

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Sign in' })).toBeInTheDocument(),
    )
    expect(confirmSignUpMock).toHaveBeenCalledWith('new@example.com', '123456')
  })

  it('resends the verification code', async () => {
    const user = userEvent.setup()
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    resendConfirmationCodeMock.mockResolvedValue(undefined)
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Need an account? Sign up' }))
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    await screen.findByRole('heading', { level: 2, name: 'Verify your email' })

    await user.click(screen.getByRole('button', { name: 'Resend code' }))
    await waitFor(() => expect(resendConfirmationCodeMock).toHaveBeenCalledWith('new@example.com'))
  })
})

describe('HeroLanding — unconfigured build (migrated from issue 033 design brief)', () => {
  it('shows a calm notice and disables submission rather than a broken form', () => {
    isAuthConfiguredMock.mockReturnValue(false)
    resetAuthStoreForTests()
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/isn't configured/i)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })

  it('"Use locally" still works when auth is unconfigured', async () => {
    isAuthConfiguredMock.mockReturnValue(false)
    resetAuthStoreForTests()
    const user = userEvent.setup()
    const onUseLocally = vi.fn()
    render(<HeroLanding onSignedIn={vi.fn()} onUseLocally={onUseLocally} />)
    await user.click(screen.getByRole('button', { name: 'Use locally' }))
    expect(onUseLocally).toHaveBeenCalledTimes(1)
  })
})
