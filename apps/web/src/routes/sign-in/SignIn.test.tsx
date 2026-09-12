import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Cognito from '../../auth/cognito.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';

// The SDK boundary is the only thing mocked; screens, session and router are real.
vi.mock('../../auth/cognito.js', () => {
  const noUser = { current: null as Cognito.SessionUser | null };
  return {
    __noUser: noUser,
    configureAuth: vi.fn(),
    classifyError: (err: unknown): Cognito.AuthFailure => {
      const name = err instanceof Error ? err.name : '';
      if (name === 'PasskeyAuthenticationCanceled') return { kind: 'cancelled' };
      if (name === 'UserNotFoundException') return { kind: 'unknown-email' };
      if (name === 'CodeMismatchException') return { kind: 'wrong-code' };
      return { kind: 'other', message: err instanceof Error ? err.message : 'x' };
    },
    isPasskeySupported: vi.fn(() => true),
    startPasskeySignIn: vi.fn(),
    startCodeSignIn: vi.fn(),
    confirmCode: vi.fn(),
    startSignUp: vi.fn(),
    confirmSignUpCode: vi.fn(),
    resendSignUp: vi.fn(),
    startAppleSignIn: vi.fn(() => Promise.resolve()),
    registerPasskey: vi.fn(),
    signOutLocal: vi.fn(() => Promise.resolve()),
    currentUser: vi.fn(() => Promise.resolve(noUser.current)),
    accessToken: vi.fn(() => Promise.resolve(null)),
    onAuthEvent: vi.fn(() => () => undefined),
  };
});

const cognito = (await import('../../auth/cognito.js')) as unknown as typeof Cognito & {
  __noUser: { current: Cognito.SessionUser | null };
};

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

