/**
 * Document shell journeys against the built bundle. Everything outside the
 * browser is a labelled FAKE at the network edge: Cognito (`fakes/cognito`),
 * the documents REST API (routes below) and the y-websocket room
 * (`fakes/room`). The SPA itself — sign-in, Amplify, the Yjs provider, the
 * replica in IndexedDB — runs for real.
 */
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { createSheet, createTable, openDocument } from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e0';
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
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

async function installFakes(page: Page, viewOnly = false): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as { title: string };
      return route.fulfill({ json: { document: { ...record, title: body.title } } });
    }
    return route.fulfill({ json: { document: record } });
  });
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
  const room = new FakeRoom({ viewOnly });
  await room.install(page);
  return room;
}

/** AUTH-01: a cold visit to the document lands on sign-in and returns after the code. */
async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // AUTH-07: the passkey offer follows a code sign-in; decline it whenever it appears.
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

test.describe('document shell', () => {
  test('DOC-01 DOC-03 DOC-06 signs in, opens the workscape, seeds Sheet 1 and shows rulers on the lattice', async ({
    page,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByLabel('Workscape title')).toHaveValue('Everest trek');
    await expect(page.getByRole('tab', { name: /1°.*Sheet 1/ })).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText(/Synced/);
    await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
    expect(room.urls[0]).toMatch(/\/ws\/6f1b2c3d-0000-4000-8000-00000000e2e0\?token=/);
    const cols = page.getByTestId('ruler-columns');
    await expect(cols.getByText('A', { exact: true })).toBeVisible();
    const a = cols.getByText('A', { exact: true });
    await expect(a).toHaveCSS('width', '160px');
    await expect(page.getByTestId('ruler-rows').getByText('1', { exact: true })).toHaveCSS(
      'height',
      '22px',
    );
  });

  test('DOC-02 GRID-01 GRID-03 GRID-07 adds a table on the lattice, selects a cell, edits it, and the room receives it', async ({
    page,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const grid = page.getByRole('grid').first();
    await expect(grid).toBeVisible();
    const table = page.locator('.gd-table').first();
    await expect(table).toHaveCSS('left', '160px');
    await expect(table).toHaveCSS('top', '22px');
    const cell = grid.getByRole('gridcell').first();
    await cell.click();
    await expect(cell).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Address B5')).toBeVisible();
    // GRID-07: the strip and stub are one lattice unit each.
    await expect(page.getByRole('button', { name: /Add row to/ })).toHaveCSS('height', '22px');
    await expect(page.getByRole('button', { name: /Add column to/ })).toHaveCSS('width', '160px');
    await cell.dblclick();
    await page.getByLabel('Edit B5').fill('Base camp');
    await page.keyboard.press('Enter');
    await expect(cell).toHaveText('Base camp');
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('Base camp'))
      .toBe(true);
    // Escape clears the selection.
    await page.keyboard.press('Escape');
    await expect(cell).not.toHaveAttribute('aria-selected', 'true');
  });

  test('DOC-04 DOC-05 DOC-07 pans by dragging, zooms with ⌥scroll into the macro tier, and Fit frames the table', async ({
    page,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const plane = page.getByTestId('plane');
    const box = await plane.boundingBox();
    if (!box) throw new Error('plane has no box');
    await page.mouse.move(box.x + 600, box.y + 500);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 450, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /translate\(-100px, -50px\)/);
    // Dragging past the origin clamps at A1 (start on empty canvas, below the table).
    await page.mouse.move(box.x + 20, box.y + 600);
    await page.mouse.down();
    await page.mouse.move(box.x + 900, box.y + 700, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /translate\(0px, 0px\)/);
    // ⌥scroll zooms out until the macro tier: block titles only, no cells.
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.keyboard.down('Alt');
    for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 400);
    await page.keyboard.up('Alt');
    await expect(page.locator('.gd-canvas')).toHaveAttribute('data-zoom-tier', 'macro');
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.locator('.gd-table__title-text')).toHaveText('Table 1');
    await page.getByRole('button', { name: 'Fit to canvas' }).click();
    await expect(page.locator('.gd-canvas')).toHaveAttribute('data-zoom-tier', 'micro');
    await expect(page.getByRole('grid')).toHaveCount(1);
  });

  for (const width of [480, 768] as const) {
    test(`RESP-02 RESP-01 at ${String(width)} px the document is read-only with no edit affordance and the geometry unchanged`, async ({
      page,
    }) => {
      const room = await installFakes(page);
      // Author a table from the room side, as a desktop collaborator would.
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
      await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
      const phone = width < 768;
      if (phone) {
        await expect(page.getByText('View only on phone')).toBeVisible();
        await expect(page.getByRole('toolbar')).toHaveCount(0);
        await expect(page.getByLabel('Workscape title')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add sheet' })).toHaveCount(0);
        await expect(page.locator('.gd-doc__sheets--bottom')).toBeVisible();
      } else {
        await expect(page.getByRole('toolbar', { name: 'Document tools' })).toBeVisible();
        await page.getByRole('button', { name: 'Add table' }).click();
        const table = page.locator('.gd-table').first();
        await expect(table).toHaveCSS('left', '160px');
        await expect(table).toHaveCSS('width', '480px');
        // RESP-05: below lg every target is at least 44 px.
        const box = await page.getByRole('button', { name: 'Add table' }).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      // No horizontal overflow of the chrome at this width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  // 200 % browser zoom halves the CSS viewport at a 2× device scale: a 1440 px window
  // becomes 720 CSS px (phone chrome, read-only), a 2560 px window 1280 CSS px (desktop).
  for (const zoomed of [
    { width: 720, height: 450, chrome: 'phone' },
    { width: 1280, height: 720, chrome: 'desktop' },
  ] as const) {
    test.describe(`at 200 % browser zoom on a ${String(zoomed.width * 2)} px window`, () => {
      test.use({
        viewport: { width: zoomed.width, height: zoomed.height },
        deviceScaleFactor: 2,
      });

      test(`A11Y-06 the ${zoomed.chrome} layout holds at 200 % zoom with no loss of content`, async ({
        page,
      }) => {
        const room = await installFakes(page);
        // A collaborator has already placed a table.
        const gd = openDocument(room.doc);
        const sheetId = createSheet(gd);
        createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 5 });
        await signInTo(page, `/d/${DOC_ID}`);
        await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
        await expect(page.getByRole('grid')).toBeVisible();
        if (zoomed.chrome === 'phone') {
          await expect(page.getByRole('heading', { level: 1 })).toHaveText('Everest trek');
          await expect(page.getByText('View only on phone')).toBeVisible();
        } else {
          await expect(page.getByLabel('Workscape title')).toBeVisible();
          await expect(page.getByRole('toolbar', { name: 'Document tools' })).toBeVisible();
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // The lattice is absolute: the table keeps its 160 px column at any zoom (RESP-01).
        await expect(page.locator('.gd-table').first()).toHaveCSS('width', '480px');
      });
    });
  }

  test('SHARE-03 the service’s read-only notice takes the edit affordances away and says why', async ({
    page,
  }) => {
    // The record still says the caller may edit; the room disagrees (permission changed since).
    const room = await installFakes(page, true);
    const gd = openDocument(room.doc);
    createSheet(gd);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByText('Your access is now view-only.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add table' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByLabel('Workscape title')).toHaveCount(0);
  });

  test('A11Y-05 selection and sync status announce through the polite live region', async ({
    page,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByTestId('live-region')).toHaveText(/Synced/);
    await page.getByRole('button', { name: 'Add table' }).click();
    await page.getByRole('grid').first().getByRole('gridcell').first().click();
    await expect(page.getByTestId('live-region')).toHaveText(/Selected B5 in Table 1/);
  });
});
