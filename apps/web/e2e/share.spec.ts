/**
 * The share sheet journey (SHARE-01, SHARE-02, SHARE-05) against the built
 * bundle. Everything outside the browser is a labelled FAKE at the network
 * edge: Cognito (`fakes/cognito`), the documents and sharing REST routes
 * (below, with a small in-memory sheet that the fake mutates the way
 * `services/sync/src/routes/share.ts` does) and the y-websocket room
 * (`fakes/room`). No mail leaves anything: the invitation mail is the
 * service's job and its SES path is proven in the service's own tests.
 */
import type { Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { asPhone, expect, test } from './fixtures/test.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e1';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-1',
  email: 'meena@1cloudhub.com',
  name: 'Meena',
};

const CONFIG = {
  region: SESSION.region,
  userPoolId: SESSION.userPoolId,
  userPoolClientId: SESSION.clientId,
  apiUrl: '/api',
  wsUrl: '/ws',
  appleSignIn: false,
  statusUrl: null,
};

/** The exact shape `services/sync` returns for GET /api/documents/:id. */
const record = {
  id: DOC_ID,
  title: 'Everest trek',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  sharedWithOthers: true,
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

interface FakeSheet {
  owner: { id: string; name: string; email: string };
  participants: {
    userId: string;
    name: string | null;
    email: string;
    permission: 'view' | 'edit';
    invitedBy: string;
    source: 'invite' | 'link';
  }[];
  invites: {
    id: string;
    email: string;
    permission: 'view' | 'edit';
    invitedBy: string;
    expiresAt: string;
    /** #121: null while the service never managed to mail it. */
    mailSentAt: string | null;
  }[];
  linkAccess: 'none' | 'view' | 'edit';
  linkToken: string | null;
  permission: 'owner';
  callerId: string;
}

/** FAKE sharing routes: the shapes of `routes/share.ts`, mutated in memory. */
async function installFakes(page: Page): Promise<{ sheet: FakeSheet; calls: string[] }> {
  const sheet: FakeSheet = {
    owner: { id: SESSION.sub, name: SESSION.name, email: SESSION.email },
    participants: [
      {
        userId: 'e2e-user-2',
        name: 'Sembian V',
        email: 'sembian@1cloudhub.com',
        permission: 'edit',
        invitedBy: SESSION.sub,
        source: 'invite',
      },
    ],
    invites: [],
    linkAccess: 'none',
    linkToken: null,
    permission: 'owner',
    callerId: SESSION.sub,
  };
  const calls: string[] = [];
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({ json: { document: record } }),
  );
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [record] } }));
  await page.route('**/api/me', (route) =>
    route.fulfill({
      json: {
        id: SESSION.sub,
        sub: SESSION.sub,
        email: SESSION.email,
        displayName: SESSION.name,
        locale: 'en-US',
      },
    }),
  );
  await page.route(`**/api/documents/${DOC_ID}/**`, (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname.replace(`/api/documents/${DOC_ID}`, '');
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/shares') return route.fulfill({ json: sheet });
    if (method === 'POST' && path === '/invites') {
      const body = route.request().postDataJSON() as { email: string; permission: 'view' | 'edit' };
      // #121: an address SES refuses (the sandbox) is saved with `delivery: 'failed'` and no
      // `mailSentAt`, as the service persists it.
      const delivery = body.email.endsWith('.invalid') ? 'failed' : 'sent';
      sheet.invites.push({
        id: `inv-${String(sheet.invites.length + 1)}`,
        email: body.email,
        permission: body.permission,
        invitedBy: SESSION.sub,
        expiresAt: '2026-09-26T00:00:00.000Z',
        mailSentAt: delivery === 'sent' ? '2026-09-13T00:00:00.000Z' : null,
      });
      return route.fulfill({
        status: 201,
        json: { kind: 'invite', created: true, delivery, shares: sheet },
      });
    }
    const resent = /^\/invites\/(inv-\d+)\/resend$/.exec(path);
    if (method === 'POST' && resent !== null) {
      const invite = sheet.invites.find((i) => i.id === resent[1]);
      if (invite) invite.mailSentAt = '2026-09-13T00:01:00.000Z';
      return route.fulfill({ status: 200, json: { delivery: 'sent', shares: sheet } });
    }
    if (method === 'PATCH' && path === '/link') {
      const body = route.request().postDataJSON() as { access: FakeSheet['linkAccess'] };
      if (sheet.linkAccess === 'none' && body.access !== 'none') sheet.linkToken = 'e2e_link_token';
      sheet.linkAccess = body.access;
      return route.fulfill({
        json: { ...sheet, linkToken: body.access === 'none' ? null : sheet.linkToken },
      });
    }
    if (method === 'PATCH' && path.startsWith('/shares/')) {
      const body = route.request().postDataJSON() as { permission: 'view' | 'edit' };
      const userId = path.slice('/shares/'.length);
      for (const p of sheet.participants) if (p.userId === userId) p.permission = body.permission;
      return route.fulfill({ json: sheet });
    }
    if (method === 'DELETE' && path.startsWith('/shares/')) {
      const userId = path.slice('/shares/'.length);
      sheet.participants = sheet.participants.filter((p) => p.userId !== userId);
      return route.fulfill({ status: 204, body: '' });
    }
    if (method === 'POST' && path === '/stop-sharing') {
      sheet.participants = [];
      sheet.invites = [];
      sheet.linkAccess = 'none';
      return route.fulfill({ json: { ...sheet, linkToken: null } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Nothing at this address', ref: 'e2e' } },
    });
  });
  const room = new FakeRoom({});
  await room.install(page);
  return { sheet, calls };
}

