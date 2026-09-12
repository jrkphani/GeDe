/**
 * The share sheet (SHARE-01), the invitation rows it lists (SHARE-02), the
 * Shared pill (SHARE-05) and the link redeem wrapper, over a mocked shares
 * API. The sync service's own tests prove the permission checks (SHARE-03);
 * here the sheet is checked for what it offers to whom and what it announces.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../api/client.js';
import type * as SharesApi from '../../../api/shares.js';
import { LiveRegion } from '../../../announce.js';
import { RequireAuth, SessionProvider, takeReturnTo, useSession } from '../../../auth/session.js';
import { installMatchMedia } from '../../../test/match-media.js';
import { renderRoutes, withConfig } from '../../../test/helpers.js';
import { LinkRedeem } from './LinkRedeem.js';
import { SharedIndicator } from './SharedIndicator.js';
import { ShareSheet } from './ShareSheet.js';

vi.mock('../../../api/shares.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SharesApi>();
  return {
    ...actual,
    getShareSheet: vi.fn(),
    inviteToDocument: vi.fn(),
    resendInvite: vi.fn(),
    withdrawInvite: vi.fn(),
    acceptInvite: vi.fn(),
    setParticipantPermission: vi.fn(),
    removeParticipant: vi.fn(),
    setLinkAccess: vi.fn(),
    redeemLink: vi.fn(),
    stopSharing: vi.fn(),
  };
});
vi.mock('../../../api/me.js', () => ({
  getMe: vi.fn(),
  updateMe: vi.fn(() => Promise.resolve()),
  bindVerifiedEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../auth/cognito.js', () => ({
  currentUser: vi.fn(),
  idToken: vi.fn(() => Promise.resolve('id.token.value')),
  onAuthEvent: vi.fn(() => () => undefined),
  signOutLocal: vi.fn(() => Promise.resolve()),
}));
const shares = await import('../../../api/shares.js');
const meApi = await import('../../../api/me.js');
const cognito = await import('../../../auth/cognito.js');

const ID = '6f1b2c3d-0000-4000-8000-00000000abcd';
const OWNER = { id: 'u-owner', name: 'Meena', email: 'meena@1cloudhub.com' };
const SEMBIAN = {
  userId: 'u-sembian',
  name: 'Sembian V',
  email: 'sembian@1cloudhub.com',
  permission: 'edit' as const,
  invitedBy: 'u-owner',
  source: 'invite' as const,
};
const PENDING = {
  id: 'inv-1',
  email: 'akshaya@example.com',
  permission: 'view' as const,
  invitedBy: 'u-owner',
  expiresAt: '2026-09-26T00:00:00.000Z',
};

function sheet(overrides: Partial<SharesApi.ShareSheet> = {}): SharesApi.ShareSheet {
  return {
    owner: OWNER,
    participants: [SEMBIAN],
    invites: [PENDING],
    linkAccess: 'none',
    linkToken: null,
    permission: 'owner',
    callerId: OWNER.id,
    ...overrides,
  };
}

function Harness({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <>
      <LiveRegion />
      <ShareSheet
        docId={ID}
        title="Everest trek"
        open
        onOpenChange={() => undefined}
        readOnly={readOnly}
      />
    </>
  );
}

describe('ShareSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia(false);
    vi.mocked(shares.getShareSheet).mockResolvedValue(sheet());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SHARE-01 LIB-07 opens one sheet with who can access, permission, the invite field, the people list with per-person permission and remove, copy link and stop sharing', async () => {
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    expect(dialog).toHaveAttribute('data-variant', 'sheet');
    expect(
      await within(dialog).findByRole('combobox', { name: 'Who can access' }),
    ).toHaveTextContent('Only people you invite');
    expect(within(dialog).getByRole('combobox', { name: 'Permission' })).toHaveTextContent(
      'Can make changes',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Add people by email' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Invite' })).toBeVisible();
    const list = within(dialog).getByRole('list', { name: 'People with access' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Meena (you)');
    expect(rows[0]).toHaveTextContent('Owner');
    expect(
      within(rows[1]!).getByRole('combobox', { name: 'Permission for Sembian V' }),
    ).toHaveTextContent('Can make changes');
    expect(within(rows[1]!).getByRole('button', { name: 'Remove Sembian V' })).toBeEnabled();
    expect(rows[2]).toHaveTextContent('akshaya@example.com');
    expect(rows[2]).toHaveTextContent(/Invited · expires/);
    expect(rows[2]).toHaveTextContent('View only');
    expect(
      within(rows[2]!).getByRole('button', { name: 'Withdraw invitation to akshaya@example.com' }),
    ).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeVisible();
    // Voice: verbs on buttons, no exclamation marks anywhere.
    expect(dialog.textContent).not.toContain('!');
  });

  it('SHARE-02 Invite sends the address at the chosen permission, announces the outcome and refreshes the list; a malformed address is refused in place', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.inviteToDocument).mockResolvedValue({
      kind: 'invite',
      created: true,
      delivery: 'sent',
      shares: sheet({
        invites: [PENDING, { ...PENDING, id: 'inv-2', email: 'vijay@example.com' }],
      }),
    });
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const field = await within(dialog).findByRole('textbox', { name: 'Add people by email' });
    await u.type(field, 'not an address');
    await u.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter an email address');
    expect(shares.inviteToDocument).not.toHaveBeenCalled();

    await u.clear(field);
    await u.type(field, 'vijay@example.com{Enter}');
    await waitFor(() => {
      expect(shares.inviteToDocument).toHaveBeenCalledWith(ID, 'vijay@example.com', 'edit');
    });
    expect(await within(dialog).findByText('vijay@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Invitation sent to vijay@example.com; it is valid for 14 days',
    );
    expect(field).toHaveValue('');
  });

  it('SHARE-01 changing a person’s permission and removing them call the service; the failure of a change is shown, never swallowed', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.setParticipantPermission).mockResolvedValue(
      sheet({ participants: [{ ...SEMBIAN, permission: 'view' }] }),
    );
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const select = await within(dialog).findByRole('combobox', {
      name: 'Permission for Sembian V',
    });
    select.focus();
    await u.keyboard('{Enter}');
    await u.click(await screen.findByRole('option', { name: 'View only' }));
    await waitFor(() => {
      expect(shares.setParticipantPermission).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ userId: 'u-sembian' }),
        'view',
      );
    });
    expect(select).toHaveTextContent('View only');

    vi.mocked(shares.removeParticipant).mockRejectedValueOnce(new Error('offline'));
    await u.click(within(dialog).getByRole('button', { name: 'Remove Sembian V' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('did not save');
    expect(within(dialog).getByRole('button', { name: 'Remove Sembian V' })).toBeEnabled();

    vi.mocked(shares.removeParticipant).mockResolvedValueOnce(undefined);
    vi.mocked(shares.getShareSheet).mockResolvedValueOnce(sheet({ participants: [] }));
    await u.click(within(dialog).getByRole('button', { name: 'Remove Sembian V' }));
    await waitFor(() => {
      expect(
        within(dialog).queryByRole('button', { name: 'Remove Sembian V' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Sembian V no longer has access');
  });

  it('SHARE-01 "Anyone with the link" turns link access on at the sheet permission; Copy link then copies the keyed address and reads "Link copied"', async () => {
    const u = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(shares.setLinkAccess).mockResolvedValue(
      sheet({ linkAccess: 'edit', linkToken: 'tok_abcdefghijklmnop' }),
    );
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const access = await within(dialog).findByRole('combobox', { name: 'Who can access' });
    access.focus();
    await u.keyboard('{Enter}');
    await u.click(await screen.findByRole('option', { name: /Anyone with the link/ }));
    await waitFor(() => {
      expect(shares.setLinkAccess).toHaveBeenCalledWith(ID, 'edit');
    });
    expect(access).toHaveTextContent('Anyone with the link');
    const copy = within(dialog).getByRole('button', { name: 'Copy link' });
    await u.click(copy);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/d/${ID}?k=tok_abcdefghijklmnop`,
      );
    });
    expect(within(dialog).getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Link copied');
  });

  it('SHARE-01 Stop sharing asks once inside the sheet, then removes everyone and announces it', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.stopSharing).mockResolvedValue(
      sheet({ participants: [], invites: [], linkAccess: 'none' }),
    );
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    await u.click(await within(dialog).findByRole('button', { name: 'Stop sharing' }));
    const confirm = within(dialog).getByRole('group', { name: 'Stop sharing Everest trek?' });
    expect(confirm).toHaveTextContent('Everyone listed loses access');
    expect(shares.stopSharing).not.toHaveBeenCalled();
    await u.click(within(confirm).getByRole('button', { name: 'Keep sharing' }));
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    await u.click(
      within(within(dialog).getByRole('group')).getByRole('button', { name: 'Stop sharing' }),
    );
    await waitFor(() => {
      expect(shares.stopSharing).toHaveBeenCalledWith(ID);
    });
    expect(await within(dialog).findByText('Only you, so far.')).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Sharing stopped');
  });

  it('SHARE-03 an editor may invite but not change permissions, remove, set the link or stop sharing; a viewer sees names only', async () => {
    vi.mocked(shares.getShareSheet).mockResolvedValueOnce(
      sheet({ permission: 'edit', callerId: SEMBIAN.userId }),
    );
    const { unmount } = render(<Harness />);
    let dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    expect(
      await within(dialog).findByRole('textbox', { name: 'Add people by email' }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Who can access' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText('Only people you invite')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Sembian V (you)')).toBeInTheDocument();
    unmount();

    // A viewer receives no emails; "(you)" still matches through callerId (review of #76).
    vi.mocked(shares.getShareSheet).mockResolvedValueOnce(
      sheet({
        permission: 'view',
        invites: [],
        linkToken: null,
        callerId: 'u-viewer',
        owner: { ...OWNER, email: null },
        participants: [
          { ...SEMBIAN, email: null },
          {
            userId: 'u-viewer',
            name: 'Vijay',
            email: null,
            permission: 'view',
            invitedBy: 'u-owner',
            source: 'link',
          },
        ],
      }),
    );
    render(<Harness />);
    dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    await within(dialog).findByRole('list', { name: 'People with access' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeVisible();
    expect(within(dialog).getByText('Vijay (you)')).toBeInTheDocument();
    expect(within(dialog).getByText('Via link')).toBeInTheDocument();
  });

  it('SHARE-02 a repeated invitation is announced as already pending, not as sent (review of #76)', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.inviteToDocument).mockResolvedValue({
      kind: 'invite',
      created: false,
      delivery: 'skipped',
      shares: sheet(),
    });
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const field = await within(dialog).findByRole('textbox', { name: 'Add people by email' });
    await u.type(field, 'akshaya@example.com{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent(
        'akshaya@example.com already has a pending invitation',
      );
    });
  });

  it('SHARE-02 ONB-05 an invitation whose mail was refused is saved: the sheet says so with Resend, the row reads "email not sent", the tour is told, and Resend reports the new delivery (#121)', async () => {
    const u = userEvent.setup();
    const created = { ...PENDING, id: 'inv-9', email: 'nobody@example.invalid' };
    vi.mocked(shares.inviteToDocument).mockResolvedValue({
      kind: 'invite',
      created: true,
      delivery: 'failed',
      shares: sheet({ invites: [PENDING, created] }),
    });
    const tourStore = await import('../../tour/store.js');
    const reported = vi.spyOn(tourStore, 'reportTourInvite');
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const field = await within(dialog).findByRole('textbox', { name: 'Add people by email' });
    await u.type(field, 'nobody@example.invalid{Enter}');
    const notice = await within(dialog).findByTestId('share-mail-failed');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(
      'Invitation saved — the email could not be sent; share the link or try again (nobody@example.invalid)',
    );
    // Not an error on the field: the invitation exists.
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).toHaveValue('');
    expect(within(dialog).getByText('Invited · email not sent')).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Invitation saved');
    // ONB-05 step 5: the action is the invitation, not the mail.
    expect(reported).toHaveBeenCalledTimes(1);

    // Resend: the same invitation, sent again; a second refusal is reported the same way.
    vi.mocked(shares.resendInvite).mockResolvedValueOnce({
      delivery: 'failed',
      shares: sheet({ invites: [PENDING, created] }),
    });
    await u.click(within(notice).getByRole('button', { name: 'Resend' }));
    await waitFor(() => {
      expect(shares.resendInvite).toHaveBeenCalledWith(ID, 'inv-9');
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'The email to nobody@example.invalid could not be sent again; share the link instead',
    );
    vi.mocked(shares.resendInvite).mockResolvedValueOnce({
      delivery: 'sent',
      shares: sheet({ invites: [PENDING, created] }),
    });
    await u.click(
      within(dialog).getByRole('button', { name: 'Resend invitation to nobody@example.invalid' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent(
        'Invitation sent again to nobody@example.invalid',
      );
    });
    expect(within(dialog).queryByTestId('share-mail-failed')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Invited · email not sent')).not.toBeInTheDocument();
    reported.mockRestore();
  });

  it('SHARE-02 a failed invitation request is shown on the field (aria-invalid, described by the message) with the ref, and the tour is not told (#121)', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.inviteToDocument).mockRejectedValue(
      new ApiError(429, '429 Too Many Requests', 'req-1234567', {
        error: {
          code: 'too_many_requests',
          message: 'Too many invitations; try again in 60 seconds',
        },
      }),
    );
    const tourStore = await import('../../tour/store.js');
    const reported = vi.spyOn(tourStore, 'reportTourInvite');
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    const field = await within(dialog).findByRole('textbox', { name: 'Add people by email' });
    await u.type(field, 'late@example.com{Enter}');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Too many invitations; try again in 60 seconds (ref req-12).');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);
    expect(field).toHaveValue('late@example.com');
    expect(reported).not.toHaveBeenCalled();
    reported.mockRestore();
  });

  it('RESP-02 on phone the sheet is read-only: who has access and Copy link, no invite field, no permission control, no remove, no stop sharing', async () => {
    render(<Harness readOnly />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    expect(dialog).toHaveAccessibleDescription(/larger screen/);
    await within(dialog).findByRole('list', { name: 'People with access' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /^Remove|^Withdraw/ }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeVisible();
    expect(within(dialog).getByText('Sembian V')).toBeInTheDocument();
  });

  it('SHARE-01 a failed load offers Retry', async () => {
    const u = userEvent.setup();
    vi.mocked(shares.getShareSheet).mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be loaded');
    await u.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByRole('list', { name: 'People with access' })).toBeVisible();
  });
});

describe('SharedIndicator', () => {
  it('SHARE-05 SHARE-04 renders Shared with one avatar per present collaborator in their presence colour, +n beyond four, and nothing when private and alone', () => {
    const { rerender } = render(<SharedIndicator sharedFlag={false} participants={[]} />);
    expect(screen.queryByText('Shared')).not.toBeInTheDocument();
    rerender(<SharedIndicator sharedFlag participants={[]} />);
    expect(screen.getByText('Shared')).toBeInTheDocument();
    const many = [1, 2, 3, 4, 5, 6].map((n) => ({
      userId: `u-${String(n)}`,
      name: `Person ${String(n)}`,
      colour: n as 1 | 2 | 3 | 4 | 5 | 6,
      sheetId: null,
    }));
    rerender(<SharedIndicator sharedFlag={false} participants={[...many, many[0]!]} />);
    const stack = screen.getByLabelText(/Shared · Person 1, Person 2/);
    expect(stack).toHaveTextContent('P1P2P3P4+2');
    expect(screen.getByTitle('Person 3')).toHaveStyle({ '--gd-presence': 'var(--presence-3)' });
  });
});

describe('LinkRedeem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
  });

  function app(path: string) {
    return renderRoutes(
      [
        {
          path: '/d/:id',
          element: (
            <LinkRedeem>
              <Routes>
                <Route path="*" element={<p>shell</p>} />
              </Routes>
            </LinkRedeem>
          ),
        },
      ],
      [path],
    );
  }

  it('SHARE-01 ?k= is presented to the service before the shell opens, then leaves the address bar', async () => {
    vi.mocked(shares.redeemLink).mockResolvedValue(undefined);
    const { router } = app(`/d/${ID}?k=tok_abcdefghijklmnop&sheet=2`);
    await screen.findByText('shell');
    expect(shares.redeemLink).toHaveBeenCalledWith(ID, 'tok_abcdefghijklmnop');
    expect(router.state.location.search).toBe('?sheet=2');
  });

  it('SHARE-02 ?invite= accepts the invitation; a refused token still opens the shell without the token', async () => {
    vi.mocked(meApi.getMe).mockResolvedValue({
      id: 'u',
      sub: 'sub-9',
      email: 'akshaya@example.com',
      displayName: null,
      locale: null,
      tourDoneAt: '2026-09-01T00:00:00.000Z',
      librarySort: null,
      sampleDocumentId: null,
    });
    vi.mocked(shares.acceptInvite).mockRejectedValue(new Error('404'));
    const { router } = app(`/d/${ID}?invite=tok_abcdefghijklmnop`);
    await screen.findByText('shell');
    expect(shares.acceptInvite).toHaveBeenCalledWith(ID, 'tok_abcdefghijklmnop');
    // The profile already carries its address: nothing to bind first.
    expect(meApi.bindVerifiedEmail).not.toHaveBeenCalled();
    expect(router.state.location.search).toBe('');
  });

  it('SHARE-02 a new account opening its invitation binds its verified address before presenting the token, so the conversion never races the session', async () => {
    const order: string[] = [];
    vi.mocked(meApi.getMe).mockResolvedValue({
      id: 'u',
      sub: 'sub-9',
      email: null,
      displayName: null,
      locale: null,
      tourDoneAt: '2026-09-01T00:00:00.000Z',
      librarySort: null,
      sampleDocumentId: null,
    });
    vi.mocked(meApi.bindVerifiedEmail).mockImplementation(() => {
      order.push('bind');
      return Promise.resolve({
        id: 'u',
        sub: 'sub-9',
        email: 'akshaya@example.com',
        displayName: null,
        locale: null,
        tourDoneAt: '2026-09-01T00:00:00.000Z',
        librarySort: null,
        sampleDocumentId: null,
      });
    });
    vi.mocked(shares.acceptInvite).mockImplementation(() => {
      order.push('accept');
      // The binding converted the invitation already; the service says so and the shell opens.
      return Promise.reject(new Error('409'));
    });
    const { router } = app(`/d/${ID}?invite=tok_abcdefghijklmnop`);
    await screen.findByText('shell');
    expect(cognito.idToken).toHaveBeenCalled();
    expect(meApi.bindVerifiedEmail).toHaveBeenCalledWith('id.token.value');
    expect(order).toEqual(['bind', 'accept']);
    expect(router.state.location.search).toBe('');
  });

  it('SHARE-02 a binding that fails does not stop the invitation being presented', async () => {
    vi.mocked(meApi.getMe).mockRejectedValue(new Error('offline'));
    vi.mocked(shares.acceptInvite).mockResolvedValue(undefined);
    app(`/d/${ID}?invite=tok_abcdefghijklmnop`);
    await screen.findByText('shell');
    expect(shares.acceptInvite).toHaveBeenCalledWith(ID, 'tok_abcdefghijklmnop');
  });

  it('SHARE-01 ?k= needs no address: the link is presented without touching the profile', async () => {
    vi.mocked(shares.redeemLink).mockResolvedValue(undefined);
    app(`/d/${ID}?k=tok_abcdefghijklmnop`);
    await screen.findByText('shell');
    expect(meApi.getMe).not.toHaveBeenCalled();
    expect(meApi.bindVerifiedEmail).not.toHaveBeenCalled();
  });

  it('SHARE-01 AUTH-01 a signed-out visitor with ?k= goes through sign-in and comes back to redeem it', async () => {
    vi.mocked(cognito.currentUser).mockResolvedValueOnce(null);
    vi.mocked(meApi.getMe).mockResolvedValue({
      id: 'u',
      sub: 'sub-9',
      email: 'dana@example.com',
      displayName: 'Dana',
      locale: null,
      tourDoneAt: '2026-09-01T00:00:00.000Z',
      librarySort: null,
      sampleDocumentId: null,
    });
    vi.mocked(shares.redeemLink).mockResolvedValue(undefined);
    // What SignIn does once the session is signed in: go where the visitor was headed.
    function FakeSignIn() {
      const { state, refresh } = useSession();
      const navigate = useNavigate();
      useEffect(() => {
        if (state.status === 'signed-in') {
          void navigate(takeReturnTo() ?? '/', { replace: true });
        }
      }, [state.status, navigate]);
      return (
        <button
          type="button"
          onClick={() => {
            vi.mocked(cognito.currentUser).mockResolvedValue({
              sub: 'sub-9',
              email: 'dana@example.com',
              name: 'Dana',
            });
            void refresh();
          }}
        >
          Continue
        </button>
      );
    }
    const { router } = renderRoutes(
      [
        {
          path: '*',
          element: (
            <SessionProvider>
              <Routes>
                <Route path="/sign-in" element={<FakeSignIn />} />
                <Route
                  path="/d/:id"
                  element={
                    <RequireAuth>
                      <LinkRedeem>
                        <p>shell</p>
                      </LinkRedeem>
                    </RequireAuth>
                  }
                />
              </Routes>
            </SessionProvider>
          ),
        },
      ],
      [`/d/${ID}?k=tok_abcdefghijklmnop`],
    );
    const user = userEvent.setup();
    const cont = await screen.findByRole('button', { name: 'Continue' });
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(shares.redeemLink).not.toHaveBeenCalled();

    await user.click(cont);
    await screen.findByText('shell');
    expect(shares.redeemLink).toHaveBeenCalledWith(ID, 'tok_abcdefghijklmnop');
    expect(router.state.location.pathname).toBe(`/d/${ID}`);
    expect(router.state.location.search).toBe('');
  });

  it('SHARE-01 without a token nothing is presented', async () => {
    app(`/d/${ID}`);
    await screen.findByText('shell');
    expect(shares.redeemLink).not.toHaveBeenCalled();
    expect(shares.acceptInvite).not.toHaveBeenCalled();
  });
});
