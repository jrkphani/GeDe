import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { ERROR_PAGES, ERROR_STATUSES, pageForStatus } from './catalogue.js';
import { ErrorBanner } from './ErrorBanner.js';
import { ErrorCell, parseWorkscapeLink } from './ErrorCell.js';
import { mapError, RouteError } from './RouteError.js';

vi.mock('../../auth/cognito.js', () => ({
  isPasskeySupported: () => false,
  accessToken: () => Promise.resolve(null),
  refreshAccessToken: () => Promise.resolve(null),
  currentUser: () => Promise.resolve(null),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));
const cognito = await import('../../auth/cognito.js');

function routeThatThrows(err: unknown) {
  return [
    {
      path: '/',
      errorElement: <RouteError />,
      element: <Thrower err={err} />,
    },
  ];
}
function Thrower({ err }: { err: unknown }): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw err;
}

describe('error catalogue', () => {
  it('covers 400/401/403/404/429/500/503/504 with amber for 4xx and red for 5xx', () => {
    expect(ERROR_STATUSES).toHaveLength(8);
    for (const s of ERROR_STATUSES) {
      expect(ERROR_PAGES[s].severity).toBe(s >= 500 ? 5 : 4);
    }
    expect(pageForStatus(418).status).toBe(400);
    expect(pageForStatus(502).status).toBe(500);
  });

  it('maps ApiError, thrown Response and unknown errors', () => {
    expect(mapError(new ApiError(403, 'no', 'req-1', { owner: 'Meenarapan D' }, 1)).owner).toBe(
      'Meenarapan D',
    );
    expect(mapError(new Response('', { status: 404 })).status).toBe(404);
    expect(mapError(new Error('boom')).status).toBe(500);
  });
});