async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

/** The sheet's 300 ms enter motion blends colours; axe must see it settled. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.gd-dialog, .gd-dialog__overlay')).every((el) =>
      el.getAnimations().every((animation) => animation.playState === 'finished'),
    ),
  );
}

for (const width of [1024, 1440]) {
  test(`SHARE-01 SHARE-05 at ${String(width)}: Share opens one sheet; invite, permission, remove, link and stop sharing reach the service; the row shows Shared; the sheet passes axe`, async ({
    page,
    checkA11y,
  }) => {
    const { sheet, calls } = await installFakes(page);
    await page.setViewportSize({ width, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByTestId('shared-indicator')).toHaveText(/Shared/);

    const share = page.getByRole('button', { name: 'Share' });
    await share.click();
    const dialog = page.getByRole('dialog', { name: 'Share Everest trek' });
    await expect(dialog).toBeVisible();
    // Focus lands inside the sheet (WCAG 2.4.3) and the tab order stays within it.
    await expect(dialog.getByRole('combobox', { name: 'Who can access' })).toHaveText(
      'Only people you invite',
    );
    const list = dialog.getByRole('list', { name: 'People with access' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first()).toContainText('Meena (you)');
    await settled(page);
    await checkA11y(`share sheet ${String(width)}`);

    // Invite: Enter in the field sends at the sheet-level permission.
    await dialog.getByRole('textbox', { name: 'Add people by email' }).fill('akshaya@example.com');
    await page.keyboard.press('Enter');
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').nth(2)).toContainText('akshaya@example.com');
    await expect(list.getByRole('listitem').nth(2)).toContainText(/Invited · expires/);
    expect(calls).toContain('POST /invites');
    expect(sheet.invites[0]).toMatchObject({ email: 'akshaya@example.com', permission: 'edit' });
    await expect(page.getByTestId('live-region')).toHaveText(
      /Invitation sent to akshaya@example.com/,
    );

    // SHARE-02 (#121): an invitation whose mail was refused is saved; the sheet says so
    // with Resend, and Resend reports the new delivery.
    await dialog
      .getByRole('textbox', { name: 'Add people by email' })
      .fill('nobody@example.invalid');
    await page.keyboard.press('Enter');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list.getByRole('listitem').nth(3)).toContainText('Invited · email not sent');
    const notice = dialog.getByTestId('share-mail-failed');
    await expect(notice).toContainText(
      'Invitation saved — the email could not be sent; share the link or try again',
    );
    await settled(page);
    await checkA11y(`share sheet mail failed ${String(width)}`);
    await notice.getByRole('button', { name: 'Resend' }).click();
    await expect(page.getByTestId('live-region')).toHaveText(
      /Invitation sent again to nobody@example.invalid/,
    );
    await expect(notice).toHaveCount(0);
    expect(calls).toContain('POST /invites/inv-2/resend');

    // Per-person permission, by keyboard on the Radix select.
    const perm = dialog.getByRole('combobox', { name: 'Permission for Sembian V' });
    await perm.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: 'View only' }).click();
    await expect(perm).toHaveText('View only');
    expect(sheet.participants[0]?.permission).toBe('view');

    // Anyone with the link: the link mode turns on at the sheet permission and Copy link carries the key.
    const access = dialog.getByRole('combobox', { name: 'Who can access' });
    await access.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: /Anyone with the link/ }).click();
    await expect(access).toHaveText('Anyone with the link');
    expect(sheet.linkAccess).toBe('edit');
    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await expect(dialog.getByRole('button', { name: 'Link copied' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${new URL(page.url()).origin}/d/${DOC_ID}?k=e2e_link_token`);
    await settled(page);
    await checkA11y(`share sheet link ${String(width)}`);

    // Remove a person.
    await dialog.getByRole('button', { name: 'Remove Sembian V' }).click();
    await expect(dialog.getByRole('button', { name: 'Remove Sembian V' })).toHaveCount(0);
    expect(calls).toContain('DELETE /shares/e2e-user-2');

    // Stop sharing is confirmed inside the sheet, then everyone goes.
    await dialog.getByRole('button', { name: 'Stop sharing' }).click();
    const confirm = dialog.getByRole('group', { name: 'Stop sharing Everest trek?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(dialog.getByText('Only you, so far.')).toBeVisible();
    expect(calls).toContain('POST /stop-sharing');

    // Escape closes the sheet and focus returns to the Share button (WCAG 2.4.3).
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(share).toBeFocused();
    // Nobody left, nobody present: the Shared pill goes.
    await expect(page.getByTestId('shared-indicator')).toHaveCount(0);
  });
}

test('RESP-02 at 480 the sheet opens read-only: who has access and Copy link, no edit affordance', async ({
  page,
  checkA11y,
}) => {
  await installFakes(page);
  await asPhone(page, 480, 800);
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share Everest trek' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'People with access' })).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
  // RESP-05: every target at least 44 px tall.
  for (const name of ['Copy link', 'Done']) {
    const box = await dialog.getByRole('button', { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await settled(page);
  await checkA11y('share sheet 480');
});
