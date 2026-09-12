import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type * as DocumentsApi from '../../api/documents.js';
import type { DocumentsView, DocumentSummary } from '../../api/documents.js';
import type * as MeApi from '../../api/me.js';
import { RECENCY_LABELS } from '../../intl.js';
import { resetLocaleForTests } from '../../locale.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

vi.mock('../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  refreshAccessToken: () => Promise.resolve('tok'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

// Fakes, labelled: the `api/documents` and `api/me` client modules are replaced
// (their HTTP behaviour is covered by documents.test.ts and me.test.ts against a
// fake `fetch`); the Cognito boundary is replaced. Screens, session, locale
// store and router are real.
vi.mock('../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
    getDocument: vi.fn(),
    deleteDocument: vi.fn(() => Promise.resolve()),
    recoverDocument: vi.fn(() => Promise.resolve()),
    archiveDocument: vi.fn(() => Promise.resolve()),
    unarchiveDocument: vi.fn(() => Promise.resolve()),
    recoverAllDocuments: vi.fn(() => Promise.resolve({ count: 1, ids: ['recovered-1'] })),
    deleteAllDocuments: vi.fn(() => Promise.resolve(1)),
    getDocumentShares: vi.fn(),
  };
});
vi.mock('../../api/me.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MeApi>();
  return {
    ...actual,
    getMe: vi.fn(() =>
      Promise.resolve({
        id: 'u1',
        sub: 'sub-1',
        email: user.email,
        displayName: 'Meena',
        locale: null,
        tourDoneAt: '2026-09-01T00:00:00.000Z',
        sampleDocumentId: null,
      }),
    ),
    updateMe: vi.fn(() => Promise.resolve()),
  };
});

const docs = await import('../../api/documents.js');
const me = await import('../../api/me.js');

const everest: DocumentSummary = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
  title: 'Everest trek',
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
  ownerId: 'sub-1',
  ownerName: 'Meena',
  sharedWithOthers: false,
  permission: 'owner',
  sizeBytes: 956000,
  deletedAt: null,
  archivedAt: null,
  everShared: false,
  sample: false,
  linkAccess: 'none',
};
const minutes: DocumentSummary = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
  title: 'Board minutes',
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-10T10:00:00Z',
  ownerId: 'sub-2',
  ownerName: 'Sembian V',
  sharedBy: { id: 'sub-2', name: 'Sembian V' },
  sharedWithOthers: false,
  permission: 'view',
  sizeBytes: 882000,
  deletedAt: null,
  archivedAt: null,
  everShared: true,
  sample: false,
  linkAccess: 'none',
};
/** Owned and shared out (LIB-D2): the toolbar offers Archive, never Delete. */
const trek: DocumentSummary = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAD',
  title: 'Shared trek',
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-09T10:00:00Z',
  ownerId: 'sub-1',
  ownerName: 'Meena',
  sharedWithOthers: true,
  permission: 'owner',
  sizeBytes: 1000,
  deletedAt: null,
  archivedAt: null,
  everShared: true,
  sample: false,
  linkAccess: 'view',
};
/** The guided sample (ONB-01, LIB-D10): neither deletable nor archivable. */
const sample: DocumentSummary = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAE',
  title: 'Q3 Delivery — Guided sample',
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-11T10:00:00Z',
  ownerId: 'sub-1',
  ownerName: 'Meena',
  sharedWithOthers: false,
  permission: 'owner',
  sizeBytes: 42000,
  deletedAt: null,
  archivedAt: null,
  everShared: false,
  sample: true,
  linkAccess: 'none',
};
const archivedTrek: DocumentSummary = {
  ...trek,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAF',
  title: 'Archived trek',
  archivedAt: '2026-09-08T00:00:00Z',
};
const oldPlan: DocumentSummary = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAC',
  title: 'Old plan',
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-07-01T10:00:00Z',
  ownerId: 'sub-1',
  sharedWithOthers: false,
  permission: 'owner',
  sizeBytes: 12000,
  deletedAt: '2026-09-05T00:00:00Z',
};

function serve(byView: Partial<Record<DocumentsView, DocumentSummary[]>>) {
  vi.mocked(docs.listDocuments).mockImplementation((view) => Promise.resolve(byView[view] ?? []));
}

const live = { recents: [everest, minutes], browse: [everest, minutes], shared: [minutes] };

