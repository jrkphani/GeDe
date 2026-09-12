import { type Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { expect, test } from './fixtures/test.js';

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
  kind: 'workscape',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-11T10:00:00Z',
  ownerId: SESSION.sub,
  ownerName: SESSION.name,
  sharedWithOthers: false,
  permission: 'owner',
  sizeBytes: 956000,
  deletedAt: null,
};

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
