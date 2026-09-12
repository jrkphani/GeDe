import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DocumentsApi from '../../api/documents.js';
import type { DocumentSummary } from '../../api/documents.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';
import { selectDocuments } from './Library.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

vi.mock('../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

vi.mock('../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
    getDocument: vi.fn(),
  };
});

const docs = await import('../../api/documents.js');

const fixture: DocumentSummary[] = [
  {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
    title: 'Everest trek',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ownerId: 'sub-1',
  },
  {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
    title: 'Board minutes',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-09-10T10:00:00Z',
    ownerId: 'sub-2',
    sharedBy: 'Sembian V',
  },
  {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAC',
    title: 'Old plan',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-07-01T10:00:00Z',
    ownerId: 'sub-1',
    deletedAt: '2026-09-05T00:00:00Z',
  },
];

describe('selectDocuments', () => {
  it('LIB-01 recents is reverse-chronological and excludes deleted; browse sorts by name; shared groups sharers; deleted lists the bin', () => {
    expect(selectDocuments(fixture, 'recents', '').map((d) => d.title)).toEqual([
      'Board minutes',
      'Everest trek',
    ]);
    expect(selectDocuments(fixture, 'browse', '').map((d) => d.title)).toEqual([
      'Board minutes',
      'Everest trek',
    ]);
    expect(selectDocuments(fixture, 'shared', '').map((d) => d.title)).toEqual(['Board minutes']);
    expect(selectDocuments(fixture, 'deleted', '').map((d) => d.title)).toEqual(['Old plan']);
  });

  it('LIB-04 search filters by name, case-insensitively', () => {
    expect(selectDocuments(fixture, 'recents', 'EVEREST').map((d) => d.title)).toEqual([
      'Everest trek',
    ]);
    expect(selectDocuments(fixture, 'recents', 'zzz')).toEqual([]);
  });
});

describe('Library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia(false);
  });

  it('AUTH-10 a new account lands in the library with the first-run empty state', async () => {
    vi.mocked(docs.listDocuments).mockResolvedValue([]);
    renderRoutes(routes, ['/']);
    expect(
      await screen.findByRole('heading', { name: 'Create your first workscape' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create workscape' })).toBeInTheDocument();
  });

  it('LIB-06 + creates an untitled workscape and opens it', async () => {
    const u = userEvent.setup();
    vi.mocked(docs.listDocuments).mockResolvedValue([]);
    vi.mocked(docs.createDocument).mockResolvedValue({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Untitled',
      createdAt: '2026-09-12T00:00:00Z',
      updatedAt: '2026-09-12T00:00:00Z',
      ownerId: 'sub-1',
    });
    vi.mocked(docs.getDocument).mockResolvedValue({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Untitled',
      createdAt: '2026-09-12T00:00:00Z',
      updatedAt: '2026-09-12T00:00:00Z',
      ownerId: 'sub-1',
    });
    const { router } = renderRoutes(routes, ['/']);
    await u.click(await screen.findByRole('button', { name: 'New workscape' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/d/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });
    expect(router.state.location.search).toBe('?new=1');
  });

  it('LIB-01 lists rows, highlights the active view and switches views', async () => {
    const u = userEvent.setup();
    vi.mocked(docs.listDocuments).mockResolvedValue(fixture);
    renderRoutes(routes, ['/']);
    expect(await screen.findByText('Everest trek')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recents' })).toHaveAttribute('aria-current', 'page');
    await u.click(screen.getByRole('button', { name: 'Shared' }));
    expect(screen.getByRole('heading', { name: 'Shared' })).toBeInTheDocument();
    expect(screen.queryByText('Everest trek')).not.toBeInTheDocument();
    expect(screen.getByText('Board minutes')).toBeInTheDocument();
  });

  it('LIB-04 a search with no matches says "No workscapes match"', async () => {
    const u = userEvent.setup();
    vi.mocked(docs.listDocuments).mockResolvedValue(fixture);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.type(screen.getByLabelText('Search workscapes'), 'quarterly');
    expect(screen.getByRole('heading', { name: 'No workscapes match' })).toBeInTheDocument();
  });

  it('LIB-08 Recently Deleted empty state reads "No items"', async () => {
    vi.mocked(docs.listDocuments).mockResolvedValue([fixture[0]!]);
    renderRoutes(routes, ['/?view=deleted']);
    expect(await screen.findByRole('heading', { name: 'No items' })).toBeInTheDocument();
  });

  it('LIB-10 below 900 px the sidebar hides behind a control and Kind/Shared columns drop', async () => {
    installMatchMedia((q) => q.includes('899.98'));
    const u = userEvent.setup();
    vi.mocked(docs.listDocuments).mockResolvedValue(fixture);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    expect(screen.queryByRole('button', { name: 'Browse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Kind' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Recents', expanded: false });
    await u.click(toggle);
    expect(await screen.findByRole('button', { name: 'Browse' })).toBeInTheDocument();
  });

  it('A11Y-05 the app shell has one polite live region and view changes announce through it', async () => {
    const u = userEvent.setup();
    vi.mocked(docs.listDocuments).mockResolvedValue(fixture);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    const region = screen.getByTestId('live-region');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    await u.click(screen.getByRole('button', { name: 'Browse' }));
    expect(region).toHaveTextContent('Browse view');
  });

  it('API failures render the catalogue page (500)', async () => {
    const { ApiError } = await import('../../api/client.js');
    vi.mocked(docs.listDocuments).mockRejectedValue(new ApiError(500, 'x', 'req-9', undefined, 4));
    renderRoutes(routes, ['/']);
    expect(
      await screen.findByRole('heading', { name: 'Something failed on our side' }),
    ).toBeInTheDocument();
  });
});
