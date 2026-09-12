/**
 * The share sheet (SHARE-01), the invitation rows it lists (SHARE-02), the
 * Shared pill (SHARE-05) and the link redeem wrapper, over a mocked shares
 * API. The sync service's own tests prove the permission checks (SHARE-03);
 * here the sheet is checked for what it offers to whom and what it announces.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SharesApi from '../../../api/shares.js';
import { LiveRegion } from '../../../announce.js';
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
    withdrawInvite: vi.fn(),
    acceptInvite: vi.fn(),
    setParticipantPermission: vi.fn(),
    removeParticipant: vi.fn(),
    setLinkAccess: vi.fn(),
    redeemLink: vi.fn(),
    stopSharing: vi.fn(),
  };
});
const shares = await import('../../../api/shares.js');

const ID = '6f1b2c3d-0000-4000-8000-00000000abcd';
const OWNER = { id: 'u-owner', name: 'Meena', email: 'meena@1cloudhub.com' };
const SEMBIAN = {
  userId: 'u-sembian',
  name: 'Sembian V',
  email: 'sembian@1cloudhub.com',
  permission: 'edit' as const,
  invitedBy: 'u-owner',
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
    ...overrides,
  };
}

function Harness({
  readOnly = false,
  viewerEmail = OWNER.email,
}: {
  readOnly?: boolean;
  viewerEmail?: string;
}) {
  return (
    <>
      <LiveRegion />
      <ShareSheet
        docId={ID}
        title="Everest trek"
        open
        onOpenChange={() => undefined}
        readOnly={readOnly}
        viewer={{ id: undefined, email: viewerEmail }}
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
    vi.mocked(shares.getShareSheet).mockResolvedValueOnce(sheet({ permission: 'edit' }));
    const { unmount } = render(<Harness viewerEmail={SEMBIAN.email} />);
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

    vi.mocked(shares.getShareSheet).mockResolvedValueOnce(
      sheet({ permission: 'view', invites: [], linkToken: null }),
    );
    render(<Harness viewerEmail="someone@else.example" />);
    dialog = await screen.findByRole('dialog', { name: 'Share Everest trek' });
    await within(dialog).findByRole('list', { name: 'People with access' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeVisible();
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
    vi.mocked(shares.acceptInvite).mockRejectedValue(new Error('404'));
    const { router } = app(`/d/${ID}?invite=tok_abcdefghijklmnop`);
    await screen.findByText('shell');
    expect(shares.acceptInvite).toHaveBeenCalledWith(ID, 'tok_abcdefghijklmnop');
    expect(router.state.location.search).toBe('');
  });

  it('SHARE-01 without a token nothing is presented', async () => {
    app(`/d/${ID}`);
    await screen.findByText('shell');
    expect(shares.redeemLink).not.toHaveBeenCalled();
    expect(shares.acceptInvite).not.toHaveBeenCalled();
  });
});
