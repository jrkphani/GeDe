import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DocumentsApi from '../../api/documents.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';
import { columnLetter } from './DocumentShell.js';

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
  return { ...actual, getDocument: vi.fn(), renameDocument: vi.fn(() => Promise.resolve()) };
});

const docs = await import('../../api/documents.js');
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('DocumentShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia(false);
    vi.mocked(docs.getDocument).mockResolvedValue({
      id: ID,
      title: 'Everest trek',
      createdAt: '2026-09-12T00:00:00Z',
      updatedAt: '2026-09-12T00:00:00Z',
      ownerId: 'sub-1',
      sharedWithOthers: true,
    });
  });

  it('renders the chrome: mark to library, title, Shared slot, sheet strip and rulers from the lattice', async () => {
    const { container } = renderRoutes(routes, [`/d/${ID}`]);
    // The input renders before the document fetch resolves; wait for the value, not the element.
    const title = await screen.findByLabelText('Workscape title');
    await waitFor(() => {
      expect(title).toHaveValue('Everest trek');
    });
    expect(screen.getByRole('link', { name: 'Back to my workscapes' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByText('Shared')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Sheet 1/ })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'View' })).toBeInTheDocument();
    const cols = container.querySelectorAll('.gd-canvas__cols span');
    expect(cols[0]).toHaveTextContent('A');
    expect((cols[0] as HTMLElement).style.width).toBe('160px');
    const rows = container.querySelectorAll('.gd-canvas__rows span');
    expect((rows[0] as HTMLElement).style.height).toBe('22px');
    expect(localStorage.getItem('gede.lastDocument')).toContain('Everest trek');
  });

  it('RESP-02 below 768 px shows "View only on phone", hides the toolbar and renders no edit affordance', async () => {
    installMatchMedia((q) => q.includes('767.98') || q.includes('899.98'));
    renderRoutes(routes, [`/d/${ID}`]);
    expect(await screen.findByText('View only on phone')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workscape title')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Everest trek');
  });

  it('a 404 from the API renders the catalogue page', async () => {
    const { ApiError } = await import('../../api/client.js');
    vi.mocked(docs.getDocument).mockRejectedValue(new ApiError(404, 'x', undefined));
    renderRoutes(routes, [`/d/${ID}`]);
    expect(
      await screen.findByRole('heading', { name: 'Nothing at this address' }),
    ).toBeInTheDocument();
  });

  it('column letters are computed A…Z, AA…', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
  });
});
