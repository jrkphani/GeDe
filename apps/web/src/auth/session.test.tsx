import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Cognito from './cognito.js';
import { RequireAuth, SessionProvider, takeReturnTo, useSession } from './session.js';

vi.mock('./cognito.js', () => ({
  currentUser: vi.fn(),
  onAuthEvent: vi.fn(() => () => undefined),
  signOutLocal: vi.fn(() => Promise.resolve()),
}));
const cognito = await import('./cognito.js');

function Who() {
  const { state } = useSession();
  return <p>{state.status === 'signed-in' ? `hello ${state.user.email}` : state.status}</p>;
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

  it('takeReturnTo rejects protocol-relative and external values', () => {
    sessionStorage.setItem('gede.returnTo', '//evil.test/x');
    expect(takeReturnTo()).toBeNull();
    sessionStorage.setItem('gede.returnTo', 'https://evil.test/x');
    expect(takeReturnTo()).toBeNull();
  });
});
