import { type Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { asPhone, expect, test } from './fixtures/test.js';

/**
 * Library chrome against the built bundle. Cognito and the documents REST API
 * are labelled FAKES at the network edge (`fakes/cognito`, routes below); the
 * SPA — sign-in, Amplify, the library — runs for real.
 */

const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-1',
  email: 'meena@1cloudhub.com',
  name: 'Meena',
};

const DOC = {
  id: '01J8Z2Q5X0Y3K7N4M6P9R2S5T8',
  title: 'Everest trek',
  kind: 'workscape' as const,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-11T10:00:00Z',
  ownerId: SESSION.sub,
  ownerName: SESSION.name,
  sharedWithOthers: false,
  permission: 'owner' as const,
  sizeBytes: 956000,
  deletedAt: null,
};

/** A row as the LIB-D service lists it (everShared, archivedAt, sample). */
interface FakeDoc {
  id: string;
  title: string;
  kind: 'workscape';
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  ownerName: string;
  sharedWithOthers: boolean;
  permission: 'owner';
  sizeBytes: number;
  deletedAt: string | null;
  archivedAt: string | null;
  everShared: boolean;
  sample: boolean;
  linkAccess: 'none' | 'view' | 'edit';
}

const LIBD_DOCS: FakeDoc[] = [
  { ...DOC, archivedAt: null, everShared: false, sample: false, linkAccess: 'none' },
  {
    ...DOC,
    id: '01J8Z2Q5X0Y3K7N4M6P9R2S5T9',
    title: 'Shared trek',
    updatedAt: '2026-09-10T10:00:00Z',
    sharedWithOthers: true,
    everShared: true,
    archivedAt: null,
    sample: false,
    linkAccess: 'view',
  },
  {
    ...DOC,
    id: '01J8Z2Q5X0Y3K7N4M6P9R2S5TA',
    title: 'Old plan',
    updatedAt: '2026-08-20T10:00:00Z',
    deletedAt: '2026-09-05T00:00:00Z',
    archivedAt: null,
    everShared: false,
    sample: false,
    linkAccess: 'none',
  },
];

/**
 * FAKE documents service for the LIB-D journeys: the same state rules as
 * `services/sync/src/routes/api.ts` (views, archive vs trash, 409 shared,
 * 409 sample), kept in memory for one test. `calls` records every write.
 */
async function installDocumentsFake(page: Page, seed: FakeDoc[]) {
  const docs = seed.map((d) => ({ ...d }));
  const calls: string[] = [];
  const now = () => new Date().toISOString();
  const listing = (view: string) =>
    docs.filter((d) =>
      view === 'deleted'
        ? d.deletedAt !== null
        : view === 'archived'
          ? d.deletedAt === null && d.archivedAt !== null
          : d.deletedAt === null && d.archivedAt === null,
    );
  const error = (status: number, code: string, message: string) => ({
    status,
    json: { error: { code, message, ref: 'e2e' } },
  });
  await page.route('**/api/documents**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname.replace('/api/documents', '');
    if (method === 'GET' && (path === '' || path === '/')) {
      return route.fulfill({
        json: { documents: listing(url.searchParams.get('view') ?? 'recents') },
      });
    }
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/recover-all') {
      const ids = docs.filter((d) => d.deletedAt !== null).map((d) => d.id);
      for (const d of docs) d.deletedAt = null;
      return route.fulfill({ json: { recovered: ids.length, ids } });
    }
    if (method === 'POST' && path === '/delete-all') {
      const gone = docs.filter((d) => d.deletedAt !== null);
      for (const d of gone) docs.splice(docs.indexOf(d), 1);
      return route.fulfill({ json: { deleted: gone.length } });
    }
    const [, id, action] = path.split('/');
    const doc = docs.find((d) => d.id === id);
    if (!doc) return route.fulfill(error(404, 'not_found', 'Nothing at this address'));
    if (method === 'DELETE' && action === undefined) {
      if (doc.sample) {
        return route.fulfill(error(409, 'sample', 'The guided sample cannot be deleted'));
      }
      if (doc.everShared) return route.fulfill(error(409, 'shared', 'Archive it instead'));
      doc.deletedAt = now();
      doc.archivedAt = null;
      return route.fulfill({ status: 204, body: '' });
    }
    if (method === 'POST' && action === 'recover') {
      doc.deletedAt = null;
      return route.fulfill({ json: { document: doc } });
    }
    if (method === 'POST' && action === 'archive') {
      if (doc.sample) {
        return route.fulfill(error(409, 'sample', 'The guided sample cannot be archived'));
      }
      doc.archivedAt = now();
      return route.fulfill({ json: { document: doc } });
    }
    if (method === 'POST' && action === 'unarchive') {
      doc.archivedAt = null;
      return route.fulfill({ json: { document: doc } });
    }
    return route.fulfill(error(404, 'not_found', 'Nothing at this address'));
  });
  return { docs, calls };
}

