import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Cognito from '../../auth/cognito.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';

// The SDK boundary is the only thing mocked: the calls that reach Cognito are fakes; the
// pure parts of the module (`classifyError`, `AuthFailureError`, `describeUnsupportedStep`)
// are real. Screens, session and router are real.
vi.mock('../../auth/cognito.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Cognito>();
  const noUser = { current: null as Cognito.SessionUser | null };
  return {
    ...actual,
    __noUser: noUser,
    configureAuth: vi.fn(),
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
    refreshAccessToken: vi.fn(() => Promise.resolve(null)),
    onAuthEvent: vi.fn(() => () => undefined),
  };
});

vi.mock('../../api/me.js', () => ({
  getMe: vi.fn(() => Promise.reject(new Error('no profile in this test'))),
  updateMe: vi.fn(() => Promise.resolve()),
}));
// Screens the flow lands on after sign-in need a quiet API; the fake is labelled here.
vi.mock('../../api/documents.js', () => ({
  listDocuments: vi.fn(() => Promise.resolve([])),
  createDocument: vi.fn(() => Promise.reject(new Error('not exercised by sign-in tests'))),
  getDocument: vi.fn(() =>
    Promise.resolve({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Everest trek',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      ownerId: 'sub-1',
      permission: 'owner',
    }),
  ),
  renameDocument: vi.fn(() => Promise.resolve()),
  permissionOf: (doc: { permission?: string | undefined }) => doc.permission ?? 'view',
}));

const cognito = (await import('../../auth/cognito.js')) as unknown as typeof Cognito & {
  __noUser: { current: Cognito.SessionUser | null };
};

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