describe('Library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia(false);
    resetLocaleForTests();
  });

  it('AUTH-10 a new account lands in the library with the first-run empty state and one primary action', async () => {
    serve({});
    renderRoutes(routes, ['/']);
    expect(
      await screen.findByRole('heading', { name: 'Create your first workscape' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create workscape' })).toBeInTheDocument();
    expect(docs.listDocuments).toHaveBeenCalledWith('recents');
  });

  it('AUTH-10 the first-run view has exactly one primary action, and a library with rows has none above the rows', async () => {
    serve({});
    const { unmount } = renderRoutes(routes, ['/']);
    await screen.findByRole('button', { name: 'Create workscape' });
    const primaries = () =>
      screen.getAllByRole('button').filter((b) => b.classList.contains('gd-btn--primary'));
    expect(primaries().map((b) => b.textContent)).toEqual(['Create workscape']);
    unmount();
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    expect(primaries()).toEqual([]);
  });

  it('LIB-06 a failed create is a banner with Retry in the library, not the full-page cell', async () => {
    const u = userEvent.setup();
    serve(live);
    vi.mocked(docs.createDocument)
      .mockRejectedValueOnce(new ApiError(503, 'x', 'req-3', undefined, 4))
      .mockResolvedValueOnce({ ...everest, title: 'Untitled' });
    vi.mocked(docs.getDocument).mockResolvedValue({ ...everest, title: 'Untitled' });
    const { router } = renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.click(screen.getByRole('button', { name: 'New workscape' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Could not create a workscape');
    expect(banner).toHaveTextContent('503 after 4 attempts (ref req-3)');
    expect(screen.getByText('Everest trek')).toBeInTheDocument(); // the library is still there
    await u.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/d/${everest.id}`);
    });
  });

  it('LIB-06 + creates an untitled workscape and opens it', async () => {
    const u = userEvent.setup();
    serve({});
    vi.mocked(docs.createDocument).mockResolvedValue({ ...everest, title: 'Untitled' });
    vi.mocked(docs.getDocument).mockResolvedValue({ ...everest, title: 'Untitled' });
    const { router } = renderRoutes(routes, ['/']);
    await u.click(await screen.findByRole('button', { name: 'New workscape' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/d/${everest.id}`);
    });
    expect(router.state.location.search).toBe('?new=1');
  });

  it('LIB-01 lists rows grouped by recency, highlights the active view and fetches each view by name', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    expect(await screen.findByText('Everest trek')).toBeInTheDocument();
    const headers = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) expect(Object.values(RECENCY_LABELS)).toContain(h);
    expect(screen.getByRole('button', { name: 'Recents' })).toHaveAttribute('aria-current', 'page');
    await u.click(screen.getByRole('button', { name: 'Shared' }));
    expect(screen.getByRole('heading', { name: 'Shared' })).toBeInTheDocument();
    expect(docs.listDocuments).toHaveBeenLastCalledWith('shared');
    expect(await screen.findByRole('rowheader', { name: 'Sembian V' })).toBeInTheDocument();
    expect(screen.queryByText('Everest trek')).not.toBeInTheDocument();
  });

  it('LIB-02 a row shows icon, name, kind, size, modified date and sharer; click selects, double click opens', async () => {
    const u = userEvent.setup();
    serve(live);
    const { router } = renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Board minutes')).closest('tr')!;
    expect(within(row).getByText('Workscape')).toBeInTheDocument();
    expect(within(row).getByText('882 kB')).toBeInTheDocument();
    expect(within(row).getByText('Sep 10, 2026')).toBeInTheDocument();
    expect(within(row).getByText('Sembian V')).toBeInTheDocument();
    expect(row.querySelector('svg[data-name="table"]')).not.toBeNull();
    expect(row).toHaveAttribute('aria-selected', 'false');
    await u.click(row);
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(router.state.location.pathname).toBe('/');
    await u.dblClick(row);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/d/${minutes.id}`);
    });
  });

  it('LIB-02 A11Y-01 the keyboard alone selects with arrows and opens with Enter', async () => {
    const u = userEvent.setup();
    serve(live);
    const { router } = renderRoutes(routes, ['/']);
    const first = (await screen.findByText('Board minutes')).closest('tr')!;
    first.focus();
    await u.keyboard('{ArrowDown}');
    const second = screen.getByText('Everest trek').closest('tr')!;
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    await u.keyboard('{ArrowUp}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    await u.keyboard('{Enter}');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/d/${minutes.id}`);
    });
  });

  it('LIB-03 MENU-02 exactly one row selects; selection enables the toolbar and reveals the row overflow; unavailable commands stay visible, disabled, with a reason', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    const everestRow = (await screen.findByText('Everest trek')).closest('tr')!;
    const minutesRow = screen.getByText('Board minutes').closest('tr')!;
    const openButton = screen.getByRole('button', { name: 'Open' });
    expect(openButton).toBeDisabled();
    expect(openButton).toHaveAttribute('title', 'Select a workscape first');
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();

    await u.click(minutesRow);
    expect(openButton).toBeEnabled();
    // Board minutes is shared with Meena (everShared), so the slot reads Archive; as a
    // viewer she cannot, and the control stays focusable so the tooltip can say why.
    const archiveButton = screen.getByRole('button', { name: 'Archive' });
    expect(archiveButton).toHaveAttribute('aria-disabled', 'true');
    act(() => {
      archiveButton.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Only the owner can archive it');
    const more = screen.getByRole('button', { name: 'More actions for Board minutes' });
    await u.click(more);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Archive/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await u.keyboard('{Escape}');

    await u.click(everestRow);
    expect(everestRow).toHaveAttribute('aria-selected', 'true');
    expect(minutesRow).toHaveAttribute('aria-selected', 'false');
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(1);
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeEnabled();
    expect(del).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
  });

  it('LIB-03 LOAD-04 deleting a selected workscape names it, shows "Deleting…" in flight, soft-deletes it and offers Undo', async () => {
    const u = userEvent.setup();
    serve(live);
    let finish = (): void => {
      /* replaced once deleteDocument is called */
    };
    vi.mocked(docs.deleteDocument).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    // LIB-D9: a reversible action goes straight through; the confirmation is the toast with Undo.
    await u.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(docs.deleteDocument).toHaveBeenCalledWith(everest.id);
    });
    // LOAD-04: the action in flight keeps its button, switches to the participle, is busy.
    const inFlight = screen.getByRole('button', { name: 'Deleting…' });
    expect(inFlight).toHaveAttribute('aria-busy', 'true');
    finish();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent('“Everest trek” moved to Recently Deleted');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Undo is available');
    await u.click(undo);
    await waitFor(() => {
      expect(docs.recoverDocument).toHaveBeenCalledWith(everest.id);
    });
    // Undo is one shot: the toast closes with it.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });
  });

  it('LIB-04 a search with no matches says "No workscapes match"', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.type(screen.getByLabelText('Search workscapes'), 'quarterly');
    expect(screen.getByRole('heading', { name: 'No workscapes match' })).toBeInTheDocument();
  });

  it('LIB-03 LIB-04 a search that hides the selected row drops the selection: the count stays honest and the toolbar cannot act on an invisible row', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    const everestRow = (await screen.findByText('Everest trek')).closest('tr')!;
    await u.click(everestRow);
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
    const openButton = screen.getByRole('button', { name: 'Open' });
    expect(openButton).toBeEnabled();

    const search = screen.getByLabelText('Search workscapes');
    await u.type(search, 'zzz');
    expect(screen.getByRole('heading', { name: 'No workscapes match' })).toBeInTheDocument();
    expect(screen.queryByText(/of 0 selected/)).not.toBeInTheDocument();
    expect(screen.getByText('0 items')).toBeInTheDocument();
    for (const name of ['Open', 'Participants'])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');

    // Narrowing to the selected row keeps it selected; clearing after it was hidden does not
    // resurrect a selection the user never saw.
    await u.clear(search);
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.queryAllByRole('row', { selected: true })).toHaveLength(0);
    await u.click(screen.getByText('Everest trek').closest('tr')!);
    await u.type(search, 'ever');
    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
    expect(openButton).toBeEnabled();
  });

  it('LIB-05 Browse sorts by Name or Date and the choice persists per user', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/?view=browse']);
    await screen.findByText('Everest trek');
    const names = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent);
    expect(names()[0]).toContain('Board minutes');
    await u.click(screen.getByRole('radio', { name: 'Date' }));
    expect(names()[0]).toContain('Board minutes'); // newest first: 10 Sep before 1 Sep
    expect(localStorage.getItem('gede.librarySort.sub-1')).toBe('date');
    await u.click(screen.getByRole('radio', { name: 'Name' }));
    expect(localStorage.getItem('gede.librarySort.sub-1')).toBe('name');
    expect(screen.queryByRole('radio', { name: 'Date' })).toBeInTheDocument();
    // Recents never offers a sort.
    await u.click(screen.getByRole('button', { name: 'Recents' }));
    expect(screen.queryByRole('radio', { name: 'Date' })).not.toBeInTheDocument();
  });

  it('LIB-05 the persisted sort is read back for the user', async () => {
    localStorage.setItem('gede.librarySort.sub-1', 'date');
    serve(live);
    renderRoutes(routes, ['/?view=browse']);
    await screen.findByText('Everest trek');
    expect(screen.getByRole('radio', { name: 'Date' })).toHaveAttribute('aria-checked', 'true');
  });

  it('LIB-07 Participants opens a sheet listing everyone with permission; the owner is labelled and cannot be removed', async () => {
    const u = userEvent.setup();
    serve(live);
    // The service keys people by its own user id (`u1`, as GET /me reports), never the Cognito sub.
    vi.mocked(docs.getDocumentShares).mockResolvedValue({
      owner: { id: 'u1', name: 'Meena', email: 'meena@1cloudhub.com' },
      participants: [
        {
          userId: 'u3',
          name: 'Akshaya A',
          email: 'akshaya@1cloudhub.com',
          permission: 'edit',
          source: 'invite',
          invitedBy: 'u1',
        },
      ],
      linkAccess: 'none',
    });
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    await u.click(screen.getByRole('button', { name: 'Participants' }));
    const sheet = await screen.findByRole('dialog', { name: 'Participants' });
    expect(sheet).toHaveAttribute('data-variant', 'sheet');
    expect(docs.getDocumentShares).toHaveBeenCalledWith(everest.id, expect.anything());
    const list = await within(sheet).findByRole('list', { name: 'People with access' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Meena (you)');
    expect(items[0]).toHaveTextContent('Owner');
    expect(within(items[0]!).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Akshaya A');
    expect(items[1]).toHaveTextContent('Can make changes');
    const remove = within(items[1]!).getByRole('button', { name: 'Remove Akshaya A' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Removing people is not available yet');
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('LIB-07 MENU-05 the sheet returns focus to the toolbar button, or to the row when opened from its menu', async () => {
    const u = userEvent.setup();
    serve(live);
    vi.mocked(docs.getDocumentShares).mockResolvedValue({
      owner: { id: 'u1', name: 'Meena', email: 'meena@1cloudhub.com' },
      participants: [],
      linkAccess: 'none',
    });
    renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Everest trek')).closest('tr')!;
    await u.click(row);
    const participants = screen.getByRole('button', { name: 'Participants' });
    await u.click(participants);
    await screen.findByRole('dialog', { name: 'Participants' });
    await u.keyboard('{Escape}');
    await waitFor(() => {
      expect(participants).toHaveFocus();
    });
    await u.click(screen.getByRole('button', { name: 'More actions for Everest trek' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Participants' }));
    await screen.findByRole('dialog', { name: 'Participants' });
    await u.keyboard('{Escape}');
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('LIB-D8 MENU-05 the Delete All confirmation returns focus to the button that opened it', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan] });
    renderRoutes(routes, ['/?view=deleted']);
    await screen.findByText('Old plan');
    const deleteAll = screen.getByRole('button', { name: 'Delete All' });
    await u.click(deleteAll);
    await screen.findByRole('alertdialog', { name: 'Permanently delete 1 workscape?' });
    await u.keyboard('{Escape}');
    await waitFor(() => {
      expect(deleteAll).toHaveFocus();
    });
    expect(docs.deleteAllDocuments).not.toHaveBeenCalled();
  });

  it('LIB-07 a person without a display name is shown by email, never an invented name', async () => {
    const u = userEvent.setup();
    serve(live);
    vi.mocked(docs.getDocumentShares).mockResolvedValue({
      owner: { id: 'u1', name: null, email: 'meena@1cloudhub.com' },
      participants: [
        {
          userId: 'u5',
          name: null,
          email: 'vijay@1cloudhub.com',
          permission: 'view',
          source: 'invite',
          invitedBy: 'u1',
        },
      ],
      linkAccess: 'edit',
    });
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    await u.click(screen.getByRole('button', { name: 'Participants' }));
    const list = await screen.findByRole('list', { name: 'People with access' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('meena@1cloudhub.com (you)');
    expect(items[1]).toHaveTextContent('vijay@1cloudhub.com');
    expect(
      within(items[1]!).getByRole('button', { name: 'Remove vijay@1cloudhub.com' }),
    ).toBeDisabled();
    expect(screen.getByText('Anyone with the link can make changes')).toBeInTheDocument();
  });

  it('LIB-01 a sharer without a display name groups under "Shared with me"', async () => {
    serve({ shared: [{ ...minutes, sharedBy: { id: 'sub-2', name: null } }] });
    renderRoutes(routes, ['/?view=shared']);
    expect(await screen.findByRole('rowheader', { name: 'Shared with me' })).toBeInTheDocument();
    const row = screen.getByText('Board minutes').closest('tr')!;
    expect(within(row).getByText('Shared with me')).toBeInTheDocument();
  });

  it('LIB-07 a participants list the service cannot serve yet says so and offers Retry', async () => {
    const u = userEvent.setup();
    serve(live);
    vi.mocked(docs.getDocumentShares).mockRejectedValue(new ApiError(404, 'x', 'req-42'));
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    await u.click(screen.getByRole('button', { name: 'More actions for Everest trek' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Participants' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The participant list is not available yet (ref req-42).');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('LIB-08 Recently Deleted: empty reads "No items" with Recover All and Delete All disabled', async () => {
    serve(live);
    renderRoutes(routes, ['/?view=deleted']);
    expect(await screen.findByRole('heading', { name: 'No items' })).toBeInTheDocument();
    expect(docs.listDocuments).toHaveBeenCalledWith('deleted');
    expect(screen.getByRole('button', { name: 'Recover All' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete All' })).toBeDisabled();
  });

  it('LIB-08 Recover, Recover All and Delete All call the service; Delete All is confirmed first', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan] });
    renderRoutes(routes, ['/?view=deleted']);
    const row = (await screen.findByText('Old plan')).closest('tr')!;
    expect(within(row).getByText('Sep 5, 2026')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Deleted' })).toBeInTheDocument();
    await u.click(row);
    await u.click(screen.getByRole('button', { name: 'Recover' }));
    await waitFor(() => {
      expect(docs.recoverDocument).toHaveBeenCalledWith(oldPlan.id);
    });
    await u.click(screen.getByRole('button', { name: 'Recover All' }));
    await waitFor(() => {
      expect(docs.recoverAllDocuments).toHaveBeenCalled();
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Recovered 1 workscape');
    await u.click(screen.getByRole('button', { name: 'Delete All' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Permanently delete 1 workscape?',
    });
    await u.click(within(dialog).getByRole('button', { name: 'Delete All' }));
    await waitFor(() => {
      expect(docs.deleteAllDocuments).toHaveBeenCalled();
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Deleted permanently — this one cannot be undone',
    );
  });

  it('LIB-08 recovering a workscape the service no longer holds in Recently Deleted (409) says so', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan] });
    vi.mocked(docs.recoverDocument).mockRejectedValueOnce(new ApiError(409, 'x', 'req-11'));
    renderRoutes(routes, ['/?view=deleted']);
    await u.click((await screen.findByText('Old plan')).closest('tr')!);
    await u.click(screen.getByRole('button', { name: 'Recover' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Could not recover Old plan');
    expect(banner).toHaveTextContent('It is no longer in Recently Deleted (ref req-11).');
  });

  it('LIB-08 an action the service does not offer yet degrades to a banner naming the reason, never fake success', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan] });
    vi.mocked(docs.recoverAllDocuments).mockRejectedValueOnce(new ApiError(404, 'x', 'req-7'));
    renderRoutes(routes, ['/?view=deleted']);
    await screen.findByText('Old plan');
    await u.click(screen.getByRole('button', { name: 'Recover All' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Could not recover the deleted workscapes');
    expect(banner).toHaveTextContent(
      'This action is not available on the service yet (ref req-7).',
    );
    await u.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('LIB-D1 LIB-D2 the fourth slot reads Delete for a workscape nobody else holds and Archive, with the tooltip, once it has been shared; the row menu matches', async () => {
    const u = userEvent.setup();
    serve({ recents: [everest, trek], browse: [everest, trek], shared: [trek] });
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toHaveAttribute('data-mode', 'delete');
    act(() => {
      del.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Delete');

    await u.click(screen.getByText('Shared trek').closest('tr')!);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(archive).toBeEnabled();
    expect(archive).not.toHaveAttribute('aria-disabled');
    act(() => {
      archive.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Archive — shared workscapes cannot be deleted',
    );
    await u.click(screen.getByRole('button', { name: 'More actions for Shared trek' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    await u.keyboard('{Escape}');
  });

  it('LIB-D3 LIB-D9 Archive calls the service, confirms that participants keep their access, and Undo unarchives through the API', async () => {
    const u = userEvent.setup();
    serve({ recents: [everest, trek], browse: [everest, trek], shared: [trek] });
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Shared trek')).closest('tr')!);
    await u.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(docs.archiveDocument).toHaveBeenCalledWith(trek.id);
    });
    expect(docs.deleteDocument).not.toHaveBeenCalled();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent(
      '“Shared trek” archived — participants keep their access',
    );
    await u.click(undo);
    await waitFor(() => {
      expect(docs.unarchiveDocument).toHaveBeenCalledWith(trek.id);
    });
  });

  it('LIB-D6 the sidebar carries Archived between Shared and Recently Deleted; the view lists archived workscapes newest first with a per-row Unarchive, and Undo re-archives', async () => {
    const u = userEvent.setup();
    serve({ ...live, archived: [archivedTrek] });
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    const nav = screen.getByRole('navigation', { name: 'Library views' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Recents', 'Browse', 'Shared', 'Archived', 'Recently Deleted']);
    await u.click(within(nav).getByRole('button', { name: 'Archived' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Archived' })).toBeInTheDocument();
    expect(docs.listDocuments).toHaveBeenCalledWith('archived');
    const row = (await screen.findByText('Archived trek')).closest('tr')!;
    expect(screen.getByRole('columnheader', { name: 'Archived' })).toBeInTheDocument();
    expect(within(row).getByText('Sep 8, 2026')).toBeInTheDocument();
    // LIB-D6: each row carries Unarchive, before any selection.
    const rowUnarchive = within(row).getByRole('button', { name: 'Unarchive Archived trek' });
    await u.click(rowUnarchive);
    await waitFor(() => {
      expect(docs.unarchiveDocument).toHaveBeenCalledWith(archivedTrek.id);
    });
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent('“Archived trek” unarchived');
    await u.click(undo);
    await waitFor(() => {
      expect(docs.archiveDocument).toHaveBeenCalledWith(archivedTrek.id);
    });
    // The toolbar has the same verb for the selection, and no Delete or Archive.
    await u.click(row);
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('LIB-D6 Archived empty state reads "Nothing archived"', async () => {
    serve(live);
    renderRoutes(routes, ['/?view=archived']);
    expect(await screen.findByRole('heading', { name: 'Nothing archived' })).toBeInTheDocument();
  });

  it('LIB-D7 LIB-D9 Recently Deleted offers per-item Recover on every row; Recover and Recover All confirm with Undo that deletes again', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan] });
    renderRoutes(routes, ['/?view=deleted']);
    const row = (await screen.findByText('Old plan')).closest('tr')!;
    await u.click(within(row).getByRole('button', { name: 'Recover Old plan' }));
    await waitFor(() => {
      expect(docs.recoverDocument).toHaveBeenCalledWith(oldPlan.id);
    });
    let undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent('“Old plan” recovered');
    await u.click(undo);
    await waitFor(() => {
      expect(docs.deleteDocument).toHaveBeenCalledWith(oldPlan.id);
    });
    vi.mocked(docs.recoverAllDocuments).mockResolvedValueOnce({
      count: 2,
      ids: [oldPlan.id, everest.id],
    });
    await u.click(screen.getByRole('button', { name: 'Recover All' }));
    undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent('Recovered 2 workscapes');
    await u.click(undo);
    await waitFor(() => {
      expect(docs.deleteDocument).toHaveBeenCalledWith(everest.id);
    });
    expect(docs.deleteDocument).toHaveBeenCalledTimes(3);
  });

  it('LIB-D8 LIB-D9 Delete All is an alert dialog that says it is permanent; the toast says it cannot be undone and carries no Undo', async () => {
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan, { ...everest, deletedAt: '2026-09-06T00:00:00Z' }] });
    vi.mocked(docs.deleteAllDocuments).mockResolvedValueOnce(2);
    renderRoutes(routes, ['/?view=deleted']);
    await screen.findByText('Old plan');
    await u.click(screen.getByRole('button', { name: 'Delete All' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Permanently delete 2 workscapes?',
    });
    expect(dialog).toHaveAccessibleDescription(
      'Everything in Recently Deleted is removed for good. This cannot be undone.',
    );
    // Focus starts on Cancel; the destructive verb is never the default.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await u.click(within(dialog).getByRole('button', { name: 'Delete All' }));
    await waitFor(() => {
      expect(docs.deleteAllDocuments).toHaveBeenCalled();
    });
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Deleted 2 workscapes permanently — this cannot be undone');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('LIB-D10 the guided sample is flagged Sample; its action is disabled with the explanatory tooltip in the toolbar and the row menu', async () => {
    const u = userEvent.setup();
    serve({ recents: [sample, everest], browse: [sample, everest] });
    renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Q3 Delivery — Guided sample')).closest('tr')!;
    expect(within(row).getByText('Sample')).toBeInTheDocument();
    await u.click(row);
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAttribute('data-mode', 'sample');
    act(() => {
      del.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'The guided sample cannot be deleted',
    );
    await u.click(del);
    expect(docs.deleteDocument).not.toHaveBeenCalled();
    expect(docs.archiveDocument).not.toHaveBeenCalled();
    await u.click(
      screen.getByRole('button', { name: 'More actions for Q3 Delivery — Guided sample' }),
    );
    const item = await screen.findByRole('menuitem', { name: /Delete/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'The guided sample cannot be deleted');
    await u.keyboard('{Escape}');
  });

  it('LIB-D2 a Delete the service refuses (409 shared) is explained in the banner and the view is refreshed', async () => {
    const u = userEvent.setup();
    serve(live);
    vi.mocked(docs.deleteDocument).mockRejectedValueOnce(
      new ApiError(409, 'x', 'req-42', { error: { code: 'shared', message: 'm', ref: 'r' } }),
    );
    renderRoutes(routes, ['/']);
    await u.click((await screen.findByText('Everest trek')).closest('tr')!);
    const before = vi.mocked(docs.listDocuments).mock.calls.length;
    await u.click(screen.getByRole('button', { name: 'Delete' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Could not delete Everest trek');
    expect(banner).toHaveTextContent(
      'It has been shared, so it can be archived but not deleted (ref req-42).',
    );
    await waitFor(() => {
      expect(vi.mocked(docs.listDocuments).mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('LIB-D11 archive and trash are document states: a second client of the same account sees an archive made in the first without a reload', async () => {
    const u = userEvent.setup();
    // Two clients, one account, one service (the fake keeps the state in `store`).
    const store = { browse: [everest, trek], archived: [] as DocumentSummary[] };
    vi.mocked(docs.listDocuments).mockImplementation((view) =>
      Promise.resolve(
        view === 'browse' ? [...store.browse] : view === 'archived' ? [...store.archived] : [],
      ),
    );
    vi.mocked(docs.archiveDocument).mockImplementation((id) => {
      const doc = store.browse.find((d) => d.id === id)!;
      store.browse = store.browse.filter((d) => d.id !== id);
      store.archived = [{ ...doc, archivedAt: '2026-09-12T00:00:00Z' }];
      return Promise.resolve();
    });
    const first = renderRoutes(routes, ['/?view=browse']);
    const second = renderRoutes(routes, ['/?view=browse']);
    const a = within(first.container);
    const b = within(second.container);
    await a.findByText('Shared trek');
    await b.findByText('Shared trek');

    await u.click(a.getByText('Shared trek').closest('tr')!);
    await u.click(a.getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(a.queryByText('Shared trek')).not.toBeInTheDocument();
    });
    // Still on screen in the second client until its next read…
    expect(b.getByText('Shared trek')).toBeInTheDocument();
    // …which the tab coming back to the front triggers (the cadence does the same, refresh.test.ts).
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(b.queryByText('Shared trek')).not.toBeInTheDocument();
    });
    expect(b.getByText('Everest trek')).toBeInTheDocument();
    first.unmount();
    second.unmount();
  });

  it('RESP-02 below 768 px the library is read-only: no delete, archive, recover or purge affordance renders', async () => {
    installMatchMedia((q) => q.includes('767.98') || q.includes('899.98') || q.includes('1023.98'));
    const u = userEvent.setup();
    serve({ ...live, deleted: [oldPlan], archived: [archivedTrek] });
    const { unmount } = renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Everest trek')).closest('tr')!;
    await u.click(row);
    expect(screen.queryByRole('button', { name: /^(Delete|Archive)$/ })).not.toBeInTheDocument();
    expect(screen.getByText('View only on phone')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'More actions for Everest trek' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['OpenEnter', 'Participants']);
    await u.keyboard('{Escape}');
    unmount();
    renderRoutes(routes, ['/?view=deleted']);
    await screen.findByText('Old plan');
    for (const name of ['Recover', 'Recover All', 'Delete All', 'Recover Old plan']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('LIB-09 no per-user quota is shown anywhere in the library', async () => {
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    expect(screen.queryByText(/quota|storage|GB used|of \d+ ?[GM]B/i)).not.toBeInTheDocument();
  });

  it('LIB-10 below 900 px the sidebar hides behind a control, Kind and Shared columns drop and the date is numeric', async () => {
    installMatchMedia((q) => q.includes('899.98') || q.includes('1023.98'));
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Board minutes')).closest('tr')!;
    expect(screen.queryByRole('button', { name: 'Browse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Kind' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Shared' })).not.toBeInTheDocument();
    expect(within(row).getByText('9/10/26')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Recents', expanded: false });
    await u.click(toggle);
    expect(await screen.findByRole('button', { name: 'Browse' })).toBeInTheDocument();
  });

  it('RESP-05 below 1024 px every library target is at least 44 px', () => {
    const css = readFileSync(resolve(__dirname, 'library.css'), 'utf8');
    const block = /@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/\.gd-lib \.gd-btn[\s\S]*min-height: 2\.75rem/);
    expect(block).toMatch(/\.gd-lib__navitem/);
    expect(block).toMatch(/min-width: 2\.75rem/);
  });

  it('I18N-04 dates and sizes render through Intl for the active locale', async () => {
    localStorage.setItem('gede.locale.sub-1', 'en-GB');
    resetLocaleForTests();
    serve(live);
    renderRoutes(routes, ['/']);
    const row = (await screen.findByText('Board minutes')).closest('tr')!;
    await waitFor(() => {
      expect(within(row).getByText('10 Sept 2026')).toBeInTheDocument();
    });
    expect(document.documentElement.lang).toBe('en-GB');
  });

  it('I18N-05 the account menu picks a locale; it applies to lang at once, persists per user and is sent to the account', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.click(screen.getByRole('button', { name: 'Account: Meena' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitemradio', { name: 'English (United States)' }),
    ).toHaveAttribute('aria-checked', 'true');
    await u.click(within(menu).getByRole('menuitemradio', { name: 'English (India)' }));
    expect(document.documentElement.lang).toBe('en-IN');
    expect(localStorage.getItem('gede.locale.sub-1')).toBe('en-IN');
    expect(localStorage.getItem('gede.locale')).toBe('en-IN');
    expect(me.updateMe).toHaveBeenCalledWith({ locale: 'en-IN' });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Language set to English (India)');
  });

  it('WCAG 3.1.2 every autonym in the locale picker carries its own lang, so தமிழ், हिन्दी and తెలుగు are read in their language', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.click(screen.getByRole('button', { name: 'Account: Meena' }));
    const menu = await screen.findByRole('menu');
    const langOf = (name: string) =>
      within(menu)
        .getByRole('menuitemradio', { name })
        .querySelector('[lang]')
        ?.getAttribute('lang');
    expect(langOf('தமிழ் (India)')).toBe('ta');
    expect(langOf('हिन्दी (India)')).toBe('hi');
    expect(langOf('తెలుగు (India)')).toBe('te');
    expect(langOf('English (United Kingdom)')).toBe('en');
    // Only the autonym is marked; the region stays in the UI language.
    const tamil = within(menu).getByRole('menuitemradio', { name: 'தமிழ் (India)' });
    expect(tamil.querySelector('[lang="ta"]')).toHaveTextContent(/^தமிழ்$/);
  });

  it('I18N-05 the account locale from the server wins over the device on sign-in', async () => {
    vi.mocked(me.getMe).mockResolvedValueOnce({
      id: 'u1',
      sub: 'sub-1',
      email: user.email,
      displayName: 'Meena',
      locale: 'ta-IN',
      tourDoneAt: '2026-09-01T00:00:00.000Z',
      sampleDocumentId: null,
    });
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ta-IN');
    });
    expect(localStorage.getItem('gede.locale.sub-1')).toBe('ta-IN');
  });

  it('AUTH-09 Sign out revokes the session locally and lands on the signed-out screen', async () => {
    const u = userEvent.setup();
    const cognito = await import('../../auth/cognito.js');
    serve(live);
    const { router } = renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    await u.click(screen.getByRole('button', { name: 'Account: Meena' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/signed-out');
    });
    expect(cognito.signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('A11Y-05 the app shell has one polite live region; view changes and selection announce through it', async () => {
    const u = userEvent.setup();
    serve(live);
    renderRoutes(routes, ['/']);
    await screen.findByText('Everest trek');
    const region = screen.getByTestId('live-region');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    await u.click(screen.getByText('Everest trek').closest('tr')!);
    expect(region).toHaveTextContent('Selected Everest trek');
    await u.click(screen.getByRole('button', { name: 'Browse' }));
    expect(region).toHaveTextContent('Browse view');
  });

  it('API failures render the catalogue page (500)', async () => {
    vi.mocked(docs.listDocuments).mockRejectedValue(new ApiError(500, 'x', 'req-9', undefined, 4));
    renderRoutes(routes, ['/']);
    expect(
      await screen.findByRole('heading', { name: 'Something failed on our side' }),
    ).toBeInTheDocument();
  });
});