async function installFakes(page: Page): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        region: SESSION.region,
        userPoolId: SESSION.userPoolId,
        userPoolClientId: SESSION.clientId,
        apiUrl: '/api',
        wsUrl: '/ws',
        appleSignIn: false,
        statusUrl: null,
      },
    }),
  );
  await installFakeCognito(page, SESSION);
  await page.route('**/api/documents?**', (route) => route.fulfill({ json: { documents: [DOC] } }));
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [DOC] } }));
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
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // AUTH-07: the passkey offer follows a code sign-in; decline it whenever it appears.
  const notNow = page.getByRole('button', { name: 'Not now' });
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(/\/$/, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
  await expect(page.getByText(DOC.title)).toBeVisible();
}

test('DS §3 at 1440 px every icon-only control in the library has a hit area of at least 32 × 32 px', async ({
  page,
}) => {
  await installFakes(page);
  await signIn(page);
  await page.getByText(DOC.title).click();
  const short: string[] = [];
  for (const b of await page.locator('.gd-btn--icon-only').all()) {
    if (!(await b.isVisible())) continue;
    const box = (await b.boundingBox())!;
    const name = (await b.getAttribute('aria-label')) ?? '(unnamed)';
    if (box.width < 32 || box.height < 32) short.push(`${name} ${box.width}×${box.height}`);
  }
  // The header "New workscape", the account button and the selected row's "More actions".
  expect(await page.locator('.gd-btn--icon-only:visible').count()).toBeGreaterThanOrEqual(3);
  expect(short, 'icon-only controls under 32 × 32 px').toEqual([]);
});

test('WCAG 3.1.2 the locale picker marks each autonym with its own lang', async ({ page }) => {
  await installFakes(page);
  await signIn(page);
  await page.getByRole('button', { name: `Account: ${SESSION.name}` }).click();
  const items = page.getByRole('menuitemradio');
  await expect(items).toHaveCount(6);
  const langs = await items.evaluateAll((els) =>
    els.map((el) => el.querySelector('[lang]')?.getAttribute('lang') ?? null),
  );
  expect(langs).toEqual(['en', 'en', 'en', 'ta', 'hi', 'te']);
  await expect(page.getByRole('menuitemradio', { name: 'தமிழ் (India)' })).toBeVisible();
});

/** The LIB-D journeys need the stateful documents fake in place of the static list. */
async function installLibDFakes(page: Page, seed: FakeDoc[] = LIBD_DOCS) {
  await installFakes(page);
  await page.unroute('**/api/documents?**');
  await page.unroute('**/api/documents');
  return installDocumentsFake(page, seed);
}

test('LIB-D1 LIB-D5 LIB-D9 delete moves an unshared workscape to Recently Deleted with a toast; Undo recovers it through the service', async ({
  page,
  checkA11y,
}) => {
  const { calls } = await installLibDFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByText(DOC.title).click();
  const del = page.getByRole('button', { name: 'Delete', exact: true });
  await expect(del).toBeEnabled();
  await del.click();
  const toast = page.locator('.gd-toast');
  await expect(toast).toContainText('“Everest trek” moved to Recently Deleted');
  await expect(page.getByRole('row').filter({ hasText: DOC.title })).toHaveCount(0);
  await checkA11y('library-delete-toast');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('row').filter({ hasText: DOC.title })).toBeVisible();
  expect(calls).toEqual([`DELETE /${DOC.id}`, `POST /${DOC.id}/recover`]);
});