function namedError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('sign-in stylesheet', () => {
  const css = readFileSync(resolve(__dirname, 'sign-in.css'), 'utf8');

  it('RESP-05 below 1024 px every sign-in target takes the 44 px token', () => {
    const block = /@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    for (const selector of [
      '.gd-signin .gd-btn',
      '.gd-signin .gd-apple',
      '.gd-signin .gd-field__input',
      '.gd-signin .gd-segmented__item',
      '.gd-signedout .gd-btn',
    ])
      expect(block).toContain(selector);
    expect(block).toMatch(/min-height:\s*var\(--hit-target\)/);
  });

  it('RESP-05 ARCHITECTURE §2 the segmented control and the ghost Change button are 44 px at every width, not only below lg', () => {
    const unscoped = css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
    expect(unscoped).toMatch(
      /\.gd-signin \.gd-segmented__item,\s*\.gd-signin \.gd-btn--sm\s*\{\s*min-height:\s*var\(--hit-target\)/,
    );
  });

  it('A11Y-06 the address row wraps so Change is never clipped, and labels wrap at 240 CSS px', () => {
    expect(css).toMatch(/\.gd-signin__who\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.gd-signin__who \.gd-btn\s*\{[^}]*flex:\s*none/);
    const narrow = /@media \(max-width: 479\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.gd-signin \.gd-btn\s*\{[^}]*white-space:\s*normal/);
  });
});

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
    expect(buttons.indexOf('Passkey')).toBeLessThan(buttons.indexOf('Email me a one-time code'));
    await u.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Email')).toHaveValue('meena@1cloudhub.com');
  });

  it('AUTH-04 a known email gets the method step: passkey first, then the code, the address shown with Change', async () => {
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    expect(await screen.findByText('meena@1cloudhub.com')).toBeInTheDocument();
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('Passkey')).toBeLessThan(names.indexOf('Email me a one-time code'));
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Email')).toHaveValue('meena@1cloudhub.com');
    expect(screen.queryByRole('button', { name: 'Passkey' })).not.toBeInTheDocument();
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
    expect(
      await screen.findByRole('button', { name: 'Email me a one-time code' }),
    ).toBeInTheDocument();
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
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
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
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    await u.type(await screen.findByLabelText('Six-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a passkey to this device?' });
    expect(dialog).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Not now' }));
    // Keyed by the user, not the device: the next person on this machine is still asked.
    expect(localStorage.getItem('gede.passkeyOfferDeclinedAt.sub-1')).not.toBeNull();
    expect(localStorage.getItem('gede.passkeyOfferDeclinedAt')).toBeNull();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('AUTH-07 the offer survives the signedIn Hub event Amplify fires before confirmSignIn resolves', async () => {
    // Amplify dispatches `signedIn` inside confirmSignIn; the session provider's
    // refresh then wins a network round trip against handleStep. The offer must
    // already be pending when that refresh lands, or the screen navigates away.
    let hub: ((event: Cognito.AuthEvent) => void) | undefined;
    vi.mocked(cognito.onAuthEvent).mockImplementationOnce((handler) => {
      hub = handler;
      return () => undefined;
    });
    // Each session read is a network round trip; later ones land later, in their own task.
    let reads = 0;
    vi.mocked(cognito.currentUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          reads += 1;
          setTimeout(() => {
            resolve(cognito.__noUser.current);
          }, 20 * reads);
        }),
    );
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({ kind: 'code', destination: undefined });
    vi.mocked(cognito.confirmCode).mockImplementation(() => {
      cognito.__noUser.current = user;
      hub?.('signedIn');
      return Promise.resolve({ kind: 'done' });
    });
    try {
      const u = userEvent.setup();
      const { router } = renderRoutes(routes, ['/sign-in']);
      await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
      await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
      await u.type(await screen.findByLabelText('Six-digit code'), '123456');
      await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
      expect(
        await screen.findByRole('dialog', { name: 'Add a passkey to this device?' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/sign-in');
    } finally {
      vi.mocked(cognito.currentUser).mockImplementation(() =>
        Promise.resolve(cognito.__noUser.current),
      );
    }
  });

  it('AUTH-07 does not re-offer within 30 days to the user who declined', async () => {
    localStorage.setItem('gede.passkeyOfferDeclinedAt.sub-1', String(Date.now() - 1000));
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({ kind: 'code', destination: undefined });
    vi.mocked(cognito.confirmCode).mockImplementation(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    const { router } = renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    await u.type(await screen.findByLabelText('Six-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('AUTH-05 a pool step GeDe does not offer surfaces as plain copy, never the SDK enum', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startPasskeySignIn).mockResolvedValueOnce({
      kind: 'unsupported',
      reason: 'This account has no passkey yet. Email me a one-time code instead.',
    });
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Passkey' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This account has no passkey yet. Email me a one-time code instead.',
    );
    expect(alert.textContent).not.toMatch(/[A-Z]+_[A-Z_]+/);
    expect(screen.getByRole('button', { name: 'Email me a one-time code' })).toBeEnabled();
  });

  it('AUTH-04 an unknown email (SELECT_CHALLENGE under preventUserExistenceErrors) says no account uses it and points at Create account', async () => {
    const u = userEvent.setup();
    // What `startCodeSignIn` / `startPasskeySignIn` throw for that pool answer (cognito.test.ts).
    const unknown = () => Promise.reject(new cognito.AuthFailureError({ kind: 'unknown-email' }));
    vi.mocked(cognito.startCodeSignIn).mockImplementation(unknown);
    vi.mocked(cognito.startPasskeySignIn).mockImplementation(unknown);
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'audit-nobody@example.invalid{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'No account uses this email. Switch to Create account to start one.',
    );
    expect(alert).not.toHaveTextContent(/passkey/i);
    // Same answer for the passkey button: the cause is the account, not the method.
    await u.click(screen.getByRole('button', { name: 'Passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No account uses this email.');
    // The remedy is one click away and keeps the address.
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByLabelText('Email')).toHaveValue('audit-nobody@example.invalid');
  });

  it('AUTH-04 the code step in sign-in mode says what to do if no code arrives (the obfuscated simulated challenge, ADR 040)', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({
      kind: 'code',
      destination: 'n***@e***',
    });
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'nobody@example.invalid{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    await screen.findByLabelText('Six-digit code');
    expect(
      screen.getByText(/If no code arrives, this email may not have an account yet/),
    ).toBeInTheDocument();
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByLabelText('Email')).toHaveValue('nobody@example.invalid');
    expect(screen.queryByText(/If no code arrives/)).not.toBeInTheDocument();
  });

  it('AUTH-02 A11Y-01 switching mode from the keyboard keeps focus on the segmented control; Change and Back still place the caret in the email field (#144)', async () => {
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    const email = await screen.findByLabelText('Email');
    expect(email).toHaveFocus(); // arriving at the screen lands in the field
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByRole('radio', { name: 'Create account' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveFocus();
    expect(screen.getByLabelText('Email')).not.toHaveFocus();
    await u.click(screen.getByRole('radio', { name: 'Sign in' }));
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
    await u.type(screen.getByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('AUTH-06 an error replaces the resend notice, and a fresh notice replaces the error (#144)', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startCodeSignIn).mockResolvedValue({ kind: 'code', destination: undefined });
    vi.mocked(cognito.confirmCode).mockRejectedValue(namedError('CodeMismatchException'));
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    await u.click(await screen.findByRole('button', { name: 'Resend code' }));
    expect(await screen.findByText('A new code is on its way.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Six-digit code'), '111111');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code does not match');
    expect(screen.queryByText('A new code is on its way.')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(await screen.findByText('A new code is on its way.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('AUTH-05 a pool exception GeDe does not name surfaces as plain copy, never the SDK text (#144)', async () => {
    const u = userEvent.setup();
    const raw = new Error(
      'PreAuthentication failed with error This account signs in only through the pipeline..',
    );
    raw.name = 'UserLambdaValidationException';
    vi.mocked(cognito.startCodeSignIn).mockRejectedValueOnce(raw);
    renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'e2e@gede.work{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Email me a one-time code' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This account cannot sign in from here. Contact support.');
    expect(alert.textContent).not.toMatch(/PreAuthentication|failed with error|\.\./);
  });

  it('AUTH-09 a tokenRefresh_failure Hub event while on a document returns to sign-in with the path retained', async () => {
    let hub: ((e: Cognito.AuthEvent) => void) | null = null;
    vi.mocked(cognito.onAuthEvent).mockImplementationOnce((handler) => {
      hub = handler;
      return () => undefined;
    });
    cognito.__noUser.current = user;
    const { router } = renderRoutes(routes, ['/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?cell=D12']);
    await waitFor(() => {
      expect(screen.getByLabelText('Workscape title')).toHaveValue('Everest trek');
    });
    hub!('tokenRefresh_failure');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(sessionStorage.getItem('gede.returnTo')).toBe('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?cell=D12');
    // The address is pre-filled for the person who was signed out; nothing else was kept.
    expect(screen.getByLabelText('Email')).toHaveValue('meena@1cloudhub.com');
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

  it('AUTH-08 (button only) the Apple button is absent unless config.appleSignIn is set', async () => {
    renderRoutes(routes, ['/sign-in']);
    await screen.findByLabelText('Email');
    expect(screen.queryByRole('button', { name: /Apple/ })).not.toBeInTheDocument();
  });

  it('AUTH-08 (button only) Apple is offered at the sign-in step, the sign-up step, and between Passkey and the email code on the method step', async () => {
    withConfig({ appleSignIn: { domain: 'auth.test' } });
    const u = userEvent.setup();
    renderRoutes(routes, ['/sign-in']);
    // Sign-in, email step.
    await screen.findByLabelText('Email');
    const appleSignIn = screen.getByRole('button', { name: 'Sign in with Apple' });
    expect(appleSignIn).toHaveClass('gd-apple');
    // Sign-up step keeps it, with Apple's own alternative wording.
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    const appleSignUp = screen.getByRole('button', { name: 'Continue with Apple' });
    expect(appleSignUp).toHaveClass('gd-apple');
    // Method step, option 1c verbatim: passkey above Apple above email code.
    await u.click(screen.getByRole('radio', { name: 'Sign in' }));
    await u.type(screen.getByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    const apple = await screen.findByRole('button', { name: 'Sign in with Apple' });
    const buttons = screen.getAllByRole('button');
    const at = (name: string) => buttons.indexOf(screen.getByRole('button', { name }));
    expect(at('Passkey')).toBeLessThan(buttons.indexOf(apple));
    expect(buttons.indexOf(apple)).toBeLessThan(at('Email me a one-time code'));
    await u.click(apple);
    expect(cognito.startAppleSignIn).toHaveBeenCalledTimes(1);
  });

  it('AUTH-09 tokens are held in memory only: after a sign-in nothing token-like is in web storage', async () => {
    const u = userEvent.setup();
    vi.mocked(cognito.startPasskeySignIn).mockImplementationOnce(() => {
      cognito.__noUser.current = user;
      return Promise.resolve({ kind: 'done' });
    });
    const { router } = renderRoutes(routes, ['/sign-in']);
    await u.type(await screen.findByLabelText('Email'), 'meena@1cloudhub.com{Enter}');
    await u.click(await screen.findByRole('button', { name: 'Passkey' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    const stored = [localStorage, sessionStorage].flatMap((store) =>
      Array.from({ length: store.length }, (_, i) => store.key(i) ?? '').map(
        (k) => `${k}=${store.getItem(k) ?? ''}`,
      ),
    );
    // Only the remembered address and the return path may be stored — never a token.
    expect(stored.filter((e) => /token|jwt|eyJ|cognito|refresh/i.test(e))).toEqual([]);
    expect(localStorage.getItem('gede.lastEmail')).toBe('meena@1cloudhub.com');
  });

  it('AUTH-09 the signed-out screen names the last document and offers Sign back in and Switch account', async () => {
    sessionStorage.setItem('gede.lastDocument', JSON.stringify({ id: 'x', title: 'Everest trek' }));
    localStorage.setItem('gede.lastEmail', 'meena@1cloudhub.com');
    renderRoutes(routes, ['/signed-out']);
    expect(await screen.findByRole('heading', { name: 'Signed out of GeDe' })).toBeInTheDocument();
    expect(screen.getByText('Everest trek')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign back in as meena@1cloudhub.com' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeInTheDocument();
  });

  it('AUTH-09 Switch account on the signed-out screen forgets the email and the last document', async () => {
    const u = userEvent.setup();
    sessionStorage.setItem('gede.lastDocument', JSON.stringify({ id: 'x', title: 'Everest trek' }));
    localStorage.setItem('gede.lastEmail', 'meena@1cloudhub.com');
    renderRoutes(routes, ['/signed-out']);
    await u.click(await screen.findByRole('button', { name: 'Switch account' }));
    expect(await screen.findByLabelText('Email')).toHaveValue('');
    expect(localStorage.getItem('gede.lastEmail')).toBeNull();
    expect(sessionStorage.getItem('gede.lastDocument')).toBeNull();
  });
});