function namedError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('SignIn (option 1c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cognito.__noUser.current = null;
    vi.mocked(cognito.isPasskeySupported).mockReturnValue(true);
    withConfig();
  });

  it('AUTH-01 an unauthenticated visit to a document renders sign-in and remembers the path', async () => {
    renderRoutes(routes, ['/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?cell=D12']);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem('gede.returnTo')).toBe('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?cell=D12');
  });

  it('AUTH-03 Continue is disabled until the email is valid and Enter submits to the method step', async () => {
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    const email = await screen.findByLabelText('Email');
    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();
    await u.type(email, 'meena@1cloudhub');
    expect(cont).toBeDisabled();
    await u.type(email, '.com{Enter}');
    // AUTH-04: address shown with Change, passkey first, then the code.
    expect(await screen.findByText('meena@1cloudhub.com')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Passkey')).toBeLessThan(buttons.indexOf('Email me a code'));
    await u.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Email')).toHaveValue('meena@1cloudhub.com');
  });

  it('AUTH-02 switching to Create account keeps the email, resets to the email step and asks for a name', async () => {
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await screen.findByRole('button', { name: 'Passkey' });
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByLabelText('Email')).toHaveValue('meena@1cloudhub.com');
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('AUTH-05 hides the passkey option when WebAuthn is unsupported', async () => {
    vi.mocked(cognito.isPasskeySupported).mockReturnValue(false);
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    expect(await screen.findByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Passkey' })).not.toBeInTheDocument();
  });

  it('AUTH-05 passkey cancel stays on the method step with no error; success signs in and returns to the path', async () => {
    const u = userEvent.setup();
    sessionStorage.setItem('gede.returnTo', '/d/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    vi.mocked(cognito.startPasskeySignIn).mockRejectedValueOnce(
      namedError('PasskeyAuthenticationCanceled'),
    );
    const { router } = renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Passkey' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Passkey' })).toBeEnabled();

    vi.mocked(cognito.startPasskeySignIn).mockImplementationOnce(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    await u.click(screen.getByRole('button', { name: 'Passkey' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });
    expect(cognito.startPasskeySignIn).toHaveBeenCalledWith('meena@1cloudhub.com');
  });

  it('AUTH-06 code step: six digits, expiry note, Resend; wrong code names the problem', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({
      kind: 'code',
      destination: 'm***@1cloudhub.com',
    });
    vi.mocked(cognito.confirmCode).mockRejectedValueOnce(namedError('CodeMismatchException'));
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a code' }));
    const code = await screen.findByLabelText('Six-digit code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByText('Codes expire in 10 minutes')).toBeInTheDocument();
    const verify = screen.getByRole('button', { name: 'Verify and sign in' });
    expect(verify).toBeDisabled();
    await u.type(code, '12ab34');
    expect(code).toHaveValue('1234');
    expect(verify).toBeDisabled();
    await u.type(code, '56');
    expect(verify).toBeEnabled();
    await u.click(verify);
    expect(await screen.findByRole('alert')).toHaveTextContent('That code does not match');

    await u.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(cognito.startCodeSignIn).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('A new code is on its way.')).toBeInTheDocument();
  });

  it('AUTH-07 after a code sign-in, offers a passkey; declining is remembered for 30 days', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({ kind: 'code', destination: undefined });
    vi.mocked(cognito.confirmCode).mockImplementation(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    const { router } = renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a code' }));
    await u.type(await screen.findByLabelText('Six-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a passkey to this device?' });
    expect(dialog).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Not now' }));
    expect(localStorage.getItem('gede.passkeyOfferDeclinedAt')).not.toBeNull();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('AUTH-07 does not re-offer within 30 days', async () => {
    localStorage.setItem('gede.passkeyOfferDeclinedAt', String(Date.now() - 1000));
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({ kind: 'code', destination: undefined });
    vi.mocked(cognito.confirmCode).mockImplementation(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    const { router } = renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a code' }));
    await u.type(await screen.findByLabelText('Six-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('AUTH-03 sign-up sends the name with no password and verifies with a code', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startSignUp).mockResolvedValue({ destination: 'm***@1cloudhub.com' });
    vi.mocked(cognito.confirmSignUpCode).mockImplementation(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    renderRoutes(routes, ['/sign-in']);
    await u.click(await screen.findByRole('radio', { name: 'Create account' }));
    await u.type(screen.getByLabelText('Email'), 'meena@1cloudhub.com');
    await u.type(screen.getByLabelText('Display name'), 'Meena{Enter}');
    expect(cognito.startSignUp).toHaveBeenCalledWith('meena@1cloudhub.com', 'Meena');
    await u.type(await screen.findByLabelText('Six-digit code'), '654321');
    await u.click(screen.getByRole('button', { name: 'Verify and create account' }));
    expect(cognito.confirmSignUpCode).toHaveBeenCalledWith('meena@1cloudhub.com', '654321');
  });

  it('AUTH-08 shows the Apple button only when configured, below the passkey', async () => {
    withConfig({ appleSignIn: { domain: 'auth.test' } });
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    const apple = await screen.findByRole('button', { name: 'Sign in with Apple' });
    const buttons = screen.getAllByRole('button');
    expect(buttons.indexOf(screen.getByRole('button', { name: 'Passkey' }))).toBeLessThan(
      buttons.indexOf(apple),
    );
    await u.click(apple);
    expect(cognito.startAppleSignIn).toHaveBeenCalled();
  });

  it('AUTH-09 the session is memory-only: reload with no user shows sign-in; signed-out page names the last document', async () => {
    localStorage.setItem('gede.lastDocument', JSON.stringify({ id: 'x', title: 'Everest trek' }));
    localStorage.setItem('gede.lastEmail', 'meena@1cloudhub.com');
    renderRoutes(routes, ['/signed-out']);
    expect(await screen.findByRole('heading', { name: 'Signed out of GeDe' })).toBeInTheDocument();
    expect(screen.getByText('Everest trek')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign back in/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeInTheDocument();
  });
});