test('LIB-D2 LIB-D3 LIB-D6 a shared workscape offers Archive, not Delete; archiving lists it under Archived, where Unarchive returns it', async ({
  page,
  checkA11y,
}) => {
  const { calls } = await installLibDFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByText('Shared trek').click();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  const archive = page.getByRole('button', { name: 'Archive', exact: true });
  await expect(archive).toBeEnabled();
  await archive.focus();
  await expect(page.getByRole('tooltip')).toHaveText(
    'Archive — shared workscapes cannot be deleted',
  );
  await archive.click();
  await expect(page.locator('.gd-toast')).toContainText(
    '“Shared trek” archived — participants keep their access',
  );
  await expect(page.getByRole('row').filter({ hasText: 'Shared trek' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Archived');
  const row = page.getByRole('row').filter({ hasText: 'Shared trek' });
  await expect(row).toBeVisible();
  await checkA11y('library-archived');
  await row.getByRole('button', { name: 'Unarchive Shared trek' }).click();
  await expect(page.locator('.gd-toast')).toContainText('“Shared trek” unarchived');
  await expect(page.getByRole('heading', { name: 'Nothing archived' })).toBeVisible();
  await page.getByRole('button', { name: 'Recents', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Shared trek' })).toBeVisible();
  expect(calls).toEqual([
    `POST /${LIBD_DOCS[1]!.id}/archive`,
    `POST /${LIBD_DOCS[1]!.id}/unarchive`,
  ]);
});

// Dark for this journey (DoD "light and dark checked"): the alert dialog, the
// per-row Recover and the permanent-delete toast go through axe on the dark palette;
// the other LIB-D journeys above and below run light.
test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('LIB-D7 LIB-D8 Recently Deleted: per-row Recover, and Delete All confirmed by an alert dialog that says it is permanent', async ({
    page,
    checkA11y,
  }) => {
    const { calls } = await installLibDFakes(page);
    await page.setViewportSize({ width: 1024, height: 900 });
    await signIn(page);
    await page.getByRole('button', { name: 'Recently Deleted' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Old plan' });
    await expect(row.getByRole('button', { name: 'Recover Old plan' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete All' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Permanently delete 1 workscape?' });
    await expect(dialog).toContainText('This cannot be undone.');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // The dialog's 300 ms enter motion blends colours; axe must see it settled.
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.gd-dialog, .gd-dialog__overlay')).every((el) =>
        el.getAnimations().every((animation) => animation.playState === 'finished'),
      ),
    );
    await checkA11y('library-delete-all-confirm-dark');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(calls).toEqual([]);
    await page.getByRole('button', { name: 'Delete All' }).click();
    await dialog.getByRole('button', { name: 'Delete All' }).click();
    const toast = page.locator('.gd-toast');
    await expect(toast).toContainText('Deleted permanently — this one cannot be undone');
    await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No items' })).toBeVisible();
    await checkA11y('library-delete-all-toast-dark');
    expect(calls).toEqual(['POST /delete-all']);
  });
});

test('LIB-D10 the guided sample cannot be deleted or archived: the action is disabled with the reason', async ({
  page,
}) => {
  const sample: FakeDoc = {
    ...LIBD_DOCS[0]!,
    id: '01J8Z2Q5X0Y3K7N4M6P9R2S5TB',
    title: 'Q3 Delivery — Guided sample',
    sample: true,
  };
  const { calls } = await installLibDFakes(page, [sample, ...LIBD_DOCS]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const row = page.getByRole('row').filter({ hasText: 'Guided sample' });
  await expect(row).toContainText('Sample');
  await row.click();
  const del = page.getByRole('button', { name: 'Delete', exact: true });
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await del.focus();
  await expect(page.getByRole('tooltip')).toHaveText('The guided sample cannot be deleted');
  await del.click({ force: true });
  await expect(page.locator('.gd-toast')).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(calls).toEqual([]);
});

test('RESP-02 at 480 the library is read-only: no delete, archive, recover or purge affordance', async ({
  page,
  checkA11y,
}) => {
  await installLibDFakes(page);
  await asPhone(page, 480, 900);
  await signIn(page);
  await page.getByText('Shared trek').click();
  await expect(page.getByRole('button', { name: /^(Delete|Archive)$/ })).toHaveCount(0);
  await expect(page.getByText('View only on phone')).toBeVisible();
  // LIB-06 / RESP-02 (#134): no create affordance on phone.
  await expect(page.getByRole('button', { name: 'New workscape' })).toHaveCount(0);
  await checkA11y('library-phone-read-only');
  await page.getByRole('button', { name: 'Recents', expanded: false }).click();
  await page.getByRole('button', { name: 'Recently Deleted' }).click();
  await expect(page.getByText('Old plan')).toBeVisible();
  for (const name of ['Recover', 'Recover All', 'Delete All', 'Recover Old plan']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
});
