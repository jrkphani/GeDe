import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DocumentsApi from '../../api/documents.js';
import type { DocumentSummary } from '../../api/documents.js';
import type * as MeApi from '../../api/me.js';
import { resetLocaleForTests, setLocale } from '../../locale.js';
import { installMatchMedia, phoneMedia } from '../../test/match-media.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';
import * as core from '@gede/core';
import * as Y from 'yjs';

import { tourFlag } from './flag-queue.js';
import {
  reportTourInvite,
  resetTourForTests,
  setTourDocument,
  setTourFindQuery,
  setTourRoute,
  setTourSampleDocumentId,
  startTour,
  tourState,
} from './store.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };
const SAMPLE_ID = '01ARZ3NDEKTSV4RRFFQ69G5SAM';

vi.mock('../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  refreshAccessToken: () => Promise.resolve('tok'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

// Labelled fakes: the `api/documents` and `api/me` client modules are replaced;
// the library screen, the session, the locale store, the router and the tour are real.
vi.mock('../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return { ...actual, listDocuments: vi.fn(), getDocument: vi.fn() };
});
vi.mock('../../api/me.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MeApi>();
  return { ...actual, getMe: vi.fn(), updateMe: vi.fn() };
});

const docs = await import('../../api/documents.js');
const me = await import('../../api/me.js');

const profile = (tourDoneAt: string | null): MeApi.Me => ({
  id: 'u1',
  sub: 'sub-1',
  email: user.email,
  displayName: 'Meena',
  locale: null,
  tourDoneAt,
  sampleDocumentId: SAMPLE_ID,
});

