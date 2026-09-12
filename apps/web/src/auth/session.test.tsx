import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Cognito from './cognito.js';
import { resetLocaleForTests } from '../locale.js';
import { RequireAuth, SessionProvider, takeReturnTo, useSession } from './session.js';

vi.mock('./cognito.js', () => ({
  currentUser: vi.fn(),
  onAuthEvent: vi.fn(() => () => undefined),
  signOutLocal: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/me.js', () => ({
  getMe: vi.fn(() => Promise.reject(new Error('no profile in this test'))),
  updateMe: vi.fn(() => Promise.resolve()),
}));
const cognito = await import('./cognito.js');
const meApi = await import('../api/me.js');

function Who() {
  const { state, signOut } = useSession();
  return (
    <>
      <p>{state.status === 'signed-in' ? `hello ${state.user.email}` : state.status}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}

function app(initial: string) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <SessionProvider>
            <Routes>
              <Route path="/sign-in" element={<p>sign-in screen</p>} />
              <Route
                path="*"
                element={
                  <RequireAuth>
                    <Who />
                  </RequireAuth>
                }
              />
            </Routes>
          </SessionProvider>
        ),
      },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLocaleForTests();
  });

  it('AUTH-01 redirects a signed-out visitor to /sign-in and remembers the full location', async () => {
    vi.mocked(cognito.currentUser).mockResolvedValue(null);
    const router = app('/d/abc?cell=B2#x');
    expect(await screen.findByText('sign-in screen')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(takeReturnTo()).toBe('/d/abc?cell=B2#x');
    expect(takeReturnTo()).toBeNull();
  });

  it('renders children once the session resolves signed-in', async () => {
    vi.mocked(cognito.currentUser).mockResolvedValue({
      sub: 's',
      email: 'meena@1cloudhub.com',
      name: 'Meena',
    });
    app('/');
    expect(await screen.findByText('hello meena@1cloudhub.com')).toBeInTheDocument();
    expect(localStorage.getItem('gede.lastEmail')).toBe('meena@1cloudhub.com');
  });

  it('AUTH-09 a tokenRefresh_failure event returns to signed-out', async () => {
    let handler: ((e: Cognito.AuthEvent) => void) | null = null;
    vi.mocked(cognito.onAuthEvent).mockImplementation((h) => {
      handler = h;
      return () => undefined;
    });
    vi.mocked(cognito.currentUser).mockResolvedValue({
      sub: 's',
      email: 'meena@1cloudhub.com',
      name: undefined,
    });
    app('/');
    await screen.findByText('hello meena@1cloudhub.com');
    handler!('tokenRefresh_failure');
    await waitFor(() => {
      expect(screen.getByText('sign-in screen')).toBeInTheDocument();
    });
  });

  it('AUTH-09 signOut revokes through the SDK, forgets the session and unbinds the user locale', async () => {
    vi.mocked(cognito.currentUser).mockResolvedValue({
      sub: 'sub-9',
      email: 'meena@1cloudhub.com',
      name: 'Meena',
    });
    app('/');
    await screen.findByText('hello meena@1cloudhub.com');
    expect(localStorage.getItem('gede.locale.sub-9')).toBe('en-US');
    screen.getByRole('button', { name: 'Sign out' }).click();
    await screen.findByText('sign-in screen');
    expect(cognito.signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('I18N-05 a signed-in user adopts the locale their account carries', async () => {
    vi.mocked(meApi.getMe).mockResolvedValueOnce({
      id: 'u',
      sub: 'sub-9',
      email: 'meena@1cloudhub.com',
      displayName: 'Meena',
      locale: 'te-IN',
    });
    vi.mocked(cognito.currentUser).mockResolvedValue({
      sub: 'sub-9',
      email: 'meena@1cloudhub.com',
      name: 'Meena',
    });
    app('/');
    await screen.findByText('hello meena@1cloudhub.com');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('te-IN');
    });
  });

  it('takeReturnTo rejects protocol-relative and external values', () => {
    sessionStorage.setItem('gede.returnTo', '//evil.test/x');
    expect(takeReturnTo()).toBeNull();
    sessionStorage.setItem('gede.returnTo', 'https://evil.test/x');
    expect(takeReturnTo()).toBeNull();
  });
});
