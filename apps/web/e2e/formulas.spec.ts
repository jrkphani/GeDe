/**
 * Formula journeys against the built bundle (FX-02, FX-06, FX-07, FX-08,
 * A11Y-04). Same labelled FAKES at the network edge as `document.spec.ts`
 * (Cognito, the documents REST API, the y-websocket room); the SPA, the Yjs
 * replica and the formula Worker run for real.
 *
 * Entry goes through the Wave 1 cell editor, which commits on Enter and on
 * blur; the `=` forms menu, `@` autocomplete and click-to-insert (FX-04,
 * FX-05) are exercised in component tests until the grid editor mounts
 * `useFormulaAdornments` (branch wave2/grid-editing).
 */
import type { Page } from '@playwright/test';
import { openDocument, setRowWrapped, tableRecord } from '@gede/core';
import { expect, test } from './fixtures/test.js';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e1';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-2',
  email: 'shankar@1cloudhub.com',
  name: 'Shankar',
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
  title: 'Trek budget',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

async function installFakes(page: Page): Promise<FakeRoom> {
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
  const room = new FakeRoom({ viewOnly: false });
  await room.install(page);
  return room;
}

async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a code' }).click();
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

/** Type into a cell through the Wave 1 editor: double-click, fill, Enter. */
async function enter(page: Page, address: string, text: string): Promise<void> {
  const cell = page.locator(`[data-address="${address}"]`);
  await cell.dblclick();
  const editor = page.getByLabel(`Edit ${address}`);
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
}

test.describe('formulas', () => {
  test('FX-02 FX-06 FX-07 FX-08 A11Y-04 a Sum shows value, badge and expression; dependents update; operands outline at two zoom levels and clear on deselect', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    // The table sits at (1, 1): title bar + header put its first data cell at B5 (rows 5–9).
    await expect(page.locator('[data-address="B5"]')).toBeVisible();
    await enter(page, 'B5', '1200');
    await enter(page, 'B6', '34');
    await enter(page, 'B7', '=Sum(B5:B6)');

    // FX-07: value and reference badge; in a compact one-unit row the expression is the tooltip.
    const overlay = page.getByTestId('formula-overlay');
    await expect(overlay).toHaveCount(1);
    await expect(overlay.locator('.gd-formula__value')).toHaveText('1,234');
    await expect(overlay.getByLabel('Formula, 1 reference')).toHaveText('ƒ1');
    await expect(overlay.getByTestId('formula-cell')).toHaveAttribute('title', '=Sum(B5:B6)');
    await expect(overlay.locator('.gd-formula__expr')).toHaveCount(0);
    // The overlay sits exactly on B7: column B = 160 px, row 7 = 6 × 22 px.
    await expect(overlay).toHaveCSS('left', '160px');
    await expect(overlay).toHaveCSS('top', '132px');

    // A collaborator wraps row 7 (GRID-09: two lattice rows): the expression takes the second line.
    await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
    const gd = openDocument(room.doc);
    const table = gd.tables.get(Array.from(gd.tables.keys())[0] ?? '')!;
    const record = tableRecord(table);
    setRowWrapped(gd, record.id, record.rows[2] ?? '', true);
    await expect(overlay).toHaveCSS('height', '44px');
    await expect(overlay.locator('.gd-formula__expr')).toHaveText('=Sum(B5:B6)');

    // FX-08: selecting the formula cell outlines its range as one block with its index badge.
    await page.locator('[data-address="B7"]').click();
    const outlines = page.getByTestId('reference-outlines');
    const block = outlines.locator('.gd-outline');
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute('data-operand', '1');
    await expect(block).toHaveAttribute('data-label', 'B5:B6');
    await expect(block).toHaveClass(/gd-outline--range/);
    await expect(block).toHaveCSS('left', '160px');
    await expect(block).toHaveCSS('top', '88px');
    await expect(block).toHaveCSS('height', '44px');
    await expect(block.locator('.gd-outline__index')).toHaveText('1');
    const strokeAt1 = await block.evaluate((el) => getComputedStyle(el).borderTopColor);
    await snapshot('formula sum outlined at 100%');

    // Outlines follow zoom: the block keeps its lattice geometry inside the scaled layer,
    // the stroke is drawn in the operand's colour at both levels.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /scale\(1\.22\)/);
    await expect(block).toHaveCount(1);
    await expect(block).toHaveCSS('left', '160px');
    await expect(block).toHaveCSS('height', '44px');
    await expect(outlines).toHaveAttribute('style', /--gd-zoom:\s*1\.22/);
    expect(await block.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(strokeAt1);
    await snapshot('formula sum outlined at 122%');
    await checkA11y('document with a formula');

    // FX-06: editing a referenced cell updates the dependent.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await enter(page, 'B6', '66');
    await expect(overlay.locator('.gd-formula__value')).toHaveText('1,266');

    // FX-02 / A11Y-04: text in range is an error with icon and text, naming the offender.
    await enter(page, 'B6', 'camp');
    await expect(overlay.locator('.gd-formula__error-text')).toHaveText('text in range');
    await expect(
      overlay.getByRole('img', { name: 'B6 holds text, so it cannot be summed' }),
    ).toBeVisible();

    // FX-07: re-opening the cell restores the expression, not the value.
    await page.locator('[data-address="B7"]').dblclick();
    await expect(page.getByLabel('Edit B7')).toHaveValue('=Sum(B5:B6)');
    await page.keyboard.press('Escape');

    // FX-08: outlines clear on deselect.
    await page.keyboard.press('Escape');
    await expect(outlines).toHaveCount(0);
  });

  test('FX-06 a reference loop reports circular on both cells and a formula may read a formula', async ({
    page,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    await enter(page, 'B5', '2');
    await enter(page, 'B6', '=Sum(B5)');
    await enter(page, 'B7', '=Sum(B6, B5)');
    const overlays = page.getByTestId('formula-overlay');
    await expect(overlays).toHaveCount(2);
    await expect(overlays.nth(1).locator('.gd-formula__value')).toHaveText('4');
    await enter(page, 'B5', '=Sum(B7)');
    await expect(page.locator('.gd-formula__error-text')).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(page.locator('.gd-formula__error-text').nth(i)).toHaveText('circular');
    }
  });
});