const sample: DocumentSummary = {
  id: SAMPLE_ID,
  title: 'Q3 Delivery — Guided sample',
  kind: 'workscape',
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
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
const everest: DocumentSummary = {
  ...sample,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
  title: 'Everest trek',
  updatedAt: '2026-09-14T10:00:00Z',
  sample: false,
};

function arrive(tourDoneAt: string | null, at = '/') {
  vi.mocked(me.getMe).mockResolvedValue(profile(tourDoneAt));
  vi.mocked(me.updateMe).mockImplementation((patch) =>
    Promise.resolve(profile(patch.tourDone === true ? '2026-09-13T01:00:00.000Z' : null)),
  );
  vi.mocked(docs.listDocuments).mockResolvedValue([everest, sample]);
  return renderRoutes(routes, [at]);
}

/**
 * Drive the store from step 1 to completion the way the document and its
 * features would; `back` is the route the page is really on afterwards.
 */
function completeFromStepOne(back = '/'): void {
  const doc = new Y.Doc();
  core.seedSampleWorkscape(doc);
  const gd = core.openDocument(doc);
  act(() => {
    setTourSampleDocumentId(SAMPLE_ID);
    setTourDocument(gd);
    setTourRoute(`/d/${SAMPLE_ID}`);
  });
  const [deliverables] = core.tablesOnSheet(gd, core.listSheets(gd)[0]!.id);
  const table = core.tableById(gd, deliverables!.id)!;
  act(() => {
    core.commitCellText(gd, table.id, table.rows[1]!, table.columns[5]!.id, '=@Team.Marcus.Role');
    core.createGraphPair(gd, { sheetId: core.listSheets(gd)[0]!.id, tableId: table.id });
    setTourFindQuery(true, 'Blocked');
    reportTourInvite();
    setTourDocument(null);
    setTourRoute(back);
  });
}

const card = () => screen.getByRole('dialog', { name: 'Open the sample workscape' });

describe('TourController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia(false);
    resetLocaleForTests();
    resetTourForTests();
    tourFlag.reset();
  });
  afterEach(() => {
    resetTourForTests();
  });

  it('ONB-02 ONB-09 ONB-01 arriving at the library with the flag unset starts step 1: counter, dots, title, body, amber action, Skip, no Next, no note; the sample row is pinned first and anchored', async () => {
    arrive(null);
    const dialog = await screen.findByRole('dialog', { name: 'Open the sample workscape' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(dialog).toHaveAttribute('data-step', '1');
    expect(within(dialog).getByText('STEP 1 OF 5')).toBeInTheDocument();
    expect(within(dialog).getByText('Step 1 of 5')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.gd-tour__dot')).toHaveLength(5);
    expect(dialog.querySelectorAll('.gd-tour__dot--done')).toHaveLength(1);
    expect(
      within(dialog).getByText(
        'Q3 Delivery sits in every library permanently. Nothing in it is precious.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Double-click “Q3 Delivery — Guided sample”')).toHaveClass(
      'gd-tour__action',
    );
    expect(within(dialog).getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /next/i })).toBeNull();
    expect(dialog.querySelector('.gd-tour__note')).toBeNull();
    // The scrim never takes the pointer (ONB-04, ONB-11).
    const scrim = screen.getByTestId('tour-scrim');
    expect(scrim).toHaveAttribute('data-target', 'sample');
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    expect(scrim).toHaveClass('gd-tour__scrim');
    // jsdom applies no stylesheet: the rule itself is asserted from the source.
    expect(readFileSync(join(__dirname, 'tour.css'), 'utf8')).toMatch(
      /\.gd-tour__scrim \{[^}]*pointer-events: none;/,
    );
    // The sample row is pinned above the newer row and carries the anchor. The list
    // arrives on its own fetch, after the profile that started the tour.
    await screen.findByText('Q3 Delivery — Guided sample');
    const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-id'));
    expect(rows[0]).toHaveAttribute('data-tour', 'sample');
    expect(rows[0]).toHaveTextContent('Q3 Delivery — Guided sample');
    expect(rows[0]).toHaveTextContent('Sample');
    expect(me.updateMe).not.toHaveBeenCalled();
  });

  it('ONB-02 ONB-03 a flag that is set keeps the tour off; the library still shows the help control', async () => {
    arrive('2026-09-01T00:00:00.000Z');
    await screen.findByText('Everest trek');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(tourState()).toEqual({ phase: 'idle' });
  });

  it('ONB-13 on a phone the tour does not run and the flag stays unset', async () => {
    installMatchMedia(phoneMedia);
    arrive(null);
    await screen.findByText('Everest trek');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(me.updateMe).not.toHaveBeenCalled();
    expect(tourState()).toEqual({ phase: 'idle' });
  });

  it('ONB-07 ONB-03 Skip ends the tour for good and sets the account flag', async () => {
    arrive(null);
    await screen.findByRole('dialog', { name: 'Open the sample workscape' });
    await userEvent.click(within(card()).getByRole('button', { name: 'Skip' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(me.updateMe).toHaveBeenCalledWith({ tourDone: true });
    expect(tourState()).toEqual({ phase: 'idle' });
    // The row and every control stay usable — nothing was ever inert.
    expect(screen.getByRole('button', { name: 'New workscape' })).toBeEnabled();
  });

  it('ONB-08 Replay guided tour from the ? help control clears the flag and restarts at step 1, whether or not a tour is running', async () => {
    arrive('2026-09-01T00:00:00.000Z');
    await screen.findByText('Everest trek');
    await userEvent.click(screen.getByRole('button', { name: 'Help' }));
    const menu = await screen.findByRole('menu', { name: 'Help' });
    expect(within(menu).getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Replay guided tour' }));
    expect(
      await screen.findByRole('dialog', { name: 'Open the sample workscape' }),
    ).toHaveAttribute('data-step', '1');
    expect(me.updateMe).toHaveBeenCalledWith({ tourDone: false });
    // Replay again while running: still step 1, no error.
    await userEvent.click(screen.getByRole('button', { name: 'Help' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Replay guided tour' }));
    expect(card()).toHaveAttribute('data-step', '1');
  });

  it('ONB-08 KEYS-01 the help control also opens the keyboard shortcut sheet from the library', async () => {
    arrive('2026-09-01T00:00:00.000Z');
    await screen.findByText('Everest trek');
    await userEvent.click(screen.getByRole('button', { name: 'Help' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('ONB-14 ONB-03 completing step 5 confirms, names the ? in the library, sets the flag and offers Replay', async () => {
    arrive(null);
    await screen.findByRole('dialog', { name: 'Open the sample workscape' });
    // Reach step 5 by satisfying each step through the store's inputs, as the
    // document route and the features would (the detectors are covered in store.test.ts).
    const doc = new Y.Doc();
    core.seedSampleWorkscape(doc);
    const gd = core.openDocument(doc);
    act(() => {
      setTourSampleDocumentId(SAMPLE_ID);
      setTourDocument(gd);
      setTourRoute(`/d/${SAMPLE_ID}`);
    });
    expect(
      await screen.findByRole('dialog', { name: 'Reference a cell in another table' }),
    ).toHaveAttribute('data-placement', 'centre');
    const [deliverables] = core.tablesOnSheet(gd, core.listSheets(gd)[0]!.id);
    const table = core.tableById(gd, deliverables!.id)!;
    act(() => {
      core.commitCellText(gd, table.id, table.rows[1]!, table.columns[5]!.id, '=@Team.Marcus.Role');
    });
    expect(await screen.findByRole('dialog', { name: 'Add a context graph' })).toHaveTextContent(
      'No Numbers equivalent — it is not a chart.',
    );
    act(() => {
      core.createGraphPair(gd, { sheetId: core.listSheets(gd)[0]!.id, tableId: table.id });
    });
    await screen.findByRole('dialog', { name: 'Find across every table' });
    act(() => {
      setTourFindQuery(true, 'Blocked');
    });
    await screen.findByRole('dialog', { name: 'Invite someone by email' });
    act(() => {
      reportTourInvite();
    });
    await waitFor(() => {
      expect(me.updateMe).toHaveBeenCalledWith({ tourDone: true });
    });
    const messages = await screen.findAllByText(
      'All five done. Replay any time from the ? in your library.',
    );
    const toast = messages.map((m) => m.closest('.gd-toast')).find((t) => t !== null);
    expect(toast).toBeDefined();
    expect(toast).toHaveClass('gd-tour__toast');
    expect(
      within(toast as HTMLElement).getByRole('button', { name: 'Replay' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Announced once, by the toast's own region — never also through the app's (A11Y-05).
    expect(screen.getByTestId('live-region')).not.toHaveTextContent(/All five done/);
    act(() => {
      setTourDocument(null);
    });
  });

  it('A11Y-05 ONB-09 only the pending-action line is live: a step change announces the next action, not the whole card', async () => {
    arrive(null);
    const dialog = await screen.findByRole('dialog', { name: 'Open the sample workscape' });
    expect(dialog).not.toHaveAttribute('aria-live');
    const live = dialog.querySelector('[aria-live="polite"]');
    expect(live).toHaveClass('gd-tour__action');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(live).toHaveTextContent('Pending action: Double-click “Q3 Delivery — Guided sample”');
    expect(dialog.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('ONB-08 Replay from the completion toast outside the library goes to the library first, then starts at step 1', async () => {
    const { router } = arrive(null, '/nowhere');
    await screen.findByRole('heading', { level: 1 });
    act(() => {
      startTour();
    });
    completeFromStepOne('/nowhere');
    const replay = await screen.findByRole('button', { name: 'Replay' });
    expect(router.state.location.pathname).toBe('/nowhere');
    await userEvent.click(replay);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(
      await screen.findByRole('dialog', { name: 'Open the sample workscape' }),
    ).toHaveAttribute('data-step', '1');
    await waitFor(() => {
      expect(me.updateMe).toHaveBeenLastCalledWith({ tourDone: false });
    });
  });

  it('ONB-08 ONB-03 Replay then Skip write the flag in order: false, then true, never overlapping', async () => {
    arrive('2026-09-01T00:00:00.000Z');
    await screen.findByText('Everest trek');
    const answers: (() => void)[] = [];
    const seen: boolean[] = [];
    vi.mocked(me.updateMe).mockImplementation(
      (patch) =>
        new Promise((resolve) => {
          seen.push(patch.tourDone === true);
          answers.push(() => {
            resolve(profile(patch.tourDone === true ? '2026-09-13T01:00:00.000Z' : null));
          });
        }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Help' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Replay guided tour' }));
    await userEvent.click(within(card()).getByRole('button', { name: 'Skip' }));
    // Only the Replay write is in flight; Skip waits for its answer.
    expect(seen).toEqual([false]);
    act(() => {
      answers[0]!();
    });
    await waitFor(() => {
      expect(seen).toEqual([false, true]);
    });
    act(() => {
      answers[1]!();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(tourState()).toEqual({ phase: 'idle' });
  });

  it('ONB-12 the card renders in the active locale from the catalogue', async () => {
    arrive(null);
    await screen.findByRole('dialog', { name: 'Open the sample workscape' });
    act(() => {
      setLocale('ta-IN');
    });
    const tamil = await screen.findByRole('dialog', { name: 'மாதிரி workscape-ஐத் திறக்கவும்' });
    expect(within(tamil).getByRole('button', { name: 'தவிர்' })).toBeInTheDocument();
    expect(within(tamil).getByText('படி 1 / 5')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ta-IN');
  });
});
