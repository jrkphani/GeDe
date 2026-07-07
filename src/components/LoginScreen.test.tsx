// @vitest-environment jsdom
//
// Drives the real store (src/store/auth.ts) with the network layer mocked
// at `amazon-cognito-identity-js`'s boundary (src/auth/cognitoClient.ts) —
// no live AWS call, matching the Test-first plan. This exercises the full
// component -> store -> client wiring, not just the component in isolation.
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

import { LoginScreen } from './LoginScreen'
import { resetAuthStoreForTests } from '../store/auth'

beforeEach(() => {
  vi.clearAllMocks()
  isAuthConfiguredMock.mockReturnValue(true)
  resetAuthStoreForTests()
})

describe('LoginScreen — configured build (issue 044 test-first plan #2)', () => {
  it('renders an enabled sign-in form with no "not configured" banner once the build has real Cognito ids', () => {
    isAuthConfiguredMock.mockReturnValue(true)
    resetAuthStoreForTests()
    render(<LoginScreen onSignedIn={vi.fn()} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})

describe('LoginScreen — sign-in (issue 033)', () => {
  it('is fully keyboard-operable in field order: email -> password -> submit -> switch link', async () => {
    const user = userEvent.setup()
    render(<LoginScreen onSignedIn={vi.fn()} />)
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
    render(<LoginScreen onSignedIn={onSignedIn} />)

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
    render(<LoginScreen onSignedIn={onSignedIn} />)

    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.')
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})

describe('LoginScreen — sign-up -> verify (issue 033)', () => {
  it('switches to sign-up, submits, and lands on the verify step', async () => {
    const user = userEvent.setup()
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    render(<LoginScreen onSignedIn={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Need an account? Sign up' }))
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Verify your email' })).toBeInTheDocument(),
    )
    expect(screen.getByText(/new@example\.com/)).toBeInTheDocument()
    expect(signUpMock).toHaveBeenCalledWith('new@example.com', 'Passw0rd!')
  })

  it('confirms the verification code and returns to sign-in', async () => {
    const user = userEvent.setup()
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    confirmSignUpMock.mockResolvedValue(undefined)
    render(<LoginScreen onSignedIn={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Need an account? Sign up' }))
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'Passw0rd!')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    await screen.findByRole('heading', { name: 'Verify your email' })

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument())
    expect(confirmSignUpMock).toHaveBeenCalledWith('new@example.com', '123456')
  })
})

describe('LoginScreen — unconfigured build (issue 033 design brief)', () => {
  it('shows a calm notice and disables submission rather than a broken form', () => {
    isAuthConfiguredMock.mockReturnValue(false)
    resetAuthStoreForTests()
    render(<LoginScreen onSignedIn={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/isn't configured/i)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })
})