describe('ErrorCell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
  });

  it.each(ERROR_STATUSES)(
    'renders the %s cell with the code in the row ruler and catalogue copy',
    (status) => {
      const router = createMemoryRouter([{ path: '/', element: <ErrorCell status={status} /> }]);
      const { container } = render(<RouterProvider router={router} />);
      const page = ERROR_PAGES[status];
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(page.title);
      expect(screen.getByText(page.body)).toBeInTheDocument();
      expect(container.querySelector('.gd-error__row--code')).toHaveTextContent(String(status));
      expect(container.querySelector('.gd-error')).toHaveClass(`gd-error--sev${page.severity}`);
      expect(screen.getByRole('button', { name: page.cta.label })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: page.alt.label })).toBeInTheDocument();
    },
  );

  it('unknown routes render the 404 cell', async () => {
    const { routes } = await import('../../routes.js');
    renderRoutes(routes, ['/no/such/place']);
    expect(
      await screen.findByRole('heading', { name: 'Nothing at this address' }),
    ).toBeInTheDocument();
  });

  it('A11Y-05 a router error page renders inside the shell: the live region exists and "Reference copied" is announced', async () => {
    const u = userEvent.setup();
    // jsdom has no clipboard; a fake that records the write, labelled as such.
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => writeText(text) },
    });
    try {
      const { routes } = await import('../../routes.js');
      renderRoutes(routes, ['/no/such/place']);
      await screen.findByRole('heading', { name: 'Nothing at this address' });
      // Exactly one polite region, present before anything is announced.
      const live = screen.getByTestId('live-region');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(screen.getAllByRole('status')).toHaveLength(1);
      // The document language is applied by the shell on this page too (I18N-03).
      expect(document.documentElement.lang).toBe('en-US');
      await u.click(screen.getByRole('button', { name: 'ref 404·nf' }));
      expect(writeText).toHaveBeenCalledWith('ref 404·nf');
      await waitFor(() => {
        expect(live).toHaveTextContent('Reference copied');
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('RESP-05 the reference button and every card target take the 44 px token below 1024 px', () => {
    const css = readFileSync(resolve(__dirname, 'errors.css'), 'utf8');
    const narrow = /@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(
      /\.gd-error \.gd-btn,\s*\.gd-error__ref,\s*\.gd-error \.gd-field__input\s*\{\s*min-height:\s*var\(--hit-target\)/,
    );
    expect(narrow).toMatch(/\.gd-error__ref\s*\{[^}]*min-width:\s*var\(--hit-target\)/);
    // At desktop the reference is still a 32 px target, not a 22 px chip.
    expect(css).toMatch(/\.gd-error__ref\s*\{[^}]*min-height:\s*2rem/);
  });

  it('a thrown 401 renders the session page, and Sign in remembers the document path', async () => {
    const u = userEvent.setup();
    const router = createMemoryRouter(routeThatThrows(new ApiError(401, 'x', undefined)), {
      initialEntries: ['/?cell=D12'],
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Your session ended' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(sessionStorage.getItem('gede.returnTo')).toBe('/?cell=D12');
    // AUTH-09: the stale tokens go too, or sign-in would bounce straight back here.
    await waitFor(() => {
      expect(cognito.signOutLocal).toHaveBeenCalledTimes(1);
    });
  });

  it('AUTH-09 401 Switch account signs out locally, forgets the email and last document, and keeps the path', async () => {
    const u = userEvent.setup();
    localStorage.setItem('gede.lastEmail', 'meena@1cloudhub.com');
    sessionStorage.setItem('gede.lastDocument', JSON.stringify({ id: 'x', title: 'Everest trek' }));
    const router = createMemoryRouter(routeThatThrows(new ApiError(401, 'x', undefined)), {
      initialEntries: ['/?cell=D12'],
    });
    render(<RouterProvider router={router} />);
    await u.click(await screen.findByRole('button', { name: 'Switch account' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in');
    });
    expect(cognito.signOutLocal).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('gede.lastEmail')).toBeNull();
    expect(sessionStorage.getItem('gede.lastDocument')).toBeNull();
    expect(sessionStorage.getItem('gede.returnTo')).toBe('/?cell=D12');
  });

  it('500 shows the attempt count and the request id in the reference', () => {
    const router = createMemoryRouter(
      routeThatThrows(new ApiError(500, 'x', 'abcdef123', undefined, 4)),
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByText('attempt 4 of 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ref 500·abcdef' })).toBeInTheDocument();
  });

  it('503 polls the health endpoint every 15 s and Check now shortcuts it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 503 }));
    try {
      const onRetry = vi.fn();
      const router = createMemoryRouter([
        { path: '/', element: <ErrorCell status={503} onRetry={onRetry} /> },
      ]);
      render(<RouterProvider router={router} />);
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchSpy).toHaveBeenCalledWith('https://api.test/health', expect.anything());
      expect(onRetry).not.toHaveBeenCalled();
      fetchSpy.mockResolvedValue(new Response('', { status: 200 }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onRetry).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('400 validates a pasted link before navigating', async () => {
    const u = userEvent.setup();
    const router = createMemoryRouter([
      { path: '/', element: <ErrorCell status={400} /> },
      { path: '/d/:id', element: <p>doc</p> },
    ]);
    render(<RouterProvider router={router} />);
    await u.click(screen.getByRole('button', { name: 'Paste the link again' }));
    const field = screen.getByLabelText('Workscape link');
    await u.type(field, 'https://evil.test/d/01ARZ3NDEKTSV4RRFFQ69G5FAV{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('not a GeDe workscape link');
    await u.clear(field);
    await u.type(field, '/d/01ARZ3NDEKTSV4RRFFQ69G5FAV{Enter}');
    expect(await screen.findByText('doc')).toBeInTheDocument();
  });

  it('parseWorkscapeLink accepts same-origin URLs and paths only', () => {
    expect(parseWorkscapeLink('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'http://localhost')).toBe(
      '/d/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(
      parseWorkscapeLink('http://localhost/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?x=1', 'http://localhost'),
    ).toBe('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV?x=1');
    expect(
      parseWorkscapeLink('http://other/d/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'http://localhost'),
    ).toBeNull();
    expect(parseWorkscapeLink('/d/short', 'http://localhost')).toBeNull();
  });

  it('403 disables Request access with a reason rather than hiding it', () => {
    const router = createMemoryRouter([
      { path: '/', element: <ErrorCell status={403} owner="Meenarapan D" /> },
    ]);
    render(<RouterProvider router={router} />);
    const b = screen.getByRole('button', { name: 'Request access' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('title');
    expect(screen.getByText('owner · Meenarapan D')).toBeInTheDocument();
  });
});

describe('ErrorBanner', () => {
  it('renders the banner placement for 429 with live meta and both actions', () => {
    const onRetry = vi.fn();
    const onWorkOffline = vi.fn();
    render(
      <ErrorBanner
        status={429}
        meta="retrying in 3s"
        onRetry={onRetry}
        onWorkOffline={onWorkOffline}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Slow down for a moment');
    expect(screen.getByText('retrying in 3s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work offline' })).toBeInTheDocument();
  });

  it('uses the red tone and alert role for 5xx', () => {
    render(<ErrorBanner status={504} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This is taking longer than expected');
  });
});
